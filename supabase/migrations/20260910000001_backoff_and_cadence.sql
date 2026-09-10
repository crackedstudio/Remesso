-- Faster cadence, and the backoff that has to come with it.
--
-- The executor ran every 5 minutes, so a schedule due at 12:01 waited until
-- 12:05. Dropping to every minute cuts worst-case latency to 60s, and an idle
-- tick is nearly free because due_schedules is indexed and returns nothing.
--
-- But a failed run is not an *open* run, so the old due_schedules re-selected
-- that schedule on the very next tick. At */5 that was a retry every five
-- minutes; at */1 it would be 1,440 rows a day for one schedule that is simply
-- underfunded, each burning RPC calls for a result that will not have changed.
--
-- So the cadence change requires backoff in the same migration. Retry delay
-- doubles per consecutive failure since the last success: 1, 2, 4, 8, 16, then
-- capped at 32 minutes. A schedule that becomes runnable again waits at most
-- half an hour, which is nothing against remittance intervals measured in weeks.
create or replace function public.due_schedules(p_limit int default 50)
returns table (
  schedule_id  uuid,
  onchain_id   numeric,
  sender_id    uuid,
  amount_in    numeric,
  min_rate_e6  numeric,
  payout_type  payout_type
)
language sql
stable
as $$
  select s.id, s.onchain_id, s.sender_id, s.amount_in, s.min_rate_e6, r.payout_type
  from public.schedules s
  join public.recipients r on r.id = s.recipient_id
  where s.status = 'active'
    and s.onchain_id is not null
    and (s.next_run_at is null or s.next_run_at <= now())
    and (s.expires_at is null or s.expires_at > now())
    -- never start a second run while one is still open
    and not exists (
      select 1 from public.runs run
      where run.schedule_id = s.id
        and run.status in ('pending','swapping','redeeming')
    )
    -- exponential backoff on consecutive unsuccessful attempts
    and not exists (
      select 1
      from (
        select
          max(f.settled_at) as last_failure,
          count(*)          as consecutive
        from public.runs f
        where f.schedule_id = s.id
          and f.status in ('failed','skipped')
          and f.started_at > coalesce(
                (select max(ok.started_at)
                   from public.runs ok
                  where ok.schedule_id = s.id
                    and ok.status in ('delivered','paid_out')),
                '-infinity'::timestamptz)
      ) fs
      where fs.consecutive > 0
        and fs.last_failure is not null
        and now() < fs.last_failure
                    + (least(power(2, least(fs.consecutive - 1, 5))::int, 32)
                       * interval '1 minute')
    )
  order by s.next_run_at nulls first
  limit p_limit;
$$;

comment on function public.due_schedules(int) is
  'Schedules eligible to run now. Excludes any with an open run, and any whose '
  'consecutive failures since the last success put it inside its backoff window '
  '(1,2,4,8,16,32 minutes).';

-- Supporting index: the backoff subquery filters runs by schedule and status.
create index if not exists runs_schedule_status_idx
  on public.runs (schedule_id, status, started_at desc);

-- Every minute. The executor bounds its own work per invocation (BATCH, and a
-- settle deadline), so overlapping ticks hand off rather than pile up.
select cron.unschedule('remesso-execute-due-runs')
where exists (select 1 from cron.job where jobname = 'remesso-execute-due-runs');

select cron.schedule(
  'remesso-execute-due-runs',
  '* * * * *',
  $$ select public.invoke_edge_function('execute-due-runs'); $$
);
