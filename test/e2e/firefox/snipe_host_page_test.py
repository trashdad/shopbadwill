"""T-116: the runner-page SnipeHost in real Firefox (the S-7 verdict's host).

The spec drives the production host through the test-only hook
``sbw:test:snipe-host`` (src/test-hooks/snipe-host.ts), which creates it
through the same factory the snipe runner uses on a Firefox build:

* ``acquire`` opens one small unfocused extension popup showing the R3 text,
  whose page holds a ``runtime.connect`` port open (the background reports it
  through the hook's status);
* a second ``acquire`` for the same snipe is a no-op;
* ``release`` closes the window;
* a window the user closes early is audited (``snipe.host-window-closed`` in
  the audit log) and re-acquired once, never twice;
* after a worker that died mid-window (simulated by the hook's ``restart``),
  the new host adopts the still-open page instead of opening a second window,
  and the page reconnects its port to it (``runtime.getContexts`` and the
  page's reconnect, in the real browser);
* the startup reap closes a left-over page whose snipe no longer needs it.

Window focus cannot be asserted headless (S-7: the popup reported focused
despite ``focused:false``); the unfocused contract is asserted through the
create options the host recorded, and headed behaviour stays A-4's manual
check. Waits poll a condition with a deadline (no fixed sleeps). The hook's
own page can also appear as a new window handle, so windows are matched by
their URL, never by handle order.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

from selenium.webdriver.firefox.webdriver import WebDriver

from harness.extension import Extension

HOOK = "sbw:test:snipe-host"
STATE_HOOK = "sbw:test:state"
PAGE_TEXT = "ShopBadwill is holding a snipe"
AUDIT_KIND = "snipe.host-window-closed"
PAGE_URL_NEEDLE = "snipe-runner.html"


def _wait_until(check: Callable[[], Any], timeout_s: float = 15.0, what: str = "condition") -> Any:
    """Polls ``check`` until it is truthy; the hook round-trips and window events are async."""
    deadline = time.monotonic() + timeout_s
    while True:
        value = check()
        if value:
            return value
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out waiting for {what}")
        time.sleep(0.25)


def _host(extension: Extension, action: str, snipe_id: str) -> Any:
    return extension.call_hook(HOOK, {"action": action, "snipeId": snipe_id})


def _status(extension: Extension) -> Any:
    return extension.call_hook(HOOK, {"action": "status"})


def _snipes(extension: Extension) -> list[dict[str, Any]]:
    return list(_status(extension)["snipes"])


def _snipe(extension: Extension, snipe_id: str) -> dict[str, Any] | None:
    return next((s for s in _snipes(extension) if s["snipeId"] == snipe_id), None)


def _new_handles(driver: WebDriver, before: set[str]) -> list[str]:
    return [h for h in driver.window_handles if h not in before]


def _popup_handles(driver: WebDriver, before: set[str]) -> list[str]:
    """The new window handles that show the runner page (matched by URL)."""
    out: list[str] = []
    for handle in _new_handles(driver, before):
        driver.switch_to.window(handle)
        if PAGE_URL_NEEDLE in driver.current_url:
            out.append(handle)
    return out


def _popup_handle(driver: WebDriver, before: set[str], what: str = "the snipe-host window to open") -> str:
    return _wait_until(lambda: _popup_handles(driver, before)[0] if _popup_handles(driver, before) else None, what=what)


def _stable_handle(driver: WebDriver) -> str:
    """A window that is not a runner page (never closed by the host), for hook calls that close popups."""
    for handle in driver.window_handles:
        driver.switch_to.window(handle)
        if PAGE_URL_NEEDLE not in driver.current_url:
            return handle
    raise AssertionError("no window other than runner pages is open")


def _audit_entries(extension: Extension) -> list[dict[str, Any]]:
    state = extension.call_hook(STATE_HOOK)
    entries: list[dict[str, Any]] = []
    for key, value in state["storage"]["local"].items():
        if key.startswith("sbw:audit:") and isinstance(value, list):
            entries.extend(value)
    return entries


def _closed_audits(extension: Extension, snipe_id: str) -> list[dict[str, Any]]:
    return [e for e in _audit_entries(extension) if e.get("kind") == AUDIT_KIND and e.get("ref") == snipe_id]


def test_acquire_opens_one_small_unfocused_popup_with_the_page_text(
    firefox: WebDriver, extension: Extension
) -> None:
    snipe = "e2e-acquire"
    before = set(firefox.window_handles)

    reply = _host(extension, "acquire", snipe)

    assert reply["held"] is True
    assert isinstance(reply["windowId"], int)
    options = reply["createOptions"]
    assert options is not None
    assert options["type"] == "popup"
    assert options["focused"] is False
    assert options["width"] <= 300 and options["height"] <= 150
    assert PAGE_URL_NEEDLE in str(options["url"])

    handle = _popup_handle(firefox, before)
    firefox.switch_to.window(handle)
    _wait_until(lambda: PAGE_TEXT in firefox.page_source, what="the runner-page text")
    assert PAGE_URL_NEEDLE in firefox.current_url

    # The page holds its runtime port open; the background sees it.
    _wait_until(
        lambda: (s := _snipe(extension, snipe)) is not None and s["portConnected"],
        what="the page port to reach the host",
    )


def test_a_second_acquire_for_the_same_snipe_is_a_noop(firefox: WebDriver, extension: Extension) -> None:
    snipe = "e2e-noop"
    before = set(firefox.window_handles)

    _host(extension, "acquire", snipe)
    _host(extension, "acquire", snipe)

    popups = _wait_until(
        lambda: _popup_handles(firefox, before) if _popup_handles(firefox, before) else None,
        what="the snipe-host window to open",
    )
    assert len(popups) == 1  # the second acquire opened nothing
    assert len([s for s in _snipes(extension) if s["snipeId"] == snipe]) == 1  # one held snipe


def test_release_closes_the_window(firefox: WebDriver, extension: Extension) -> None:
    snipe = "e2e-release"
    before = set(firefox.window_handles)

    _host(extension, "acquire", snipe)
    handle = _popup_handle(firefox, before)

    # Release closes the popup while its hook call is in flight; sit on the
    # original window so call_hook's restore never targets a closed window.
    firefox.switch_to.window(next(iter(before)))
    reply = _host(extension, "release", snipe)
    assert reply["held"] is False

    _wait_until(lambda: handle not in firefox.window_handles, what="release to close the window")
    assert _popup_handles(firefox, before) == []


def test_an_early_user_close_is_audited_and_the_window_is_reacquired_once(
    firefox: WebDriver, extension: Extension
) -> None:
    snipe = "e2e-early-close"
    before = set(firefox.window_handles)

    reply = _host(extension, "acquire", snipe)
    first_window_id = reply["windowId"]
    first_handle = _popup_handle(firefox, before)

    # The user closes the window early: the host notices, audits, re-acquires once.
    firefox.switch_to.window(first_handle)
    firefox.close()
    firefox.switch_to.window(next(iter(before)))

    _wait_until(
        lambda: (s := _snipe(extension, snipe)) is not None and s["reacquired"],
        what="the host to re-acquire the window",
    )
    second_handle = _popup_handle(firefox, before)
    status = _snipe(extension, snipe)
    assert status is not None and status["windowId"] != first_window_id

    # The re-acquired window closes early too: audited again, never a third window.
    firefox.switch_to.window(second_handle)
    firefox.close()
    firefox.switch_to.window(next(iter(before)))

    audits = _wait_until(
        lambda: _closed_audits(extension, snipe) if len(_closed_audits(extension, snipe)) >= 2 else None,
        what="both early closes to be audited",
    )
    assert [a["details"]["reacquired"] for a in audits[:2]] == [True, False]
    assert _popup_handles(firefox, before) == []


def test_a_restarted_worker_adopts_the_open_window_instead_of_opening_a_second(
    firefox: WebDriver, extension: Extension
) -> None:
    snipe = "e2e-restart"
    before = set(firefox.window_handles)

    first = _host(extension, "acquire", snipe)
    handle = _popup_handle(firefox, before)
    _wait_until(
        lambda: (s := _snipe(extension, snipe)) is not None and s["portConnected"],
        what="the page port to reach the first host",
    )

    # The worker dies with the window open; the restarted one acquires the snipe again.
    firefox.switch_to.window(_stable_handle(firefox))
    second = extension.call_hook(HOOK, {"action": "restart", "snipeId": snipe, "acquire": True})

    assert second["windowId"] == first["windowId"]  # the same window, adopted
    assert second["createOptions"] is None  # nothing was created
    status = _snipe(extension, snipe)
    assert status is not None and status["adopted"] is True
    assert _popup_handles(firefox, before) == [handle]  # no second window
    # The page's port dropped with the old worker; it reconnects to the new host.
    _wait_until(
        lambda: (s := _snipe(extension, snipe)) is not None and s["portConnected"],
        what="the page to reconnect its port to the restarted host",
    )

    firefox.switch_to.window(_stable_handle(firefox))
    _host(extension, "release", snipe)
    _wait_until(lambda: handle not in firefox.window_handles, what="release to close the adopted window")


def test_the_startup_reap_closes_a_left_over_page_whose_snipe_is_gone(
    firefox: WebDriver, extension: Extension
) -> None:
    snipe = "e2e-orphan"
    before = set(firefox.window_handles)

    reply = _host(extension, "acquire", snipe)
    handle = _popup_handle(firefox, before)

    # The worker dies with the window open; no snipe "e2e-orphan" exists in storage.
    firefox.switch_to.window(_stable_handle(firefox))
    extension.call_hook(HOOK, {"action": "restart"})
    reaped = extension.call_hook(HOOK, {"action": "reap"})

    assert reply["windowId"] in reaped["closed"]
    _wait_until(lambda: handle not in firefox.window_handles, what="the reap to close the left-over window")
