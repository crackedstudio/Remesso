/// Picks up schedules pg_cron says are due and executes them.
///
/// Ordering matters and is the whole point of this file:
///
///   wallet payout   quote -> simulate -> executeRun -> delivered
///   bank payout     quote -> redeemAsset (get deposit address)
///                         -> executeRun sending cNGN there
///                         -> redeeming -> [webhook] -> paid_out
///
/// A bank run is NOT complete when the swap settles. It is complete when cNGN
/// says naira reached the account. Marking it earlier is the mistake that
/// tells a sender money arrived when it has not.
import { createClient } from "npm:@supabase/supabase-js@2";
import { CELO, LIMITS, requireEnv } from "../_shared/config.ts";
import {
  executeRun,
  getSchedule,
  liquidityIsHealthy,
  quoteUsdtToCngn,
  runnability,
} from "../_shared/celo.ts";
import { assertCeloSupported, CngnError, redeemToBank } from "../_shared/cngn.ts";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  try {
    requireEnv();
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }

  const { data: due, error } = await db.rpc("due_schedules", { p_limit: 50 });
  if (error) return json({ error: error.message }, 500);

  const schedules = due ?? [];

  // One cached call per environment, not per run: confirm cNGN still lists Celo
  // as enabled before any bank payout is attempted. Wallet payouts touch no
  // cNGN API at all and must not be blocked by this.
  if (schedules.some((s: { payout_type: string }) => s.payout_type === "ngn_bank")) {
    try {
      await assertCeloSupported();
    } catch (e) {
      return json({ error: `cNGN preflight failed: ${(e as Error).message}` }, 503);
    }
  }

  const results = [];
  for (const s of schedules) {
    results.push(await runOne(s));
  }
  return json({ processed: results.length, results });
});

async function runOne(s: {
  schedule_id: string;
  onchain_id: string;
  sender_id: string;
  amount_in: string;
  payout_type: "wallet" | "ngn_bank";
}) {
  const onchainId = BigInt(s.onchain_id);
  const amountIn = BigInt(s.amount_in);

  // Claim the attempt first. The unique (schedule_id, attempt) constraint is
  // the idempotency key: a duplicate cron tick loses the insert and exits.
  const { count } = await db
    .from("runs")
    .select("*", { count: "exact", head: true })
    .eq("schedule_id", s.schedule_id);
  const attempt = (count ?? 0) + 1;

  const { data: run, error: claimErr } = await db
    .from("runs")
    .insert({
      schedule_id: s.schedule_id,
      sender_id: s.sender_id,
      attempt,
      amount_in: s.amount_in,
      status: "pending",
    })
    .select()
    .single();

  if (claimErr) return { schedule: s.schedule_id, skipped: "already claimed" };

  const fail = async (reason: string, status: "failed" | "skipped" = "failed") => {
    await db.from("runs").update({
      status,
      failure_reason: reason,
      settled_at: new Date().toISOString(),
    }).eq("id", run.id);
    return { schedule: s.schedule_id, status, reason };
  };

  try {
    // 1. Ask the contract, not the database. It is the authority.
    const r = await runnability(onchainId);
    if (!r.due) return await fail("not due on-chain", "skipped");
    if (!r.funded) return await fail("sender funding wallet is short", "skipped");
    if (!r.approved) return await fail("sender allowance revoked or too low", "skipped");

    // 2. Backstop the on-chain envelope with our own ceiling.
    if (amountIn > BigInt(LIMITS.maxRunAmountUsdt) * 1_000_000n) {
      return await fail(`amount exceeds backend cap of ${LIMITS.maxRunAmountUsdt} USDT`);
    }

    // 3. One pool, ~$95k deep. Confirm it can still fill this before spending gas.
    const health = await liquidityIsHealthy(amountIn);
    if (!health.ok) {
      return await fail(`pool impact ${health.impactBps}bps exceeds limit`, "skipped");
    }

    const quote = await quoteUsdtToCngn(amountIn);
    await db.from("runs").update({
      status: "swapping",
      quoted_rate_e6: quote.rateE6.toString(),
      min_out: quote.minOut.toString(),
    }).eq("id", run.id);

    // 4. For a bank payout, open the redemption BEFORE moving any money, so
    //    the swap can deliver straight to the address cNGN gives us.
    let cngnTrxRef: string | null = null;
    if (s.payout_type === "ngn_bank") {
      const recipient = await bankDetails(s.schedule_id);

      // cNGN is 6dp on Celo; redeemAsset takes whole naira and rejects
      // anything under 1. Truncating is deliberate — rounding up would ask
      // cNGN to burn cNGN the swap did not produce.
      const wholeNaira = Number(quote.amountOut / 1_000_000n);
      if (wholeNaira < 1) {
        return await fail(`swap output ${quote.amountOut} is below cNGN's 1 naira minimum`);
      }

      const redemption = await redeemToBank({
        amount: wholeNaira,
        bankCode: recipient.bank_code,
        accountNumber: recipient.account_number,
      });
      cngnTrxRef = redemption.trxRef;

      // The contract fixes `destination` at authorisation and cannot be
      // steered here. If cNGN hands back a different address, the swap would
      // deliver cNGN somewhere the redemption is not watching and the naira
      // would never arrive — so stop before spending gas.
      const dest = (await getSchedule(onchainId)).destination.toLowerCase();
      if (redemption.address.toLowerCase() !== dest) {
        return await fail(
          `cNGN redemption address ${redemption.address} does not match the ` +
            `sender-authorised destination ${dest}; the sender must re-authorise`,
        );
      }

      await db.from("runs").update({
        cngn_trx_ref: cngnTrxRef,
        cngn_deposit_address: redemption.address,
      }).eq("id", run.id);
    }

    // 5. Execute. The contract re-checks every limit.
    const { hash, receipt } = await executeRun(onchainId, quote.minOut);

    await db.from("runs").update({
      status: s.payout_type === "ngn_bank" ? "redeeming" : "delivered",
      tx_hash: hash,
      block_number: Number(receipt.blockNumber),
      gas_used: receipt.gasUsed.toString(),
      amount_out: quote.amountOut.toString(),
      settled_at: s.payout_type === "ngn_bank" ? null : new Date().toISOString(),
    }).eq("id", run.id);

    await db.from("schedules").update({
      next_run_at: new Date(Number(r.nextRunAt) * 1000).toISOString(),
    }).eq("id", s.schedule_id);

    return { schedule: s.schedule_id, status: "ok", hash, awaitingPayout: !!cngnTrxRef };
  } catch (e) {
    const msg = e instanceof CngnError
      ? `cNGN ${e.status}: ${e.message}${e.retryable ? " (retryable)" : ""}`
      : (e as Error).message;
    return await fail(msg);
  }
}

async function bankDetails(scheduleId: string) {
  const { data, error } = await db
    .from("schedules")
    .select("recipients(bank_code, account_number, bank_verified_at)")
    .eq("id", scheduleId)
    .single();
  if (error) throw new Error(error.message);
  // supabase-js types an embedded relation as an array regardless of cardinality.
  type Bank = { bank_code: string; account_number: string; bank_verified_at: string | null };
  const rel = (data as unknown as { recipients: Bank | Bank[] }).recipients;
  const r = Array.isArray(rel) ? rel[0] : rel;
  if (!r) throw new Error("schedule has no recipient");
  if (!r.bank_verified_at) throw new Error("recipient bank account not verified");
  return r;
}

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
