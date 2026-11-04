"""Checks that the installed harness packages are exactly the pinned set.

Every package in the dependency closure of requirements.txt (for this
interpreter and platform, extras included) must be pinned with ``==`` in
requirements.txt or constraints.txt and installed at that version. Run it after

  python -m pip install -r test/e2e/firefox/requirements.txt -c test/e2e/firefox/constraints.txt

Exit code 0 when everything matches, 1 with a list of problems otherwise.
"""

from __future__ import annotations

import importlib.metadata as metadata
import re
import sys
from pathlib import Path

from packaging.requirements import Requirement

HERE = Path(__file__).resolve().parent


def canonical(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def read_pins(path: Path) -> dict[str, str]:
    pins: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        requirement = Requirement(line)
        specifiers = list(requirement.specifier)
        if len(specifiers) != 1 or specifiers[0].operator != "==":
            raise SystemExit(f"{path.name}: {line!r} is not an exact `==` pin")
        pins[canonical(requirement.name)] = specifiers[0].version
    return pins


def closure(roots: list[str]) -> set[str]:
    """Installed distributions reachable from ``roots``; missing ones are kept so they get reported."""
    seen: set[str] = set()
    stack: list[tuple[str, frozenset[str]]] = [(name, frozenset()) for name in roots]
    while stack:
        name, extras = stack.pop()
        key = f"{name}[{','.join(sorted(extras))}]"
        if key in seen:
            continue
        seen.add(key)
        try:
            requires = metadata.requires(name) or []
        except metadata.PackageNotFoundError:
            continue
        for raw in requires:
            requirement = Requirement(raw)
            wanted = requirement.marker is None or any(
                requirement.marker.evaluate({"extra": extra}) for extra in ("", *extras)
            )
            if wanted:
                stack.append((canonical(requirement.name), frozenset(requirement.extras)))
    return {key.split("[", 1)[0] for key in seen}


def main() -> int:
    direct = read_pins(HERE / "requirements.txt")
    constraints = read_pins(HERE / "constraints.txt")
    problems = [
        f"{name}: requirements.txt pins {version}, constraints.txt pins {constraints[name]}"
        for name, version in direct.items()
        if name in constraints and constraints[name] != version
    ]
    pins = {**constraints, **direct}
    for name in sorted(closure(list(direct))):
        try:
            installed = metadata.version(name)
        except metadata.PackageNotFoundError:
            problems.append(f"{name}: required but not installed")
            continue
        pinned = pins.get(name)
        if pinned is None:
            problems.append(f"{name}=={installed}: not pinned in constraints.txt")
        elif installed != pinned:
            problems.append(f"{name}: installed {installed}, pinned {pinned}")
    if problems:
        print("check_pins: the harness environment does not match the pins:", *problems, sep="\n  ")
        return 1
    print(f"check_pins: {len(closure(list(direct)))} packages, all pinned and installed at their pins")
    return 0


if __name__ == "__main__":
    sys.exit(main())
