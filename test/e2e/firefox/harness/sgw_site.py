"""The fixture SGW site: T-12's static pages, served as https://shopgoodwill.com/.

This is the S-6 "hostname override". Firefox sends every http and https request
to this local proxy. A CONNECT to ``shopgoodwill.com:443`` is answered here: the
proxy terminates TLS with a throwaway self-signed certificate (Firefox runs with
``acceptInsecureCerts``) and serves files from ``fixtures/sgw/``. Every other
CONNECT, and every plain-HTTP proxy request, gets 403.

The proxy never opens an outbound connection, so the browser cannot reach the
real shopgoodwill.com, or any other internet host, during a test. Firefox does
not proxy loopback, so the fake SGW buyerapi (``pnpm fake:sgw`` on 127.0.0.1)
stays directly reachable.

The extension's manifest is exactly the production one plus the test build's
``http://127.0.0.1/*`` host: the content script matches the real hostname.
"""

from __future__ import annotations

import datetime
import mimetypes
import ssl
import tempfile
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socket import socket
from typing import Any
from urllib.parse import unquote, urlsplit

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

SGW_HOST = "shopgoodwill.com"
FIXTURES = Path(__file__).resolve().parent.parent / "fixtures" / "sgw"
SOCKET_TIMEOUT_S = 30
# In the body of every 403 the proxy sends, so the sandbox canary can tell the
# proxy's refusal from a page served by anything else.
REFUSAL_MARKER = "sbw-e2e-proxy-refused"


@dataclass(frozen=True)
class SiteRequest:
    """One request the fixture site answered (after TLS termination)."""

    method: str
    host: str
    path: str
    status: int


def _tls_context(hostname: str) -> ssl.SSLContext:
    """A server context with a fresh self-signed EC certificate for ``hostname``."""
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, hostname)])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(hours=1))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(hostname)]), critical=False)
        .sign(key, hashes.SHA256())
    )
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.set_alpn_protocols(["http/1.1"])
    # load_cert_chain only reads files; the key never outlives this call on disk.
    with tempfile.TemporaryDirectory(prefix="sbw-sgw-site-") as tmp:
        cert_file, key_file = Path(tmp, "cert.pem"), Path(tmp, "key.pem")
        cert_file.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        key_file.write_bytes(
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        context.load_cert_chain(cert_file, key_file)
    return context


def _resolve(root: Path, url_path: str) -> Path | None:
    """The fixture file for ``url_path`` (``/`` and ``/dir/`` map to index.html), or None."""
    relative = unquote(urlsplit(url_path).path).lstrip("/")
    if relative == "" or relative.endswith("/"):
        relative += "index.html"
    candidate = (root / relative).resolve()
    if not candidate.is_relative_to(root) or not candidate.is_file():
        return None
    return candidate


class SgwSite:
    """Start with :meth:`start`, point Firefox at :attr:`proxy_port`, stop with :meth:`stop`."""

    def __init__(self, root: Path = FIXTURES, host: str = SGW_HOST) -> None:
        self.root = root.resolve()
        self.host = host
        self.requests: list[SiteRequest] = []
        self.refused: list[str] = []
        self._lock = threading.Lock()
        self._tls = _tls_context(host)
        self._server: ThreadingHTTPServer | None = None

    @property
    def proxy_port(self) -> int:
        if self._server is None:
            raise RuntimeError("SgwSite is not started")
        return int(self._server.server_address[1])

    def url(self, path: str = "/") -> str:
        return f"https://{self.host}{path}"

    def start(self) -> None:
        site = self

        class Proxy(_ProxyHandler):
            pass

        Proxy.site = site
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
        self._server.daemon_threads = True
        threading.Thread(target=self._server.serve_forever, name="sgw-site", daemon=True).start()

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None

    def _record(self, request: SiteRequest) -> None:
        with self._lock:
            self.requests.append(request)

    def _refuse(self, target: str) -> None:
        with self._lock:
            self.refused.append(target)


class _ProxyHandler(BaseHTTPRequestHandler):
    """The proxy side: CONNECT to the fixture host is served locally, the rest refused."""

    site: SgwSite
    protocol_version = "HTTP/1.1"

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(SOCKET_TIMEOUT_S)

    def do_CONNECT(self) -> None:  # noqa: N802 (http.server naming)
        host, _, port = self.path.partition(":")
        if host != self.site.host or port not in ("", "443"):
            self._forbid(self.path)
            return
        self.send_response(200, "Connection Established")
        self.end_headers()
        self.close_connection = True
        try:
            tls = self.site._tls.wrap_socket(self.connection, server_side=True)
        except (ssl.SSLError, OSError):
            return  # the browser gave up on the handshake
        _FixtureHandler(tls, self.client_address, self.server, self.site)

    def _refuse_plain(self) -> None:
        self._forbid(f"{self.command} {self.path}")

    def _forbid(self, target: str) -> None:
        self.site._refuse(target)
        self.send_error(
            403,
            "Forbidden by the E2E sandbox",
            f"{REFUSAL_MARKER}: only the fixture SGW site ({self.site.host}) is reachable in E2E tests",
        )

    do_GET = do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = _refuse_plain

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        pass


class _FixtureHandler(BaseHTTPRequestHandler):
    """The site side, inside the TLS tunnel: static files from the fixture root."""

    protocol_version = "HTTP/1.1"

    def __init__(self, request: socket, client_address: Any, server: Any, site: SgwSite) -> None:
        self.site = site
        super().__init__(request, client_address, server)

    def do_GET(self) -> None:  # noqa: N802
        self._serve(send_body=True)

    def do_HEAD(self) -> None:  # noqa: N802
        self._serve(send_body=False)

    def _serve(self, send_body: bool) -> None:
        file = _resolve(self.site.root, self.path)
        status = 200 if file else 404
        self.site._record(SiteRequest(self.command, self.site.host, urlsplit(self.path).path, status))
        body = file.read_bytes() if file else b"Not found in the fixture SGW site\n"
        content_type = (mimetypes.guess_type(file.name)[0] if file else None) or "text/plain"
        if content_type.startswith("text/") or content_type == "application/javascript":
            content_type += "; charset=utf-8"
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if send_body:
            self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        pass
