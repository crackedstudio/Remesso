-- V3 adds a Direct rail where the sender funds in USDT, USDC or cUSD and the
-- recipient receives that same asset unswapped. The funding asset is therefore
-- per-schedule rather than a fixed property of the contract, and the mirror has
-- to record it — not least because the three do not share a scale: USDT and
-- USDC are 6dp, cUSD is 18dp. Formatting amount_in without knowing which one
-- is a factor of 10^12.
alter table public.schedules
  add column if not exists token_address text;

-- Every pre-V3 schedule was funded in USDT; nothing else was possible.
update public.schedules
   set token_address = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e'
 where token_address is null;

comment on column public.schedules.token_address is
  'Asset pulled from the sender. Swap rails: always USDT. Direct rail: whichever '
  'allowed stablecoin the sender chose. Decimals vary by token — do not assume 6.';

alter table public.runs
  add column if not exists token_address text;

comment on column public.runs.token_address is
  'Copied from the schedule at run time so historical rows stay readable if a '
  'schedule is deleted.';
