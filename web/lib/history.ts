/// Merges the database's view of a schedule's runs with the chain's. Pure so
/// it can be pinned by `history.test.ts`; `useHistory` in hooks.ts is the
/// React side.
///
/// The database is the spine because it knows things the chain never will —
/// a failed quote, a skipped run, a bank payout still redeeming. The subgraph
/// knows one thing the database learns late: that a run executed. So each
/// `RunExecuted` is matched to its row by tx hash, or to the row currently in
/// flight when the backend has not written the hash yet, and that row is
/// shown as settled with the chain's numbers. An event with no row at all is
/// rendered from the event alone — the contract is the authority, and a run
/// it made is not hidden because the mirror is behind.
///
/// A bank run becomes `redeeming`, not `delivered`: the swap landing means
/// cNGN reached the redemption address, not that anyone has naira.

import type { OnchainRun } from "./goldsky";
import { one, type Run, type Schedule } from "./types";

export function mergeHistory(
  schedule: Schedule | null | undefined,
  dbRuns: Run[] | undefined,
  events: OnchainRun[] | null,
): Run[] {
  const rows = [...(dbRuns ?? [])];
  if (!events?.length || !schedule) return rows;

  const isBank = one(schedule.recipients)?.payout_type === "ngn_bank";
  const byTx = new Map(
    rows.filter((r) => r.tx_hash).map((r) => [r.tx_hash!.toLowerCase(), r]),
  );
  // Oldest first: an in-flight row without a hash is claimed by the earliest
  // unmatched event, which is the only pairing that is ever right because the
  // executor runs schedules sequentially.
  const inflight = rows
    .filter((r) => !r.tx_hash && (r.status === "pending" || r.status === "swapping"))
    .sort((a, b) => a.attempt - b.attempt);

  const out: Run[] = [];
  const taken = new Set<string>();
  for (const ev of [...events].sort((a, b) => a.blockNumber - b.blockNumber)) {
    const settled = {
      status: (isBank ? "redeeming" : "delivered") as Run["status"],
      tx_hash: ev.txHash,
      block_number: ev.blockNumber,
      amount_out: ev.amountOut,
      settled_at: new Date(ev.timestamp * 1000).toISOString(),
    };
    const matched = byTx.get(ev.txHash) ?? inflight.shift();
    if (matched) {
      taken.add(matched.id);
      // A row the backend has already settled carries more than the event
      // does (cNGN reference, later payout state), so it is left alone.
      out.push(matched.tx_hash ? matched : { ...matched, ...settled });
    } else {
      out.push({
        id: `onchain:${ev.txHash}`,
        schedule_id: schedule.id,
        attempt: ev.runsExecuted,
        amount_in: ev.amountIn,
        quoted_rate_e6: null,
        token_address: schedule.token_address,
        min_out: null,
        cngn_trx_ref: null,
        cngn_deposit_address: null,
        redeemed_at: null,
        failure_reason: null,
        started_at: settled.settled_at,
        ...settled,
      });
    }
  }
  for (const r of rows) if (!taken.has(r.id)) out.push(r);

  // Newest first, as the database orders it; the synthesised rows have only
  // a block time to sort by, so time is the key for everything.
  return out.sort(
    (a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || b.attempt - a.attempt,
  );
}
