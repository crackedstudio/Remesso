/// Receives cNGN webhook deliveries.
///
/// This is the only thing that may move an ngn_bank run to `paid_out`. The
/// on-chain swap settling means cNGN reached the redemption address; it does
/// not mean the recipient has naira. Only `redemption.completed` means that.
///
/// Two facts from the docs shape this handler:
///
///   1. "Deliveries are sent once, with a 10-second timeout, and are not
///      automatically retried." A 500 from us loses the event permanently, so
///      we persist and acknowledge first and do the work afterwards — and
///      `reconcile-redemptions` sweeps for whatever still goes missing.
///   2. Signature is `X-cNGN-Signature: sha256=<hex>`, an HMAC-SHA256 of the
///      raw body. Parse nothing before it verifies.
import { createClient } from "npm:@supabase/supabase-js@2";
import { CNGN_API } from "../_shared/config.ts";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

type Delivery = {
  event: string;
  data: Record<string, unknown>;
  timestamp?: string;
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const raw = await req.text();
  const signature = req.headers.get("x-cngn-signature") ?? "";
  const ok = await verify(raw, signature);

  let payload: Delivery;
  try {
    payload = JSON.parse(raw) as Delivery;
  } catch {
    // Still worth a row: unparseable bodies at this URL are either a cNGN
    // change or someone probing it.
    await db.from("webhook_events").insert({
      event_type: "unparseable",
      payload: { raw: raw.slice(0, 4000) },
      signature_ok: ok,
    });
    return new Response("bad json", { status: 400 });
  }

  const { transactionId, ref } = identifiers(payload);

  // Persist every delivery, valid or not — an unsigned flood is itself signal.
  // The unique index on (event_type, transaction_id) makes a replayed delivery
  // a no-op rather than a double payout.
  const { data: inserted, error: insertErr } = await db
    .from("webhook_events")
    .insert({
      event_type: payload.event,
      transaction_id: transactionId,
      external_ref: ref,
      payload,
      signature_ok: ok,
    })
    .select("id")
    .maybeSingle();

  if (!ok) return new Response("invalid signature", { status: 401 });

  // Duplicate delivery: the insert lost to the unique index. Already handled.
  if (insertErr) return new Response("ok (duplicate)", { status: 200 });

  // Acknowledge inside the 10s window, then work. There is no second delivery.
  queueMicrotask(() =>
    process(payload, ref, inserted?.id ?? null).catch((e) =>
      console.error("webhook processing failed", payload.event, ref, e)
    )
  );
  return new Response("ok", { status: 200 });
});

/// cNGN uses `trx_ref` in webhook payloads and `trxRef` in API responses for
/// the same value. Accept both rather than depending on which side we are on.
function identifiers(p: Delivery) {
  const d = p.data ?? {};
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = d[k];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return null;
  };
  return {
    transactionId: pick("transactionId", "transaction_id", "id"),
    ref: pick("trx_ref", "trxRef", "reference"),
  };
}

async function process(payload: Delivery, ref: string | null, eventRowId: string | null) {
  const done = async () => {
    if (eventRowId) {
      await db.from("webhook_events")
        .update({ processed_at: new Date().toISOString() })
        .eq("id", eventRowId);
    }
  };

  if (!ref) return await done();
  const now = new Date().toISOString();

  switch (payload.event) {
    case "redemption.completed": {
      // Guarded on `redeeming` so a replay cannot resurrect a failed run, and
      // so a completion for a run we never opened is ignored rather than
      // inventing state.
      await db.from("runs")
        .update({ status: "paid_out", redeemed_at: now, settled_at: now })
        .eq("cngn_trx_ref", ref)
        .eq("status", "redeeming");
      break;
    }

    case "transaction.failed": {
      const reason = typeof payload.data?.reason === "string"
        ? payload.data.reason
        : String(payload.data?.status ?? "unknown");
      // A failure after the swap means cNGN is sitting at the redemption
      // address with no naira paid. That needs a human, so it is recorded as a
      // distinct reason rather than a generic failure.
      await db.from("runs")
        .update({
          status: "failed",
          failure_reason: `cNGN redemption failed (${reason}) — cNGN may be stranded at the redemption address`,
          settled_at: now,
        })
        .eq("cngn_trx_ref", ref)
        .in("status", ["redeeming", "swapping", "pending"]);
      break;
    }

    case "deposit.received":
    case "deposit.completed":
    case "withdrawal.completed":
      // Not part of the remittance path today. Recorded above for audit.
      break;
  }

  await done();
}

/// HMAC-SHA256 over the raw body, hex, compared in constant time.
async function verify(raw: string, header: string): Promise<boolean> {
  if (!header || !CNGN_API.webhookSecret) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(CNGN_API.webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const expected = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return timingSafeEqual(expected, header.trim().toLowerCase().replace(/^sha256=/, ""));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
