import { NextResponse } from "next/server";
import { callCngn } from "@/lib/cngn-proxy";

export const dynamic = "force-dynamic";

export type AccountDetails = {
  accountNumber: string;
  accountName: string;
  bankCode: string;
};

/// Resolve a Nigerian account number to the name the bank holds for it.
///
/// This runs once, at recipient onboarding, and never at payout time. Two
/// reasons: it spends from a 20-per-minute budget shared with the executor,
/// and a sender who mistyped a digit needs to find out before they authorise a
/// schedule rather than after naira has left.
export async function POST(req: Request) {
  let body: { bankCode?: string; accountNumber?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const bankCode = (body.bankCode ?? "").trim();
  const accountNumber = (body.accountNumber ?? "").trim();

  // Validated here as well as in the Edge Function: a malformed number costs a
  // request from the shared budget and always fails upstream anyway.
  if (!bankCode) {
    return NextResponse.json({ error: "choose a bank" }, { status: 400 });
  }
  if (!/^[0-9]{10}$/.test(accountNumber)) {
    return NextResponse.json(
      { error: "Nigerian account numbers are exactly 10 digits" },
      { status: 400 },
    );
  }

  const result = await callCngn<AccountDetails>(req.headers.get("authorization"), {
    op: "verifyAccount",
    bankCode,
    accountNumber,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ data: result.data });
}
