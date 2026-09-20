import { NextResponse } from "next/server";
import "server-only";

export const dynamic = "force-dynamic";

/// Server-side hop from the browser to the ai-assist Edge Function.
///
/// Same arrangement as the cNGN route handlers and for the same reason: the
/// DeepSeek key lives in exactly one place, Supabase's secret store, and never
/// reaches a client bundle. MiniPay's WebView is a browser like any other.
const FUNCTIONS_URL = () => {
  const base = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) throw new Error("SUPABASE_URL is not set");
  return `${base.replace(/\/$/, "")}/functions/v1/ai-assist`;
};

const ALLOWED_OPS = new Set(["parse_schedule", "classify_run", "risk_check"]);

export async function POST(req: Request) {
  const authorization = req.headers.get("authorization");
  if (!authorization) {
    return NextResponse.json({ error: "sign in to continue" }, { status: 401 });
  }

  let body: { op?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  // Allowlisted rather than forwarded blindly: this handler is reachable by
  // anyone with a session, and the set of things the assistant may be asked to
  // do should be decided here, not by whatever the caller typed.
  if (!body.op || !ALLOWED_OPS.has(body.op)) {
    return NextResponse.json({ error: "unknown op" }, { status: 400 });
  }

  let res: Response;
  try {
    res = await fetch(FUNCTIONS_URL(), {
      method: "POST",
      headers: {
        Authorization: authorization,
        apikey: process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch (e) {
    return NextResponse.json(
      { error: `assistant unreachable: ${(e as Error).message}` },
      { status: 502 },
    );
  }

  const json = await res.json().catch(() => ({}));
  return NextResponse.json(json, { status: res.status });
}
