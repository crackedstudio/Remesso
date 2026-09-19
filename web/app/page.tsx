"use client";

import Link from "next/link";
import { useAccount, useConnect } from "wagmi";
import { useAllowance, useIsMiniPay, useSchedules, useUsdtBalance } from "@/lib/hooks";
import { recipientLabel } from "@/lib/identity";
import { formatUnits, intervalLabel, relativeTime } from "@/lib/format";
import { SchedulePill } from "@/components/StatusPill";
import { ActionBar, Amount, MINIPAY_DEPOSIT_URL, Skeleton } from "@/components/ui";
import { isConfigured, tokenFor, USDT } from "@/lib/config";
import { one, type Schedule } from "@/lib/types";

export default function SchedulesPage() {
  const { isConnected } = useAccount();
  const { data: schedules, isPending, error } = useSchedules();
  const { data: allowance } = useAllowance();
  const { data: balance } = useUsdtBalance();
  const inMiniPay = useIsMiniPay();

  if (!isConfigured()) {
    return (
      <div className="notice-warn mt-2">
        <p className="font-medium">Not configured</p>
        <p className="mt-1">
          <code>NEXT_PUBLIC_REMESSO_EXECUTOR_ADDRESS</code> is unset, so there is no contract
          to read. Deploy <code>RemessoExecutor</code> and set it in <code>.env.local</code>.
        </p>
      </div>
    );
  }

  if (!isConnected) return <Landing />;

  const hasSchedules = Boolean(schedules?.length);

  return (
    <div className="pb-bar">
      <section className="mt-2 flex items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Available</p>
          {balance === undefined ? (
            <Skeleton className="mt-1.5 h-8 w-32" />
          ) : (
            <Amount value={formatUnits(balance, USDT.decimals)} unit="USDT" size="lg" />
          )}
        </div>
        {inMiniPay && (
          <a href={MINIPAY_DEPOSIT_URL} className="btn-soft btn-sm">
            Add money
          </a>
        )}
      </section>

      {/* The allowance is the sender's kill switch, so it is stated as one —
          but under a disclosure, because a returning sender came to check on
          a payment, not to re-read the security model. */}
      <details className="group mt-4 rounded-xl bg-sand/70">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-4 text-[13px] text-ink-2 [&::-webkit-details-marker]:hidden">
          <span>
            Remesso can move up to{" "}
            <span className="font-medium text-ink">
              {allowance !== undefined ? formatUnits(allowance, USDT.decimals) : "—"} USDT
            </span>{" "}
            in total
          </span>
          <span className="text-ink-3 transition group-open:rotate-180" aria-hidden>
            ▾
          </span>
        </summary>
        <p className="px-4 pb-3 text-[13px] leading-relaxed text-ink-2">
          That is the hard ceiling on everything Remesso can ever move, across all your
          schedules. Revoke it in your wallet and every schedule stops at once — no need to
          tell us.
        </p>
      </details>

      <section className="mt-8">
        <div className="mb-3 flex items-baseline justify-between">
          <h1 className="font-display text-[26px] text-ink">Schedules</h1>
          {hasSchedules && (
            <span className="text-[13px] text-ink-3">
              {schedules!.filter((s) => s.status === "active").length} active
            </span>
          )}
        </div>

        {error && (
          <div className="notice-danger mb-3">
            <p className="font-medium">Couldn&rsquo;t load your schedules</p>
            <p className="mt-0.5">{error.message}</p>
          </div>
        )}

        {isPending && !error ? (
          <ul className="space-y-3">
            {[0, 1].map((i) => (
              <li key={i} className="card flex items-center gap-4">
                <Skeleton className="h-11 w-11 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-3 w-3/4" />
                </div>
              </li>
            ))}
          </ul>
        ) : !hasSchedules ? (
          <EmptyState />
        ) : (
          <ul className="stagger space-y-3">
            {schedules!.map((s) => (
              <ScheduleCard key={s.id} schedule={s} />
            ))}
          </ul>
        )}
      </section>

      <ActionBar>
        <Link href="/schedules/new" className="btn-primary flex-1">
          {hasSchedules ? "New schedule" : "Set up your first schedule"}
        </Link>
      </ActionBar>
    </div>
  );
}

function ScheduleCard({ schedule }: { schedule: Schedule }) {
  const recipient = one(schedule.recipients);
  const isBank = recipient?.payout_type === "ngn_bank";
  const name = schedule.label || recipient?.display_name || "Remittance";
  const token = tokenFor(schedule.token_address);
  const quiet = schedule.status !== "active";

  return (
    <li>
      <Link
        href={`/schedules/${schedule.id}`}
        className={`card flex items-center gap-4 transition duration-200 ease-out hover:border-ink-3/60 active:scale-[0.99] ${
          quiet ? "bg-surface/60" : ""
        }`}
      >
        <Initial name={name} muted={quiet} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <p className="truncate text-[16px] font-medium text-ink">{name}</p>
            <SchedulePill status={schedule.status} />
          </div>
          <p className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-[13px] text-ink-2">
            <Amount value={formatUnits(schedule.amount_in, token.decimals)} unit={token.symbol} size="sm" />
            <span className="text-ink-3">·</span>
            <span>{intervalLabel(schedule.interval_seconds).toLowerCase()}</span>
          </p>
          <p className="mt-0.5 truncate text-[13px] text-ink-3">
            {schedule.status === "active"
              ? `Next ${relativeTime(schedule.next_run_at)}`
              : isBank
                ? `${recipient?.account_name ?? "Bank account"} · ${recipient?.account_number ?? ""}`
                : recipientLabel(null, recipient?.wallet_address)}
          </p>
        </div>
      </Link>
    </li>
  );
}

/// A person, not a row. Initials in a warm disc do more for "this is Mum's
/// money" than any icon could.
function Initial({ name, muted }: { name: string; muted?: boolean }) {
  const letter = name.trim().charAt(0).toUpperCase() || "•";
  return (
    <span
      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full font-display text-xl ${
        muted ? "bg-sand text-ink-3" : "bg-clay-soft text-clay-deep"
      }`}
      aria-hidden
    >
      {letter}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-line px-5 py-8">
      <p className="font-display text-[22px] leading-tight text-ink">
        Nothing set up yet.
      </p>
      <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
        A schedule is one decision you make once: who, how much, how often. After you
        sign it, it runs by itself — and it can only ever do what you signed.
      </p>
      <ol className="mt-5 space-y-2.5 text-[14px] text-ink">
        {[
          "Pick the person and how they get paid",
          "Set the amount and the rhythm",
          "Sign once in your wallet",
        ].map((step, i) => (
          <li key={step} className="flex items-center gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sand text-[12px] font-semibold text-ink-2">
              {i + 1}
            </span>
            {step}
          </li>
        ))}
      </ol>
    </div>
  );
}

/// Seen only outside MiniPay, or for the moment before MiniPay auto-connects.
function Landing() {
  const inMiniPay = useIsMiniPay();
  const { connect, connectors, isPending } = useConnect();
  const injected = connectors.find((c) => c.id === "injected");

  return (
    <div className="stagger mt-6">
      <h1 className="font-display text-[40px] leading-[1.02] text-ink">
        Send money home,
        <br />
        <span className="text-clay">on a schedule.</span>
      </h1>
      <p className="mt-5 max-w-sm text-[16px] leading-relaxed text-ink-2">
        Decide once who gets what and how often. Sign it in your wallet, and it runs on its
        own — every week or every month, without you remembering.
      </p>

      <ul className="mt-8 divide-y divide-line/70 border-y border-line/70">
        {[
          ["You stay in control", "Nothing moves outside the amount, rhythm and person you signed."],
          ["They see it in MiniPay", "Paid in USDT, USDC or cUSD — the balances MiniPay actually shows."],
          ["Stop it any time", "Pause or cancel from your wallet. No calls, no forms."],
        ].map(([title, body]) => (
          <li key={title} className="py-4">
            <p className="text-[15px] font-medium text-ink">{title}</p>
            <p className="mt-0.5 text-[14px] leading-relaxed text-ink-2">{body}</p>
          </li>
        ))}
      </ul>

      <div className="mt-8">
        {inMiniPay ? (
          <p className="text-[14px] text-ink-3">Connecting to your wallet…</p>
        ) : (
          <button
            className="btn-primary w-full"
            disabled={!injected || isPending}
            onClick={() => injected && connect({ connector: injected })}
          >
            {isPending ? "Connecting…" : injected ? "Connect wallet to begin" : "Open in MiniPay"}
          </button>
        )}
      </div>
    </div>
  );
}
