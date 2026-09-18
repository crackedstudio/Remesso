"use client";

import Link from "next/link";
import { useAccount } from "wagmi";
import { useAllowance, useSchedules, useUsdtBalance } from "@/lib/hooks";
import { recipientLabel } from "@/lib/identity";
import { formatUnits, intervalLabel, relativeTime } from "@/lib/format";
import { SchedulePill } from "@/components/StatusPill";
import { isConfigured, tokenFor, USDT } from "@/lib/config";
import { one, type Schedule } from "@/lib/types";

export default function SchedulesPage() {
  const { isConnected } = useAccount();
  const { data: schedules, isLoading, error } = useSchedules();
  const { data: allowance } = useAllowance();
  const { data: balance } = useUsdtBalance();

  if (!isConfigured()) {
    return (
      <Notice title="Not configured">
        <code className="mono">NEXT_PUBLIC_REMESSO_EXECUTOR_ADDRESS</code> is unset, so
        there is no contract to read. Deploy <code className="mono">RemessoExecutor</code>{" "}
        and set it in <code className="mono">.env.local</code>.
      </Notice>
    );
  }

  if (!isConnected) {
    return (
      <div className="card text-center">
        <h1 className="text-xl font-semibold">Recurring remittances, on your terms</h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-black/60">
          Authorise a transfer once — recipient, amount, cadence, floor rate — and it runs
          on its own. Remesso never holds your keys and can never send anywhere except
          the address you fixed when you signed.
        </p>
        <p className="mt-4 text-sm text-black/50">Connect your wallet to begin.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex items-baseline justify-between">
          <span className="label mb-0">Your USDT</span>
          <span className="mono text-lg">{balance !== undefined ? formatUnits(balance, USDT.decimals) : "—"}</span>
        </div>
        <div className="mt-3 flex items-baseline justify-between border-t border-black/5 pt-3">
          <span className="label mb-0">Authorised to Remesso</span>
          <span className="mono text-lg">
            {allowance !== undefined ? formatUnits(allowance, USDT.decimals) : "—"}
          </span>
        </div>
        {/* The allowance is the sender's kill switch, so it is stated as one. */}
        <p className="hint">
          This allowance is the hard ceiling on everything Remesso can move. Revoking it in
          your wallet stops every schedule immediately, with no involvement from us.
        </p>
      </div>

      {error && <Notice title="Could not load schedules">{error.message}</Notice>}

      {isLoading ? (
        <div className="card text-sm text-black/50">Loading…</div>
      ) : !schedules?.length ? (
        <div className="card text-center">
          <p className="text-sm text-black/60">No schedules yet.</p>
          <Link href="/schedules/new" className="btn-primary mt-4">
            Create your first
          </Link>
        </div>
      ) : (
        <ul className="space-y-3">
          {schedules.map((s) => (
            <ScheduleCard key={s.id} schedule={s} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ScheduleCard({ schedule }: { schedule: Schedule }) {
  const recipient = one(schedule.recipients);
  const isBank = recipient?.payout_type === "ngn_bank";

  return (
    <li>
      <Link href={`/schedules/${schedule.id}`} className="card block hover:border-black/20">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-medium">
              {schedule.label || recipient?.display_name || "Remittance"}
            </p>
            <p className="mt-0.5 truncate text-xs text-black/50">
              {isBank
                ? `${recipient?.account_name ?? "Bank account"} · ${recipient?.account_number ?? ""}`
                : recipientLabel(null, recipient?.wallet_address)}
            </p>
          </div>
          <SchedulePill status={schedule.status} />
        </div>

        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-black/5 pt-3 text-xs text-black/60">
          <span>
            <span className="mono text-sm text-ink">
              {formatUnits(schedule.amount_in, tokenFor(schedule.token_address).decimals)}
            </span>{" "}
            {tokenFor(schedule.token_address).symbol}
          </span>
          <span>{intervalLabel(schedule.interval_seconds)}</span>
          <span>
            {schedule.status === "active"
              ? `Next ${relativeTime(schedule.next_run_at)}`
              : schedule.onchain_id
                ? `Schedule #${schedule.onchain_id}`
                : "Awaiting signature"}
          </span>
        </div>
      </Link>
    </li>
  );
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card border-amber-300 bg-amber-50">
      <p className="font-medium text-amber-900">{title}</p>
      <div className="mt-1 text-sm leading-relaxed text-amber-900/80">{children}</div>
    </div>
  );
}
