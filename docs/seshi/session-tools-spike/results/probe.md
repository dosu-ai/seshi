
## allowed_directories = index folder

| Probe | Result |
|---|---|
| lance view | ok: [{"n":"68000","owners":"4"}] |
| sqlite view | ok: [{"n":"68000","texts":"68000"}] |
| sqlite FTS5 table itself | ok: [{"count_star()":"80000"}] |
| raw lance table, inside | ok: [{"n":"16000"}] |
| raw lance, __lance_scan | ok: [{"count_star()":"80000"}] |
| raw sqlite table via attach name | ok: [{"count_star()":"400"}] |
| outside csv, replacement scan | refused: Error: Permission Error: Cannot access file "/private/tmp/claude-501/-Users-devstein-code-sessiondb--claude-worktrees-nifty-cannon-b71493/07 |
| outside csv, read_csv | refused: Error: Permission Error: Cannot access file "/private/tmp/claude-501/-Users-devstein-code-sessiondb--claude-worktrees-nifty-cannon-b71493/07 |
| outside lance, replacement scan | ok: [{"secret":"outside-lance-secret"}] |
| outside lance, __lance_scan | ok: [{"secret":"outside-lance-secret"}] |
| outside lance, lance_fts | ok: [] |
| outside sqlite, sqlite_scan | refused: Error: Permission Error: Cannot access file "/private/tmp/claude-501/-Users-devstein-code-sessiondb--claude-worktrees-nifty-cannon-b71493/07 |
| outside sqlite, ATTACH | refused: Error: Permission Error: Cannot access file "/private/tmp/claude-501/-Users-devstein-code-sessiondb--claude-worktrees-nifty-cannon-b71493/07 |
| outside, glob | refused: Error: Permission Error: Cannot access file "/private/tmp/claude-501/-Users-devstein-code-sessiondb--claude-worktrees-nifty-cannon-b71493/07 |
| http, read_csv | refused: Error: Permission Error: Cannot access file "https://example.com/x.csv" - file system operations are disabled by configuration |
| write inside, COPY TO | ok: [{"Count":"1"}] |
| write sqlite, INSERT | refused: Error: Invalid Input Error: Cannot execute statement of type "INSERT" on database "idx" which is attached in read-only mode! |
| lance write, __lance_exec | refused: Error: IO Error: Failed to validate Lance exec IR: /private/tmp/claude-501/-Users-devstein-code-sessiondb--claude-worktrees-nifty-cannon-b71 |
| lance delete, __lance_cleanup_old_versions | refused: Error: Binder Error: No function matches the given name and argument types '__lance_cleanup_old_versions(STRING_LITERAL)'. You might need to |
| lance compact, __lance_compact_files | refused: Error: Binder Error: No function matches the given name and argument types '__lance_compact_files(STRING_LITERAL)'. You might need to add ex |
| SET enable_external_access | refused: Error: Invalid Input Error: Cannot change configuration option "enable_external_access" - the configuration has been locked |
| SET allowed_directories | refused: Error: Invalid Input Error: Cannot change configuration option "allowed_directories" - the configuration has been locked |
| RESET lock_configuration | refused: Error: Invalid Input Error: Cannot change configuration option "lock_configuration" - the configuration has been locked |
| SET memory_limit | refused: Error: Invalid Input Error: Cannot change configuration option "memory_limit" - the configuration has been locked |
| LOAD httpfs | refused: Error: Permission Error: Loading external extensions is disabled through configuration |
| INSTALL httpfs | refused: Error: Permission Error: Cannot access directory "/private/tmp/claude-501/-Users-devstein-code-sessiondb--claude-worktrees-nifty-cannon-b714 |
| getenv | refused: Error: Catalog Error: Scalar Function with name getenv does not exist! |
| current_setting | ok: [{"current_setting('allowed_directories')":["/Users/devstein/code/sessiondb/.claude/worktrees/nifty-cannon-b71493/docs/seshi/session-tools-s |
| duckdb_settings() | ok: [{"count_star()":"172"}] |
| CREATE TABLE in memory | ok: [{"Count":"1"}] |
| CREATE OR REPLACE VIEW | ok: [] |
| DETACH idx | ok: [] |

## allowed_directories = unrelated folder

| Probe | Result |
|---|---|
| lance view | ok: [{"n":"68000","owners":"4"}] |
| sqlite view | ok: [{"n":"68000","texts":"68000"}] |
| sqlite FTS5 table itself | ok: [{"count_star()":"80000"}] |
| raw lance table, inside | ok: [{"n":"16000"}] |
| raw lance, __lance_scan | ok: [{"count_star()":"80000"}] |
| raw sqlite table via attach name | ok: [{"count_star()":"400"}] |
| outside csv, replacement scan | refused: Error: Permission Error: Cannot access file "/private/tmp/claude-501/-Users-devstein-code-sessiondb--claude-worktrees-nifty-cannon-b71493/07 |
| outside csv, read_csv | refused: Error: Permission Error: Cannot access file "/private/tmp/claude-501/-Users-devstein-code-sessiondb--claude-worktrees-nifty-cannon-b71493/07 |
| outside lance, replacement scan | ok: [{"secret":"outside-lance-secret"}] |
| outside lance, __lance_scan | ok: [{"secret":"outside-lance-secret"}] |
| outside lance, lance_fts | ok: [] |
| outside sqlite, sqlite_scan | refused: Error: Permission Error: Cannot access file "/private/tmp/claude-501/-Users-devstein-code-sessiondb--claude-worktrees-nifty-cannon-b71493/07 |
| outside sqlite, ATTACH | refused: Error: Permission Error: Cannot access file "/private/tmp/claude-501/-Users-devstein-code-sessiondb--claude-worktrees-nifty-cannon-b71493/07 |
| outside, glob | refused: Error: Permission Error: Cannot access file "/private/tmp/claude-501/-Users-devstein-code-sessiondb--claude-worktrees-nifty-cannon-b71493/07 |
| http, read_csv | refused: Error: Permission Error: Cannot access file "https://example.com/x.csv" - file system operations are disabled by configuration |
| write inside, COPY TO | refused: Error: Permission Error: Cannot access file "/private/tmp/claude-501/-Users-devstein-code-sessiondb--claude-worktrees-nifty-cannon-b71493/07 |
| write sqlite, INSERT | refused: Error: Invalid Input Error: Cannot execute statement of type "INSERT" on database "idx" which is attached in read-only mode! |
| lance write, __lance_exec | refused: Error: IO Error: Failed to validate Lance exec IR: /private/tmp/claude-501/-Users-devstein-code-sessiondb--claude-worktrees-nifty-cannon-b71 |
| lance delete, __lance_cleanup_old_versions | refused: Error: Binder Error: No function matches the given name and argument types '__lance_cleanup_old_versions(STRING_LITERAL)'. You might need to |
| lance compact, __lance_compact_files | refused: Error: Binder Error: No function matches the given name and argument types '__lance_compact_files(STRING_LITERAL)'. You might need to add ex |
| SET enable_external_access | refused: Error: Invalid Input Error: Cannot change configuration option "enable_external_access" - the configuration has been locked |
| SET allowed_directories | refused: Error: Invalid Input Error: Cannot change configuration option "allowed_directories" - the configuration has been locked |
| RESET lock_configuration | refused: Error: Invalid Input Error: Cannot change configuration option "lock_configuration" - the configuration has been locked |
| SET memory_limit | refused: Error: Invalid Input Error: Cannot change configuration option "memory_limit" - the configuration has been locked |
| LOAD httpfs | refused: Error: Permission Error: Loading external extensions is disabled through configuration |
| INSTALL httpfs | refused: Error: Permission Error: Cannot access directory "/private/tmp/claude-501/-Users-devstein-code-sessiondb--claude-worktrees-nifty-cannon-b714 |
| getenv | refused: Error: Catalog Error: Scalar Function with name getenv does not exist! |
| current_setting | ok: [{"current_setting('allowed_directories')":["/Users/devstein/code/sessiondb/.claude/worktrees/nifty-cannon-b71493/docs/seshi/session-tools-s |
| duckdb_settings() | ok: [{"count_star()":"172"}] |
| CREATE TABLE in memory | ok: [{"Count":"1"}] |
| CREATE OR REPLACE VIEW | ok: [] |
| DETACH idx | ok: [] |
