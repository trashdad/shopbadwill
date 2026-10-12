"""T-40: the overlay in real Firefox highlights and stubs the fake SGW search page.

The Firefox test build, installed temporarily, gets three rules through the
background's real router (``rules.save``, as the options page sends it):
Highlight Fiesta, Hide Lodge, Watch Pyrex. Then it opens T-39's fake search page
as ``https://shopgoodwill.com/categories/listing?layout=grid&p=1``. The page's
own script sends the site's search XHR to ``https://buyerapi.shopgoodwill.com``;
the MAIN-world api-tap observes the reply and the overlay decorates the cards:

* every Fiesta card is highlighted (``data-sbw-highlight="green"``);
* every Lodge card is collapsed (``data-sbw-hidden="1"``, not displayed) with
  exactly one stub row (``<sbw-stub-row data-sbw-stub=<id>>``) standing in for it;
* the watch rule decorates nothing (it drives the daily job, never the page);
* the hidden bar counts the hidden cards.

Network: the proxy (harness/sgw_site.py) routes the search page to
``scripts/serve-fake-site.ts`` and buyerapi to the fake buyerapi, both on
127.0.0.1 (harness/fake_servers.py); every other host stays refused. The
background's own base URL points at the fake buyerapi too (``sbw:test:baseUrl``).
The routes stay installed for the rest of the run (they reach only those fakes).

The fake buyerapi clock is pinned to 2026-10-08T00:00:00 Pacific, as in
test/e2e/chromium/overlay.spec.ts, so page 1 of the end-time-sorted search is
fixed: five Fiesta lots, one Lodge-titled skillet and "Pyrex lot #1 vintage".
Expected decorations come from the card titles on the page; the item ids below
anchor them so the check can never pass on an empty page.
"""

from __future__ import annotations

import re
from typing import Any

import pytest
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.webdriver import WebDriver

from harness.extension import Extension
from harness.fake_servers import FakeServer, pdt_epoch_ms
from harness.sgw_site import SGW_HOST, SgwSite
from harness.waits import wait_until

BUYERAPI_HOST = f"buyerapi.{SGW_HOST}"
SEARCH_PREFIX = "/categories/listing"
SEARCH_PATH = f"{SEARCH_PREFIX}?layout=grid&p=1"
SERVER_PIN_MS = pdt_epoch_ms("2026-10-08T00:00:00")
RULE_TIME_MS = pdt_epoch_ms("2026-10-08T00:30:00")

PYREX = "280000000"  # "Pyrex lot #1 vintage": watch rule, never decorated
FIESTA = "280000001"  # "Fiesta lot #2": highlight
LODGE = "279250311"  # "Heavy Cast Iron Skillet 12 inch Lodge (Local Pickup Only)": hide


def _rule(rule_id: str, name: str, action: str, term: str) -> dict[str, Any]:
    """A one-keyword rule on the title (src/domain/rules/schema.ts)."""
    return {
        "id": rule_id,
        "name": name,
        "enabled": True,
        "action": action,
        "all": [
            {"kind": "keyword", "mode": "any", "terms": [term], "wholeWord": True, "regex": False, "fields": ["title"]}
        ],
        "createdAt": RULE_TIME_MS,
        "updatedAt": RULE_TIME_MS,
    }


RULES = [
    _rule("e2e-highlight-fiesta", "Highlight Fiesta", "highlight", "Fiesta"),
    _rule("e2e-hide-lodge", "Hide Lodge", "hide", "Lodge"),
    _rule("e2e-watch-pyrex", "Watch Pyrex", "watch", "Pyrex"),
]

# Every result card on the page, with what the overlay set on it.
_CARDS_JS = """
return Array.from(document.querySelectorAll('app-home-product-items'), (card) => {
  const link = card.querySelector('a.feat-item_name');
  return {
    id: link ? link.id : null,
    title: link ? link.textContent.trim() : '',
    highlight: card.getAttribute('data-sbw-highlight'),
    hidden: card.getAttribute('data-sbw-hidden'),
  };
});
"""


def _cards(driver: WebDriver) -> list[dict[str, Any]]:
    return list(driver.execute_script(_CARDS_JS))


def _titled(cards: list[dict[str, Any]], word: str) -> set[str]:
    return {c["id"] for c in cards if re.search(rf"\b{word}\b", c["title"], re.IGNORECASE)}


def _card(driver: WebDriver, item_id: str) -> Any:
    link = f'.//a[contains(@class, "feat-item_name") and @id="{item_id}"]'
    return driver.find_element(By.XPATH, f"//app-home-product-items[{link}]")


@pytest.fixture(scope="module")
def routed_site(sgw_site: SgwSite, fake_sgw: FakeServer, fake_site: FakeServer) -> SgwSite:
    sgw_site.route(SGW_HOST, fake_site.port, SEARCH_PREFIX)
    sgw_site.route(BUYERAPI_HOST, fake_sgw.port)
    return sgw_site


def test_rules_highlight_and_stub_the_fake_search_page(
    firefox: WebDriver, extension: Extension, routed_site: SgwSite, fake_sgw: FakeServer
) -> None:
    fake_sgw.call("POST", "/__scenario", {"reset": True, "serverNowMs": SERVER_PIN_MS})
    assert extension.call_hook("sbw:test:baseUrl", {"sgw": fake_sgw.url}) == {"sgw": fake_sgw.url, "google": None}
    for rule in RULES:
        extension.send_message("rules.save", rule)
    stored = extension.call_hook("sbw:test:state")["storage"]["local"]["sbw:rules"]
    assert [r["id"] for r in stored] == [r["id"] for r in RULES]

    firefox.get(routed_site.url(SEARCH_PATH))
    assert firefox.current_url == routed_site.url(SEARCH_PATH)

    # The fake site's script (the Angular replacement) replaced the fixture's
    # captured cards with the fake buyerapi's rows (it marks the grid with the page).
    def hydrated() -> list[dict[str, Any]]:
        error = firefox.find_element(By.TAG_NAME, "html").get_attribute("data-sbw-fake-error")
        assert error is None, f"the fake search page's XHR failed: {error}"
        rendered = firefox.execute_script("return document.querySelector('.p-dataview-content')?.dataset.page ?? null")
        return _cards(firefox) if rendered == "1" else []

    cards = wait_until(hydrated, "the fake search page to render its result cards")
    ids = {c["id"] for c in cards}
    highlights, hides = _titled(cards, "Fiesta"), _titled(cards, "Lodge")
    assert {PYREX, FIESTA, LODGE} <= ids, sorted(ids)
    assert FIESTA in highlights and LODGE in hides and PYREX not in highlights | hides

    # The overlay decorates exactly the matching cards.
    def decorated() -> bool:
        now = _cards(firefox)
        return {c["id"] for c in now if c["highlight"]} == highlights and {c["id"] for c in now if c["hidden"]} == hides

    wait_until(decorated, f"highlights on {sorted(highlights)} and hides on {sorted(hides)}")
    cards = {c["id"]: c for c in _cards(firefox)}

    # Highlights: the rule's default tone, and the card stays on screen.
    for item_id in highlights:
        assert cards[item_id]["highlight"] == "green", cards[item_id]
        assert _card(firefox, item_id).is_displayed()

    # Hides: the card collapses and exactly one stub row stands in for it.
    for item_id in hides:
        assert cards[item_id]["hidden"] == "1", cards[item_id]
        assert not _card(firefox, item_id).is_displayed()
        stubs = firefox.find_elements(By.CSS_SELECTOR, f'sbw-stub-row[data-sbw-stub="{item_id}"]')
        assert len(stubs) == 1
        assert stubs[0].is_displayed()
    assert len(firefox.find_elements(By.CSS_SELECTOR, "sbw-stub-row")) == len(hides)

    # The watch rule decorates nothing.
    assert cards[PYREX]["highlight"] is None and cards[PYREX]["hidden"] is None

    # The hidden bar (the page badge's open shadow root) counts the hidden cards.
    def pill_text() -> str:
        badge = firefox.find_element(By.CSS_SELECTOR, "shopbadwill-badge")
        return str(badge.shadow_root.find_element(By.CSS_SELECTOR, '[role="status"]').text)

    wait_until(lambda: f"{len(hides)} hidden" in pill_text(), f"the bar to say '{len(hides)} hidden'")

    # The page and its search came from the local fakes through the proxy routes; nothing SGW was refused.
    served = [(r.method, r.host, r.path, r.status) for r in routed_site.requests]
    assert ("GET", SGW_HOST, SEARCH_PREFIX, 200) in served
    assert ("POST", BUYERAPI_HOST, "/api/Search/ItemListing", 200) in served
    assert not any(SGW_HOST in entry for entry in routed_site.refused), routed_site.refused
