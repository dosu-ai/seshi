"""The client over a fake server that answers by route: what each call sends, and how each
answer comes back. The calls against a real server are in test_live.py."""

from __future__ import annotations

import gzip
import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
import pytest

from seshi import (
    AsyncSeshiClient,
    Forbidden,
    NotWritten,
    OffsetMismatch,
    ServerError,
    SeshiClient,
    SessionConflict,
    SessionRejected,
    Stored,
    StoreError,
    TokenInfo,
    Trace,
    Upload,
    __version__,
    auth_config,
    exchange_id_token,
    rfc3339,
)
from seshi.models import LettaTrace, OtlpTrace

SERVER = "https://seshi.example.com"
SHA = "0" * 64
WHOLE = {"records_total": 3, "prefix_sha256": SHA, "bytes_total": 120}
STORED = {
    "status": "stored",
    "archive_id": SHA,
    "content_hash": SHA,
    "session_id": "s",
    "records": 3,
    "events": 2,
    **WHOLE,
}
WRITER = {"kind": "static", "principal": "alice", "source_id": "upload"}
META = {
    "schema": "seshi/metadata/1",
    "owner": "bob",
    "archive_id": SHA,
    "session_id": "s",
    "format": "claude-code",
    "status": "stored",
    "head": SHA,
    "traces": [{"content_hash": SHA, "created_at": "2026-11-14T09:00:00.000Z", "records": 3}],
    "writer": WRITER,
    "owner_basis": "verified",
    "visibility": "org",
    "created_at": "2026-11-14T09:00:00.000Z",
    "updated_at": "2026-11-14T09:00:00.000Z",
}
TRACE = {
    "schema": "seshi/trace/1",
    "content_hash": SHA,
    "source": "claude-code",
    "format": "claude-code",
    "session_id": "s",
    "started_at": None,
    "ended_at": None,
    "records": [
        {"role": "meta", "source": "claude-code"},
        {"role": "user", "content": "hi", "timestamp": "2026-11-14T09:00:00.000Z"},
        {"role": "assistant", "content": None, "timestamp": "t", "tool_calls": []},
        {"role": "tool", "tool_call_id": "c1", "content": "ok", "timestamp": "t"},
    ],
    "events": [{"index": 0, "role": "user", "text": "hi", "timestamp": None}],
    "metadata": {"cwd": "/w", "anything": "kept"},
}
TOKEN = {
    "schema": "seshi/token/1",
    "id": "abc",
    "kind": "device",
    "owner": "alice",
    "scopes": ["sessions:write"],
    "created_at": "2026-11-14T09:00:00.000Z",
    "expires_at": None,
    "revoked": False,
}
CHANGE = {
    "schema": "seshi/change/1",
    "kind": "published",
    "at": "2026-11-14T09:00:00.000Z",
    "owner": "alice",
    "archive_id": SHA,
    "session_id": "s",
    "format": "claude-code",
    "content_hash": SHA,
    "writer": WRITER,
}
RULES = {
    "schema": "seshi/redaction-rules/1",
    "rule_set": SHA,
    "builtin": "seshi/rules/3",
    "packs": [],
}
RELOAD = {
    "trigger": "api",
    "started_at": "t",
    "finished_at": "t",
    "outcome": "rejected",
    "generation": 1,
    "config_hash": "h",
    "rule_set": SHA,
    "review_set": None,
    "errors": ["bad pack"],
    "changed": [],
    "restart_required": [],
}
CONFIG = {
    "generation": 1,
    "config_hash": "h",
    "rule_set": SHA,
    "review_set": None,
    "loaded_at": "t",
    "reloadable": True,
    "restart_required": [],
    "last_reload": None,
    "live_sections": ["sources"],
    "restart_only_sections": ["server"],
}


def error(code: str, message: str = "no", **extra: Any) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, **extra}}


Reply = tuple[int, Any] | Callable[[httpx.Request], httpx.Response]


@dataclass
class Fake:
    """A server that answers `routes["GET /v1/x"]` with its status and JSON body (or calls it);
    anything else is 404 `not_found`. Keeps every request it saw."""

    routes: dict[str, Reply] = field(default_factory=dict)
    seen: list[httpx.Request] = field(default_factory=list)

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(request)
        reply = self.routes.get(f"{request.method} {request.url.raw_path.decode().split('?')[0]}")
        if reply is None:
            return httpx.Response(404, json=error("not_found"))
        if callable(reply):
            return reply(request)
        status, body = reply
        return httpx.Response(status, json=body)

    def client(self, token: str | None = "tok", **options: Any) -> SeshiClient:
        return SeshiClient(SERVER, token, transport=httpx.MockTransport(self.handle), **options)

    @property
    def last(self) -> httpx.Request:
        return self.seen[-1]


def sent(request: httpx.Request) -> Any:
    body = request.content
    if request.headers.get("content-encoding") == "gzip":
        body = gzip.decompress(body)
    return json.loads(body)


def param(request: httpx.Request, name: str) -> str | None:
    value: str | None = request.url.params.get(name)
    return value


def upload(**fields: Any) -> Upload:
    return Upload.model_validate(
        {"format": "claude-code", "session_id": "s", "transcript": "{}\n", **fields}
    )


class TestRequests:
    def test_sends_the_token_and_its_user_agent(self) -> None:
        fake = Fake(
            {
                "GET /v1/me": (200, {"owner": "alice"}),
                "GET /v1/owners": (200, {"owners": [], "truncated": False}),
            }
        )
        with pytest.raises(ValueError, match="validation"):
            fake.client().me()  # not an Identity: the answer is checked
        assert fake.last.headers["authorization"] == "Bearer tok"
        assert fake.last.headers["user-agent"] == f"seshi-python/{__version__}"
        assert "x-seshi-user" not in fake.last.headers
        fake.client(user_agent="dosu-cli/0.68.5").owners()
        assert fake.last.headers["user-agent"] == "dosu-cli/0.68.5"

    def test_sends_x_seshi_user_with_the_org_key(self) -> None:
        fake = Fake({"GET /v1/owners": (200, {"owners": ["alice"], "truncated": False})})
        page = fake.client(user="alice").owners(limit=5)
        assert page.owners == ["alice"]
        assert fake.last.headers["x-seshi-user"] == "alice"
        assert param(fake.last, "limit") == "5"

    def test_encodes_the_session_path_and_leaves_out_absent_query_values(self) -> None:
        fake = Fake()
        assert fake.client().get_session("claude-code", "a/b c") is None
        assert fake.last.url.raw_path == b"/v1/sessions/claude-code/a%2Fb%20c"
        assert fake.last.url.query == b""

    def test_strips_a_trailing_slash_from_the_server(self) -> None:
        fake = Fake()
        client = SeshiClient(f"{SERVER}//", "t", transport=httpx.MockTransport(fake.handle))
        client.get_session("a", "b")
        assert str(fake.last.url) == f"{SERVER}/v1/sessions/a/b"

    def test_sends_owner_on_reads_deletes_and_visibility_changes(self) -> None:
        path = "/v1/sessions/claude-code/s"
        fake = Fake(
            {
                f"GET {path}": (200, META),
                f"GET {path}/trace": (200, TRACE),
                f"DELETE {path}": (200, {"removed": 2}),
                f"PATCH {path}": (200, {**META, "visibility": "owner"}),
                f"GET {path}/reviews": (200, {"reviews": []}),
            }
        )
        db = fake.client()
        meta = db.get_session("claude-code", "s", owner="bob")
        assert meta is not None and meta.owner == "bob" and meta.schema_ == "seshi/metadata/1"
        trace = db.get_trace("claude-code", "s", owner="bob")
        assert isinstance(trace, Trace) and trace.metadata.model_extra == {"anything": "kept"}
        removed = db.tombstone("claude-code", "s", owner="bob")
        assert removed is not None and removed.removed == 2
        changed = db.set_visibility("claude-code", "s", "owner", owner="bob")
        assert changed is not None and changed.visibility == "owner"
        assert db.reviews("claude-code", "s", owner="bob") == []
        assert [param(r, "owner") for r in fake.seen] == ["bob"] * 5
        assert fake.seen[3].method == "PATCH" and sent(fake.seen[3]) == {"visibility": "owner"}

    def test_reads_a_session_by_owner_and_archive_id(self) -> None:
        base = f"/v1/owners/svc%3Aci/sessions/{SHA}"
        fake = Fake(
            {
                f"GET {base}": (200, META),
                f"GET {base}/trace": (200, TRACE),
                f"GET {base}/reviews": (200, {"reviews": []}),
            }
        )
        db = fake.client()
        got = db.get_session_by_archive("svc:ci", SHA)
        assert got is not None and got.format == "claude-code"
        trace = db.get_trace_by_archive("svc:ci", SHA, render="seshi", hash=SHA)
        assert isinstance(trace, Trace)
        assert param(fake.last, "render") == "seshi" and param(fake.last, "hash") == SHA
        assert db.reviews_by_archive("svc:ci", SHA) == []

    def test_asks_for_a_rendering_and_reads_it_as_that_type(self) -> None:
        # The Letta rendering names the format `agent`.
        letta = {**TRACE, "schema": "sessionstorage/trace/1", "agent": TRACE["format"]}
        del letta["format"]
        otlp = {"resourceSpans": [{"resource": {"attributes": []}, "scopeSpans": []}]}
        replies = iter([(200, letta), (200, otlp)])

        def answer(_: httpx.Request) -> httpx.Response:
            status, body = next(replies)
            return httpx.Response(status, json=body)

        fake = Fake({"GET /v1/sessions/a/s/trace": answer})
        db = fake.client()
        assert isinstance(db.get_trace("a", "s", render="letta", hash=SHA), LettaTrace)
        assert param(fake.last, "render") == "letta" and param(fake.last, "hash") == SHA
        rendered = db.get_trace("a", "s", render="otlp")
        assert isinstance(rendered, OtlpTrace)
        assert rendered.model_dump(by_alias=True, exclude_none=True) == otlp

    def test_gzips_a_body_from_gzip_from(self) -> None:
        fake = Fake({"POST /v1/sessions": (201, STORED)})
        fake.client(gzip_from=64).ingest(upload(transcript="x" * 200))
        assert fake.last.headers["content-encoding"] == "gzip"
        assert sent(fake.last)["transcript"] == "x" * 200
        fake.client().ingest(upload())
        assert "content-encoding" not in fake.last.headers

    def test_sends_a_retraction_secret_in_x_seshi_retract_never_the_body(self) -> None:
        fake = Fake(
            {
                "POST /v1/sessions": (201, STORED),
                "DELETE /v1/sessions/claude-code/s": (200, {"removed": 1}),
            }
        )
        db = fake.client()
        db.ingest(upload(replace=True), retract_secret="s3cret", idempotency_key="k1")
        assert fake.last.headers["x-seshi-retract"] == "s3cret"
        assert fake.last.headers["idempotency-key"] == "k1"
        assert sent(fake.last) == {
            "format": "claude-code",
            "session_id": "s",
            "transcript": "{}\n",
            "replace": True,
        }
        db.tombstone("claude-code", "s", retract_secret="s3cret")
        assert fake.last.headers["x-seshi-retract"] == "s3cret"

    def test_takes_an_upload_as_a_mapping_and_refuses_a_field_it_does_not_know(self) -> None:
        fake = Fake({"POST /v1/sessions": (200, {"status": "unchanged", **WHOLE})})
        db = fake.client()
        answer = db.ingest({"format": "codex", "session_id": "s", "transcript": "x", "offset": 4})
        assert isinstance(answer, NotWritten) and answer.bytes_total == 120
        with pytest.raises(ValueError, match="extra"):
            db.ingest({"format": "codex", "session_id": "s", "transcript": "x", "ofset": 4})
        with pytest.raises(ValueError, match="format"):
            db.ingest({"format": 7, "session_id": "s", "transcript": "x"})

    def test_reads_a_stored_answer(self) -> None:
        fake = Fake({"POST /v1/sessions": (201, STORED)})
        answer = fake.client().ingest(upload())
        assert isinstance(answer, Stored) and answer.content_hash == SHA

    def test_sends_times_as_seshi_writes_them(self) -> None:
        fake = Fake({"GET /v1/changes": (200, {"entries": [], "truncated": False})})
        at = datetime(2026, 11, 14, 10, 0, 0, 123456, tzinfo=timezone(timedelta(hours=1)))
        fake.client().changes(since=at, limit=10, owner="bob")
        assert param(fake.last, "since") == "2026-11-14T09:00:00.123Z"
        assert param(fake.last, "owner") == "bob"
        assert rfc3339(datetime(2026, 1, 2, 3, 4, 5)) == "2026-01-02T03:04:05.000Z"

    def test_searches_with_every_filter(self) -> None:
        results = {
            "query": "q",
            "total": 0,
            "results": [],
            "index": {"ready_at": "t", "sessions": 0},
        }
        fake = Fake({"GET /v1/search": (200, results)})
        fake.client().search(
            "flaky test",
            repo="widget",
            role=["tool_result", "observation"],
            sort="recent",
            limit=5,
            matches=0,
            until=datetime(2026, 11, 14, tzinfo=timezone.utc),
        )
        assert dict(fake.last.url.params) == {
            "q": "flaky test",
            "repo": "widget",
            "role": "tool_result,observation",
            "sort": "recent",
            "limit": "5",
            "matches": "0",
            "until": "2026-11-14T00:00:00.000Z",
        }

    def test_runs_sql_and_reads_the_rows(self) -> None:
        answer = {
            "now": "2026-11-25T12:00:00.000Z",
            "scope": {"as": "ops", "role": "admin", "since": "a", "until": "b"},
            "index": {"backend": "sqlite", "dialect": "sqlite"},
            "columns": [{"name": "owner", "type": "TEXT"}, {"name": "n", "type": "INTEGER"}],
            "rows": [["alice", 3]],
            "truncated": False,
            "elapsed_ms": 4,
        }
        fake = Fake({"POST /v1/sql": (200, answer)})
        result = fake.client().sql(
            "SELECT owner, count(*) AS n FROM sessions GROUP BY 1",
            since=datetime(2026, 11, 1, tzinfo=timezone.utc),
            max_rows=10,
        )
        assert sent(fake.last) == {
            "sql": "SELECT owner, count(*) AS n FROM sessions GROUP BY 1",
            "since": "2026-11-01T00:00:00.000Z",
            "max_rows": 10,
        }
        assert result.scope.as_ == "ops"
        assert [c.name for c in result.columns] == ["owner", "n"]
        assert result.rows == [["alice", 3]]

    def test_a_refused_sql_statement_says_where(self) -> None:
        refusal = {
            "error": {"code": "sql_refused", "message": "table meta is not allowed", "at": 14}
        }
        fake = Fake({"POST /v1/sql": (400, refusal)})
        with pytest.raises(ServerError) as raised:
            fake.client().sql("SELECT * FROM meta")
        assert (raised.value.status, raised.value.code, raised.value.at) == (400, "sql_refused", 14)

    def test_reads_the_sql_schema(self) -> None:
        schema = {
            "dialect": "sqlite",
            "hint": "SQLite: …",
            "ddl": "CREATE VIEW sessions (…);",
            "examples": ["SELECT 1"],
            "scope": {"as": "ops", "role": "admin", "since": "a", "until": "b"},
            "index": {"backend": "sqlite", "dialect": "sqlite"},
            "limits": {
                "max_rows": 1000,
                "max_bytes": 1048576,
                "timeout_ms": 15000,
                "max_sql_bytes": 16384,
            },
        }
        fake = Fake({"GET /v1/sql/schema": (200, schema)})
        got = fake.client().sql_schema(since="7d")
        assert param(fake.last, "since") == "7d"
        assert got.dialect == "sqlite" and got.limits.max_rows == 1000

    def test_searches_by_labels_each_as_key_value(self) -> None:
        results = {
            "query": "q",
            "total": 0,
            "results": [],
            "index": {"ready_at": "t", "sessions": 0},
        }
        fake = Fake({"GET /v1/search": (200, results)})
        fake.client().search(
            "flaky", labels={"dosu.project": "github.com/acme/billing", "team": "platform"}
        )
        assert fake.last.url.params.get_list("label") == [
            "dosu.project=github.com/acme/billing",
            "team=platform",
        ]

    def test_reads_labels_on_sessions_traces_and_search_results(self) -> None:
        labels = {"dosu.project": "github.com/acme/billing"}
        path = "/v1/sessions/claude-code/s"
        hit = {
            "owner": "bob",
            "agent": "claude-code",
            "session_id": "s",
            "archive_id": SHA,
            "labels": labels,
            "visibility": "org",
            "updated_at": "t",
            "score": 1.0,
            "hits": 1,
            "matches": [],
        }
        results = {
            "query": "q",
            "total": 1,
            "results": [hit],
            "index": {"ready_at": "t", "sessions": 1},
        }
        fake = Fake(
            {
                f"GET {path}": (200, {**META, "labels": labels}),
                f"GET {path}/trace": (200, {**TRACE, "metadata": {"labels": labels}}),
                "GET /v1/search": (200, results),
                "POST /v1/sessions": (201, STORED),
            }
        )
        db = fake.client()
        meta = db.get_session("claude-code", "s")
        assert meta is not None and meta.labels == labels
        trace = db.get_trace("claude-code", "s")
        assert isinstance(trace, Trace) and trace.metadata.labels == labels
        assert db.search("q").results[0].labels == labels
        db.ingest(upload(labels=labels))
        assert sent(fake.last)["labels"] == labels


class TestRefusals:
    @pytest.mark.parametrize(
        ("status", "body", "kind", "attrs"),
        [
            (409, error("offset_mismatch", expected=40), OffsetMismatch, {"expected": 40}),
            (409, error("conflict"), SessionConflict, {"code": "conflict"}),
            (403, error("forbidden"), Forbidden, {"code": "forbidden"}),
            (422, error("too_large", "big"), SessionRejected, {"code": "too_large"}),
            (502, error("storage_error"), StoreError, {}),
            (401, error("unauthorized"), ServerError, {"status": 401, "code": "unauthorized"}),
            (400, error("bad_field"), ServerError, {"status": 400, "code": "bad_field"}),
            (500, None, ServerError, {"status": 500, "code": "unknown", "message": "HTTP 500"}),
        ],
    )
    def test_turns_refusals_into_the_pipelines_errors(
        self, status: int, body: Any, kind: type[Exception], attrs: dict[str, Any]
    ) -> None:
        fake = Fake({"POST /v1/sessions": (status, body)})
        with pytest.raises(kind) as raised:
            fake.client().ingest(upload(offset=12))
        for name, value in attrs.items():
            assert getattr(raised.value, name) == value
        if isinstance(raised.value, OffsetMismatch):
            assert raised.value.offset == 12

    def test_is_none_for_what_is_not_there(self) -> None:
        unknown = (404, error("unknown_source"))
        fake = Fake(
            {
                "GET /v1/sessions/a/gone/trace": (410, error("redacted")),
                "GET /v1/admin/sources/zz": unknown,
                "GET /v1/admin/sources/zz/dropped": unknown,
            }
        )
        db = fake.client()
        assert db.get_trace("a", "nope") is None
        assert db.get_trace("a", "gone") is None
        assert db.tombstone("a", "nope") is None
        assert db.set_visibility("a", "nope", "org") is None
        assert db.reviews("a", "nope") is None
        assert db.revoke_token("nope") is None
        assert db.source("zz") is None
        assert db.records("dropped", "zz") is None
        # An older server without the route: not "unknown source".
        with pytest.raises(ServerError) as raised:
            db.records("failed", "zz")
        assert raised.value.status == 404

    def test_refuses_a_redacted_visibility_change(self) -> None:
        fake = Fake({"PATCH /v1/sessions/a/gone": (410, error("redacted"))})
        with pytest.raises(ServerError) as raised:
            fake.client().set_visibility("a", "gone", "org")
        assert (raised.value.status, raised.value.code) == (410, "redacted")

    def test_refuses_a_2xx_that_is_not_json(self) -> None:
        fake = Fake({"GET /v1/me": lambda _: httpx.Response(200, text="<html>")})
        with pytest.raises(ServerError) as raised:
            fake.client().me()
        assert raised.value.code == "bad_response"

    def test_reports_an_unreachable_server_as_store_error(self) -> None:
        def down(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused", request=request)

        client = SeshiClient(SERVER, "t", transport=httpx.MockTransport(down))
        with pytest.raises(StoreError, match=re.escape("cannot reach https://seshi.example.com")):
            client.me()


class TestTokensAndAdmin:
    def test_creates_lists_and_revokes_tokens(self) -> None:
        fake = Fake(
            {
                "POST /v1/tokens": (201, {"token": "seshi_x", "record": TOKEN}),
                "GET /v1/tokens": (200, {"tokens": [TOKEN]}),
                "DELETE /v1/tokens/abc": (200, {"token": {**TOKEN, "revoked": True}}),
                "POST /v1/tokens/revoke": (200, {"revoked": [TOKEN]}),
            }
        )
        db = fake.client()
        created = db.create_token({"kind": "device", "owner": "alice", "label": "mbp"})
        assert created.token == "seshi_x" and created.record.id == "abc"
        assert sent(fake.last) == {"kind": "device", "owner": "alice", "label": "mbp"}
        assert [t.id for t in db.list_tokens(owner="alice", kind="device", all=True)] == ["abc"]
        assert dict(fake.last.url.params) == {"owner": "alice", "kind": "device", "all": "true"}
        db.list_tokens()
        assert fake.last.url.query == b""
        revoked = db.revoke_token("abc")
        assert revoked is not None and revoked.revoked
        assert [t.id for t in db.revoke_owner_tokens("alice", "device")] == ["abc"]
        assert sent(fake.last) == {"owner": "alice", "kind": "device"}

    def test_returns_a_rejected_reload_instead_of_raising_it(self) -> None:
        fake = Fake(
            {
                "POST /v1/admin/reload": (
                    422,
                    {**error("reload_rejected"), "reload": RELOAD, "config": CONFIG},
                )
            }
        )
        result = fake.client().reload()
        assert result.reload.outcome == "rejected" and result.reload.errors == ["bad pack"]
        assert result.config.reloadable
        fake.routes["POST /v1/admin/reload"] = (409, error("not_reloadable"))
        with pytest.raises(ServerError) as raised:
            fake.client().reload()
        assert raised.value.code == "not_reloadable"

    def test_fetches_redaction_rules_again_only_when_they_changed(self) -> None:
        def rules(request: httpx.Request) -> httpx.Response:
            if request.headers.get("if-none-match") == '"v1"':
                return httpx.Response(304)
            return httpx.Response(200, json=RULES, headers={"etag": '"v1"'})

        fake = Fake({"GET /v1/redaction/rules": rules})
        db = fake.client()
        assert db.redaction_rules().builtin == "seshi/rules/3"
        first = db.redaction_rules_since()
        assert first is not None and first.etag == '"v1"'
        assert db.redaction_rules_since(first.etag) is None

    def test_fetches_capture_rules_again_only_when_they_changed(self) -> None:
        document = {"schema": "seshi/capture-rules/1", "exclude": ["acme/payroll"]}

        def rules(request: httpx.Request) -> httpx.Response:
            if request.headers.get("if-none-match") == '"c1"':
                return httpx.Response(304)
            return httpx.Response(200, json=document, headers={"etag": '"c1"'})

        fake = Fake({"GET /v1/capture/rules": rules})
        db = fake.client()
        assert db.capture_rules().exclude == ["acme/payroll"]
        first = db.capture_rules_since()
        assert first is not None and first.etag == '"c1"'
        assert db.capture_rules_since(first.etag) is None


class TestPaging:
    def test_iterates_every_page_of_a_feed(self) -> None:
        pages = {
            None: {"entries": [{"key": "k1", "entry": CHANGE}], "cursor": "k1", "truncated": True},
            "k1": {"entries": [{"key": "k2", "entry": CHANGE}], "cursor": "k2", "truncated": False},
        }

        def feed(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=pages[param(request, "after")])

        fake = Fake({"GET /v1/changes": feed})
        assert [c.key for c in fake.client().iter_changes(limit=1)] == ["k1", "k2"]
        assert [param(r, "after") for r in fake.seen] == [None, "k1"]

    def test_iterates_every_owners_feed_up_to_through(self) -> None:
        entry = {"owner": "bob", "key": "owners/bob/changes/1", "entry": CHANGE}
        pages = {
            None: {"entries": [entry], "cursor": "c1", "truncated": True, "through": "t"},
            "c1": {"entries": [entry], "truncated": False, "through": "t"},
        }
        fake = Fake(
            {"GET /v1/changes/all": lambda r: httpx.Response(200, json=pages[param(r, "after")])}
        )
        assert [c.owner for c in fake.client().iter_all_changes()] == ["bob", "bob"]
        assert param(fake.seen[0], "owner") is None

    def test_iterates_every_page_of_sessions(self) -> None:
        pages = {
            None: {"sessions": [META], "cursor": "c1", "truncated": True},
            "c1": {"sessions": [META], "truncated": False},
        }
        fake = Fake(
            {"GET /v1/sessions": lambda r: httpx.Response(200, json=pages[param(r, "after")])}
        )
        assert len(list(fake.client().iter_sessions(owner="bob"))) == 2


class TestBeforeThereIsAToken:
    def test_reads_the_auth_config_and_exchanges_an_id_token_without_a_credential(self) -> None:
        config = {
            "version": "1",
            "org_key": True,
            "oidc": None,
            "session_token_seconds": 3600,
            "delete_fresh_seconds": 600,
        }
        result = {
            "session_token": "jwt",
            "expires_at": "t",
            "owner": "alice",
            "role": "member",
            "scopes": ["sessions:read"],
        }
        fake = Fake({"GET /v1/auth/config": (200, config), "POST /v1/auth/exchange": (200, result)})
        transport = httpx.MockTransport(fake.handle)
        assert auth_config(f"{SERVER}/", transport=transport).org_key
        exchanged = exchange_id_token(
            SERVER, {"id_token": "id", "nonce": "n", "machine": {"id": "m1"}}, transport=transport
        )
        assert exchanged.session_token == "jwt"
        # A client with a token sends none on these routes either.
        fake.client().auth_config()
        assert [r.headers.get("authorization") for r in fake.seen] == [None, None, None]
        assert sent(fake.seen[1]) == {"id_token": "id", "nonce": "n", "machine": {"id": "m1"}}

    def test_refuses_an_id_token_the_server_does_not_accept(self) -> None:
        fake = Fake({"POST /v1/auth/exchange": (401, error("unauthorized", "bad token"))})
        with pytest.raises(ServerError) as raised:
            fake.client(None).exchange_id_token({"id_token": "x"})
        assert raised.value.status == 401


@pytest.mark.anyio
async def test_the_async_client_makes_the_same_calls() -> None:
    fake = Fake(
        {
            "POST /v1/sessions": (409, error("offset_mismatch", expected=7)),
            "GET /v1/sessions/claude-code/s": (200, META),
            "GET /v1/changes": (
                200,
                {"entries": [{"key": "k1", "entry": CHANGE}], "truncated": False},
            ),
        }
    )

    async def handle(request: httpx.Request) -> httpx.Response:
        await request.aread()
        return fake.handle(request)

    async with AsyncSeshiClient(
        SERVER, "tok", user="alice", transport=httpx.MockTransport(handle)
    ) as db:
        with pytest.raises(OffsetMismatch) as raised:
            await db.ingest(upload(offset=3))
        assert (raised.value.offset, raised.value.expected) == (3, 7)
        meta = await db.get_session("claude-code", "s")
        assert meta is not None and meta.session_id == "s"
        assert [c.key async for c in db.iter_changes()] == ["k1"]
    assert fake.seen[0].headers["x-seshi-user"] == "alice"
    assert fake.seen[0].headers["user-agent"] == f"seshi-python/{__version__}"


class TestReviewFixes:
    def test_sets_the_timeout_on_every_request_even_with_its_own_http_client(self) -> None:
        fake = Fake({"GET /v1/owners": (200, {"owners": [], "truncated": False})})
        shared = httpx.Client(transport=httpx.MockTransport(fake.handle))
        SeshiClient(SERVER, "t", http_client=shared, timeout=600).owners()
        assert fake.last.extensions["timeout"]["read"] == 600
        SeshiClient(SERVER, "t", http_client=shared, timeout=0).owners()
        assert fake.last.extensions["timeout"]["read"] is None
        with pytest.raises(ValueError, match="not both"):
            SeshiClient(SERVER, "t", http_client=shared, transport=httpx.MockTransport(fake.handle))

    def test_reads_an_enum_value_from_a_newer_server(self) -> None:
        fake = Fake(
            {
                "GET /v1/tokens": (
                    200,
                    {"tokens": [{**TOKEN, "scopes": ["sessions:export"], "kind": "robot"}]},
                )
            }
        )
        [token] = fake.client().list_tokens()
        assert (token.scopes, token.kind) == (["sessions:export"], "robot")

    def test_sends_an_agent_a_newer_server_knows(self) -> None:
        fake = Fake({"POST /v1/sessions": (201, STORED)})
        fake.client().ingest({"format": "amp", "session_id": "s", "transcript": "x"})
        assert sent(fake.last)["format"] == "amp"

    def test_checks_another_model_given_as_a_body(self) -> None:
        fake = Fake({"POST /v1/tokens": (201, {"token": "x", "record": TOKEN})})
        record = TokenInfo.model_validate(TOKEN)
        with pytest.raises(ValueError, match="extra"):
            fake.client().create_token(record)  # type: ignore[arg-type]
        assert fake.seen == []
