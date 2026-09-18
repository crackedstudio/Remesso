-- Lower the interval floor from one hour to five minutes.
--
-- `sane_interval` is a rail against a runaway schedule — a typo turning a
-- monthly remittance into a per-second one — not a statement of product policy.
-- The shortest cadence the UI actually offers is weekly, so the old 3600 was
-- already two orders of magnitude below anything a sender can pick.
--
-- Five minutes is what a test needs to watch the agent execute, reschedule and
-- execute again inside one sitting. At weekly, a live schedule yields exactly
-- one observable run and then nothing for seven days, which proves a run
-- happened but not that the loop repeats.
--
-- It stays a rail: per-second and per-minute schedules remain rejected, and the
-- real limits on damage are elsewhere and unchanged — `max_runs`, the ERC-20
-- allowance the sender approved, MAX_RUN_AMOUNT_USDT, and the contract's own
-- envelope, which is the only authority that actually moves money.

alter table public.schedules
  drop constraint sane_interval;

alter table public.schedules
  add constraint sane_interval check (interval_seconds >= 300);
