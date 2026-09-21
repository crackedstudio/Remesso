/// Celo attribution tag (ERC-8021) for every transaction Remesso sends.
///
/// A short suffix appended after the calldata. The EVM discards trailing bytes,
/// so the contract sees exactly the arguments it always saw and execution is
/// unchanged — the suffix only lets Celo trace a transaction back to the app
/// that produced it. That data feeds ecosystem reward distribution and cannot
/// be claimed retroactively: an untagged transaction is unattributed forever.
///
/// Encoded here rather than via `@celo/attribution-tags`, which the frontend
/// does use. Schema 0 is four concatenated pieces and nothing more, and this
/// module sits in the path of every remittance — a dependency there earns its
/// place or stays out. `attribution.test.ts` pins the output to the SDK's own.
///
/// One fixed code, not the SDK's hostname-derived one: the executor has no
/// hostname, and a hostname code would change the moment the frontend moves
/// off ngrok onto a real domain, splitting one app's history in two.
/// `remesso` is a custom code — it tags immediately, and having it credited on
/// the attribution dashboard is a registry step with the Celo team.

/// `[code:N][length:1][schema:1][marker:16]`
const MARKER = "80218021802180218021802180218021";
const SCHEMA_0 = "00";

export const ATTRIBUTION_CODE = (Deno.env.get("ATTRIBUTION_CODE") ?? "remesso").toLowerCase();

/// The suffix for one code, or `undefined` if the code is unusable.
///
/// Never throws: a malformed tag must not be the reason a remittance fails to
/// go out. The worst case is an untagged transaction, which is what every
/// transaction was before this existed.
export function suffixFor(code: string): `0x${string}` | undefined {
  if (!/^[a-z0-9_]{1,32}$/.test(code)) {
    console.error("attribution code must be 1-32 of [a-z0-9_]:", code);
    return undefined;
  }
  const hex = [...new TextEncoder().encode(code)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const length = code.length.toString(16).padStart(2, "0");
  return `0x${hex}${length}${SCHEMA_0}${MARKER}`;
}

export const attributionSuffix = suffixFor(ATTRIBUTION_CODE);
