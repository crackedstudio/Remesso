/// Closes bank payouts whose webhook never arrived.
///
/// cNGN sends each webhook once, with a 10-second timeout and no retry. A
/// dropped connection, a cold start, or a deploy during the delivery window all
/// lose the event permanently — and the run sits in `redeeming` forever while
/// the recipient has, in fact, been paid.
///
/// So the transactions API is the authority and the webhook is the fast path.
/// This sweep is what makes the webhook optional rather than load-bearing.
import { createClient } from "npm:@supabase/supabase-js@2";
import { CngnError, findTransaction } from "../_shared/cngn.ts";
import { CNGN_API } from "../_shared/config.ts";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

/// Past this many sweeps (~2h at 10-minute cadence) a reference that cNGN has
/// never heard of is not going to resolve itself. Flag it for a human instead
/// of polling forever against a 20/min budget.
const MAX_ATTEMPTS = 12;

/// How long to leave a redemption alone before polling for it.
///
/// This was 10 minutes, sized to give the webhook a fair chance first. With no
/// webhook configured there is nothing to wait for: the transactions API is the
/// only way a redemption is ever observed, so the delay is pure settlement
/// latency. Two minutes still avoids polling a redemption cNGN has not had time
/// to process.
const STALE_AFTER = "2 minutes";

Deno.serve(async () => {
  if (!CNGN_API.apiKey || !CNGN_API.sshPrivateKey) {
    return json({ error: "cNGN credentials not configured" }, 500);
  }

  const { data: stale, error } = await db.rpc("stale_redemptions", {
    p_older_than: STALE_AFTER,
    // cNGN allows 20 requests per 60s per API key. The limiter in cngn.ts is
    // per-isolate, and each Edge Function invocation gets its own isolate, so
    // it cannot see requests made by a concurrent executor run. The budget is
    // therefore kept low here by construction rather than by coordination:
    // 5 runs x at most 2 pages = 10 requests worst case per sweep.
    p_limit: 5,
  });
  if (error) return json({ error: error.message }, 500);

  const results = [];
  for (const run of stale ?? []) {
    results.push(await reconcileOne(run));
  }
  return json({ checked: results.length, results });
});

async function reconcileOne(run: {
  run_id: string;
  cngn_trx_ref: string;
  reconcile_attempts: number;
}) {
  const now = new Date().toISOString();
  const attempts = run.reconcile_attempts + 1;

  try {
    const tx = await findTransaction(run.cngn_trx_ref);

    if (!tx) {
      if (attempts >= MAX_ATTEMPTS) {
        // Two hours of the API not knowing this reference. Either the
        // redemption was never opened or it was opened against a different
        // environment's key. Neither resolves by waiting.
        await db.from("runs").update({
          status: "failed",
          failure_reason:
            `cNGN has no transaction for ${run.cngn_trx_ref} after ${attempts} checks — ` +
            "reconcile manually before re-running this schedule",
          reconcile_attempts: attempts,
          reconciled_at: now,
          settled_at: now,
        }).eq("id", run.run_id).eq("status", "redeeming");
        return { run: run.run_id, outcome: "escalated" };
      }
      await db.from("runs")
        .update({ reconcile_attempts: attempts, reconciled_at: now })
        .eq("id", run.run_id);
      return { run: run.run_id, outcome: "not found yet", attempts };
    }

    switch (tx.status) {
      case "success":
        // Same guard as the webhook: only a run still in `redeeming` advances,
        // so this sweep and a late delivery cannot both settle it.
        await db.from("runs").update({
          status: "paid_out",
          redeemed_at: now,
          settled_at: now,
          reconcile_attempts: attempts,
          reconciled_at: now,
        }).eq("id", run.run_id).eq("status", "redeeming");
        return { run: run.run_id, outcome: "paid_out" };

      case "failed":
        await db.from("runs").update({
          status: "failed",
          failure_reason:
            "cNGN redemption failed — cNGN may be stranded at the redemption address",
          reconcile_attempts: attempts,
          reconciled_at: now,
          settled_at: now,
        }).eq("id", run.run_id).eq("status", "redeeming");
        return { run: run.run_id, outcome: "failed" };

      default:
        await db.from("runs")
          .update({ reconcile_attempts: attempts, reconciled_at: now })
          .eq("id", run.run_id);
        return { run: run.run_id, outcome: "still pending", attempts };
    }
  } catch (e) {
    // Do not burn an attempt on our own rate limit or a cNGN outage — that
    // would march a healthy run toward escalation for reasons of our making.
    const transient = e instanceof CngnError && e.retryable;
    if (!transient) {
      await db.from("runs")
        .update({ reconcile_attempts: attempts, reconciled_at: now })
        .eq("id", run.run_id);
    }
    return {
      run: run.run_id,
      outcome: transient ? "deferred" : "error",
      error: (e as Error).message,
    };
  }
}

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
