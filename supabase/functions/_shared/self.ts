/// Self (self.xyz) identity verification — a hand-rolled client.
///
/// Why not `@selfxyz/enterprise-sdk`: it is Node-only and imports
/// `@selfxyz/core` at module load for an optional proof verifier we never call,
/// which drags a ZK/ethers dependency tree into every cold start. The part we
/// use is two authenticated HTTP calls and a Svix signature check. This file is
/// written against the SDK's own source (v0.4.1): same base URL, same paths,
/// same field names.
///
/// Verification is optional in Remesso and gates nothing. The contract checks
/// `msg.sender`; nothing here can move, block or redirect a payment.
import { SELF_API } from "./config.ts";

export type SessionStatus = "pending" | "valid" | "invalid" | "error" | "expired";

export type Session = {
  id: string;
  verificationUrl: string;
  expiresAt: string;
};

export type SessionDetail = {
  id: string;
  status: SessionStatus;
  completedAt: string | null;
  expiresAt: string;
  externalUuid: string;
  proofAttributes: Record<string, unknown> | null;
};

/// The one event that carries a result. Unlike `SessionDetail` it also carries
/// the nullifier, which is the only field that tells two accounts apart as the
/// same person.
export type VerificationCompleted = {
  type: "verification.completed";
  verification_id: string;
  external_uuid: string;
  environment: "test" | "live";
  status: Exclude<SessionStatus, "pending">;
  reason?: string;
  proof_attributes: Record<string, unknown>;
  nullifier: string | null;
  verified_at: string;
};

export class SelfError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
  /// The SDK does not retry, and neither do we; this only tells the caller
  /// whether asking again later is worth it.
  get retryable() {
    return this.status === 429 || this.status >= 500;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${SELF_API.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SELF_API.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new SelfError(
      res.status,
      err?.message ?? `Self ${res.status}: ${text.slice(0, 200) || res.statusText}`,
      err?.code,
    );
  }
  return json as T;
}

/// `externalUuid` is echoed back verbatim in the webhook. We pass our own
/// verification row id, so a delivery maps to exactly one row without trusting
/// anything else in the payload.
export function createSession(input: {
  externalUuid: string;
  successUrl?: string;
  failureUrl?: string;
}): Promise<Session> {
  return request<Session>("POST", "/v1/sessions", {
    flowId: SELF_API.flowId,
    externalUuid: input.externalUuid,
    // Long enough to install the Self app and scan a passport from scratch,
    // short enough that an abandoned link stops working the same day.
    expiresInSeconds: 3600,
    ...(input.successUrl ? { successUrl: input.successUrl } : {}),
    ...(input.failureUrl ? { failureUrl: input.failureUrl } : {}),
  });
}

export function getSession(id: string): Promise<SessionDetail> {
  return request<SessionDetail>("GET", `/v1/sessions/${encodeURIComponent(id)}`);
}

/// Svix signature check ("Standard Webhooks"), which is what Self's SDK
/// delegates to:
///
///   signed    = `${svix-id}.${svix-timestamp}.${rawBody}`
///   key       = base64-decode(secret without its `whsec_` prefix)
///   signature = base64(HMAC-SHA256(key, signed)), sent as `v1,<sig>`,
///               space-separated when the secret is mid-rotation
///
/// The timestamp window is what stops a captured delivery being replayed
/// later. `self.test.ts` checks this against the `svix` library itself.
export async function verifyWebhook(
  raw: string,
  headers: Headers,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const id = headers.get("svix-id") ?? headers.get("webhook-id");
  const ts = headers.get("svix-timestamp") ?? headers.get("webhook-timestamp");
  const sigs = headers.get("svix-signature") ?? headers.get("webhook-signature");
  if (!id || !ts || !sigs || !secret) return false;

  const sent = Number(ts);
  if (!Number.isFinite(sent) || Math.abs(nowSeconds - sent) > 5 * 60) return false;

  let keyBytes: Uint8Array<ArrayBuffer>;
  try {
    keyBytes = base64ToBytes(secret.replace(/^whsec_/, ""));
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${ts}.${raw}`),
  );
  const expected = bytesToBase64(new Uint8Array(mac));

  return sigs.split(" ").some((part) => {
    const [version, sig] = part.split(",", 2);
    return version === "v1" && sig !== undefined && timingSafeEqual(expected, sig);
  });
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
