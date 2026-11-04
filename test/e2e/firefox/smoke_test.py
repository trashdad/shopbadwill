"""S-6 smoke: the Firefox test build, installed temporarily, decorates a fixture
page served as https://shopgoodwill.com/ and its background answers the
test-only ``sbw:test:state`` hook.

Two checks wait on code that has not landed yet. Each is a strict xfail keyed on
the built background script, so it turns into a plain, required test by itself
as soon as that code is in the build (and an unexpected pass fails the run):

* ``sbw:test:state`` answers once the background calls ``installTestHooks``
  (T-36's ``main.ts``; today's background is the T-01 placeholder).
* the ``sbw:tick`` alarm exists once ``reconcile()`` lands (T-52's scheduler).
"""

from __future__ import annotations

import pytest
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.webdriver import WebDriver
from selenium.webdriver.support.ui import WebDriverWait

from harness.extension import Extension, background_contains
from harness.firefox import CANARIES
from harness.sgw_site import SGW_HOST, SgwSite

HOOKS_WIRED = background_contains("sbw:test:state")
RECONCILE_BUILT = background_contains("sbw:tick")


def test_sandbox_canary_was_refused_by_the_proxy(firefox: WebDriver, sgw_site: SgwSite) -> None:
    # The session fixture ran check_sandbox() on this browser before any test.
    for _url, log_entry in CANARIES:
        assert log_entry in sgw_site.refused
    assert not any(SGW_HOST in entry for entry in sgw_site.refused)


def test_badge_shadow_dom_on_fixture_page(firefox: WebDriver, sgw_site: SgwSite) -> None:
    firefox.get(sgw_site.url("/"))

    # The page is T-12's fixture, fetched through the hostname override.
    assert firefox.current_url == f"https://{SGW_HOST}/"
    assert firefox.title == "ShopGoodwill fixture"
    assert ("GET", SGW_HOST, "/") in [(r.method, r.host, r.path) for r in sgw_site.requests]

    host = WebDriverWait(firefox, 10).until(
        lambda d: d.find_element(By.CSS_SELECTOR, "shopbadwill-badge"),
        message="no <shopbadwill-badge> host: the content script did not run on the fixture page",
    )
    badge = host.shadow_root.find_element(By.CSS_SELECTOR, '[role="status"]')
    assert badge.text.strip() != ""


@pytest.mark.xfail(
    not HOOKS_WIRED,
    reason="the background does not call installTestHooks() yet (T-36 main.ts)",
    strict=True,
)
def test_background_answers_sbw_test_state(extension: Extension) -> None:
    state = extension.call_hook("sbw:test:state")

    assert "state" in state["hooks"]
    assert isinstance(state["installedAt"], (int, float))
    assert set(state["storage"]) == {"local", "session"}
    assert isinstance(state["alarms"], list)


@pytest.mark.xfail(
    not (HOOKS_WIRED and RECONCILE_BUILT),
    reason="reconcile() and its sbw:tick alarm land with the scheduler (T-52), read through sbw:test:state (T-36)",
    strict=True,
)
def test_reconcile_created_the_tick_alarm(extension: Extension) -> None:
    alarms = extension.call_hook("sbw:test:state")["alarms"]

    tick = [alarm for alarm in alarms if alarm["name"] == "sbw:tick"]
    assert len(tick) == 1, alarms
    assert tick[0]["periodInMinutes"] == 2
