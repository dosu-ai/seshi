"""Claude Code logs for the live tests: the repository's shared fixture
(`claude-basic.claude-code.jsonl`, which the claude-code adapter's own tests keep current), with
turns added after it so a log passes the server's session filter and says something searchable,
as tests/instance/end-to-end.test.ts does."""

from __future__ import annotations

import json
from pathlib import Path

FIXTURE = (
    Path(__file__).resolve().parents[4]
    / "integrations"
    / "claude-code"
    / "testdata"
    / "transcripts"
    / "claude-basic.claude-code.jsonl"
)
FIRST_ADDED_SECOND = 10
"""The fixture's records end at 00:00:07; added records come after them."""


def record(kind: str, session_id: str, uid: str, at: int, text: str) -> str:
    stamp = f"2026-09-01T00:{at // 60:02d}:{at % 60:02d}.000Z"
    if kind == "user":
        message: dict[str, object] = {"role": "user", "content": text}
    else:
        message = {
            "role": "assistant",
            "model": "claude-x",
            "content": [{"type": "text", "text": text}],
        }
    line = {
        "type": kind,
        "uuid": uid,
        "timestamp": stamp,
        "sessionId": session_id,
        "message": message,
    }
    return json.dumps(line) + "\n"


def transcript(session_id: str, turns: int = 1, start: int = 0, topic: str = "checkout") -> str:
    """The fixture (when `start` is 0) and `turns` prompts and answers after it; with `start`
    above 0, only those turns: what the log gained, for a chunk."""
    lines: list[str] = [FIXTURE.read_text().rstrip("\n") + "\n"] if start == 0 else []
    for n in range(start, start + turns):
        at = FIRST_ADDED_SECOND + 2 * n
        lines.append(record("user", session_id, f"pu{n}", at, f"Why is the {topic} test flaky?"))
        answer = (
            f"The {topic} test races the payment mock. " + "Here is the fix, step by step. " * 80
        )
        lines.append(record("assistant", session_id, f"pa{n}", at + 1, answer))
    return "".join(lines)
