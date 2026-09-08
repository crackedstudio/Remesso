-- Retune reconciliation for operation without webhooks.
--
-- Webhook URLs and signing secrets can only be configured in the cNGN merchant
-- dashboard — there is no API for it among the 15 documented endpoints. Where
-- that section is not available to an account, redemptions can only ever be
-- observed by polling GET /transactions, which is what the redeemAsset docs
-- point at anyway ("Track it via Get Transactions").
--
-- The */10 cadence was sized to let the webhook handle the fast path, with the
-- sweep as a backstop for the deliveries cNGN never retries. With no webhook
-- the sweep IS the path, so every minute of that interval is settlement
-- latency a sender waits through. Halving it, together with dropping the stale
-- threshold from 10 minutes to 2 in the function, brings typical settlement
-- from ~20 minutes to under 7.
--
-- Not tightened further because cNGN allows 20 requests per 60s per API key,
-- and breaching that blocks the key for another 60s.
select cron.unschedule('remesso-reconcile-redemptions')
where exists (select 1 from cron.job where jobname = 'remesso-reconcile-redemptions');

select cron.schedule(
  'remesso-reconcile-redemptions',
  '*/5 * * * *',
  $$ select public.invoke_edge_function('reconcile-redemptions'); $$
);
