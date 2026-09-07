/// Client for the cNGN API (docs.cngn.co), written against the published spec.
///
/// Three things about this API are unusual and are all handled here:
///
///   Requests   POST/PUT bodies are AES-256-CBC encrypted and sent as
///              `{content, iv}`, both base64. The AES key is SHA-256 of the
///              dashboard encryption key — the key itself is never used raw.
///
///   Responses  EVERY successful body is `{status, message, data}` where `data`
///              is a base64 libsodium `crypto_box` sealed to our Ed25519 public
///              key. It is an opaque string on the wire: reading a field off it
///              without opening it first always yields undefined, which is the
///              bug this file previously had.
///
///   Limits     20 requests per 60 seconds per API key, and breaching it blocks
///              the key for a further 60s. The limiter below is therefore a
///              correctness feature, not politeness — one burst takes the whole
///              integration offline for a minute.
///
/// Source IPs must additionally be whitelisted in the merchant dashboard or the
/// API answers 403 regardless of credentials. See README "cNGN egress".
import sodium from "npm:libsodium-wrappers@0.7.15";
import { CNGN_API } from "./config.ts";

// ---------------------------------------------------------------------------
// base64 helpers
// ---------------------------------------------------------------------------

/// Chunked, because `String.fromCharCode(...bytes)` overflows the argument
/// stack on payloads of a few hundred KB.
function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Request encryption: AES-256-CBC, key = SHA-256(encryptionKey)
// ---------------------------------------------------------------------------

export type EncryptedBody = { content: string; iv: string };

let aesKeyPromise: Promise<CryptoKey> | null = null;

function aesKey(): Promise<CryptoKey> {
  aesKeyPromise ??= (async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(CNGN_API.encryptionKey),
    );
    return crypto.subtle.importKey("raw", digest, { name: "AES-CBC" }, false, ["encrypt"]);
  })();
  return aesKeyPromise;
}

/// WebCrypto's AES-CBC applies PKCS#7 padding, which is what the reference
/// Node implementation (`createCipheriv`) does too.
export async function encryptBody(payload: unknown): Promise<EncryptedBody> {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv },
    await aesKey(),
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return { content: b64encode(new Uint8Array(ct)), iv: b64encode(iv) };
}

// ---------------------------------------------------------------------------
// Response decryption: libsodium crypto_box, opened with our Ed25519 key
// ---------------------------------------------------------------------------

/// The sealed blob is laid out `nonce(24) || ciphertext || ephemeralPubKey(32)`.
const NONCE_BYTES = 24;
const PUBLIC_KEY_BYTES = 32;

function findBytes(haystack: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

const OPENSSH_MAGIC = "openssh-key-v1\0";

/// Pull the 64-byte Ed25519 secret key out of an OpenSSH-format private key.
///
/// The key material is framed with a 4-byte big-endian length, and for Ed25519
/// that length is always 0x40. Locating that marker is how the official SDKs do
/// it, and it avoids implementing the whole container format.
///
/// The container header IS checked first, though, because the marker search is
/// only meaningful on a plaintext body. A passphrase-protected key encrypts
/// everything after the header, and searching ciphertext for four bytes either
/// finds nothing — reported as "not an Ed25519 key", which is wrong and sends
/// people off to regenerate a perfectly good key — or worse, matches by
/// coincidence and loads 64 bytes of garbage that fails much later as an
/// unexplained key mismatch.
function parseOpenSSHPrivateKey(pem: string): Uint8Array {
  const body = pem
    .replace(/\\n/g, "\n")               // survives being stored in an env var
    .replace(/-----[A-Z ]*PRIVATE KEY-----/g, "")
    .trim();
  if (!body) throw new Error("CNGN_SSH_PRIVATE_KEY is empty");

  // An OpenSSH *public* key is a single "ssh-ed25519 AAAA... comment" line.
  // Caught by shape, because it is not valid base64 either and would otherwise
  // surface as an opaque decoding error rather than the actual mistake.
  if (/^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-)/.test(body)) {
    throw new Error(
      "CNGN_SSH_PRIVATE_KEY holds a PUBLIC key. The .pub file goes in the " +
        "dashboard; this variable takes the private half — the file with no " +
        ".pub extension, starting -----BEGIN OPENSSH PRIVATE KEY-----.",
    );
  }

  let buf: Uint8Array;
  try {
    buf = b64decode(body);
  } catch {
    throw new Error(
      "CNGN_SSH_PRIVATE_KEY is not valid base64. Paste the whole private key " +
        "file including its BEGIN and END lines.",
    );
  }

  const magic = new TextDecoder().decode(buf.subarray(0, OPENSSH_MAGIC.length));
  if (magic !== OPENSSH_MAGIC) {
    throw new Error(
      "CNGN_SSH_PRIVATE_KEY is not an OpenSSH private key. It must be the " +
        "PRIVATE half (the file with no .pub extension), generated with: " +
        "ssh-keygen -t ed25519 -C api@remesso -f cngn_api_key",
    );
  }

  // Immediately after the magic: a 4-byte big-endian length, then the cipher
  // name. "none" for an unencrypted key, "aes256-ctr" for a passphrase.
  let at = OPENSSH_MAGIC.length;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const cipherLen = view.getUint32(at);
  at += 4;
  const cipherName = new TextDecoder().decode(buf.subarray(at, at + cipherLen));

  if (cipherName !== "none") {
    throw new Error(
      `CNGN_SSH_PRIVATE_KEY is passphrase-protected (${cipherName}). This runs ` +
        "unattended and has no way to prompt for one. Strip the passphrase with: " +
        'ssh-keygen -p -N "" -f cngn_api_key — the public key is unchanged, so ' +
        "the dashboard needs no update.",
    );
  }

  const start = findBytes(buf, [0x00, 0x00, 0x00, 0x40]);
  if (start === -1 || start + 68 > buf.length) {
    throw new Error(
      "CNGN_SSH_PRIVATE_KEY has no Ed25519 key material. cNGN requires an " +
        "Ed25519 key; RSA and ECDSA keys will not work. Generate one with: " +
        "ssh-keygen -t ed25519 -C api@remesso -f cngn_api_key",
    );
  }
  return buf.subarray(start + 4, start + 68);
}

let curveKeyPromise: Promise<Uint8Array> | null = null;

function curve25519SecretKey(): Promise<Uint8Array> {
  curveKeyPromise ??= (async () => {
    await sodium.ready;
    return sodium.crypto_sign_ed25519_sk_to_curve25519(
      parseOpenSSHPrivateKey(CNGN_API.sshPrivateKey),
    );
  })();
  return curveKeyPromise;
}

export async function decryptData<T>(encrypted: string): Promise<T> {
  await sodium.ready;
  const sk = await curve25519SecretKey();
  const blob = b64decode(encrypted);

  if (blob.length <= NONCE_BYTES + PUBLIC_KEY_BYTES) {
    throw new Error("cNGN response payload is too short to be a sealed box");
  }
  const nonce = blob.subarray(0, NONCE_BYTES);
  const ephemeralPk = blob.subarray(blob.length - PUBLIC_KEY_BYTES);
  const ciphertext = blob.subarray(NONCE_BYTES, blob.length - PUBLIC_KEY_BYTES);

  let plain: Uint8Array;
  try {
    plain = sodium.crypto_box_open_easy(ciphertext, nonce, ephemeralPk, sk);
  } catch {
    // Almost always means the dashboard holds a different public key than the
    // private key configured here — not a transport problem.
    throw new Error(
      "cNGN response decryption failed: the Ed25519 public key uploaded to the " +
        "dashboard does not match CNGN_SSH_PRIVATE_KEY for this environment",
    );
  }
  return JSON.parse(sodium.to_string(plain)) as T;
}

// ---------------------------------------------------------------------------
// Rate limiting: 20 requests / 60s per API key
// ---------------------------------------------------------------------------

const WINDOW_MS = 60_000;
const MAX_IN_WINDOW = 20;

/// Kept one under the documented ceiling. Hitting the limit is not a soft
/// failure — the key is blocked for another 60s, which would strand an
/// in-flight redemption behind a cache-list refresh.
const BUDGET = MAX_IN_WINDOW - 1;

let hits: number[] = [];
let chain: Promise<void> = Promise.resolve();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/// Serialised so two concurrent callers cannot both read a stale window and
/// jointly overshoot the budget.
function reserveSlot(): Promise<void> {
  const next = chain.then(async () => {
    for (;;) {
      const now = Date.now();
      hits = hits.filter((t) => now - t < WINDOW_MS);
      if (hits.length < BUDGET) {
        hits.push(now);
        return;
      }
      await sleep(WINDOW_MS - (now - hits[0]) + 50);
    }
  });
  chain = next.catch(() => {});
  return next;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CngnError extends Error {
  constructor(
    msg: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(msg);
    this.name = "CngnError";
  }

  /// Per the error reference: 429 and 5xx are retryable with backoff. A 400 is
  /// the request being wrong and retrying it unchanged only burns quota — with
  /// one exception, the platform-wide outage message, which is transient.
  ///
  /// Note this says nothing about whether a retry is *safe*. For money-moving
  /// calls, confirm state via getTransactions() before re-sending.
  get retryable(): boolean {
    if (this.status === 429 || this.status >= 500) return true;
    return /service is currently unavailable/i.test(this.message);
  }

  /// A missing dashboard permission, a non-whitelisted IP or a bad key are all
  /// operator errors. They will not fix themselves, so surface them loudly
  /// rather than folding them into a generic failure.
  get isConfigError(): boolean {
    return /permission denied|not whitelisted|invalid token prefix|merchant not found|ssh key/i
      .test(this.message);
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

type Envelope = { status: number | boolean; message: string; data?: unknown };

/// Fixed-IP egress.
///
/// cNGN validates the source IP of every request against a dashboard whitelist
/// and answers 403 to anything else, credentials notwithstanding. Serverless
/// runtimes do not offer a stable egress address, so production traffic is sent
/// through a forward proxy whose IP is the one on the whitelist.
let proxyClient: unknown | null | undefined;

function egressClient(): unknown | null {
  if (proxyClient !== undefined) return proxyClient as unknown | null;

  const url = CNGN_API.egressProxyUrl;
  if (!url) {
    proxyClient = null;
    return null;
  }

  const create = (Deno as unknown as {
    createHttpClient?: (o: { proxy: { url: string } }) => unknown;
  }).createHttpClient;

  if (typeof create !== "function") {
    // Failing here is deliberate. Silently going direct would send requests
    // from an un-whitelisted address, and a 403 from cNGN is a far more
    // confusing symptom than this message.
    throw new Error(
      "CNGN_EGRESS_PROXY_URL is set but this runtime has no Deno.createHttpClient. " +
        "Either run the cNGN calls somewhere that supports an outbound proxy, or " +
        "whitelist this runtime's egress IPs with cNGN and unset the variable.",
    );
  }

  proxyClient = create({ proxy: { url } });
  return proxyClient as unknown;
}

async function request<T>(
  path: string,
  init: { method?: "GET" | "POST" | "PUT"; body?: unknown; attempt?: number } = {},
): Promise<T> {
  const method = init.method ?? "GET";
  const attempt = init.attempt ?? 0;

  await reserveSlot();

  let res: Response;
  try {
    const client = egressClient();
    res = await fetch(`${CNGN_API.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${CNGN_API.apiKey}`,
        "Content-Type": "application/json",
      },
      body: init.body === undefined
        ? undefined
        : JSON.stringify(await encryptBody(init.body)),
      ...(client ? { client } : {}),
    } as RequestInit);
  } catch (e) {
    // Network-level failure. Safe to retry a GET; a POST may already have been
    // received, so let the caller reconcile rather than duplicating it.
    if (method === "GET" && attempt < 2) {
      await sleep(1000 * 2 ** attempt);
      return request<T>(path, { ...init, attempt: attempt + 1 });
    }
    throw new CngnError(`cNGN unreachable: ${(e as Error).message}`, 0, null);
  }

  const text = await res.text();
  let env: Envelope;
  try {
    env = JSON.parse(text) as Envelope;
  } catch {
    throw new CngnError(`cNGN returned non-JSON (${res.status})`, res.status, text);
  }

  // Permission denial answers `{status: false}`, so HTTP status alone is not a
  // reliable success test — check both.
  const ok = res.ok && env.status !== false;
  if (!ok) {
    const status = typeof env.status === "number" ? env.status : res.status;
    const err = new CngnError(env.message ?? `cNGN ${res.status}`, status, env);

    // 429 blocks the key for a full minute; anything shorter is wasted.
    if (err.retryable && attempt < 2 && !err.isConfigError) {
      const backoff = status === 429 ? 60_000 : 2000 * 2 ** attempt;
      if (method === "GET" || status === 429) {
        await sleep(backoff);
        return request<T>(path, { ...init, attempt: attempt + 1 });
      }
    }
    throw err;
  }

  if (env.data === undefined || env.data === null) return undefined as T;
  // Encrypted on the wire; the docs' response examples show it already opened.
  if (typeof env.data === "string") return await decryptData<T>(env.data);
  return env.data as T;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export type Bank = { name: string; code: string };
export type Network = {
  id: string;
  name: string;
  short_name: string;
  isDisabled: boolean;
  blockchain?: unknown;
};
export type AccountDetails = {
  accountNumber: string;
  accountName: string;
  bankCode: string;
};
export type Redemption = { trxRef: string; address: string };
export type Transaction = {
  id: string;
  from: string;
  receiver: unknown;
  amount: string;
  description?: string;
  createdAt: string;
  trx_ref: string;
  trx_type: string;
  network?: string;
  asset_type?: string;
  asset_symbol?: string;
  base_trx_hash?: string;
  extl_trx_hash?: string;
  explorer_link?: string;
  status: "pending" | "success" | "failed";
};
type Paginated<T> = {
  data: T[];
  pagination: {
    count: number;
    pages: number;
    isLastPage: boolean;
    nextPage: number | null;
    previousPage: number | null;
  };
};

/// A cache with a TTL, because the rate limit is 20/min and the bank list is
/// ~900 entries that change a few times a year.
function cached<T>(ttlMs: number, load: () => Promise<T>) {
  let value: T | null = null;
  let loadedAt = 0;
  let inflight: Promise<T> | null = null;
  return (): Promise<T> => {
    if (value !== null && Date.now() - loadedAt < ttlMs) return Promise.resolve(value);
    inflight ??= load()
      .then((v) => {
        value = v;
        loadedAt = Date.now();
        return v;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}

/// CBN bank codes. Cache hard: the docs explicitly say to hold this for hours.
export const getBanks = cached(6 * 60 * 60 * 1000, () =>
  request<Bank[]>("/banks"));

export const getNetworks = cached(6 * 60 * 60 * 1000, () =>
  request<Network[]>("/networks"));

/// Resolve a Nigerian account number to the name the bank has on file.
///
/// Run this at recipient onboarding, never at payout time: it costs a request
/// from a 20/min budget and a wrong answer should stop a sender before they
/// authorise a schedule, not after money has moved.
export function verifyAccount(bankCode: string, accountNumber: string) {
  return request<AccountDetails>("/account/verify", {
    method: "POST",
    body: { bankCode, accountNumber },
  });
}

/// Burn cNGN and pay naira to a Nigerian bank account. Requires the "Redeem"
/// permission on the API key.
///
/// Returns a `trxRef` for tracking and the `address` the cNGN must be sent to.
/// Order matters: call this FIRST, then deliver cNGN to the address it returns.
/// Settlement is confirmed by the `redemption.completed` webhook or by polling
/// getTransactions() — never by this call returning 200.
export function redeemToBank(params: {
  amount: number;
  bankCode: string;
  accountNumber: string;
  saveDetails?: boolean;
}) {
  if (!Number.isInteger(params.amount) || params.amount < 1) {
    throw new Error(`redeemAsset amount must be a whole number >= 1, got ${params.amount}`);
  }
  return request<Redemption>("/redeemAsset", {
    method: "POST",
    body: { saveDetails: false, ...params },
  });
}

export function getBalance() {
  return request<unknown>("/balance");
}

export function getTransactions(page = 1, limit = 50) {
  return request<Paginated<Transaction>>(`/transactions?page=${page}&limit=${limit}`);
}

/// Find a transaction by reference, for reconciling a run whose webhook never
/// arrived. cNGN delivers each webhook exactly once with no retry, so this is
/// the only way a missed delivery is ever recovered.
///
/// Bounded at `maxPages` so a stale reference cannot walk the entire history
/// and exhaust the rate limit.
export async function findTransaction(
  trxRef: string,
  maxPages = 4,
): Promise<Transaction | null> {
  for (let page = 1; page <= maxPages; page++) {
    const res = await getTransactions(page, 50);
    const hit = res.data?.find((t) => t.trx_ref === trxRef);
    if (hit) return hit;
    if (!res.pagination || res.pagination.isLastPage) break;
  }
  return null;
}

/// Assert the account is actually able to redeem to Celo before a schedule is
/// authorised. Cheap, cached, and it turns a silent mid-flight failure into a
/// setup-time error.
export async function assertCeloSupported(): Promise<Network> {
  const networks = await getNetworks();
  const celo = networks.find(
    (n) =>
      n.short_name?.toUpperCase() === "CELO" ||
      n.name?.toLowerCase() === "celo",
  );
  if (!celo) {
    throw new Error(
      "cNGN reports no Celo network for this environment — confirm Celo support " +
        "with cNGN before authorising bank-payout schedules",
    );
  }
  if (celo.isDisabled) {
    throw new Error("cNGN currently has Celo disabled for transfers");
  }
  return celo;
}
