-- Self identity verification, one row per attempt.
--
-- Optional, and it gates nothing: no payment path reads this table. It records
-- what Self attested about a sender (a Pre-KYC flow: OFAC screening, minimum
-- age, a per-person nullifier) so the app can show it and a later decision to
-- require it has history to stand on.
--
-- What it does NOT prove: that the verified person controls the wallet. MiniPay
-- cannot sign messages, so the sender row is still an anonymous-session claim
-- (see ensureSender). The attestation is about a human, bound to that claim.

create table public.identity_verifications (
  -- Passed to Self as `externalUuid` and echoed back in the webhook, so a
  -- delivery resolves to exactly one row by an id we minted.
  id              uuid primary key default gen_random_uuid(),
  sender_id       uuid not null references public.senders(id) on delete cascade,
  provider        text not null default 'self',

  -- Null only between the insert and Self answering the create call.
  session_id      text unique,
  verification_url text,

  -- Self's session statuses, plus one of ours: `duplicate` means the proof
  -- was valid but the same nullifier already verified a different sender.
  status          text not null default 'pending',
  -- sk_test_ keys accept the Self app's mock passports. Never render a
  -- `test` result as if a real document stood behind it.
  environment     text,
  nullifier       text,
  proof_attributes jsonb,
  reason          text,

  expires_at      timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint identity_status_known check (
    status in ('pending', 'valid', 'invalid', 'error', 'expired', 'duplicate')
  ),
  constraint identity_environment_known check (
    environment is null or environment in ('test', 'live')
  )
);

create index identity_verifications_sender_idx
  on public.identity_verifications (sender_id, created_at desc);

-- Not unique: the same person re-verifying the same sender produces the same
-- nullifier on a new row, and that is fine. What is checked (in self-webhook)
-- is the same nullifier across two different senders. If verification ever
-- gates money, promote this to a constraint on a (nullifier -> sender) table.
create index identity_verifications_nullifier_idx
  on public.identity_verifications (nullifier)
  where nullifier is not null;

-- Written only by the self-verify and self-webhook functions (service role).
-- A sender may read their own attempts; nothing else, and no writes, so the
-- browser cannot mark itself verified.
alter table public.identity_verifications enable row level security;

create policy identity_verifications_own_read on public.identity_verifications
  for select using (
    sender_id in (select id from public.senders where auth_user_id = auth.uid())
  );
