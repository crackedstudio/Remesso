-- `onchain_id` was globally unique, which assumes there is only ever one
-- executor contract. There isn't: the contract is immutable, so fixing a defect
-- means deploying a new one — and every deployment numbers its schedules from 1.
-- Deploying V2 immediately collided with V1's schedule #1.
--
-- The identity of a schedule is (which contract, which id), so the constraint
-- becomes that pair. This also keeps V1's run history readable instead of
-- forcing a delete to make room.
alter table public.schedules
  add column if not exists executor_address text;

-- Backfill: every existing row predates V2 and therefore belongs to V1.
update public.schedules
   set executor_address = '0xC7eF75fC6283aB3b810fa4dE270F074C47761189'
 where executor_address is null;

alter table public.schedules
  drop constraint if exists schedules_onchain_id_key;

create unique index if not exists schedules_contract_onchain_id_idx
  on public.schedules (executor_address, onchain_id)
  where onchain_id is not null;

comment on column public.schedules.executor_address is
  'Which RemessoExecutor deployment this schedule lives in. Scheduled ids are '
  'per-contract, so this is half of a schedule''s identity.';
