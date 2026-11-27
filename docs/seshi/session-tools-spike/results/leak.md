| lance_events | `CAST(text AS INTEGER) = 1` | error, nothing out of scope: Error: Conversion Error: Could not convert string 'user 0 of alice/a0 ' to INT32 when casting from source column text |
| lance_events | `archive_id = 'a5' AND CAST(text AS INTEGER) = 1` | no error, [{"n":"0"}] |
| lance_events | `CAST(text AS INTEGER) = 1 AND archive_id = 'a5'` | no error, [{"n":"0"}] |
| lance_events | `archive_id = 'a5' AND error(text) IS NULL` | no error, [{"n":"0"}] |
| lance_events | `archive_id = 'a5' AND json_extract(text, '$.x') IS NULL` | no error, [{"n":"0"}] |
| lance_events | `CASE WHEN archive_id = 'a5' THEN CAST(text AS INTEGER) END = 1` | no error, [{"n":"0"}] |
| lance_events | `CASE WHEN archive_id = 'a5' THEN error(text::VARCHAR) END IS NULL` | no error, [{"n":"68000"}] |
| lance_events | `(CASE WHEN owner = 'bob' AND archive_id = 'a5' THEN CAST(text::VARCHAR AS INTEGER) ELSE 0 END) = 0` | no error, [{"n":"68000"}] |
| sqlite_events | `CAST(text AS INTEGER) = 1` | error, nothing out of scope: Error: Conversion Error: Could not convert string 'user 0 of alice/a0 ' to INT32 when casting from source column text |
| sqlite_events | `archive_id = 'a5' AND CAST(text AS INTEGER) = 1` | no error, [{"n":"0"}] |
| sqlite_events | `CAST(text AS INTEGER) = 1 AND archive_id = 'a5'` | no error, [{"n":"0"}] |
| sqlite_events | `archive_id = 'a5' AND error(text) IS NULL` | no error, [{"n":"0"}] |
| sqlite_events | `archive_id = 'a5' AND json_extract(text, '$.x') IS NULL` | no error, [{"n":"0"}] |
| sqlite_events | `CASE WHEN archive_id = 'a5' THEN CAST(text AS INTEGER) END = 1` | no error, [{"n":"0"}] |
| sqlite_events | `CASE WHEN archive_id = 'a5' THEN error(text::VARCHAR) END IS NULL` | no error, [{"n":"68000"}] |
| sqlite_events | `(CASE WHEN owner = 'bob' AND archive_id = 'a5' THEN CAST(text::VARCHAR AS INTEGER) ELSE 0 END) = 0` | no error, [{"n":"68000"}] |
