"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (!client) {
    client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: true, autoRefreshToken: true } },
    );
  }
  return client;
}

/// Bind a connected wallet to a Supabase session.
///
/// This is anonymous auth, not proof of wallet ownership, and the reason is
/// MiniPay: it does not support message signing, so SIWE — the normal way to
/// prove an address — is unavailable to most of this audience.
///
/// What that does and does not cost us:
///   - It does NOT weaken the money path. The contract checks `msg.sender`
///     against the schedule owner for pause and cancel, and the executor can
///     only ever pay the destination the sender signed. Nothing in this
///     database can move funds.
///   - It DOES mean the `senders` row is a claim rather than a proof, and the
///     unique constraint on `wallet_address` makes claiming first-come. A
///     squatter could block an address from being registered.
///
/// See README "Sender identity" for the fix once a signing path exists.
export async function ensureSender(walletAddress: string) {
  const sb = supabase();

  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    const { error } = await sb.auth.signInAnonymously();
    if (error) throw new Error(`sign-in failed: ${error.message}`);
  }

  const { data: { user } } = await sb.auth.getUser();
  if (!user) throw new Error("no session after sign-in");

  const address = walletAddress.toLowerCase();

  const { data: existing } = await sb
    .from("senders")
    .select("id, wallet_address")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (existing) {
    // A different wallet in the same browser session. Point the row at it
    // rather than silently reporting the previous wallet's schedules.
    if (existing.wallet_address !== address) {
      const { error } = await sb
        .from("senders")
        .update({ wallet_address: address })
        .eq("id", existing.id);
      if (error) throw new Error(claimMessage(error.message));
    }
    return existing.id as string;
  }

  const { data, error } = await sb
    .from("senders")
    .insert({ auth_user_id: user.id, wallet_address: address })
    .select("id")
    .single();
  if (error) throw new Error(claimMessage(error.message));
  return data.id as string;
}

function claimMessage(msg: string): string {
  return /duplicate key|unique/i.test(msg)
    ? "This wallet is already registered in another session. Open Remesso in the browser you first used it in, or contact support."
    : msg;
}
