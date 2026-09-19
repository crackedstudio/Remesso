"use client";

import { useMarketRate } from "@/lib/hooks";
import {
  INTERVALS,
  SELECTABLE_INTERVALS,
  formatUnits,
  parseUnits,
  rateToNairaPerUsd,
} from "@/lib/format";
import { CNGN, type TokenInfo } from "@/lib/config";

export type TermsDraft = {
  amount: string;          // decimal USDT as typed
  intervalSeconds: number;
  floorPercent: number;    // how far below market the sender will accept
  maxRuns: string;         // "" = unlimited
  expiresAt: string;       // yyyy-mm-dd — required; V2 rejects a schedule with no expiry
  startNow: boolean;
};

/// yyyy-mm-dd, `days` from now.
function isoDate(days: number): string {
  return new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
}

export const defaultTerms: TermsDraft = {
  amount: "",
  intervalSeconds: INTERVALS.find((i) => i.label === "Monthly")!.seconds,
  floorPercent: 3,
  maxRuns: "12",
  // V2 requires every schedule to expire, capped at MAX_LIFETIME (365 days).
  // A floor rate that never has to be re-consented is the stale-floor defect
  // the security review found, so "never" is no longer offered.
  expiresAt: isoDate(330),
  startNow: true,
};

/// Parsed at the funding token's own scale — cUSD is 18dp while USDT and USDC
/// are 6dp, so a fixed 6 would be wrong by 10^12 for a third of the assets.
export function amountInUnits(t: TermsDraft, decimals: number): bigint | null {
  try {
    const v = parseUnits(t.amount, decimals);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

/// Amounts a sender can tap instead of type. Small on purpose: this audience
/// sends tens of dollars, not hundreds, and the field is right there.
const QUICK_AMOUNTS = ["10", "20", "50", "100"];

export function TermsStep({
  value,
  onChange,
  token,
  converts,
}: {
  value: TermsDraft;
  onChange: (t: TermsDraft) => void;
  token: TokenInfo;
  /// Direct schedules move the asset untouched, so there is no rate, no floor
  /// and nothing to quote.
  converts: boolean;
}) {
  const set = (patch: Partial<TermsDraft>) => onChange({ ...value, ...patch });
  const amount = amountInUnits(value, token.decimals);
  const market = useMarketRate(converts ? (amount ?? 0n) : 0n);

  const floorE6 = market.rateE6
    ? (market.rateE6 * BigInt(100 - value.floorPercent)) / 100n
    : undefined;

  return (
    <div className="space-y-7">
      {/* The amount is the headline of the whole screen, so it is set like one:
          large, borderless, unit beside it, nothing competing. */}
      <div>
        <label className="label" htmlFor="amount">
          Amount per transfer
        </label>
        <div className="flex items-baseline gap-2 border-b-2 border-line pb-2 transition-colors focus-within:border-clay">
          <input
            id="amount"
            className="min-w-0 flex-1 bg-transparent font-display text-[44px] leading-none text-ink outline-none placeholder:text-ink-3/50"
            inputMode="decimal"
            placeholder="0"
            autoComplete="off"
            value={value.amount}
            onChange={(e) => set({ amount: e.target.value.replace(/[^0-9.]/g, "") })}
          />
          <span className="text-lg font-medium text-ink-3">{token.symbol}</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {QUICK_AMOUNTS.map((q) => (
            <button
              key={q}
              type="button"
              className={`chip ${value.amount === q ? "border-clay bg-clay-soft text-clay-deep" : ""}`}
              onClick={() => set({ amount: q })}
            >
              {q}
            </button>
          ))}
        </div>
        {converts && market.rateE6 && amount ? (
          <p className="hint">
            About{" "}
            <span className="font-medium text-naira">
              ₦{formatUnits((amount * market.rateE6) / 1_000_000n, CNGN.decimals, 0)}
            </span>{" "}
            at today&rsquo;s rate of ₦{rateToNairaPerUsd(market.rateE6).toFixed(2)} per USDT.
          </p>
        ) : null}
      </div>

      <div>
        <p className="label">How often</p>
        <div className="grid grid-cols-2 gap-2">
          {SELECTABLE_INTERVALS.map((i) => (
            <button
              key={i.seconds}
              type="button"
              onClick={() => set({ intervalSeconds: i.seconds })}
              aria-pressed={value.intervalSeconds === i.seconds}
              className={`tile min-h-12 text-center text-[15px] font-medium ${
                value.intervalSeconds === i.seconds ? "tile-on" : ""
              }`}
            >
              {i.label}
            </button>
          ))}
        </div>
      </div>

      {converts && (
        <div>
          <div className="flex items-baseline justify-between">
            <label className="label mb-0" htmlFor="floor">
              Rate floor
            </label>
            {floorE6 !== undefined && (
              <span className="text-[15px] font-medium text-ink">
                ₦{rateToNairaPerUsd(floorE6).toFixed(0)}
                <span className="text-ink-3"> / USDT</span>
              </span>
            )}
          </div>
          <input
            id="floor"
            type="range"
            min={1}
            max={10}
            step={1}
            className="mt-3 w-full accent-clay"
            value={value.floorPercent}
            onChange={(e) => set({ floorPercent: Number(e.target.value) })}
          />
          <p className="mt-1 text-[14px] text-ink-2">
            Skip a run if the rate drops more than{" "}
            <span className="font-medium text-ink">{value.floorPercent}%</span> below today.
          </p>
          {/* This is the single most important number a sender sets, so it says
              plainly what it protects them from. */}
          <p className="hint">
            Written into the contract. Nobody — not Remesso, not a stolen backend key — can
            run a transfer below this rate. Tighter means fewer bad transfers and more
            skipped months.
          </p>
        </div>
      )}

      <div>
        <p className="label">How many transfers</p>
        <div className="flex flex-wrap gap-2">
          {["6", "12", ""].map((n) => (
            <button
              key={n || "open"}
              type="button"
              className={`chip ${value.maxRuns === n ? "border-clay bg-clay-soft text-clay-deep" : ""}`}
              onClick={() => set({ maxRuns: n })}
            >
              {n || "Until I stop it"}
            </button>
          ))}
          <input
            className="field min-h-9 w-24 rounded-full px-3.5 py-0 text-[13px]"
            inputMode="numeric"
            placeholder="Other"
            aria-label="Number of transfers"
            value={value.maxRuns}
            onChange={(e) => set({ maxRuns: e.target.value.replace(/\D/g, "") })}
          />
        </div>
      </div>

      <div>
        <label className="label" htmlFor="expires">
          Expires on
        </label>
        <input
          id="expires"
          type="date"
          className="field"
          value={value.expiresAt}
          min={isoDate(1)}
          max={isoDate(364)}
          onChange={(e) => set({ expiresAt: e.target.value })}
        />
        {/* Not optional, and worth saying why rather than just enforcing it. */}
        <p className="hint">
          Up to a year. Your floor rate is fixed for the life of the schedule, so it has to
          be re-confirmed rather than drift against the market forever.
        </p>
      </div>

      <label className="flex items-center justify-between gap-4 rounded-xl border border-line bg-surface px-4 py-3.5">
        <span className="text-[15px] text-ink">
          Send the first one now
          <span className="mt-0.5 block text-[13px] text-ink-2">
            Otherwise the first transfer waits one full interval.
          </span>
        </span>
        <Switch checked={value.startNow} onChange={(v) => set({ startNow: v })} />
      </label>
    </div>
  );
}

/// A switch that looks like the one in the phone's own settings, which is the
/// control this audience already knows how to read.
function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-7 w-12 shrink-0 rounded-full transition-colors duration-200 ${
        checked ? "bg-clay" : "bg-line"
      }`}
    >
      <span
        className={`absolute top-0.5 h-6 w-6 rounded-full bg-surface shadow-card transition-transform duration-200 ease-out ${
          checked ? "translate-x-[22px]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
