-- Remesso core schema.
--
-- The database mirrors on-chain state; it is never the authority on it.
-- A schedule exists on Celo the moment the sender authorises it. The rows
-- here exist so the backend knows what to run, and so senders can read their
-- own history without an indexer.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- senders
-- ---------------------------------------------------------------------------
create table public.senders (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid not null unique references auth.users(id) on delete cascade,
  wallet_address text not null unique,
  email         text,
  created_at    timestamptz not null default now(),
  constraint wallet_is_evm_address check (wallet_address ~ '^0x[a-fA-F0-9]{40}$')
);

-- ---------------------------------------------------------------------------
-- recipients
-- ---------------------------------------------------------------------------
create type payout_type as enum ('wallet', 'ngn_bank');

create table public.recipients (
  id            uuid primary key default gen_random_uuid(),
  sender_id     uuid not null references public.senders(id) on delete cascade,
  display_name  text not null,
  payout_type   payout_type not null,

  -- payout_type = 'wallet'
  wallet_address text,

  -- payout_type = 'ngn_bank': settled through the cNGN API, never stored on chain
  bank_code      text,
  account_number text,
  account_name   text,           -- resolved via cNGN /verifyAccountDetails
  bank_verified_at timestamptz,

  created_at    timestamptz not null default now(),

  constraint wallet_payout_needs_address check (
    payout_type <> 'wallet' or wallet_address ~ '^0x[a-fA-F0-9]{40}$'
  ),
  constraint bank_payout_needs_verified_account check (
    payout_type <> 'ngn_bank' or (
      bank_code is not null
      and account_number ~ '^[0-9]{10}$'
      and bank_verified_at is not null
    )
  )
);

-- ---------------------------------------------------------------------------
-- schedules  (mirror of the on-chain policy)
-- ---------------------------------------------------------------------------
create type schedule_status as enum ('pending_authorization', 'active', 'paused', 'cancelled', 'completed');

create table public.schedules (
  id                uuid primary key default gen_random_uuid(),
  sender_id         uuid not null references public.senders(id) on delete cascade,
  recipient_id      uuid not null references public.recipients(id) on delete restrict,

  -- Set once createSchedule() is mined. Null means the sender has not yet
  -- signed the authorising transaction, and nothing may run.
  onchain_id        numeric(78,0) unique,
  chain_id          integer not null default 42220,
  authorized_tx_hash text,

  -- Mirrors of the on-chain envelope. Advisory only: the contract is the
  -- authority. Kept here so the poller can filter without an RPC round-trip.
  amount_in         numeric(78,0) not null,   -- USDT, 6dp
  interval_seconds  bigint not null,
  min_rate_e6       numeric(78,0) not null,
  max_runs          integer not null default 0,
  expires_at        timestamptz,
  next_run_at       timestamptz,

  status            schedule_status not null default 'pending_authorization',
  label             text,
  created_at        timestamptz not null default now(),

  constraint positive_amount check (amount_in > 0),
  constraint sane_interval check (interval_seconds >= 3600)
);

create index schedules_due_idx
  on public.schedules (next_run_at)
  where status = 'active' and onchain_id is not null;

-- ---------------------------------------------------------------------------
-- runs
-- ---------------------------------------------------------------------------
-- A run's lifecycle differs by payout type:
--   wallet   : pending -> swapping -> delivered
--   ngn_bank : pending -> swapping -> redeeming -> paid_out
-- 'delivered' for an ngn_bank run means cNGN reached the redemption address —
-- NOT that the recipient has naira. Only redemption.completed means that.
create type run_status as enum (
  'pending', 'swapping', 'delivered', 'redeeming', 'paid_out', 'failed', 'skipped'
);

create table public.runs (
  id              uuid primary key default gen_random_uuid(),
  schedule_id     uuid not null references public.schedules(id) on delete cascade,
  sender_id       uuid not null references public.senders(id) on delete cascade,

  -- The run number the contract will record. Together with schedule_id this is
  -- the idempotency key: at most one row per (schedule, attempt).
  attempt         integer not null,

  status          run_status not null default 'pending',

  amount_in       numeric(78,0) not null,
  amount_out      numeric(78,0),
  quoted_rate_e6  numeric(78,0),
  min_out         numeric(78,0),

  tx_hash         text,
  block_number    bigint,
  gas_used        numeric(78,0),

  -- cNGN redemption leg (payout_type = 'ngn_bank' only)
  cngn_trx_ref    text unique,
  cngn_deposit_address text,
  redeemed_at     timestamptz,

  failure_reason  text,
  started_at      timestamptz not null default now(),
  settled_at      timestamptz,

  unique (schedule_id, attempt)
);

create index runs_schedule_idx on public.runs (schedule_id, started_at desc);
create index runs_open_idx on public.runs (status) where status in ('pending','swapping','redeeming');

-- ---------------------------------------------------------------------------
-- webhook_events  (raw cNGN deliveries, for replay and audit)
-- ---------------------------------------------------------------------------
create table public.webhook_events (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null default 'cngn',
  event_type    text not null,
  external_ref  text,
  payload       jsonb not null,
  signature_ok  boolean not null,
  processed_at  timestamptz,
  received_at   timestamptz not null default now()
);

create index webhook_events_ref_idx on public.webhook_events (external_ref);

-- ---------------------------------------------------------------------------
-- Row level security: a sender sees only their own rows. Edge Functions use
-- the service role key and bypass all of this.
-- ---------------------------------------------------------------------------
alter table public.senders        enable row level security;
alter table public.recipients     enable row level security;
alter table public.schedules      enable row level security;
alter table public.runs           enable row level security;
alter table public.webhook_events enable row level security;

create policy senders_self on public.senders
  for all using (auth_user_id = auth.uid()) with check (auth_user_id = auth.uid());

create policy recipients_own on public.recipients
  for all using (sender_id in (select id from public.senders where auth_user_id = auth.uid()))
  with check (sender_id in (select id from public.senders where auth_user_id = auth.uid()));

create policy schedules_own on public.schedules
  for all using (sender_id in (select id from public.senders where auth_user_id = auth.uid()))
  with check (sender_id in (select id from public.senders where auth_user_id = auth.uid()));

-- Runs are written by the backend only; senders read their history.
create policy runs_own_read on public.runs
  for select using (sender_id in (select id from public.senders where auth_user_id = auth.uid()));

-- webhook_events: no policy at all, so only the service role can reach it.
