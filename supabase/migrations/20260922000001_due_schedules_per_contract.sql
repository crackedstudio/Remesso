-- `due_schedules` returned every active schedule regardless of which contract
-- it lives in, which was harmless while one deployment existed and is not any
-- more.
--
-- Schedule ids are per-contract and every deployment numbers from 1. So an
-- executor pointed at V4 would read a V3 row's `onchain_id` and ask V4 about
-- *its* schedule with that number — a different sender, a different
-- destination, a different amount. The V1 -> V2 collision this table's
-- `executor_address` column was added for, now reachable from the executor
-- loop rather than just from a unique index.
--
-- The executor passes the address it is configured with, so a run can only
-- ever touch a schedule authorised against that exact contract. A migration
-- therefore becomes: point the executor at the new address, and the old
-- schedules stop being picked up. They are not cancelled and not lost — they
-- simply belong to a contract nothing is running any more, which is the
-- truthful state of a schedule whose sender has not re-authorised.
drop function if exists public.due_schedules(int);

create function public.due_schedules(p_limit int default 50, p_executor text default null)
returns table (
  schedule_id   uuid,
  onchain_id    numeric,
  sender_id     uuid,
  amount_in     numeric,
  min_rate_e6   numeric,
  payout_type   payout_type,
  token_address text
)
language sql
stable
as $$
  select s.id, s.onchain_id, s.sender_id, s.amount_in, s.min_rate_e6,
         r.payout_type, s.token_address
  from public.schedules s
  join public.recipients r on r.id = s.recipient_id
  where s.status = 'active'
    and s.onchain_id is not null
    -- Null `p_executor` keeps the old behaviour for a caller that has not been
    -- updated yet; the executor always passes one.
    and (p_executor is null or lower(s.executor_address) = lower(p_executor))
    and (s.next_run_at is null or s.next_run_at <= now())
    and (s.expires_at is null or s.expires_at > now())
    and not exists (
      select 1 from public.runs run
      where run.schedule_id = s.id
        and run.status in ('pending','swapping','redeeming')
    )
    and not exists (
      select 1
      from (
        select max(f.settled_at) as last_failure, count(*) as consecutive
        from public.runs f
        where f.schedule_id = s.id
          and f.status in ('failed','skipped')
          and f.started_at > coalesce(
                (select max(ok.started_at) from public.runs ok
                  where ok.schedule_id = s.id and ok.status in ('delivered','paid_out')),
                '-infinity'::timestamptz)
      ) fs
      where fs.consecutive > 0
        and fs.last_failure is not null
        and now() < fs.last_failure
                    + (least(power(2, least(fs.consecutive - 1, 5))::int, 32) * interval '1 minute')
    )
  order by s.next_run_at nulls first
  limit p_limit;
$$;

revoke all on function public.due_schedules(int, text) from public, anon, authenticated;

-- Rows created before the column existed were backfilled to V1. Anything since
-- carries the address the frontend wrote at creation.
comment on function public.due_schedules(int, text) is
  'Schedules due to run against ONE executor contract. The caller passes the '
  'address it is configured with; ids are per-contract and collide across '
  'deployments.';
