"""Starts Firefox with Selenium/geckodriver and installs the test build temporarily.

The browser runs in a network sandbox: every request goes to the fixture site's
proxy (harness/sgw_site.py), which serves only https://shopgoodwill.com/ from
local fixtures and refuses everything else. Because Firefox also runs with
``acceptInsecureCerts``, a proxy bypass would mean real traffic without
certificate checks, so the sandbox is enforced twice:

* :func:`proxy_prefs` closes every documented way around the proxy (no direct
  failover, no SOCKS/FTP/PAC/exception list, no DNS-over-HTTPS, QUIC, WebRTC or
  speculative connections). Only loopback stays direct, for the fake servers.
* :func:`check_sandbox` runs canary navigations before any test and aborts the
  run unless the proxy itself saw and refused them.

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
from typing import Protocol

from selenium import webdriver
from selenium.common.exceptions import WebDriverException
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.firefox.webdriver import WebDriver

from .extension import EXTENSION_UUID, Extension, extension_dir, gecko_id
from .sgw_site import REFUSAL_MARKER

_WINDOWS_FIREFOX = (
    Path(r"C:\Program Files\Mozilla Firefox\firefox.exe"),
    Path(r"C:\Program Files (x86)\Mozilla Firefox\firefox.exe"),
)

# Canary navigations, and the entry each must leave in the proxy's refusal log.
# `.invalid` never resolves (RFC 2606), so even a bypass could not reach a server.
CANARIES = (
    ("https://example.invalid/", "example.invalid:443"),
    ("http://example.invalid/", "GET http://example.invalid/"),
)


class SandboxError(RuntimeError):
    """The browser's traffic is not confined to the fixture site's proxy."""


class RefusalLog(Protocol):
    @property
    def refused(self) -> list[str]: ...


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


def proxy_prefs(proxy_port: int) -> dict[str, str | int | bool]:
    """Prefs that send all of Firefox's non-loopback traffic to the proxy, and nowhere else."""
    return {
        # Manual proxy for http and https; no shared-settings or backup copies.
        "network.proxy.type": 1,
        "network.proxy.http": "127.0.0.1",
        "network.proxy.http_port": proxy_port,
        "network.proxy.ssl": "127.0.0.1",
        "network.proxy.ssl_port": proxy_port,
        "network.proxy.share_proxy_settings": False,
        "network.proxy.backup.ssl": "",
        "network.proxy.backup.ssl_port": 0,
        # No other proxy route, no exceptions, no PAC, no falling back to direct.
        "network.proxy.socks": "",
        "network.proxy.socks_port": 0,
        "network.proxy.ftp": "",
        "network.proxy.ftp_port": 0,
        "network.proxy.autoconfig_url": "",
        "network.proxy.no_proxies_on": "",
        "network.proxy.failover_direct": False,
        # Loopback (127.0.0.0/8, ::1, localhost) stays direct for the fake
        # servers; it cannot leave the machine. Firefox's default, made explicit.
        "network.proxy.allow_hijacking_localhost": False,
        # Traffic that does not go through an HTTP proxy at all.
        "network.trr.mode": 5,  # DNS-over-HTTPS off
        "network.http.http3.enable": False,  # QUIC (UDP)
        "media.peerconnection.enabled": False,  # WebRTC (UDP)
        "network.dns.disablePrefetch": True,
        "network.prefetch-next": False,
        "network.http.speculative-parallel-limit": 0,
        "network.captive-portal-service.enabled": False,
        "network.connectivity-service.enabled": False,
    }


def launch(proxy_port: int) -> WebDriver:
    """A fresh Firefox profile whose web traffic all goes to the fixture site's proxy."""
    options = webdriver.FirefoxOptions()
    binary = firefox_binary()
    if binary:
        options.binary_location = binary
    if os.environ.get("SBW_E2E_HEADED") != "1":
        options.add_argument("-headless")
    # The fixture site's certificate is self-signed (harness/sgw_site.py).
    # Safe only inside the sandbox; check_sandbox() proves it before any test.
    options.accept_insecure_certs = True
    prefs: dict[str, str | int | bool] = {
        **proxy_prefs(proxy_port),
        "extensions.webextensions.uuids": json.dumps({gecko_id(): EXTENSION_UUID}),
    }
    for name, value in prefs.items():
        options.set_preference(name, value)
    # Without system access, Marionette refuses to navigate to moz-extension://
    # pages ("not allowed in this context"), and extension pages are the only
    # place a test can run extension code (docs/spikes/S-6.md).
    service = Service(executable_path=geckodriver_binary(), service_args=["--allow-system-access"])
    return webdriver.Firefox(options=options, service=service)


def check_sandbox(driver: WebDriver, site: RefusalLog) -> None:
    """Fails closed unless each canary went to the proxy and came back refused.

    Run it on a fresh browser before any test navigation. Raises SandboxError if
    a canary is missing from the proxy's refusal log (Firefox went around the
    proxy) or if the browser shows anything but a refusal (an error page for
    https, the proxy's own 403 page for http).
    """
    for url, log_entry in CANARIES:
        seen_before = len(site.refused)
        try:
            driver.get(url)
        except WebDriverException as error:
            if "Reached error page" not in str(error):
                raise SandboxError(f"canary {url}: unexpected navigation failure: {error}") from error
            served_elsewhere = False  # a network error page: nothing was loaded
        else:
            served_elsewhere = REFUSAL_MARKER not in driver.page_source
        if log_entry not in site.refused[seen_before:]:
            raise SandboxError(
                f"canary {url} never reached the E2E proxy (expected {log_entry!r} in its refusal log): "
                "Firefox is not honouring the proxy prefs, so tests could reach the internet "
                "without certificate checks"
            )
        if served_elsewhere:
            raise SandboxError(f"canary {url} loaded a page that is not the proxy's refusal")


def install(driver: WebDriver) -> Extension:
    """Installs the test build as a temporary add-on (as about:debugging does)."""
    addon_id = driver.install_addon(str(extension_dir()), temporary=True)
    if addon_id != gecko_id():
        raise AssertionError(f"installed {addon_id!r}, expected the manifest's gecko id {gecko_id()!r}")
    return Extension(driver=driver, addon_id=addon_id)
