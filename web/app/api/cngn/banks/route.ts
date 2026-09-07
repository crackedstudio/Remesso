import { NextResponse } from "next/server";
import { callCngn } from "@/lib/cngn-proxy";

export const dynamic = "force-dynamic";

export type Bank = { name: string; code: string };

/// The CBN bank list: ~900 entries that change a few times a year, behind an
/// API that allows 20 requests a minute in total. Caching it here keeps a page
/// of dropdowns from starving the executor loop of its request budget.
///
/// Module-level rather than Next's data cache because the upstream call carries
/// a per-user Authorization header, and the response is identical for everyone.
const TTL_MS = 12 * 60 * 60 * 1000;
let cache: { banks: Bank[]; at: number } | null = null;

export async function GET(req: Request) {
  if (cache && Date.now() - cache.at < TTL_MS) {
    return NextResponse.json({ data: cache.banks, cached: true });
  }

  const result = await callCngn<Bank[]>(req.headers.get("authorization"), {
    op: "banks",
  });

  if (!result.ok) {
    // A stale list beats no list: bank codes do not churn, and a sender midway
    // through onboarding should not be blocked by a transient upstream error.
    if (cache) {
      return NextResponse.json({ data: cache.banks, cached: true, stale: true });
    }
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  const banks = [...result.data].sort((a, b) => a.name.localeCompare(b.name));
  cache = { banks, at: Date.now() };
  return NextResponse.json({ data: banks });
}
