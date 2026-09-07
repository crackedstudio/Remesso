/// Threshold triggers and pre-flight warnings.
///
/// Postgres cannot watch an on-chain balance, so this closes that gap: it
/// checks every active schedule's funding and allowance ahead of the next run
/// and warns the sender BEFORE a run fails, not after. It never executes
/// anything — that is execute-due-runs' job alone.
import { createClient } from "npm:@supabase/supabase-js@2";
import { runnability } from "../_shared/celo.ts";
import { liquidityIsHealthy } from "../_shared/celo.ts";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async () => {
  const { data: schedules, error } = await db
    .from("schedules")
    .select("id, onchain_id, amount_in, sender_id, label")
    .eq("status", "active")
    .not("onchain_id", "is", null)
    .lte("next_run_at", new Date(Date.now() + 24 * 3600 * 1000).toISOString());

  if (error) return new Response(error.message, { status: 500 });

  const warnings: Array<Record<string, unknown>> = [];

  for (const s of schedules ?? []) {
    const r = await runnability(BigInt(s.onchain_id));
    if (!r.funded) {
      warnings.push({ schedule: s.id, kind: "underfunded" });
    }
    if (!r.approved) {
      warnings.push({ schedule: s.id, kind: "allowance_revoked" });
    }
    const health = await liquidityIsHealthy(BigInt(s.amount_in));
    if (!health.ok) {
      warnings.push({ schedule: s.id, kind: "thin_liquidity", impactBps: health.impactBps });
    }
  }

  // TODO(notify): route these to the sender by email/push. Deliberately left
  // as a single seam rather than scattered through the executor.
  return new Response(JSON.stringify({ checked: schedules?.length ?? 0, warnings }), {
    headers: { "Content-Type": "application/json" },
  });
});
