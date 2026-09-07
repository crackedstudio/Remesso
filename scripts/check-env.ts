/// Preflight for .env. Reports what is present, what is malformed, and what is
/// merely plausible — without printing a single secret value.
///
/// The expensive failures in this system are quiet ones: an SSH key that parses
/// but does not match the dashboard, a sandbox API key pointed at Celo mainnet,
/// an executor account with no CELO. Each of those surfaces hours later as
/// something unrelated, so they are checked here instead.
///
///   deno run --allow-env --allow-read --allow-net scripts/check-env.ts
import sodium from "npm:libsodium-wrappers@0.7.15";
import { createPublicClient, formatEther, http } from "npm:viem@2";
import { privateKeyToAccount } from "npm:viem@2/accounts";
import { Buffer } from "node:buffer";

const env: Record<string, string> = {};
for (const line of (await Deno.readTextFile(".env")).split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
for (const [k, v] of Object.entries(env)) if (v) Deno.env.set(k, v);

let bad = 0, warn = 0;
const pass = (m: string, d = "") => console.log(`  ok    ${m}${d ? `  ${d}` : ""}`);
const fail = (m: string, d = "") => { bad++; console.log(`  FAIL  ${m}${d ? `  ${d}` : ""}`); };
const note = (m: string, d = "") => { warn++; console.log(`  warn  ${m}${d ? `  ${d}` : ""}`); };
const set = (k: string) => Boolean(env[k]);
const mask = (k: string) => {
  const v = env[k] ?? "";
  return v.length <= 8 ? `${v.length} chars` : `${v.slice(0, 4)}…${v.slice(-4)} (${v.length} chars)`;
};

console.log("\ncNGN credentials");

if (!set("CNGN_API_KEY")) fail("CNGN_API_KEY is empty");
else {
  const k = env.CNGN_API_KEY;
  const live = k.startsWith("cngn_live");
  if (!live && !k.startsWith("cngn_test")) {
    fail("CNGN_API_KEY has no cngn_test/cngn_live prefix", mask("CNGN_API_KEY"));
  } else {
    pass(`CNGN_API_KEY  ${live ? "LIVE — moves real naira" : "sandbox"}`, mask("CNGN_API_KEY"));
  }
}

if (!set("CNGN_ENCRYPTION_KEY")) fail("CNGN_ENCRYPTION_KEY is empty");
else pass("CNGN_ENCRYPTION_KEY", mask("CNGN_ENCRYPTION_KEY"));

// The one credential whose correctness can be proven locally: derive the public
// half, then seal a payload to it the way cNGN does and require the client to
// open it. If this passes, the only remaining question is whether the dashboard
// holds this same public key.
if (!set("CNGN_SSH_PRIVATE_KEY")) fail("CNGN_SSH_PRIVATE_KEY is empty");
else {
  try {
    await sodium.ready;
    const cngn = await import("../supabase/functions/_shared/cngn.ts");

    // Parsed by the library, not re-implemented here: duplicating it once
    // already turned a precise "holds a PUBLIC key" into a bare "invalid key".
    const pubLine = await cngn.ed25519PublicKeyLine();
    const pk = Buffer.from(pubLine.split(" ")[1], "base64").subarray(-32);
    const curvePk = sodium.crypto_sign_ed25519_pk_to_curve25519(new Uint8Array(pk));
    const eph = sodium.crypto_box_keypair();
    const nonce = sodium.randombytes_buf(24);
    const probe = JSON.stringify({ trxRef: "PREFLIGHT" });
    const ct = sodium.crypto_box_easy(sodium.from_string(probe), nonce, curvePk, eph.privateKey);
    const sealed = Buffer.concat([Buffer.from(nonce), Buffer.from(ct), Buffer.from(eph.publicKey)]);

    const opened = await cngn.decryptData<{ trxRef: string }>(sealed.toString("base64"));
    if (opened.trxRef !== "PREFLIGHT") throw new Error("round trip returned wrong payload");

    pass("CNGN_SSH_PRIVATE_KEY loads and decrypts a sealed payload");
    console.log(`\n        public half — must match the dashboard exactly:`);
    console.log(`        ${pubLine}\n`);
  } catch (e) {
    fail("CNGN_SSH_PRIVATE_KEY", (e as Error).message);
  }
}

if (!set("CNGN_WEBHOOK_SECRET")) {
  note("CNGN_WEBHOOK_SECRET is empty — every delivery is rejected 401");
} else if (env.CNGN_WEBHOOK_SECRET.length < 32) {
  note("CNGN_WEBHOOK_SECRET is short", `${env.CNGN_WEBHOOK_SECRET.length} chars; prefer 64`);
} else pass("CNGN_WEBHOOK_SECRET", mask("CNGN_WEBHOOK_SECRET"));

if (!set("CNGN_EGRESS_PROXY_URL")) {
  note("CNGN_EGRESS_PROXY_URL unset — requests leave from the runtime's own IP",
       "cNGN 403s any non-whitelisted source");
} else pass("CNGN_EGRESS_PROXY_URL", env.CNGN_EGRESS_PROXY_URL.replace(/:\/\/[^@]+@/, "://***@"));

console.log("\nChain");

const chainId = Number(env.CELO_CHAIN_ID ?? 42220);
const isMainnet = chainId === 42220;
pass("CELO_CHAIN_ID", `${chainId} ${isMainnet ? "(mainnet)" : "(testnet)"}`);

// requireEnv() refuses this combination at boot rather than swapping real USDT
// and then trying to redeem it in a sandbox that never pays out.
if (isMainnet && env.CNGN_API_KEY?.startsWith("cngn_test")) {
  fail("mainnet Celo with a cNGN SANDBOX key",
       "requireEnv() will refuse to start — use Sepolia, or a live key");
}

for (const [k, label] of [["REMESSO_EXECUTOR_ADDRESS", "executor contract"]] as const) {
  if (!set(k)) fail(`${k} is empty`, `${label} not deployed yet`);
  else if (!/^0x[a-fA-F0-9]{40}$/.test(env[k])) fail(`${k} is not an address`, mask(k));
  else pass(k, env[k]);
}

let executorAddr: `0x${string}` | null = null;
if (!set("EXECUTOR_PRIVATE_KEY")) fail("EXECUTOR_PRIVATE_KEY is empty");
else if (!/^0x[a-fA-F0-9]{64}$/.test(env.EXECUTOR_PRIVATE_KEY)) {
  fail("EXECUTOR_PRIVATE_KEY must be 0x + 64 hex chars", `${env.EXECUTOR_PRIVATE_KEY.length} chars`);
} else {
  executorAddr = privateKeyToAccount(env.EXECUTOR_PRIVATE_KEY as `0x${string}`).address;
  pass("EXECUTOR_PRIVATE_KEY", `-> ${executorAddr}`);
}

// Nothing in the system watches this balance. An executor that runs dry fails
// every run at the simulate step with no other signal.
if (executorAddr && env.CELO_RPC_URL) {
  try {
    const client = createPublicClient({ transport: http(env.CELO_RPC_URL) });
    const bal = await client.getBalance({ address: executorAddr });
    const celo = Number(formatEther(bal));
    if (celo === 0) fail("executor holds 0 CELO", "cannot pay gas for a single run");
    else if (celo < 0.5) note("executor CELO is low", `${celo.toFixed(4)} CELO`);
    else pass("executor gas balance", `${celo.toFixed(4)} CELO`);
  } catch (e) {
    note("could not reach CELO_RPC_URL", (e as Error).message.split("\n")[0].slice(0, 80));
  }
}

console.log("\nSupabase");
for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"]) {
  if (!set(k)) fail(`${k} is empty`);
  else if (k === "SUPABASE_URL" && !/^https:\/\/.+\.supabase\.co\/?$/.test(env[k])) {
    note(`${k} is not the usual https://<ref>.supabase.co form`, env[k]);
  } else pass(k, k === "SUPABASE_URL" ? env[k] : mask(k));
}

console.log(`\n${bad} blocking, ${warn} advisory\n`);
Deno.exit(bad > 0 ? 1 : 0);
