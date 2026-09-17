-- A direct payout lands in a wallet, so it needs the same address check the
-- wallet rail has. Written as a separate migration because a new enum value
-- cannot be referenced in the transaction that adds it.
alter table public.recipients
  drop constraint if exists wallet_payout_needs_address;

alter table public.recipients
  add constraint wallet_payout_needs_address check (
    payout_type = 'ngn_bank' or wallet_address ~ '^0x[a-fA-F0-9]{40}$'
  );
