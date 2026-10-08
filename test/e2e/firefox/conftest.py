"""Fixtures for Firefox E2E specs (``*_test.py`` in this directory).

* ``sgw_site``: the fixture SGW site behind the hostname override (one per run).
* ``firefox``: a WebDriver with the test build installed (one fresh profile per spec file).
  Each new browser first passes the sandbox canary (harness/firefox.py:check_sandbox);
  if it fails, the whole run stops with exit code 3.
* ``extension``: the installed build: ``url(path)``, ``call_hook(name, payload)``.

On failure, a screenshot and the page source go to ``test-results/firefox/``.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from pathlib import Path

import pytest
from selenium.webdriver.firefox.webdriver import WebDriver

from harness import firefox as firefox_launcher
from harness.extension import REPO_ROOT, Extension, extension_dir
from harness.sgw_site import SgwSite

RESULTS_DIR = REPO_ROOT / "test-results" / "firefox"
_versions: dict[str, str] = {}


def pytest_report_header(config: pytest.Config) -> list[str]:
    return [
        f"extension: {extension_dir()}",
        f"firefox: {firefox_launcher.firefox_binary() or '(Selenium Manager)'}",
        f"geckodriver: {firefox_launcher.geckodriver_binary() or '(Selenium Manager)'}",
    ]


def pytest_terminal_summary(terminalreporter: pytest.TerminalReporter) -> None:
    if _versions:
        terminalreporter.write_line(", ".join(f"{k} {v}" for k, v in _versions.items()))


@pytest.fixture(scope="session")
def sgw_site() -> Iterator[SgwSite]:
    site = SgwSite()
    site.start()
    yield site
    site.stop()


@pytest.fixture(scope="module")
def _session(sgw_site: SgwSite) -> Iterator[Extension]:
    driver = firefox_launcher.launch(sgw_site.proxy_port)
    try:
        caps = driver.capabilities
        _versions["Firefox"] = str(caps.get("browserVersion"))
        _versions["geckodriver"] = str(caps.get("moz:geckodriverVersion"))
        # Before any test navigation: prove the browser cannot go around the proxy.
        try:
            firefox_launcher.check_sandbox(driver, sgw_site)
        except firefox_launcher.SandboxError as error:
            pytest.exit(f"Firefox E2E sandbox check failed, aborting the run: {error}", returncode=3)
        yield firefox_launcher.install(driver)
    finally:
        driver.quit()


@pytest.fixture
def extension(_session: Extension) -> Extension:
    return _session


@pytest.fixture
def firefox(_session: Extension) -> WebDriver:
    return _session.driver


@pytest.hookimpl(wrapper=True)
def pytest_runtest_makereport(item: pytest.Item, call: pytest.CallInfo[None]) -> Iterator[None]:
    report = yield
    if report.when == "call" and report.failed and not hasattr(report, "wasxfail"):
        session = getattr(item, "funcargs", {}).get("_session")
        if isinstance(session, Extension):
            _save_artifacts(session.driver, item.nodeid)
    return report


def _save_artifacts(driver: WebDriver, nodeid: str) -> None:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^A-Za-z0-9_.-]+", "_", nodeid)
    try:
        driver.save_screenshot(str(RESULTS_DIR / f"{stem}.png"))
        Path(RESULTS_DIR / f"{stem}.html").write_text(driver.page_source, encoding="utf-8")
    except Exception as error:  # noqa: BLE001 (artifacts are best effort)
        print(f"could not save failure artifacts for {nodeid}: {error}")
