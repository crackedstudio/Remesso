import "server-only";

/// Server-side hop from a Next route handler to the cngn-proxy Edge Function.
///
/// The route handlers never hold a cNGN credential. They forward the caller's
/// Supabase JWT to one Edge Function, which is the single place the API key,
/// AES key and Ed25519 key exist — and therefore the single source IP that has
/// to be whitelisted with cNGN.

const FUNCTIONS_URL = (name: string) => {
  const base = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) throw new Error("SUPABASE_URL is not set");
  return `${base.replace(/\/$/, "")}/functions/v1/${name}`;
};

export type ProxyResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

export function callCngn<T>(
  authorization: string | null,
  body: Record<string, unknown>,
): Promise<ProxyResult<T>> {
  return callFunction<T>("cngn-proxy", "payout provider", authorization, body);
}

/// The same hop for any Edge Function that re-checks the sender's JWT itself.
/// `self-verify` uses it so the Self API key stays server-side too.
export async function callFunction<T>(
  name: string,
  service: string,
  authorization: string | null,
  body: Record<string, unknown>,
): Promise<ProxyResult<T>> {
  if (!authorization) {
    return { ok: false, status: 401, error: "sign in to continue" };
  }

  let res: Response;
  try {
    res = await fetch(FUNCTIONS_URL(name), {
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
    return { ok: false, status: 502, error: `${service} unreachable: ${(e as Error).message}` };
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: (json as { error?: string }).error ?? `upstream ${res.status}`,
    };
  }
  return { ok: true, data: (json as { data: T }).data };
}
