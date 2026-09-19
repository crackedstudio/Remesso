import { NextResponse } from "next/server";
import { callFunction } from "@/lib/cngn-proxy";

export const dynamic = "force-dynamic";

/// Self identity verification, forwarded to the self-verify Edge Function.
///
/// The Self API key lives only there. What comes back to the browser is the
/// sender's own standing and, when they start, a single-use link to open.
export async function POST(req: Request) {
  let body: { op?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (body.op !== "start" && body.op !== "status") {
    return NextResponse.json({ error: "unknown op" }, { status: 400 });
  }

  const result = await callFunction("self-verify", "identity verification", req.headers.get("authorization"), {
    op: body.op,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ data: result.data });
}
