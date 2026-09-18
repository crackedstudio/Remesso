"use client";

import { supabase } from "./supabase";

/// The assistant, from the browser's side.
///
/// Everything here is advisory. `parseSchedule` returns a draft the sender
/// still edits and signs, and `explainRun` only rewords something the backend
/// already decided. Neither can cause a payment.

export type Draft = {
  amount: string | null;
  token: "USDT" | "USDC" | "cUSD" | null;
  intervalSeconds: number | null;
  maxRuns: number | null;
  destination: `0x${string}` | null;
  recipientName: string | null;
  payoutType: "direct";
};

export type ParseResult = { draft: Draft; note: string | null; missing: string[] };
export type Explanation = { title: string; detail: string; action: string | null };

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data } = await supabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("sign in to continue");

  const res = await fetch("/api/ai", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `assistant error ${res.status}`);
  return json as T;
}

export const parseSchedule = (text: string) =>
  call<ParseResult>({ op: "parse_schedule", text });

export const explainRun = (reason: string) =>
  call<Explanation>({ op: "explain_run", reason });
