-- cNGN delivers each webhook exactly once, with a 10-second timeout and no
-- automatic retry. Two consequences, both handled here.
--
-- Statement order matters in this file: a `language sql` function body is
-- parsed and validated when the function is created, not when it is first
-- called, so every column it reads has to exist by then.

-- ---------------------------------------------------------------------------
-- 1. A delivery that does arrive may arrive twice (a manual replay from the
--    dashboard, a proxy retry). Idempotency is keyed on the pair the docs
--    recommend: transactionId + event.
-- ---------------------------------------------------------------------------
alter table public.webhook_events
  add column if not exists transaction_id text;

create unique index if not exists webhook_events_idempotency_idx
  on public.webhook_events (event_type, transaction_id)
  where transaction_id is not null;

-- ---------------------------------------------------------------------------
-- 2. A delivery that never arrives leaves a run stuck in `redeeming` forever,
--    while the recipient has in fact been paid.
-- ---------------------------------------------------------------------------

-- Declared before stale_redemptions(), which selects both of these.
alter table public.runs
  add column if not exists reconcile_attempts int not null default 0,
  add column if not exists reconciled_at timestamptz;

comment on column public.runs.reconcile_attempts is
  'Times reconcile-redemptions has polled cNGN for this run. Escalate past 12 (~2h).';

comment on column public.runs.reconciled_at is
  'Last time the transactions API was consulted about this run.';

-- `reconcile-redemptions` polls the cNGN transactions API for these. Ordered
-- oldest-first so the longest-stuck run is never starved, and bounded because
-- the API allows 20 requests per minute across the whole integration.
create or replace function public.stale_redemptions(
  p_older_than interval default '10 minutes',
  p_limit int default 20
)
returns table (
  run_id uuid,
  cngn_trx_ref text,
  started_at timestamptz,
  reconcile_attempts int
)
language sql
stable
security definer
set search_path = public
as $$
  select r.id, r.cngn_trx_ref, r.started_at, r.reconcile_attempts
  from public.runs r
  where r.status = 'redeeming'
    and r.cngn_trx_ref is not null
    and r.started_at < now() - p_older_than
  order by r.started_at asc
  limit p_limit;
$$;

revoke all on function public.stale_redemptions(interval, int) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The hourly reconcile in 20260907000002 pointed at execute-due-runs with a
--    mode flag that function never implemented, so nothing was reconciled.
--    Give it its own function, and run it every 10 minutes: an unretried
--    webhook is the normal way a bank payout goes quiet, not an exotic one.
-- ---------------------------------------------------------------------------
select cron.unschedule('remesso-reconcile')
where exists (select 1 from cron.job where jobname = 'remesso-reconcile');

select cron.unschedule('remesso-reconcile-redemptions')
where exists (select 1 from cron.job where jobname = 'remesso-reconcile-redemptions');

select cron.schedule(
  'remesso-reconcile-redemptions',
  '*/10 * * * *',
  $$ select public.invoke_edge_function('reconcile-redemptions'); $$
);
