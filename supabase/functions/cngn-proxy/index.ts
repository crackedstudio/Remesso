/// The only path from the frontend to the cNGN API.
///
/// Why a proxy and not a direct call: the API key, the AES encryption key and
/// the Ed25519 private key are all server-only ("Never embed your API key,
/// encryption key, or Ed25519 private key in client-side or mobile code"), and
/// cNGN whitelists by source IP. Funnelling every call through one function
/// means one set of secrets and one IP to whitelist.
///
/// Exposes only the two read/verify operations a sender needs during
/// onboarding. Nothing here can move money — `redeemAsset` is deliberately
/// absent, and is reachable only from the executor loop.
import { createClient } from "npm:@supabase/supabase-js@2";
import { CngnError, getBanks, verifyAccount } from "../_shared/cngn.ts";

const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("WEB_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // Anonymous callers do not get to spend our 20-requests-per-minute budget.
  const authHeader = req.headers.get("Authorization") ?? "";
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return json({ error: "unauthenticated" }, 401);

  let body: { op?: string; bankCode?: string; accountNumber?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }

  try {
    switch (body.op) {
      case "banks":
        // Cached in-process for 6h; the frontend caches it again for a day.
        return json({ data: await getBanks() });

      case "verifyAccount": {
        const { bankCode, accountNumber } = body;
        if (!bankCode || !/^[0-9]{10}$/.test(accountNumber ?? "")) {
          return json({ error: "bankCode and a 10-digit accountNumber are required" }, 400);
        }
        return json({ data: await verifyAccount(bankCode, accountNumber!) });
      }

      default:
        return json({ error: `unknown op: ${body.op}` }, 400);
    }
  } catch (e) {
    if (e instanceof CngnError) {
      // Config errors are ours, not the sender's. Say so plainly in the logs
      // and give the sender something that is not a raw upstream string.
      if (e.isConfigError) {
        console.error("cNGN configuration error:", e.message, e.body);
        return json({ error: "payout provider is not configured correctly" }, 502);
      }
      return json({ error: e.message, retryable: e.retryable }, e.status === 429 ? 429 : 400);
    }
    console.error("cngn-proxy failed", e);
    return json({ error: (e as Error).message }, 500);
  }
});

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
