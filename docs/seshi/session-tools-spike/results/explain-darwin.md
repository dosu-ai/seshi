| `SELECT count(*) FROM events WHERE lower(role) = 'user'` | OpenRead db0:events, OpenRead db0:sessions | Function(lower(1)), AggStep(count(0)) |
| `SELECT count(*) FROM main.events` | OpenRead db0:events | — |
| `SELECT * FROM s2.secret` | OpenRead db2:2 | — |
| `SELECT name FROM pragma_database_list` | — | VOpen(vtab:109272270), VFilter |
| `SELECT count(*) FROM json_each('[1,2]')` | — | VOpen(vtab:1092711C0), VFilter, AggStep(count(0)) |
| `SELECT 1; DROP VIEW events` | — | — |
