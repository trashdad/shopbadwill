"""Condition waits for the Firefox specs: poll with a deadline, never a fixed sleep as a wait."""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import TypeVar

T = TypeVar("T")
POLL_S = 0.25


def wait_until(check: Callable[[], T], what: str, timeout_s: float = 15.0) -> T:
    """Polls ``check`` until it returns something truthy and returns that; fails with the last value seen."""
    deadline = time.monotonic() + timeout_s
    while True:
        value = check()
        if value:
            return value
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out after {timeout_s} s waiting for {what}; last value: {value!r}")
        time.sleep(POLL_S)
