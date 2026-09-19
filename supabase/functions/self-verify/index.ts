/// Starts a Self identity verification and reports where it stands.
///
/// Called by the Next route handler with the signed-in sender's JWT. The Self
/// API key never reaches the browser; the browser only ever gets back a
/// single-use `verificationUrl` to open.
///
/// Two ops:
///   start   open a Self session (or hand back the one still open)
///   status  the sender's standing, refreshing an open session from Self
///
/// `status` asks Self directly rather than waiting for the webhook. Self's
/// deliveries do retry (Svix), unlike cNGN's, but the rule here is the same as
/// for payouts: the provider's API is the record, the webhook is a shortcut.
/// The one thing only the webhook carries is the nullifier — see self-webhook.
///
/// Verification is optional and gates nothing. No payment path reads its
/// result.
import { createClient } from "npm:@supabase/supabase-js@2";
import { SELF_API } from "../_shared/config.ts";
import { createSession, getSession, SelfError } from "../_shared/self.ts";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("WEB_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/// Expired and errored sessions cost nothing, but an anonymous session can be
/// minted by anyone, so opening them is still bounded per sender.
const MAX_STARTS_PER_DAY = 5;

/// Reuse an open session only if there is enough time left to finish a
/// passport scan in it; otherwise the sender starts inside a dying link.
const REUSE_MIN_REMAINING_MS = 10 * 60_000;

type Row = {
  id: string;
  session_id: string | null;
  verification_url: string | null;
  status: string;
  environment: string | null;
  reason: string | null;
  expires_at: string | null;
  completed_at: string | null;
  created_at: string;
};

const COLUMNS =
  "id, session_id, verification_url, status, environment, reason, expires_at, completed_at, created_at";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return json({ error: "unauthenticated" }, 401);

  const { data: sender } = await db
    .from("senders")
    .select("id")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  if (!sender) return json({ error: "connect a wallet first" }, 400);

  let body: { op?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }

  try {
    switch (body.op) {
      case "status":
        return json({ data: await standing(sender.id) });
      case "start":
        if (!SELF_API.isConfigured) return json({ error: "identity verification is not available" }, 503);
        return json({ data: await start(sender.id) });
      default:
        return json({ error: `unknown op: ${body.op}` }, 400);
    }
  } catch (e) {
    if (e instanceof SelfError) {
      console.error("Self API error", e.status, e.code, e.message);
      // 401/403 from Self is our key, not the sender's problem.
      if (e.status === 401 || e.status === 403) {
        return json({ error: "identity verification is not configured correctly" }, 502);
      }
      return json({ error: e.message, retryable: e.retryable }, e.status === 429 ? 429 : 502);
    }
    console.error("self-verify failed", e);
    return json({ error: (e as Error).message }, 500);
  }
});

async function start(senderId: string) {
  const recent = await attempts(senderId);
  // Same environment only: a session opened under the test key cannot be
  // answered by a real passport, and handing it back after the switch to live
  // sends the sender into a request their document can never satisfy.
  const open = recent.find((r) =>
    r.status === "pending" && r.environment === currentEnvironment() &&
    r.verification_url && r.expires_at &&
    Date.parse(r.expires_at) - Date.now() > REUSE_MIN_REMAINING_MS
  );
  if (open) return { verificationUrl: open.verification_url };

  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { count } = await db
    .from("identity_verifications")
    .select("*", { count: "exact", head: true })
    .eq("sender_id", senderId)
    .gte("created_at", since);
  if ((count ?? 0) >= MAX_STARTS_PER_DAY) {
    throw new SelfError(429, "too many verification attempts today — try again tomorrow");
  }

  // Row first, so its id can travel to Self as externalUuid and come back in
  // the webhook. A delivery then needs nothing from its payload to find us.
  const { data: row, error } = await db
    .from("identity_verifications")
    .insert({ sender_id: senderId })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  try {
    const back = returnUrl();
    const session = await createSession({
      externalUuid: row.id,
      // Self finishes in the phone's own browser, not in MiniPay, so this lands
      // somewhere with no wallet. /verified says so and sends them back.
      ...(back ? { successUrl: `${back}/verified?ok=1`, failureUrl: `${back}/verified?ok=0` } : {}),
    });
    await db.from("identity_verifications").update({
      session_id: session.id,
      verification_url: session.verificationUrl,
      expires_at: session.expiresAt,
      environment: currentEnvironment(),
      updated_at: new Date().toISOString(),
    }).eq("id", row.id);
    return { verificationUrl: session.verificationUrl };
  } catch (e) {
    // No session exists for this row; leaving it would read as an attempt
    // the sender never got to make.
    await db.from("identity_verifications").delete().eq("id", row.id);
    throw e;
  }
}

async function standing(senderId: string) {
  const recent = await attempts(senderId);
  const newest = recent[0];

  // A session belongs to the key that opened it; the other environment's key
  // gets a 404 for it. Leave it to expire rather than ask the wrong API.
  if (
    newest?.status === "pending" && newest.session_id && SELF_API.isConfigured &&
    newest.environment === currentEnvironment()
  ) {
    // Self being unreachable should leave the sender looking at what we
    // already know, not at an error about a feature they may not care about.
    const detail = await getSession(newest.session_id).catch((e) => {
      console.error("Self session refresh failed", newest.session_id, (e as Error).message);
      return null;
    });
    if (detail && detail.status !== "pending") {
      // Guarded on `pending`: if the webhook landed first it may have set
      // `duplicate`, which Self's own status cannot know about.
      await db.from("identity_verifications").update({
        status: detail.status,
        proof_attributes: detail.proofAttributes,
        completed_at: detail.completedAt ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", newest.id).eq("status", "pending");
      const { data: fresh } = await db
        .from("identity_verifications")
        .select(COLUMNS)
        .eq("id", newest.id)
        .single();
      if (fresh) Object.assign(newest, fresh);
    }
  }

  // A valid result stands even if a later retry failed or is still open.
  const verified = recent.find((r) => r.status === "valid");
  const pendingUrl = newest?.status === "pending" && newest.expires_at &&
      newest.environment === currentEnvironment() &&
      Date.parse(newest.expires_at) > Date.now()
    ? newest.verification_url
    : null;

  return {
    available: SELF_API.isConfigured,
    verified: verified
      ? { environment: verified.environment, completedAt: verified.completed_at }
      : null,
    latest: newest
      ? { status: newest.status, reason: newest.reason, verificationUrl: pendingUrl }
      : null,
  };
}

async function attempts(senderId: string): Promise<Row[]> {
  const { data, error } = await db
    .from("identity_verifications")
    .select(COLUMNS)
    .eq("sender_id", senderId)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) throw new Error(error.message);
  return (data ?? []) as Row[];
}

/// The API key alone decides the environment; there is no separate setting.
function currentEnvironment(): "live" | "test" {
  return SELF_API.apiKey.startsWith("sk_live") ? "live" : "test";
}

/// Where Self sends the sender back to. Only a concrete origin will do; the
/// CORS wildcard is not a place.
function returnUrl(): string | null {
  const origin = Deno.env.get("WEB_ORIGIN") ?? "";
  return /^https?:\/\/[^*\s]+$/.test(origin) ? origin.replace(/\/+$/, "") : null;
}

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
