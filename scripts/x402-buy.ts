/// Pay for one early send, the way an agent would.
///
/// This is the buyer half of `trigger-run`: ask the endpoint for a price, sign
/// a USDC transfer authorisation for exactly that price, and retry the call
/// with it. Nothing here is Remesso-specific — it is the x402 client flow, and
/// any agent that speaks it can trigger a schedule whose sender nominated our
/// executor.
///
/// EIP-3009: the payer signs, and the facilitator submits and pays the gas. So
/// this wallet needs USDC and no CELO at all.
///
///   deno run --allow-read --allow-net --allow-env scripts/x402-buy.ts --schedule 3
///
/// Payer key: PAYER_PRIVATE_KEY, or ~/.remesso/keys/e2e-test.json.
import { createWalletClient, http, parseAbi, createPublicClient } from "npm:viem@2";
import { privateKeyToAccount } from "npm:viem@2/accounts";
import { celo } from "npm:viem@2/chains";

const ENDPOINT = flag("endpoint") ??
  "https://engaboljiqudghvzmebq.supabase.co/functions/v1/trigger-run";
const SCHEDULE = flag("schedule");
if (!SCHEDULE) {
  console.error("usage: x402-buy.ts --schedule <onchain id> [--endpoint <url>]");
  Deno.exit(2);
}

/// The EIP-712 struct USDC verifies a gasless transfer against. Field order is
/// part of the hash — a reordering is a different signature and an invalid one.
const authorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const account = privateKeyToAccount(await payerKey());
const wallet = createWalletClient({ account, chain: celo, transport: http("https://forno.celo.org") });
const pub = createPublicClient({ chain: celo, transport: http("https://forno.celo.org") });

console.log("payer:", account.address);

// --- 1. ask the price --------------------------------------------------
const quote = await fetch(ENDPOINT, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ schedule: SCHEDULE }),
});

if (quote.status !== 402) {
  console.log(`\nno price to pay — HTTP ${quote.status}`);
  console.log(await quote.text());
  Deno.exit(quote.ok ? 0 : 1);
}

const { accepts } = await quote.json() as { accepts: Requirements[] };
const reqs = accepts[0];
console.log(`price: ${Number(reqs.maxAmountRequired) / 1e6} USDC -> ${reqs.payTo}`);

// A balance check here only to make the failure legible: the facilitator would
// reject it anyway, but "you hold 0" is a better sentence than its error code.
const held = await pub.readContract({
  address: reqs.asset as `0x${string}`,
  abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
  functionName: "balanceOf",
  args: [account.address],
});
console.log(`payer holds: ${Number(held) / 1e6} USDC`);

// --- 2. sign the authorisation ----------------------------------------
const now = Math.floor(Date.now() / 1000);
const authorization = {
  from: account.address,
  to: reqs.payTo as `0x${string}`,
  value: BigInt(reqs.maxAmountRequired),
  // A few seconds in the past: clocks differ, and a validAfter in the future
  // is rejected outright.
  validAfter: BigInt(now - 60),
  validBefore: BigInt(now + (reqs.maxTimeoutSeconds ?? 60)),
  // Random, not sequential: the nonce is the replay guard and USDC stores it
  // as used-or-not, so it never has to be ordered.
  nonce: `0x${[...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`,
};

const signature = await wallet.signTypedData({
  domain: {
    name: (reqs.extra?.name as string) ?? "USDC",
    version: (reqs.extra?.version as string) ?? "2",
    // v1 names the chain "celo"; v2 names it "eip155:42220". The signature is
    // over a chain id either way.
    chainId: reqs.network.startsWith("eip155:") ? Number(reqs.network.split(":")[1]) : 42220,
    verifyingContract: reqs.asset as `0x${string}`,
  },
  types: authorizationTypes,
  primaryType: "TransferWithAuthorization",
  message: authorization,
});

const payload = {
  x402Version: 1,
  scheme: reqs.scheme,
  network: reqs.network,
  payload: {
    signature,
    authorization: {
      ...authorization,
      value: authorization.value.toString(),
      validAfter: authorization.validAfter.toString(),
      validBefore: authorization.validBefore.toString(),
    },
  },
};

// --- 3. pay and call ---------------------------------------------------
const paid = await fetch(ENDPOINT, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "X-PAYMENT": btoa(JSON.stringify(payload)),
  },
  body: JSON.stringify({ schedule: SCHEDULE }),
});

console.log(`\nHTTP ${paid.status}`);
console.log(await paid.text());

const settlement = paid.headers.get("x-payment-response");
if (settlement) {
  try {
    console.log("settlement:", JSON.parse(atob(settlement)));
  } catch {
    console.log("settlement header:", settlement);
  }
}

type Requirements = {
  scheme: string;
  network: string;
  payTo: string;
  asset: string;
  maxAmountRequired: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
};

function flag(name: string): string | undefined {
  const i = Deno.args.indexOf(`--${name}`);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}

async function payerKey(): Promise<`0x${string}`> {
  const fromEnv = Deno.env.get("PAYER_PRIVATE_KEY");
  if (fromEnv) return fromEnv as `0x${string}`;
  const path = `${Deno.env.get("HOME")}/.remesso/keys/e2e-test.json`;
  const file = JSON.parse(await Deno.readTextFile(path));
  const entry = Array.isArray(file) ? file[0] : file;
  return entry.private_key as `0x${string}`;
}
