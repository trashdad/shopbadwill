"""T-89: a dry-run snipe in real Firefox, on the S-7 host (T-116's runner page).

S-7's verdict for Firefox is runner-page: Firefox defers an event page's timers
when no extension window is open, so from the T-5 min wake until the end the
snipe runner holds a small unfocused popup (``snipe-runner.html``) whose page
keeps a runtime port open. This spec arms a dry-run snipe through the
dashboard's Snipes section (T-85; the sidebar page in a tab) and drives it
through the real runner of the Firefox test build against the fake SGW
buyerapi (150 ms latency, SGW's clock 1.3 s ahead, following the fake clock),
then checks that:

* the runner page opens at the wake (one window, its URL names the snipe, the
  page shows the R3 text) and the host is not degraded;
* the tight timer, with the page held, fires on time: the last 3 s before the
  fire run on real time (the harness fires the window's ``recover`` alarm,
  whose drive re-arms the timer), and the measured fire error is printed and
  bounded by the CI bound (1 s);
* the dry run resolves as ``dry-run``, the window closes, and the fake SGW
  saw ZERO PlaceBid / ShowBidModal requests: the one ItemDetail read at fire
  time is the only request after the fire.

Time moves through ``sbw:test:advance`` (fake time) and only ever to a deadline
the runner itself set, once it holds that timer. Waits poll a condition with a
deadline (no fixed sleeps). Live gating (T-102) stays as it ships: bidding is
in dry run. The Chromium scenarios are test/e2e/chromium/snipe.spec.ts.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.webdriver import WebDriver
from selenium.webdriver.remote.webelement import WebElement

from harness.extension import Extension
from harness.fake_sgw import FakeSgw

ITEM = 279250057  # "Vintage Pyrex Butterprint Casserole Dish": next acceptable bid $17.00
MAX_BID_TEXT = "20.00"
MAX_BID = 2000
LEAD_MS = 8000  # the settings default the dashboard pre-fills
LATENCY_MS = 150
SKEW_MS = 1300
END_IN_MS = 20 * 60_000
APPROACH_MS = 3000
SAMPLE_SPACING_MS = 20_000  # T-81: three clock samples, 20 s apart
VERIFY_BEFORE_END_MS = 60_000  # snipe-runner.ts
CI_FIRE_ERROR_BOUND_MS = 1000  # test-strategy: the generous CI bound; on time = within 1 s (soak.ts)
MSG_VERSION = 1  # src/messaging/protocol.ts
ITEM_DETAIL = "ItemDetail/GetItemDetailModelByItemId"
RUNNER_PAGE = "snipe-runner.html"
RUNNER_TEXT = "ShopBadwill is holding a snipe"
DRY_RUN_LABEL = "DRY RUN — no bid will be placed"
DRY_RUN_OPTION = "Dry run (no bid will be placed)"

_SEND_JS = """
const [type, payload, v] = arguments;
const message = { v, reqId: crypto.randomUUID(), type };
if (payload !== null) message.payload = payload;
return browser.runtime.sendMessage(message).then(
  (reply) => reply,
  (error) => ({ ok: false, error: { code: 'send', message: String(error) } }),
);
"""

_STORAGE_SET_JS = """
const [items] = arguments;
return browser.storage.local.set(items).then(() => true);
"""


@pytest.fixture(scope="module")
def fake_sgw() -> Iterator[FakeSgw]:
    server = FakeSgw.start()
    yield server
    server.stop()


def _wait_until(check: Callable[[], Any], what: str, timeout_s: float = 20.0) -> Any:
    """Polls ``check`` until it is truthy (hook round trips and window events are async)."""
    deadline = time.monotonic() + timeout_s
    while True:
        value = check()
        if value:
            return value
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out waiting for {what}")
        time.sleep(0.1)


class Snipe:
    """The background, seen from the dashboard tab (messages) and the test hooks."""

    def __init__(self, driver: WebDriver, extension: Extension, ui: str) -> None:
        self.driver = driver
        self.extension = extension
        self.ui = ui
        self.id = ""

    def send(self, type_: str, payload: Any = None) -> Any:
        self.driver.switch_to.window(self.ui)
        reply = self.driver.execute_script(_SEND_JS, type_, payload, MSG_VERSION)
        assert isinstance(reply, dict) and reply.get("ok"), f"{type_} failed: {reply}"
        return reply.get("reply")

    def hook(self, name: str, payload: Any = None) -> Any:
        self.driver.switch_to.window(self.ui)
        return self.extension.call_hook(name, payload)

    def advance(self, **payload: int) -> dict[str, Any]:
        return dict(self.hook("sbw:test:advance", payload))

    def state(self) -> dict[str, Any]:
        return dict(self.hook("sbw:test:state"))

    def snipe(self) -> dict[str, Any]:
        found = [s for s in self.send("snipe.list") if s["id"] == self.id]
        assert len(found) == 1, f"snipe {self.id} is stored"
        return dict(found[0])

    def alarm_at(self, kind: str) -> int | None:
        name = f"sbw:snipe:{self.id}:{kind}"
        return next((int(a["scheduledTime"]) for a in self.state()["alarms"] if a["name"] == name), None)

    def runner_entry(self) -> dict[str, Any] | None:
        record = self.state()["storage"]["local"].get("sbw:snipeRunner") or {}
        entry = record.get("entries", {}).get(self.id)
        return dict(entry) if entry is not None else None

    def audit(self) -> list[dict[str, Any]]:
        entries: list[dict[str, Any]] = []
        for key, value in self.state()["storage"]["local"].items():
            if key.startswith("sbw:audit:") and isinstance(value, list):
                entries.extend(e for e in value if e.get("ref") == self.id)
        return sorted(entries, key=lambda e: e["seq"])

    def wait_for_state(self, *states: str, what: str) -> dict[str, Any]:
        return _wait_until(lambda: (s := self.snipe())["state"] in states and s, what)

    def wait_for_timer(self, lo: float, hi: float, what: str) -> int:
        """A Clock timer due in [lo, hi]: the runner set it, so its read has returned (no read in flight)."""
        return int(
            _wait_until(
                lambda: next((t for t in self.advance(ms=0)["timers"] if lo <= t <= hi), None),
                f"the runner's timer for {what}",
            )
        )

    def advance_until(self, at: float) -> None:
        self.advance(until=int(at))


def _button(scope: WebElement, text: str) -> WebElement:
    return scope.find_element(By.XPATH, f".//button[normalize-space()='{text}']")


def _arm_through_dashboard(driver: WebDriver) -> None:
    """T-85: Prepare, the max (the lead keeps the 8 s default), Review and arm, Arm snipe."""
    section = driver.find_element(By.ID, "section-snipes")
    driver.find_element(By.ID, "snipe-item-id").send_keys(str(ITEM))
    _button(section, "Prepare").click()
    _wait_until(lambda: "Next acceptable bid: $17.00" in section.text, "the prepared item")
    driver.find_element(By.ID, "snipe-amount").send_keys(MAX_BID_TEXT)
    assert driver.find_element(By.ID, "snipe-lead").get_attribute("value") == str(LEAD_MS // 1000)
    # Global bidding dry run on (T-102): the box is checked and cannot be cleared.
    dry_run = section.find_element(By.XPATH, f".//label[contains(normalize-space(.), '{DRY_RUN_OPTION}')]/input")
    assert dry_run.is_selected() and not dry_run.is_enabled()
    _button(section, "Review and arm").click()
    confirm = _wait_until(lambda: section.find_elements(By.CLASS_NAME, "sbw-confirm"), "the review step")[0]
    assert f"Max bid: ${MAX_BID_TEXT}" in confirm.text
    assert DRY_RUN_LABEL in confirm.text
    _button(confirm, "Arm snipe").click()
    _wait_until(lambda: f"Snipe armed. {DRY_RUN_LABEL}." in section.text, "the armed status")


def _runner_windows(driver: WebDriver, ui: str, snipe_id: str) -> list[str]:
    """Open windows showing this snipe's runner page (matched by URL, never by handle order)."""
    found: list[str] = []
    for handle in driver.window_handles:
        if handle == ui:
            continue
        driver.switch_to.window(handle)
        if RUNNER_PAGE in driver.current_url and f"s={snipe_id}" in driver.current_url:
            found.append(handle)
    driver.switch_to.window(ui)
    return found


def test_a_dry_run_snipe_holds_the_runner_page_through_its_window_and_fires_on_time(
    firefox: WebDriver, extension: Extension, fake_sgw: FakeSgw
) -> None:
    driver = firefox
    driver.switch_to.new_window("tab")
    ui = driver.current_window_handle
    driver.get(extension.url("sidebar.html"))
    rig = Snipe(driver, extension, ui)

    # The background talks to the fake (in-memory override, T-59 R2), SGW follows its fake clock.
    rig.hook("sbw:test:baseUrl", {"sgw": fake_sgw.url})
    started = rig.state()["installedAt"]
    t0 = int(rig.advance(ms=0)["now"])
    end_ms = round((t0 + SKEW_MS + END_IN_MS) / 1000) * 1000 + 450
    fake_sgw.scenario(
        {
            "reset": True,
            "followFakeNow": True,
            "skewMs": SKEW_MS,
            "latencyMs": {"*": LATENCY_MS},
            "bidding": {"items": {str(ITEM): {"endsAtMs": end_ms}}},
        }
    )
    fake_sgw.clear_log()
    token = fake_sgw.mint_token()
    session = {
        "bearer": token["accessToken"],
        "capturedAt": t0,
        "expiresAt": token["expiresAtMs"],
        "buyerId": "1234567",
        "source": "tap",
    }
    driver.switch_to.window(ui)
    assert driver.execute_script(_STORAGE_SET_JS, {"sbw:sgwSession": session}) is True
    settings = rig.send("settings.get")
    assert settings["dryRun"]["bidding"] is True  # T-102 ships with bidding in dry run
    rig.send("settings.set", {"snipe": {**settings["snipe"], "enabled": True}})

    driver.switch_to.window(ui)
    _arm_through_dashboard(driver)
    armed = [s for s in rig.send("snipe.list") if s["itemId"] == ITEM and s["state"] == "armed"]
    assert len(armed) == 1
    rig.id = armed[0]["id"]
    assert armed[0]["dryRun"] is True and armed[0]["maxBid"] == MAX_BID and armed[0]["leadMs"] == LEAD_MS

    # T-15 min: the preflight passes.
    preflight_at = rig.alarm_at("preflight")
    assert preflight_at is not None
    rig.advance_until(preflight_at)
    _wait_until(lambda: (rig.runner_entry() or {}).get("preflightAt") is not None, "the preflight")
    assert rig.snipe()["state"] == "armed"

    # The wake opens the window: one runner page for this snipe, with its text.
    assert _runner_windows(driver, ui, rig.id) == []
    wake_at = rig.alarm_at("wake")
    assert wake_at is not None
    rig.advance_until(wake_at)
    rig.wait_for_state("waking", what="the wake")
    pages = _wait_until(lambda: _runner_windows(driver, ui, rig.id), "the runner page to open at the wake")
    assert len(pages) == 1
    driver.switch_to.window(pages[0])
    _wait_until(lambda: RUNNER_TEXT in driver.page_source, "the runner-page text")
    driver.switch_to.window(ui)

    # The clock samples, 20 s apart, then the T-60 s verify.
    earliest = wake_at + SAMPLE_SPACING_MS
    second = rig.wait_for_timer(earliest, earliest + 5000, "the second clock sample")
    rig.advance_until(second)
    third = rig.wait_for_timer(second + SAMPLE_SPACING_MS - 5, second + SAMPLE_SPACING_MS + 50, "the third sample")
    rig.advance_until(third)
    verify_at = end_ms - VERIFY_BEFORE_END_MS - SKEW_MS
    verify_timer = rig.wait_for_timer(verify_at - 1000, verify_at + 1000, "the T-60 s verify")
    rig.advance_until(verify_timer)
    verified = rig.wait_for_state("verified", "resolved", "killed", what="the verify")
    assert verified["state"] == "verified"
    offset = verified["measured"]["offsetMs"]
    rtt = verified["measured"]["rttMs"]
    assert rtt >= LATENCY_MS
    assert abs(offset - SKEW_MS) <= rtt / 2 + 50  # SGW +1.3 s, within the estimator's rtt/2
    fire_local = verified["fireAt"] - offset
    rig.wait_for_timer(fire_local - 2, fire_local + 2, "the fire")

    # The last 3 s run on real time, with the runner page held (the same one window since the wake).
    assert _runner_windows(driver, ui, rig.id) == pages
    rig.advance_until(fire_local - APPROACH_MS)
    rig.hook("sbw:test:fireAlarm", {"name": f"sbw:snipe:{rig.id}:recover"})
    done = rig.wait_for_state("resolved", "killed", what="the dry run to resolve")
    assert done["state"] == "resolved" and done["outcome"] == "dry-run"
    fired_at = done["measured"]["firedAt"]
    error = fired_at - done["fireAt"]
    print(
        "[snipe timing] firefox runner-page: "
        f"fireErrorMs={error} fireErrorVsSgwClockMs={fired_at - offset + SKEW_MS - done['fireAt']} "
        f"offsetMs={offset} rttMs={rtt} firedBeforeEndMs={end_ms - fired_at}"
    )
    assert 0 <= error <= CI_FIRE_ERROR_BOUND_MS, f"fire error {error} ms"

    # Released after the outcome: the window closes; the host was the page host, not degraded.
    _wait_until(lambda: _runner_windows(driver, ui, rig.id) == [], "the runner page to close")
    kinds = [e["kind"] for e in rig.audit()]
    assert "snipe.host-degraded" not in kinds
    assert "bid.dry-run" in kinds and "snipe.post-read" in kinds
    assert "bid.sent" not in kinds

    # Zero bid writes; the one harmless read at fire time is the only request after the fire.
    log = fake_sgw.log()
    assert [e for e in log if "PlaceBid" in e["path"] or "ShowBidModal" in e["path"]] == []
    after = [e for e in log if e["fakeNowMs"] is not None and e["fakeNowMs"] >= fire_local]
    assert [(e["endpoint"], e["status"]) for e in after] == [(ITEM_DETAIL, 200)]

    settings = rig.send("settings.get")
    assert settings["snipe"]["completedDryRuns"] == 1
    assert settings["dryRun"]["bidding"] is True
    # One event page throughout: a restart would have lost the fake clock.
    assert rig.state()["installedAt"] == started
