"""The extension under test: the Firefox test build and its handle in a session.

``pnpm test:e2e:firefox`` builds ``.output/firefox-mv3-test`` (``pnpm build:test
-b firefox --mv3``: SBW_TEST=1, mode "test") and passes its path in
``SBW_FIREFOX_EXTENSION_DIR``.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path
from typing import Any

from selenium.webdriver.firefox.webdriver import WebDriver

REPO_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_EXTENSION_DIR = REPO_ROOT / ".output" / "firefox-mv3-test"

# Pinned through the `extensions.webextensions.uuids` pref, so pages have fixed
# moz-extension:// URLs. Synthetic; any valid UUID works.
EXTENSION_UUID = "5bad0111-0000-4000-8000-000000000006"

# Calls a test hook (src/test-hooks/index.ts) over a runtime Port from an
# extension page, and resolves with its { ok, value | error } reply.
_CALL_HOOK_JS = """
const [name, payload, timeoutMs] = arguments;
return new Promise((resolve) => {
  const port = browser.runtime.connect({ name });
  const timer = setTimeout(() => {
    port.disconnect();
    resolve({ ok: false, error: `no reply on ${name} within ${timeoutMs} ms` });
  }, timeoutMs);
  port.onMessage.addListener((reply) => {
    clearTimeout(timer);
    resolve(reply);
  });
  port.onDisconnect.addListener((p) => {
    clearTimeout(timer);
    const error = p.error ?? browser.runtime.lastError;
    resolve({ ok: false, error: `${name} disconnected: ${error ? error.message : 'no reply'}` });
  });
  port.postMessage({ payload });
});
"""


class TestHookError(AssertionError):
    """A test hook answered ``{ ok: false }``, or nothing answered."""

    __test__ = False  # not a pytest test class


def extension_dir() -> Path:
    path = Path(os.environ.get("SBW_FIREFOX_EXTENSION_DIR", DEFAULT_EXTENSION_DIR)).resolve()
    if not (path / "manifest.json").is_file():
        raise FileNotFoundError(
            f"No Firefox test build at {path}. Run `pnpm test:e2e:firefox` "
            "(it builds one) or `pnpm build:test -b firefox --mv3`."
        )
    return path


@cache
def manifest() -> dict[str, Any]:
    return json.loads((extension_dir() / "manifest.json").read_text(encoding="utf-8"))


def gecko_id() -> str:
    return str(manifest()["browser_specific_settings"]["gecko"]["id"])


def background_contains(text: str) -> bool:
    """Whether the built background script contains ``text`` (what this build wires in)."""
    scripts = manifest()["background"]["scripts"]
    return any(text in (extension_dir() / script).read_text(encoding="utf-8") for script in scripts)


@dataclass
class Extension:
    """The temporarily installed test build in one Firefox session."""

    driver: WebDriver
    addon_id: str
    uuid: str = EXTENSION_UUID
    _hook_window: str | None = field(default=None, repr=False)

    def url(self, path: str) -> str:
        return f"moz-extension://{self.uuid}/{path.lstrip('/')}"

    @property
    def hook_page(self) -> str:
        """The extension page that hosts hook calls: Firefox's sidebar panel (any extension page works)."""
        return self.url(manifest()["sidebar_action"]["default_panel"])

    def call_hook(self, name: str, payload: Any = None, timeout_s: float = 10) -> Any:
        """Calls test hook ``name`` from the extension page in a background tab and returns its value.

        The current tab is left as it was, so a test can call hooks while a page is open.
        """
        driver = self.driver
        previous = driver.current_window_handle
        if self._hook_window not in driver.window_handles:
            driver.switch_to.new_window("tab")
            self._hook_window = driver.current_window_handle
            driver.get(self.hook_page)
        else:
            driver.switch_to.window(self._hook_window)
        try:
            reply = driver.execute_script(_CALL_HOOK_JS, name, payload, int(timeout_s * 1000))
        finally:
            driver.switch_to.window(previous)
        if not isinstance(reply, dict) or not reply.get("ok"):
            error = reply.get("error") if isinstance(reply, dict) else reply
            raise TestHookError(f"test hook {name} failed: {error}")
        return reply.get("value")
