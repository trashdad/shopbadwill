"""Starts Firefox with Selenium/geckodriver and installs the test build temporarily.

Environment:
  SBW_FIREFOX_BIN   Firefox binary (default: the standard Windows install, else
                    `firefox` on PATH, else whatever Selenium Manager finds)
  SBW_GECKODRIVER   geckodriver binary (default: $GECKOWEBDRIVER/geckodriver on
                    GitHub's runners, else Selenium Manager fetches one)
  SBW_E2E_HEADED=1  show the browser window (default: headless)
"""

from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.firefox.webdriver import WebDriver

from .extension import EXTENSION_UUID, Extension, extension_dir, gecko_id

_WINDOWS_FIREFOX = (
    Path(r"C:\Program Files\Mozilla Firefox\firefox.exe"),
    Path(r"C:\Program Files (x86)\Mozilla Firefox\firefox.exe"),
)


def firefox_binary() -> str | None:
    if os.environ.get("SBW_FIREFOX_BIN"):
        return os.environ["SBW_FIREFOX_BIN"]
    if sys.platform == "win32":
        for candidate in _WINDOWS_FIREFOX:
            if candidate.is_file():
                return str(candidate)
    return shutil.which("firefox")


def geckodriver_binary() -> str | None:
    if os.environ.get("SBW_GECKODRIVER"):
        return os.environ["SBW_GECKODRIVER"]
    runner_dir = os.environ.get("GECKOWEBDRIVER")  # GitHub's ubuntu runners
    if runner_dir:
        candidate = Path(runner_dir, "geckodriver.exe" if sys.platform == "win32" else "geckodriver")
        if candidate.is_file():
            return str(candidate)
    return None


def launch(proxy_port: int) -> WebDriver:
    """A fresh Firefox profile whose web traffic all goes to the fixture site's proxy."""
    options = webdriver.FirefoxOptions()
    binary = firefox_binary()
    if binary:
        options.binary_location = binary
    if os.environ.get("SBW_E2E_HEADED") != "1":
        options.add_argument("-headless")
    # The fixture site's certificate is self-signed (harness/sgw_site.py).
    options.accept_insecure_certs = True
    prefs: dict[str, str | int | bool] = {
        "network.proxy.type": 1,  # manual
        "network.proxy.http": "127.0.0.1",
        "network.proxy.http_port": proxy_port,
        "network.proxy.ssl": "127.0.0.1",
        "network.proxy.ssl_port": proxy_port,
        # Loopback stays direct (the fake servers); this is Firefox's default.
        "network.proxy.allow_hijacking_localhost": False,
        "extensions.webextensions.uuids": json.dumps({gecko_id(): EXTENSION_UUID}),
    }
    for name, value in prefs.items():
        options.set_preference(name, value)
    # Without system access, Marionette refuses to navigate to moz-extension://
    # pages ("not allowed in this context"), and extension pages are the only
    # place a test can run extension code (docs/spikes/S-6.md).
    service = Service(executable_path=geckodriver_binary(), service_args=["--allow-system-access"])
    return webdriver.Firefox(options=options, service=service)


def install(driver: WebDriver) -> Extension:
    """Installs the test build as a temporary add-on (as about:debugging does)."""
    addon_id = driver.install_addon(str(extension_dir()), temporary=True)
    if addon_id != gecko_id():
        raise AssertionError(f"installed {addon_id!r}, expected the manifest's gecko id {gecko_id()!r}")
    return Extension(driver=driver, addon_id=addon_id)
