-- The executor needs the funding asset: a Direct schedule skips the quote and
-- the liquidity check entirely, and the backend's run cap is denominated in
-- whole units, so it cannot be applied without knowing the token's scale
-- (USDT/USDC 6dp, cUSD 18dp).
-- The return type gains a column, and `create or replace` cannot change a
-- function's signature — it has to be dropped first. Nothing holds a reference:
-- pg_cron invokes the Edge Function, which calls this over RPC by name.
drop function if exists public.due_schedules(int);

create function public.due_schedules(p_limit int default 50)
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

revoke all on function public.due_schedules(int) from public, anon, authenticated;
