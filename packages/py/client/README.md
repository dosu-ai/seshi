# seshi

The typed Python client for a [seshi](https://github.com/dosu-ai/seshi) server: store, read,
search and tail coding-agent sessions. The Python counterpart of `@dosu/seshi-client`, released
at the same version as the server.

```sh
pip install seshi        # or: uv add seshi
```

Python 3.10+, on [httpx](https://www.python-httpx.org/) and [pydantic](https://docs.pydantic.dev/) v2,
with a sync and an async client.

```python
import os
from seshi import OffsetMismatch, SeshiClient, Upload

with SeshiClient(
    "https://seshi.acme.internal",
    os.environ["ACME_SESHI_TOKEN"],  # a device, service, admin or static token, or the org key
    user="alice@acme.com",  # with the org key only: the username to write as
) as db:
    answer = db.ingest(Upload(agent="claude-code", session_id="8f1c…", transcript=log))
    # Stored(status='stored', content_hash='…', records_total=41, bytes_total=48213, …)

    # As the log grows, send only what it gained, from where the last answer ended.
    db.ingest(
        Upload(agent="claude-code", session_id="8f1c…", transcript=tail, offset=answer.bytes_total)
    )

    session = db.get_session("claude-code", "8f1c…")
    trace = db.get_trace("claude-code", "8f1c…", format="otlp")
    for entry in db.iter_changes(after=cursor):
        ...
    found = db.search("flaky checkout test", repo="widget", sort="recent")
```

`AsyncSeshiClient` has the same calls as coroutines:

```python
async with AsyncSeshiClient(server, token) as db:
    async for entry in db.iter_all_changes(since="2026-11-01T00:00:00.000Z"):
        ...
```

The calls, options and errors are documented in
[docs/client.md](https://github.com/dosu-ai/seshi/blob/main/docs/client.md#python-seshi); the HTTP
contract is [spec/openapi.yaml](https://github.com/dosu-ai/seshi/blob/main/spec/openapi.yaml).
