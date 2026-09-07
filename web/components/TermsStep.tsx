"use client";

import { useMarketRate } from "@/lib/hooks";
import { INTERVALS, formatUnits6, parseUnits6, rateToNairaPerUsd } from "@/lib/format";

export type TermsDraft = {
  amount: string;          // decimal USDT as typed
  intervalSeconds: number;
  floorPercent: number;    // how far below market the sender will accept
  maxRuns: string;         // "" = unlimited
  expiresAt: string;       // yyyy-mm-dd, "" = never
  startNow: boolean;
};

export const defaultTerms: TermsDraft = {
  amount: "",
  intervalSeconds: INTERVALS[2].seconds, // monthly
  floorPercent: 3,
  maxRuns: "12",
  expiresAt: "",
  startNow: true,
};

export function amountInUnits(t: TermsDraft): bigint | null {
  try {
    const v = parseUnits6(t.amount);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

export function TermsStep({
  value,
  onChange,
}: {
  value: TermsDraft;
  onChange: (t: TermsDraft) => void;
}) {
  const set = (patch: Partial<TermsDraft>) => onChange({ ...value, ...patch });
  const amount = amountInUnits(value);
  const market = useMarketRate(amount ?? 0n);

  const floorE6 = market.rateE6
    ? (market.rateE6 * BigInt(100 - value.floorPercent)) / 100n
    : undefined;

  return (
    <div className="space-y-5">
      <div>
        <label className="label">Amount per transfer</label>
        <div className="relative">
          <input
            className="field pr-16 text-lg"
            inputMode="decimal"
            placeholder="50.00"
            value={value.amount}
            onChange={(e) => set({ amount: e.target.value })}
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-black/40">
            USDT
          </span>
        </div>
        {market.rateE6 && amount && (
          <p className="hint">
            About{" "}
            <span className="mono text-ink">
              ₦{formatUnits6((amount * market.rateE6) / 1_000_000n, 0)}
            </span>{" "}
            at today&rsquo;s rate of ₦{rateToNairaPerUsd(market.rateE6).toFixed(2)} per USDT.
          </p>
        )}
      </div>

      <div>
        <label className="label">How often</label>
        <div className="grid grid-cols-2 gap-2">
          {INTERVALS.map((i) => (
            <button
              key={i.seconds}
              type="button"
              onClick={() => set({ intervalSeconds: i.seconds })}
              className={`rounded-lg border px-3 py-2.5 text-sm transition ${
                value.intervalSeconds === i.seconds
                  ? "border-ink bg-ink text-white"
                  : "border-black/15 bg-white hover:bg-black/[0.03]"
              }`}
            >
              {i.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="label">Rate floor</label>
        <input
          type="range"
          min={1}
          max={10}
          step={1}
          className="w-full accent-ink"
          value={value.floorPercent}
          onChange={(e) => set({ floorPercent: Number(e.target.value) })}
        />
        <div className="mt-1 flex items-baseline justify-between text-sm">
          <span className="text-black/60">
            Skip a run if the rate falls more than{" "}
            <span className="font-medium text-ink">{value.floorPercent}%</span> below today
          </span>
          {floorE6 !== undefined && (
            <span className="mono">₦{rateToNairaPerUsd(floorE6).toFixed(0)}</span>
          )}
        </div>
        {/* This is the single most important number a sender sets, so it says
            plainly what it protects them from. */}
        <p className="hint">
          Written into the contract. Nobody — not Remesso, not a compromised backend key —
          can execute a run below this rate. A tighter floor means fewer bad transfers and
          more skipped months.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Number of transfers</label>
          <input
            className="field"
            inputMode="numeric"
            placeholder="Unlimited"
            value={value.maxRuns}
            onChange={(e) => set({ maxRuns: e.target.value.replace(/\D/g, "") })}
          />
          <p className="hint">Blank runs until you stop it.</p>
        </div>
        <div>
          <label className="label">Stop after</label>
          <input
            type="date"
            className="field"
            value={value.expiresAt}
            min={new Date(Date.now() + 86400_000).toISOString().slice(0, 10)}
            onChange={(e) => set({ expiresAt: e.target.value })}
          />
          <p className="hint">Optional hard expiry.</p>
        </div>
      </div>

      <label className="flex items-start gap-3 rounded-lg border border-black/10 bg-white p-3">
        <input
          type="checkbox"
          className="mt-0.5 accent-ink"
          checked={value.startNow}
          onChange={(e) => set({ startNow: e.target.checked })}
        />
        <span className="text-sm">
          Send the first transfer straight away
          <span className="block text-xs text-black/50">
            Otherwise the first runs one full interval from now.
          </span>
        </span>
      </label>
    </div>
  );
}
