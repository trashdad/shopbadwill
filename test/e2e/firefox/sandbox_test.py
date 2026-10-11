"""The network sandbox around the E2E browser, tested without Firefox.

* check_sandbox() aborts unless every canary was refused by the proxy itself.
* proxy_prefs() leaves no route around the proxy except loopback.
* The proxy refuses every host but the fixture site and marks its refusals.
"""

from __future__ import annotations

import socket
from collections.abc import Iterator
from dataclasses import dataclass, field

import pytest
from selenium.common.exceptions import TimeoutException, WebDriverException

from harness.firefox import CANARIES, SandboxError, check_sandbox, proxy_prefs
from harness.sgw_site import REFUSAL_MARKER, SGW_HOST, SgwSite

HTTPS_CANARY, HTTP_CANARY = (url for url, _ in CANARIES)
ERROR_PAGE = WebDriverException("Reached error page: about:neterror?e=proxyConnectFailure&u=https%3A//example.invalid/")
REFUSAL_PAGE = f"<html><body><p>{REFUSAL_MARKER}: only the fixture SGW site is reachable</p></body></html>"


@dataclass
class FakeSite:
    refused: list[str] = field(default_factory=list)


@dataclass
class Outcome:
    """What a fake navigation does: optionally log at the proxy, then fail or show a page."""

    logged: bool = True
    error: Exception | None = None
    page: str = ""


class FakeDriver:
    def __init__(self, site: FakeSite, outcomes: dict[str, Outcome]) -> None:
        self.site = site
        self.outcomes = outcomes
        self.page_source = ""
        self.visited: list[str] = []

    def get(self, url: str) -> None:
        self.visited.append(url)
        outcome = self.outcomes[url]
        if outcome.logged:
            self.site.refused.append(dict(CANARIES)[url])
        if outcome.error:
            raise outcome.error
        self.page_source = outcome.page


def sandboxed() -> dict[str, Outcome]:
    """What a correctly proxied Firefox does (observed on Firefox 157)."""
    return {HTTPS_CANARY: Outcome(error=ERROR_PAGE), HTTP_CANARY: Outcome(page=REFUSAL_PAGE)}


def run_check(outcomes: dict[str, Outcome]) -> FakeDriver:
    site = FakeSite()
    driver = FakeDriver(site, outcomes)
    check_sandbox(driver, site)  # type: ignore[arg-type]
    return driver


def test_passes_when_the_proxy_refused_every_canary() -> None:
    driver = run_check(sandboxed())
    assert driver.visited == [HTTPS_CANARY, HTTP_CANARY]


@pytest.mark.parametrize("canary", [HTTPS_CANARY, HTTP_CANARY])
def test_aborts_when_a_canary_bypassed_the_proxy(canary: str) -> None:
    outcomes = sandboxed()
    # Prefs ignored: the request never reached the proxy; .invalid fails DNS instead.
    outcomes[canary] = Outcome(logged=False, error=WebDriverException("Reached error page: about:neterror?e=dnsNotFound"))
    with pytest.raises(SandboxError, match="never reached the E2E proxy"):
        run_check(outcomes)


@pytest.mark.parametrize("canary", [HTTPS_CANARY, HTTP_CANARY])
def test_aborts_when_a_canary_loaded_something_other_than_the_refusal(canary: str) -> None:
    outcomes = sandboxed()
    outcomes[canary] = Outcome(page="<html><body>Example Domain</body></html>")
    with pytest.raises(SandboxError, match="not the proxy's refusal"):
        run_check(outcomes)


def test_fails_closed_on_any_other_navigation_failure() -> None:
    outcomes = sandboxed()
    outcomes[HTTPS_CANARY] = Outcome(error=TimeoutException("page load timed out"))
    with pytest.raises(SandboxError, match="unexpected navigation failure"):
        run_check(outcomes)


def test_proxy_prefs_leave_no_route_around_the_proxy() -> None:
    prefs = proxy_prefs(4321)
    assert prefs["network.proxy.type"] == 1
    assert (prefs["network.proxy.http"], prefs["network.proxy.http_port"]) == ("127.0.0.1", 4321)
    assert (prefs["network.proxy.ssl"], prefs["network.proxy.ssl_port"]) == ("127.0.0.1", 4321)
    assert prefs["network.proxy.failover_direct"] is False
    for host_pref in ("socks", "ftp", "backup.ssl", "autoconfig_url", "no_proxies_on"):
        assert prefs[f"network.proxy.{host_pref}"] == "", host_pref
    for port_pref in ("socks_port", "ftp_port", "backup.ssl_port"):
        assert prefs[f"network.proxy.{port_pref}"] == 0, port_pref
    assert prefs["network.proxy.allow_hijacking_localhost"] is False  # loopback only
    assert prefs["network.trr.mode"] == 5
    assert prefs["network.http.http3.enable"] is False
    assert prefs["media.peerconnection.enabled"] is False


@pytest.fixture
def proxy() -> Iterator[SgwSite]:
    site = SgwSite()
    site.start()
    yield site
    site.stop()


def proxy_request(site: SgwSite, request: str) -> str:
    """Sends one raw request to the proxy and returns its response head and body."""
    with socket.create_connection(("127.0.0.1", site.proxy_port), timeout=5) as conn:
        conn.sendall(request.encode("ascii"))
        data = b""
        while b"\r\n\r\n" not in data and (chunk := conn.recv(4096)):
            data += chunk
        if data.startswith(b"HTTP/1.1 403"):  # a refusal sends `Connection: close` after its body
            while chunk := conn.recv(4096):
                data += chunk
    return data.decode("latin-1")


def test_proxy_refuses_connect_to_any_other_host(proxy: SgwSite) -> None:
    response = proxy_request(proxy, "CONNECT example.invalid:443 HTTP/1.1\r\nHost: example.invalid:443\r\n\r\n")
    assert response.startswith("HTTP/1.1 403")
    assert REFUSAL_MARKER in response
    assert proxy.refused == ["example.invalid:443"]


def test_proxy_refuses_the_fixture_host_on_another_port(proxy: SgwSite) -> None:
    response = proxy_request(proxy, f"CONNECT {SGW_HOST}:8443 HTTP/1.1\r\nHost: {SGW_HOST}:8443\r\n\r\n")
    assert response.startswith("HTTP/1.1 403")
    assert proxy.refused == [f"{SGW_HOST}:8443"]


def test_proxy_refuses_plain_http(proxy: SgwSite) -> None:
    response = proxy_request(proxy, f"GET http://{SGW_HOST}/ HTTP/1.1\r\nHost: {SGW_HOST}\r\n\r\n")
    assert response.startswith("HTTP/1.1 403")
    assert REFUSAL_MARKER in response
    assert proxy.refused == [f"GET http://{SGW_HOST}/"]


def test_proxy_tunnels_only_the_fixture_host(proxy: SgwSite) -> None:
    response = proxy_request(proxy, f"CONNECT {SGW_HOST}:443 HTTP/1.1\r\nHost: {SGW_HOST}:443\r\n\r\n")
    assert response.startswith("HTTP/1.1 200")
    assert proxy.refused == []
