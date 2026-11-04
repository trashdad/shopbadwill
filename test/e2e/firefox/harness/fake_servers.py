"""The local fake servers the Chromium E2E uses, started as child processes for Firefox.

* :data:`FAKE_SGW`: the fake buyerapi (``test/fakes/fake-sgw-server``, ``pnpm fake:sgw``).
* :data:`FAKE_SITE`: the fake SGW search page (``scripts/serve-fake-site.ts``): the
  sanitized fixture HTML with a small script that sends the site's search XHR to
  ``https://buyerapi.shopgoodwill.com`` and renders the rows as the site's cards.

Each listens on a free port on 127.0.0.1 (port 0; the URL is read from the line
the script prints). The browser reaches them through the fixture site's proxy
routes (harness/sgw_site.py) or, for the background's requests rewritten by
``sbw:test:baseUrl``, directly on loopback. The harness talks to their control
planes with a proxy-free opener, so not even a system proxy sees that traffic.
"""

from __future__ import annotations

import datetime
import json
import os
import queue
import re
import shutil
import subprocess
import threading
from dataclasses import dataclass
from types import TracebackType
from typing import Any
from urllib import request as urlrequest

from .extension import REPO_ROOT

START_TIMEOUT_S = 60
STOP_TIMEOUT_S = 10
# The fixture seeds end in October 2026: Pacific Daylight Time (the fake site's own rows assume it too).
_PDT = datetime.timezone(datetime.timedelta(hours=-7), "PDT")
_LISTENING = re.compile(r"listening on (http://127\.0\.0\.1:(\d+))")
# Never through a proxy: the fakes are on loopback.
_OPENER = urlrequest.build_opener(urlrequest.ProxyHandler({}))


@dataclass(frozen=True)
class FakeScript:
    name: str
    script: str  # relative to the repo root
    port_env: str


FAKE_SGW = FakeScript("fake:sgw", "test/fakes/fake-sgw-server/index.ts", "SBW_FAKE_SGW_PORT")
FAKE_SITE = FakeScript("serve-fake-site", "scripts/serve-fake-site.ts", "SBW_FAKE_SITE_PORT")


def pdt_epoch_ms(naive: str) -> int:
    """Epoch ms of a naive Pacific wall time in the PDT season (``2026-10-08T00:00:00``)."""
    return int(datetime.datetime.fromisoformat(naive).replace(tzinfo=_PDT).timestamp() * 1000)


def _node() -> str:
    node = shutil.which("node")
    if node is None:
        raise FileNotFoundError("node is not on PATH (the fake servers are TypeScript run through tsx)")
    return node


class FakeServer:
    """One fake server process. Use as a context manager, or :meth:`start` / :meth:`stop`."""

    def __init__(self, spec: FakeScript) -> None:
        self.spec = spec
        self.url = ""
        self.port = 0
        self.output: list[str] = []
        self._proc: subprocess.Popen[str] | None = None

    def start(self) -> FakeServer:
        # One process (node itself, with tsx as an import hook), so stop() leaves no orphan.
        self._proc = subprocess.Popen(
            [_node(), "--import", "tsx", self.spec.script],
            cwd=REPO_ROOT,
            env={**os.environ, self.spec.port_env: "0"},
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        lines: queue.Queue[str | None] = queue.Queue()

        def pump(stream: Any) -> None:  # keeps draining after startup, so the pipe never fills
            for line in stream:
                self.output.append(line.rstrip())
                lines.put(line)
            lines.put(None)  # the process closed its output

        threading.Thread(target=pump, args=(self._proc.stdout,), name=self.spec.name, daemon=True).start()
        while True:
            try:
                line = lines.get(timeout=START_TIMEOUT_S)
            except queue.Empty:
                self.stop()
                raise RuntimeError(f"{self.spec.name} did not report its port within {START_TIMEOUT_S} s") from None
            if line is None:
                self.stop()
                raise RuntimeError(f"{self.spec.name} exited before listening:\n" + "\n".join(self.output))
            match = _LISTENING.search(line)
            if match:
                self.url, self.port = match.group(1), int(match.group(2))
                return self

    def stop(self) -> None:
        proc, self._proc = self._proc, None
        if proc is None or proc.poll() is not None:
            return
        proc.terminate()
        try:
            proc.wait(timeout=STOP_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=STOP_TIMEOUT_S)

    def __enter__(self) -> FakeServer:
        return self.start()

    def __exit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None
    ) -> None:
        self.stop()

    def call(self, method: str, path: str, body: Any = None) -> Any:
        """A JSON request to the server's own (control) endpoints; returns the parsed reply."""
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urlrequest.Request(f"{self.url}{path}", data=data, method=method)
        if data is not None:
            req.add_header("content-type", "application/json")
        with _OPENER.open(req, timeout=10) as response:
            text = response.read().decode("utf-8")
        return json.loads(text) if text else None
