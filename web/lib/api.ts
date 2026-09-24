"use client";

import { ensureSession } from "./supabase";

/// Every cNGN call from the browser goes through our own route handlers, which
/// forward to the cngn-proxy Edge Function. The browser never sees a cNGN
/// credential, and cNGN only ever sees one source IP.
async function authedFetch(path: string, init: RequestInit = {}) {
  // Establish the session rather than discovering its absence server-side:
  // this runs on a phone, on a fresh origin, possibly before the wallet has
  // connected, and "sign in to continue" names a screen that does not exist.
  const token = await ensureSession();
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `request failed (${res.status})`);
  return json;
}

export type Bank = { name: string; code: string };
export type AccountDetails = {
  accountNumber: string;
  accountName: string;
  bankCode: string;
};

export async function fetchBanks(): Promise<Bank[]> {
  return (await authedFetch("/api/cngn/banks")).data;
}

/// Where the sender stands with Self. `verified` survives later failed
/// attempts; `latest` is the most recent attempt, whatever its outcome.
export type IdentityStanding = {
  available: boolean;
  verified: { environment: "test" | "live" | null; completedAt: string | null } | null;
  latest: {
    status: "pending" | "valid" | "invalid" | "error" | "expired" | "duplicate";
    reason: string | null;
    verificationUrl: string | null;
  } | null;
};

export async function identityStanding(): Promise<IdentityStanding> {
  return (await authedFetch("/api/self", { method: "POST", body: JSON.stringify({ op: "status" }) })).data;
}

export async function startIdentityCheck(): Promise<{ verificationUrl: string }> {
  return (await authedFetch("/api/self", { method: "POST", body: JSON.stringify({ op: "start" }) })).data;
}

export async function verifyAccount(
  bankCode: string,
  accountNumber: string,
): Promise<AccountDetails> {
  return (
    await authedFetch("/api/cngn/verify-account", {
      method: "POST",
      body: JSON.stringify({ bankCode, accountNumber }),
    })
  ).data;
}
