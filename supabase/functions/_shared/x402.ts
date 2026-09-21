/// x402: charging for a call, over plain HTTP.
///
/// The protocol is three moves. A caller asks for something; we answer 402
/// with exactly what payment we would accept; they retry with a signed
/// authorisation in `X-PAYMENT`. We ask Celo's hosted facilitator to check the
/// signature (`/verify`), do the work, and only then ask it to move the money
/// (`/settle`). The facilitator submits the transfer and pays the gas, so the
/// caller needs no CELO and we run no payment infrastructure.
///
/// Hand-rolled rather than `@x402/hono`: the middleware assumes a Hono server,
/// this is one Deno handler, and the wire format is a 402 body and two
/// authenticated POSTs. Same reasoning as `cngn.ts` and `self.ts`.
///
/// Verify before the work, settle after it. A caller whose run reverts should
/// not be charged, and a caller who is charged should have had their run.
import { CELO } from "./config.ts";

export const X402 = {
  get base(): string {
    return (Deno.env.get("X402_FACILITATOR") ?? "https://api.x402.celo.org").replace(/\/+$/, "");
  },
  /// `x402_…`, from the dashboard at x402.celo.org. Metering and settlement
  /// credits hang off it.
  get apiKey(): string {
    return Deno.env.get("X402_API_KEY") ?? "";
  },
  /// What one call costs, in USDC base units. 6dp, so 10_000 is one cent.
  get priceUnits(): string {
    return Deno.env.get("X402_PRICE_UNITS") ?? "10000";
  },
  /// Where the money goes. The treasury, not the hot executor key.
  get payTo(): string {
    return Deno.env.get("X402_PAY_TO") ?? "";
  },
  get isConfigured(): boolean {
    return Boolean(this.apiKey && /^0x[a-fA-F0-9]{40}$/.test(this.payTo));
  },
};

/// USDC on Celo, 6dp. EIP-3009, so the payer signs a transfer authorisation
/// and needs no native CELO.
const USDC: `0x${string}` = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";

/// CAIP-2, which is how x402 names a chain.
const NETWORK = `eip155:${CELO.chainId}`;

export type PaymentRequirements = {
  scheme: "exact";
  network: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxAmountRequired: string;
  asset: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
};

export function requirements(resource: string, description: string): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    resource,
    description,
    mimeType: "application/json",
    payTo: X402.payTo,
    maxAmountRequired: X402.priceUnits,
    asset: USDC,
    // Long enough for a signature round trip, short enough that a stale
    // authorisation cannot be replayed against a later price.
    maxTimeoutSeconds: 60,
    // The EIP-712 domain the payer signs against. Getting this wrong makes
    // every signature invalid for reasons the payer cannot see.
    extra: { name: "USDC", version: "2" },
  };
}

/// The body of a 402. It is the price list, in the shape x402 clients parse.
export function paymentRequiredBody(reqs: PaymentRequirements, error = "payment required") {
  return { x402Version: 1, error, accepts: [reqs] };
}

async function facilitator(path: string, body: unknown): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${X402.base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The dashboard key meters settlement credits; without it the
        // facilitator answers 401 and nothing settles.
        "X-API-Key": X402.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("x402", path, res.status, JSON.stringify(json).slice(0, 300));
      return null;
    }
    return json as Record<string, unknown>;
  } catch (e) {
    console.error("x402 facilitator unreachable:", (e as Error).message);
    return null;
  }
}

/// Is this signed authorisation good for this price? Nothing has moved yet.
export async function verify(
  paymentPayload: unknown,
  paymentRequirements: PaymentRequirements,
): Promise<{ ok: boolean; reason?: string; payer?: string }> {
  const out = await facilitator("/verify", { x402Version: 1, paymentPayload, paymentRequirements });
  if (!out) return { ok: false, reason: "payment verification unavailable" };
  return {
    ok: out.isValid === true,
    reason: typeof out.invalidReason === "string" ? out.invalidReason : undefined,
    payer: typeof out.payer === "string" ? out.payer : undefined,
  };
}

/// Move the money. Called only after the work succeeded.
export async function settle(
  paymentPayload: unknown,
  paymentRequirements: PaymentRequirements,
): Promise<{ ok: boolean; txHash?: string }> {
  const out = await facilitator("/settle", { x402Version: 1, paymentPayload, paymentRequirements });
  if (!out) return { ok: false };
  return {
    ok: out.success === true,
    txHash: typeof out.transaction === "string" ? out.transaction : undefined,
  };
}

/// `X-PAYMENT` carries base64 JSON.
export function decodePayment(header: string | null): unknown | null {
  if (!header) return null;
  try {
    return JSON.parse(atob(header));
  } catch {
    console.error("x402: X-PAYMENT is not base64 JSON");
    return null;
  }
}

/// What the caller gets back so they can find the settlement on-chain.
export function encodeSettlement(txHash: string | undefined): string {
  return btoa(JSON.stringify({ success: true, transaction: txHash ?? null, network: NETWORK }));
}
