"""Claude Code logs for the live tests, long enough to pass the server's session filter."""

from __future__ import annotations

import json


def record(kind: str, session_id: str, uid: str, at: int, text: str) -> str:
    stamp = f"2026-09-01T00:00:{at:02d}.000Z"
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
        "cwd": "/work/widget",
        "message": message,
    }
    return json.dumps(line) + "\n"


def transcript(session_id: str, turns: int = 1, start: int = 0, topic: str = "checkout") -> str:
    """A Claude Code log: `turns` prompts and answers, long enough to pass the session filter."""
    lines: list[str] = []
    for n in range(start, start + turns):
        lines.append(record("user", session_id, f"u{n}", 2 * n, f"Why is the {topic} test flaky?"))
        answer = (
            f"The {topic} test races the payment mock. " + "Here is the fix, step by step. " * 80
        )
        lines.append(record("assistant", session_id, f"a{n}", 2 * n + 1, answer))
    return "".join(lines)
