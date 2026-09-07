"use client";

import { supabase } from "./supabase";

/// Every cNGN call from the browser goes through our own route handlers, which
/// forward to the cngn-proxy Edge Function. The browser never sees a cNGN
/// credential, and cNGN only ever sees one source IP.
async function authedFetch(path: string, init: RequestInit = {}) {
  const { data: { session } } = await supabase().auth.getSession();
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
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
