-- Is the agent actually being driven?
--
-- The whole product rests on pg_cron invoking `execute-due-runs` every minute.
-- If that job is unscheduled, erroring, or silently failing its HTTP call, the
-- symptom is nothing at all: no error surfaces, schedules simply never run and
-- every sender is quietly unpaid. There was no way to check it without a
-- superuser psql session, so the answer to "is the cron running?" was inference
-- from whether runs happened to appear.
--
-- SECURITY DEFINER because `cron` is owned by the postgres role and not exposed
-- through PostgREST. Execute is granted to service_role only — this is an
-- operator view, not something a signed-in sender may call.

create or replace function public.cron_health()
returns table (
  jobname     text,
  schedule    text,
  active      boolean,
  last_run    timestamptz,
  last_status text,
  runs_1h     bigint,
  failures_1h bigint
)
language sql
security definer
set search_path = public, cron, pg_temp
as $$
  select
    j.jobname::text,
    j.schedule::text,
    j.active,
    max(d.start_time)                                          as last_run,
    (array_agg(d.status order by d.start_time desc))[1]::text  as last_status,
    count(d.*) filter (where d.start_time > now() - interval '1 hour')     as runs_1h,
    count(d.*) filter (where d.start_time > now() - interval '1 hour'
                         and d.status <> 'succeeded')                      as failures_1h
  from cron.job j
  left join cron.job_run_details d on d.jobid = j.jobid
  where j.jobname like 'remesso-%'
  group by j.jobname, j.schedule, j.active
  order by j.jobname;
$$;

revoke all on function public.cron_health() from public, anon, authenticated;
grant execute on function public.cron_health() to service_role;
