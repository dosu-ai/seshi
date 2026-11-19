"""A real seshi server for test_live.py, started from this repository (`seshi serve` on a folder
store), and the async test backend.

The server runs from source with Bun (`bun run apps/seshi/src/main.ts`), or from a built binary
named by `TEST_SESHI_BIN`. Without Bun the live tests are skipped, except under CI, where they
fail instead.
"""

from __future__ import annotations

import os
import re
import shutil
import socket
import subprocess
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from subprocess import Popen

import httpx
import pytest

from seshi import SeshiClient, Upload

from .transcripts import transcript

ROOT = Path(__file__).resolve().parents[4]
"""The seshi repository: packages/py/client/tests/ is four folders down."""

ALICE = "alice-token-0123456789abcdef"
BOB = "bob-token-0123456789abcdef"
PACK = """id = "py-client"
[[rules]]
id = "py-secret"
pattern = 'PYSECRET-[0-9]{6}'
tests.match = ["deploy with PYSECRET-271828"]
tests.no_match = ["PYSECRET-12"]
"""


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@dataclass(frozen=True)
class LiveServer:
    url: str
    admin_token: str
    org_key: str
    alice: str
    bob: str
    config: Path
    pack: Path
    seed_session: str
    """A session alice stored before the server last started."""


def _command() -> list[str] | None:
    binary = os.environ.get("TEST_SESHI_BIN")
    if binary:
        return [binary]
    bun = shutil.which("bun")
    if bun is None:
        return None
    return [bun, "run", str(ROOT / "apps" / "seshi" / "src" / "main.ts")]


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port: int = sock.getsockname()[1]
        return port


def _env(home: Path) -> dict[str, str]:
    """The test runner's environment without any SESHI_* setting (the server refuses to start
    on one it does not know), and with a home and cache of its own."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("SESHI_")}
    env.update(
        HOME=str(home),
        XDG_CONFIG_HOME=str(home / "config"),
        XDG_STATE_HOME=str(home / "state"),
        XDG_CACHE_HOME=str(home / "cache"),
        NO_COLOR="1",
    )
    return env


@pytest.fixture(scope="session")
def live_server(tmp_path_factory: pytest.TempPathFactory) -> Iterator[LiveServer]:
    command = _command()
    if command is None:
        if os.environ.get("CI"):
            pytest.fail("the live tests need bun (or TEST_SESHI_BIN) on CI")
        pytest.skip("no bun on PATH and no TEST_SESHI_BIN: cannot start a seshi server")

    work = tmp_path_factory.mktemp("seshi")
    home = work / "home"
    home.mkdir()
    pack = work / "pack.toml"
    pack.write_text(PACK)
    port = _free_port()
    config = work / "seshi.toml"
    config.write_text(
        "\n".join(
            [
                "[server]",
                f'listen = "127.0.0.1:{port}"',
                "[store]",
                f'url = "{(work / "store").as_uri()}"',
                "[auth.tokens]",
                f'alice = "{ALICE}"',
                f'bob = "{BOB}"',
                "[search]",
                'path = ":memory:"',
                'interval = "1s"',
                "[redaction]",
                f"packs = ['{pack}']",
                "",
            ]
        )
    )
    config.chmod(0o600)
    env = _env(home)

    init = subprocess.run(
        [*command, "admin", "init", "--config", str(config)],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    if init.returncode != 0:
        pytest.fail(f"seshi admin init failed ({init.returncode}):\n{init.stdout}\n{init.stderr}")
    tokens = re.findall(r"^\s+(seshi_\S+)$", init.stdout, flags=re.MULTILINE)
    if len(tokens) != 2:
        pytest.fail(f"seshi admin init printed no admin token and org key:\n{init.stdout}")
    admin_token, org_key = tokens

    url = f"http://127.0.0.1:{port}"
    log = work / "serve.log"
    server = _serve(command, config, env, url, log)
    # Every owner's change feed serves entries stamped before the search indexer listed the
    # owners, which it does when it starts and then once a minute. A session stored before a
    # restart is there at once; one stored after waits up to that minute.
    seed = "seed-" + uuid.uuid4().hex
    with SeshiClient(url, ALICE) as alice:
        alice.ingest(Upload(agent="claude-code", session_id=seed, transcript=transcript(seed)))
    _stop(server)
    server = _serve(command, config, env, url, log)
    try:
        yield LiveServer(url, admin_token, org_key, ALICE, BOB, config, pack, seed)
    finally:
        _stop(server)


def _serve(
    command: list[str], config: Path, env: dict[str, str], url: str, log: Path
) -> Popen[bytes]:
    with log.open("a") as out:
        server = subprocess.Popen(
            [*command, "serve", "--config", str(config)],
            cwd=ROOT,
            env=env,
            stdout=out,
            stderr=subprocess.STDOUT,
        )
    deadline = time.monotonic() + 60
    while True:
        try:
            if httpx.get(f"{url}/healthz", timeout=2).is_success:
                return server
        except httpx.TransportError:
            pass
        if server.poll() is not None or time.monotonic() > deadline:
            _stop(server)
            pytest.fail(f"seshi serve did not come up:\n{log.read_text()}")
        time.sleep(0.2)


def _stop(server: Popen[bytes]) -> None:
    server.terminate()
    try:
        server.wait(timeout=10)
    except subprocess.TimeoutExpired:
        server.kill()
        server.wait()
