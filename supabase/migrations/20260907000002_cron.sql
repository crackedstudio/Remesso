-- Time-based triggers.
--
-- pg_cron picks due schedules and hands them to the execute-due-runs Edge
-- Function over pg_net. The database never talks to Celo directly; it only
-- decides *when*. The Edge Function decides *whether*, by asking the contract.

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
  order by s.next_run_at nulls first
  limit p_limit;
$$;

-- Vault-held config, so the service role key is not written into a cron
-- definition in plain text.
--   select vault.create_secret('https://<ref>.supabase.co', 'project_url');
--   select vault.create_secret('<service-role-key>',        'service_role_key');
create or replace function public.invoke_edge_function(fn text, body jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  base text;
  key  text;
begin
  select decrypted_secret into base from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into key  from vault.decrypted_secrets where name = 'service_role_key';

  return net.http_post(
    url     := base || '/functions/v1/' || fn,
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || key
               ),
    body    := body,
    timeout_milliseconds := 55000
  );
end;
$$;

revoke all on function public.invoke_edge_function(text, jsonb) from public, anon, authenticated;

-- Every 5 minutes: execute anything due.
select cron.schedule(
  'remesso-execute-due-runs',
  '*/5 * * * *',
  $$ select public.invoke_edge_function('execute-due-runs'); $$
);

-- Every 15 minutes: check funding and liquidity, warn senders before a run
-- fails rather than after.
select cron.schedule(
  'remesso-balance-poller',
  '*/15 * * * *',
  $$ select public.invoke_edge_function('balance-poller'); $$
);

-- Hourly: re-check runs that went out but never confirmed.
select cron.schedule(
  'remesso-reconcile',
  '7 * * * *',
  $$ select public.invoke_edge_function('execute-due-runs', '{"mode":"reconcile"}'::jsonb); $$
);
