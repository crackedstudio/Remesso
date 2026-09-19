/// Receives Self webhook deliveries.
///
/// Not load-bearing for status — self-verify polls Self's session API for that.
/// What only arrives here is the nullifier: a per-person value derived from the
/// passport, stable across sessions. It is how two Remesso senders are
/// recognised as the same human, so a result for a nullifier already verified
/// on another sender is recorded as `duplicate` rather than `valid`.
///
/// Self delivers through Svix, which retries a non-2xx with backoff. That is the
/// opposite of cNGN (one attempt, no retry), and it changes the shape of this
/// handler: work is done before answering, and a failure answers 500 so the
/// delivery comes back, instead of acknowledging first and sweeping later.
import { createClient } from "npm:@supabase/supabase-js@2";
import { SELF_API } from "../_shared/config.ts";
import { type VerificationCompleted, verifyWebhook } from "../_shared/self.ts";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const raw = await req.text();
  const ok = await verifyWebhook(raw, req.headers, SELF_API.webhookSecret);

  let event: { type?: string; [k: string]: unknown };
  try {
    event = JSON.parse(raw);
  } catch {
    await db.from("webhook_events").insert({
      provider: "self",
      event_type: "unparseable",
      payload: { raw: raw.slice(0, 4000) },
      signature_ok: ok,
    });
    return new Response("bad json", { status: 400 });
  }

  // The raw proof is large and we never re-verify it; everything we act on is
  // in the attested fields beside it.
  const { proof: _proof, ...kept } = event;
  const messageId = req.headers.get("svix-id") ?? req.headers.get("webhook-id");

  // svix-id is constant across retries of one message, so the existing unique
  // index on (event_type, transaction_id) makes a redelivery find its row.
  const { data: inserted } = await db
    .from("webhook_events")
    .insert({
      provider: "self",
      event_type: String(event.type ?? "unknown"),
      transaction_id: ok ? messageId : null,
      external_ref: typeof event.external_uuid === "string" ? event.external_uuid : null,
      payload: kept,
      signature_ok: ok,
    })
    .select("id, processed_at")
    .maybeSingle();

  if (!ok) return new Response("invalid signature", { status: 401 });

  // Lost the insert to the unique index: a retry. Only redo the work if the
  // first attempt never finished it.
  let eventRow = inserted;
  if (!eventRow) {
    const { data } = await db
      .from("webhook_events")
      .select("id, processed_at")
      .eq("event_type", String(event.type))
      .eq("transaction_id", messageId)
      .maybeSingle();
    if (data?.processed_at) return new Response("ok (duplicate)", { status: 200 });
    eventRow = data;
  }

  try {
    if (event.type === "verification.completed") {
      await completed(event as unknown as VerificationCompleted);
    }
    // verification.storage_committed / storage_failed concern Self's own
    // proof custody and change nothing on our side. Recorded above for audit.

    if (eventRow) {
      await db.from("webhook_events")
        .update({ processed_at: new Date().toISOString() })
        .eq("id", eventRow.id);
    }
    return new Response("ok", { status: 200 });
  } catch (e) {
    console.error("self-webhook processing failed", event.type, e);
    return new Response("retry", { status: 500 });
  }
});

async function completed(e: VerificationCompleted) {
  // We minted external_uuid as the row id. Anything else is not ours — most
  // likely a test-environment delivery aimed at a shared endpoint.
  if (!UUID.test(e.external_uuid ?? "")) return;
  const { data: row, error } = await db
    .from("identity_verifications")
    .select("id, sender_id")
    .eq("id", e.external_uuid)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) return;

  let status: string = e.status;
  let reason = e.reason ?? null;

  if (e.status === "valid" && e.nullifier) {
    const { data: other, error: dupErr } = await db
      .from("identity_verifications")
      .select("id")
      .eq("nullifier", e.nullifier)
      .eq("status", "valid")
      .neq("sender_id", row.sender_id)
      .limit(1);
    if (dupErr) throw new Error(dupErr.message);
    if (other?.length) {
      status = "duplicate";
      reason = "this identity is already verified on another Remesso account";
    }
  }

  const { error: updErr } = await db.from("identity_verifications").update({
    status,
    reason,
    nullifier: e.nullifier,
    environment: e.environment,
    proof_attributes: e.proof_attributes,
    completed_at: e.verified_at,
    updated_at: new Date().toISOString(),
  }).eq("id", row.id);
  if (updErr) throw new Error(updErr.message);
}
