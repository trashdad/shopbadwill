"""The fake SGW buyerapi (test/fakes/fake-sgw-server, T-04) for Firefox specs.

One Node process per use, on a free loopback port: ``node --import tsx
test/fakes/fake-sgw-server/index.ts`` with ``SBW_FAKE_SGW_PORT=0``. The
extension's background reaches it through ``sbw:test:baseUrl``; Firefox never
proxies loopback, so the E2E sandbox proxy (harness/sgw_site.py) is not in the
way and the background still cannot reach any other host. The control plane
(``/__scenario``, ``/__log``, ``/__token``) is described in the server's
README; this class only wraps it.

Environment: SBW_NODE (the Node binary; default ``node`` on PATH).
"""

from __future__ import annotations

import json
import os
import queue
import re
import shutil
import subprocess
import threading
import time
from typing import Any
from urllib.request import ProxyHandler, Request, build_opener

from .extension import REPO_ROOT

SERVER = REPO_ROOT / "test" / "fakes" / "fake-sgw-server" / "index.ts"
_LISTENING = re.compile(r"fake:sgw listening on (http://127\.0\.0\.1:\d+)")
# The control plane is on loopback: never through an HTTP(S)_PROXY from the environment.
_OPENER = build_opener(ProxyHandler({}))


class FakeSgw:
    """Start with :meth:`start`, stop with :meth:`stop`; :attr:`url` is the buyerapi origin."""

    def __init__(self, process: subprocess.Popen[str], url: str) -> None:
        self._process = process
        self.url = url

    @classmethod
    def start(cls, timeout_s: float = 30) -> FakeSgw:
        node = os.environ.get("SBW_NODE") or shutil.which("node")
        if not node:
            raise RuntimeError("Node is not on PATH; set SBW_NODE to the node binary")
        process = subprocess.Popen(
            [node, "--import", "tsx", str(SERVER)],
            cwd=REPO_ROOT,
            env={**os.environ, "SBW_FAKE_SGW_PORT": "0"},
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        lines: queue.Queue[str] = queue.Queue()

        def pump() -> None:
            # Keep draining the pipe for the server's whole life, so it never blocks on a full buffer.
            assert process.stdout is not None
            for line in process.stdout:
                lines.put(line)

        threading.Thread(target=pump, name="fake-sgw-stdout", daemon=True).start()
        deadline = time.monotonic() + timeout_s
        seen: list[str] = []
        while True:
            if process.poll() is not None or time.monotonic() > deadline:
                process.kill()
                raise RuntimeError(f"the fake SGW server did not start: {''.join(seen)[-2000:]}")
            try:
                line = lines.get(timeout=0.25)
            except queue.Empty:
                continue
            seen.append(line)
            match = _LISTENING.search(line)
            if match:
                return cls(process, match.group(1))

    def stop(self) -> None:
        self._process.terminate()
        try:
            self._process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self._process.kill()
            self._process.wait(timeout=10)

    def _call(self, method: str, path: str, body: Any = None) -> Any:
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = Request(self.url + path, data=data, method=method, headers={"content-type": "application/json"})
        with _OPENER.open(request, timeout=10) as response:
            text = response.read().decode("utf-8")
        return json.loads(text) if text else None

    def scenario(self, patch: dict[str, Any]) -> Any:
        """POST /__scenario: reset, clock (skewMs, followFakeNow), latencyMs, errors, bidding."""
        return self._call("POST", "/__scenario", patch)

    def log(self) -> list[dict[str, Any]]:
        """Every logged request (control routes are never logged)."""
        return list(self._call("GET", "/__log")["entries"])

    def clear_log(self) -> None:
        self._call("DELETE", "/__log")

    def mint_token(self) -> dict[str, Any]:
        """A bearer the fake accepts: ``{accessToken, expiresAtMs}``."""
        return dict(self._call("POST", "/__token", {}))
