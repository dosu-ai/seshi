sqlite 3.51.0

| Probe | Result |
|---|---|
| unqualified events (the TEMP view?) | ok: [{"n":68000,"owners":4}] |
| main.events, bypassing the view | ok: [{"n":80000}] |
| main.sessions owner-only rows | ok: [{"n":400}] |
| text through the view | ok: [{"text":"user 0 of alice/a0 "}] |
| json_each (table-valued) | ok: [{"n":2}] |
| ATTACH a file outside | ok: [] |
| read the attached file | ok: [{"secret":"outside-sqlite-secret"}] |
| ATTACH ':memory:' | ok: [] |
| load_extension() | refused: SQLiteError: no such function: load_extension |
| readfile() | refused: SQLiteError: no such function: readfile |
| fts3_tokenizer() | ok: [{"fts3_tokenizer('simple')":null}] |
| INSERT into main | refused: SQLiteError: table main.sessions has no column named format |
| CREATE TEMP TABLE before query_only | ok: [] |
| CREATE TEMP TABLE after query_only | refused: SQLiteError: attempt to write a readonly database |
| DROP VIEW events after query_only | refused: SQLiteError: attempt to write a readonly database |
| CREATE TEMP VIEW after query_only | refused: SQLiteError: attempt to write a readonly database |
| PRAGMA query_only = 0 (caller undoes it) | ok: [] |
| ATTACH after query_only | ok: [] |
| prepare two statements | prepared; runs: [{"a":1}]; events view still there: yes |
| hard_heap_limit 64 MB: sort 5M wide rows | ok: [{"count(*)":5000000}] |
(1968 ms)

worker running a 10^12-row cross join, terminate() at 500 ms: not closed 10 s after terminate(); main thread ticked 206 times (every 50 ms) meanwhile
