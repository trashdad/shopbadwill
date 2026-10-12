"""T-61: one daily-job tick in real Firefox, read back through the test page.

The background's buyerapi points at the fake buyerapi on loopback
(``sbw:test:baseUrl``), its Clock is anchored to a fixed instant
(``sbw:test:advance``), and the tick is fired directly (``sbw:test:fireAlarm``):
the test build keeps alarms in a fake registry, so nothing else ticks. With
``dailyRun.catchUp`` off, watch ``w-late`` missed its slot three days ago and
watch ``w-due`` is due now. ONE ``sbw:tick`` then:

* skips ``w-late`` to its next slot and audits it: exactly one ``job.skipped``
  entry (actor ``daily-job``, reason ``catch-up-off``, the watch and its missed
  slot), read from the audit chunks in storage.local through ``sbw:test:state``,
  with none there before the tick;
* plans a scheduled run for ``w-due`` and executes exactly one step, page 1 of
  its search: one request to the fake buyerapi (stamped with the fake now), sent
  straight to loopback (the proxy never saw buyerapi). The run is left at cursor
  1 (the favorites list is next), so ``job.run.done`` is not audited yet.

The fake buyerapi clock is pinned to 2026-10-08T00:00:00 Pacific and the
background's Clock anchored 30 minutes later, as in
test/e2e/chromium/daily-job.spec.ts, so "Pyrex lot #1 vintage" is open and
matches. Waits poll a condition with a deadline; time moves only by the hook.
"""

from __future__ import annotations

from typing import Any

from harness.extension import Extension
from harness.fake_servers import FakeServer, pdt_epoch_ms
from harness.sgw_site import SGW_HOST, SgwSite
from harness.waits import wait_until

SERVER_PIN_MS = pdt_epoch_ms("2026-10-08T00:00:00")
ANCHOR_MS = pdt_epoch_ms("2026-10-08T00:30:00")
DAY_MS = 24 * 60 * 60 * 1000
# The background lane's 120 s gap plus its 15 s jitter (test/e2e/chromium/helpers/time.ts).
TICK_STEP_MS = 135_000
LATE_AT = ANCHOR_MS - 3 * DAY_MS
PYREX_1 = 280000000  # "Pyrex lot #1 vintage"
WATCH_RULE = {
    "id": "r-pyrex",
    "name": "Pyrex lot #1",
    "enabled": True,
    "action": "watch",
    "all": [
        {
            "kind": "keyword",
            "mode": "any",
            "terms": ["lot #1 vintage"],
            "wholeWord": True,
            "regex": False,
            "fields": ["title"],
        }
    ],
    "createdAt": ANCHOR_MS,
    "updatedAt": ANCHOR_MS,
}


def _state(extension: Extension) -> dict[str, Any]:
    return dict(extension.call_hook("sbw:test:state"))


def _audit(extension: Extension) -> list[dict[str, Any]]:
    """The audit entries across the stored chunks, oldest first."""
    local = _state(extension)["storage"]["local"]
    entries = [e for key, chunk in local.items() if key.startswith("sbw:audit:") for e in chunk]
    return sorted(entries, key=lambda e: e["seq"])


def _runs(extension: Extension) -> list[dict[str, Any]]:
    return list(_state(extension)["storage"]["local"].get("sbw:jobRuns", []))


def _watch(watch_id: str, rule_id: str) -> dict[str, Any]:
    return {
        "id": watch_id,
        "name": watch_id,
        "enabled": True,
        "query": {"searchText": "pyrex", "categoryIds": [], "sellerIds": [], "page": 1},
        "ruleIds": [rule_id],
        "maxPages": 1,
        "favoriteMode": "local",
        "calendar": False,
        "notify": False,
        "nextRunAt": 0,
        "seenItemIds": [],
    }


def _background_log(fake_sgw: FakeServer) -> list[dict[str, Any]]:
    """The fake buyerapi's log entries the background sent (every one carries ``x-sbw-fake-now``)."""
    return [e for e in fake_sgw.call("GET", "/__log")["entries"] if e["fakeNowMs"] is not None]


def test_one_tick_audits_the_skipped_watch_and_runs_one_search_step(
    extension: Extension, sgw_site: SgwSite, fake_sgw: FakeServer
) -> None:
    fake_sgw.call("POST", "/__scenario", {"reset": True, "serverNowMs": SERVER_PIN_MS})
    fake_sgw.call("DELETE", "/__log")
    assert extension.call_hook("sbw:test:baseUrl", {"sgw": fake_sgw.url}) == {"sgw": fake_sgw.url, "google": None}

    # The startup reconcile created the tick alarm before the Clock is anchored
    # (in real time, so it stays days ahead of the fake clock and never fires by itself).
    wait_until(
        lambda: any(a["name"] == "sbw:tick" for a in _state(extension)["alarms"]),
        "the startup reconcile to create sbw:tick",
    )
    assert extension.call_hook("sbw:test:advance", {"to": ANCHOR_MS})["now"] == ANCHOR_MS

    # Catch-up off; one watch three days late, one due now (both saved through the router).
    settings = extension.send_message("settings.get")
    extension.send_message("settings.set", {"dailyRun": {**settings["dailyRun"], "catchUp": False}})
    extension.send_message("rules.save", WATCH_RULE)
    extension.send_message("watches.save", _watch("w-late", "r-pyrex"))
    extension.send_message("watches.save", _watch("w-due", "r-pyrex"))
    # A saved watch is first due at its next daily slot; move the slots (the job owns them).
    slots = {"w-late": LATE_AT, "w-due": ANCHOR_MS}
    watches = extension.send_message("watches.list")
    extension.storage_set({"sbw:watches": [{**w, "nextRunAt": slots[w["id"]]} for w in watches]})
    assert {w["id"]: w["nextRunAt"] for w in extension.send_message("watches.list")} == slots

    before = _audit(extension)
    assert not [e for e in before if e["kind"].startswith("job.")], before
    assert _runs(extension) == []
    last_seq = max((e["seq"] for e in before), default=-1)
    proxied, refused = len(sgw_site.requests), len(sgw_site.refused)

    # One tick, after one tick-step of fake time (which fires no alarm by itself).
    # The fake clock is an offset on the real one, so the real time this test took is in it too.
    advanced = extension.call_hook("sbw:test:advance", {"ms": TICK_STEP_MS})
    assert ANCHOR_MS + TICK_STEP_MS <= advanced["now"] < ANCHOR_MS + TICK_STEP_MS + 60_000
    assert advanced["fired"] == []
    fired = extension.call_hook("sbw:test:fireAlarm", {"name": "sbw:tick"})
    assert fired["name"] == "sbw:tick"

    runs = wait_until(
        lambda: (r := _runs(extension)) and r[0]["cursor"] >= 1 and r,
        "the tick to plan the run and execute its first step",
    )

    # The audit entry: w-late skipped to its next slot, from this tick's reconcile.
    job_entries = [e for e in _audit(extension) if e["seq"] > last_seq and e["actor"] == "daily-job"]
    assert [e["kind"] for e in job_entries] == ["job.skipped"], job_entries
    assert job_entries[0]["details"] == {"reason": "catch-up-off", "watchId": "w-late", "dueAt": LATE_AT}

    # The same tick ran exactly one step of w-due's scheduled run.
    assert len(runs) == 1, runs
    run = runs[0]
    assert run["trigger"] == "scheduled"
    assert run["status"] == "running"
    assert run["cursor"] == 1
    assert run["steps"] == [{"kind": "search", "watchId": "w-due", "page": 1}, {"kind": "favoritesList"}]
    assert run["results"]["newMatches"] == [PYREX_1]
    assert run["results"]["errors"] == []
    next_slots = {w["id"]: w["nextRunAt"] for w in extension.send_message("watches.list")}
    assert all(slot > ANCHOR_MS for slot in next_slots.values()), next_slots

    # One request: the search, from the background, at the tick's fake now, straight to loopback.
    log = _background_log(fake_sgw)
    assert [e["endpoint"] for e in log] == ["Search/ItemListing"], log
    assert log[0]["fakeNowMs"] >= ANCHOR_MS + TICK_STEP_MS
    # (Firefox's own background traffic, e.g. remote settings, is refused by the proxy as always.)
    assert sgw_site.requests[proxied:] == [], sgw_site.requests[proxied:]
    assert not [e for e in sgw_site.refused[refused:] if SGW_HOST in e], sgw_site.refused[refused:]
