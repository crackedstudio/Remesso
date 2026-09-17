/// Formatting helpers. Every amount in this app is an integer in token base
/// units — 6dp for both USDT and cNGN — and is only ever converted to a
/// decimal string at the point of display.

/// Coerce whatever the source actually hands us into a bigint.
///
/// PostgREST serialises `numeric(78,0)` as a JSON *number*, not a string, so a
/// column typed `string` in lib/types.ts arrives as a number at runtime and
/// TypeScript cannot catch it. Getting this wrong crashed the schedule detail
/// page with "Cannot mix BigInt and other types" immediately after the first
/// live run.
///
/// Above 2^53 a JSON number has already lost precision before it reaches us;
/// nothing can be recovered here, so it is truncated rather than thrown on —
/// 9e15 base units is 9 billion tokens at 6dp, far beyond any real amount.
function toUnits(v: bigint | string | number): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  return BigInt(v);
}

/// Format base units for display.
///
/// `decimals` is the token's own scale and must be passed — USDT and USDC are
/// 6dp while cUSD is 18dp, so a hardcoded 6 is wrong for a third of the assets
/// this app accepts.
export function formatUnits(
  v: bigint | string | number,
  decimals: number,
  dp = 2,
): string {
  const n = toUnits(v);
  const scale = 10n ** BigInt(decimals);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, "0").slice(0, dp);
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${grouped}${dp > 0 ? `.${frac}` : ""}`;
}

/// Parse a user-typed decimal into base units at the token's own scale, without
/// going through a float — "0.1" as a Number is not exact, and at scale that is
/// money quietly disappearing.
export function parseUnits(input: string, decimals: number): bigint {
  const s = input.trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") throw new Error("enter a number");
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`at most ${decimals} decimal places`);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) +
    BigInt(frac.padEnd(decimals, "0") || "0");
}

/// @deprecated pass the token's decimals explicitly — see formatUnits.
export function formatUnits6(v: bigint | string | number, dp = 2): string {
  const n = toUnits(v);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0").slice(0, dp);
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${grouped}${dp > 0 ? `.${frac}` : ""}`;
}

/// Parse a user-typed decimal into 6dp base units without going through a
/// float — "0.1" as a Number cannot be represented exactly, and at scale that
/// is money quietly disappearing.
export function parseUnits6(input: string): bigint {
  const s = input.trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") {
    throw new Error("enter a number");
  }
  const [whole, frac = ""] = s.split(".");
  if (frac.length > 6) throw new Error("at most 6 decimal places");
  return BigInt(whole || "0") * 1_000_000n + BigInt(frac.padEnd(6, "0") || "0");
}

export const shortAddress = (a?: string) =>
  a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "";

const INTERVALS = [
  { label: "Weekly", seconds: 7 * 24 * 3600 },
  { label: "Fortnightly", seconds: 14 * 24 * 3600 },
  { label: "Monthly", seconds: 30 * 24 * 3600 },
  { label: "Quarterly", seconds: 90 * 24 * 3600 },
] as const;

export { INTERVALS };

export function intervalLabel(seconds: number | bigint): string {
  const s = Number(seconds);
  const known = INTERVALS.find((i) => i.seconds === s);
  if (known) return known.label;
  if (s % 86400 === 0) return `Every ${s / 86400} days`;
  if (s % 3600 === 0) return `Every ${s / 3600} hours`;
  return `Every ${s}s`;
}

export function relativeTime(iso: string | number | null | undefined): string {
  if (!iso) return "—";
  const t = typeof iso === "number" ? iso * 1000 : Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diff = t - Date.now();
  const abs = Math.abs(diff);
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [86400_000, "day"],
    [3600_000, "hour"],
    [60_000, "minute"],
  ];
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [ms, unit] of units) {
    if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return "just now";
}

/// The floor rate the contract stores: minimum cNGN base units out per 1e6
/// USDT base units in. With both tokens at 6dp that is just naira-per-dollar
/// scaled by 1e6, which is the only reason a "rate" and a "unit price" can be
/// the same number here.
export function rateToNairaPerUsd(rateE6: bigint | string | number): number {
  return Number(toUnits(rateE6)) / 1_000_000;
}

export function nairaPerUsdToRateE6(naira: number): bigint {
  return BigInt(Math.floor(naira * 1_000_000));
}
