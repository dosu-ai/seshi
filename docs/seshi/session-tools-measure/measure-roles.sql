-- Phase 2 of session-tools.md (decision T5): per-role event text lengths on Dosu's production
-- sample (Supabase `memory.trace`). Aggregates only: no text leaves the database. One trace per
-- session, its largest, since later uploads repeat earlier records. The session key is
-- (owner_user_id, agent, session_id): `archive_id` is null on every row with events.
--
-- `memory.trace` keeps tool results cut to about 2,500 characters (near_2500), so the 4 and
-- 8 KiB figures for tool_result come from the tail measured in local transcripts
-- (tool-tail.ts).
with t as (
  select distinct on (owner_user_id, agent, session_id) events
  from memory.trace
  where jsonb_typeof(events) = 'array'
  order by owner_user_id, agent, session_id, jsonb_array_length(events) desc
),
e as (
  select x->>'role' as role, length(coalesce(x->>'text', '')) as n
  from t, jsonb_array_elements(t.events) x
)
select role,
  count(*) as events,
  count(*) filter (where n > 0) as with_text,
  percentile_disc(0.5) within group (order by n) filter (where n > 0) as p50,
  percentile_disc(0.9) within group (order by n) filter (where n > 0) as p90,
  percentile_disc(0.99) within group (order by n) filter (where n > 0) as p99,
  max(n) as max,
  count(*) filter (where n between 2480 and 2520) as near_2500,
  count(*) filter (where n > 2520) as over_2520,
  sum(n) as chars,
  sum(least(n, 2048)) as kept_2k,
  sum(least(n, 4096)) as kept_4k,
  sum(least(n, 8192)) as kept_8k,
  sum(least(n, 32768)) as kept_32k,
  (select count(*) from t) as sessions
from e
group by role
order by chars desc;
