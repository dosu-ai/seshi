"""The client is released at the server's version: scripts/release-version.ts writes both."""

from __future__ import annotations

import json
from importlib.metadata import version
from pathlib import Path

from seshi import __version__

ROOT = Path(__file__).resolve().parents[4]


def test_the_version_is_the_releases() -> None:
    model = json.loads((ROOT / "packages" / "ts" / "model" / "package.json").read_text())
    assert __version__ == model["version"]
    assert version("seshi") == __version__


def test_the_package_carries_the_repositorys_license() -> None:
    here = Path(__file__).resolve().parents[1] / "LICENSE"
    assert here.read_text() == (ROOT / "LICENSE").read_text()
