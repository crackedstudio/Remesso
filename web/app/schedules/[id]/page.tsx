"use client";

import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { explainRun } from "@/lib/ai";
import { useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { wagmiConfig } from "@/lib/wagmi";
import { txOverrides } from "@/lib/tx";
import { executorAbi } from "@/lib/abi";
import { EXECUTOR_ADDRESS, EXPLORER, CNGN, tokenFor } from "@/lib/config";
import { supabase } from "@/lib/supabase";
import { useRunnability, useRuns, useSchedule } from "@/lib/hooks";
import {
  formatUnits,
  intervalLabel,
  rateToNairaPerUsd,
  relativeTime,
  shortAddress,
} from "@/lib/format";
import { RunPill, SchedulePill } from "@/components/StatusPill";
import { one, type Run } from "@/lib/types";

export default function ScheduleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { writeContractAsync } = useWriteContract();

  const { data: schedule, isLoading } = useSchedule(id);
  const { data: runs } = useRuns(id);
  const { data: runnability } = useRunnability(schedule?.onchain_id ?? null);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (isLoading) return <div className="card text-sm text-black/50">Loading…</div>;
  if (!schedule) return <div className="card text-sm">Schedule not found.</div>;

  const recipient = one(schedule.recipients);
  const isBank = recipient?.payout_type === "ngn_bank";
  // Direct moves the funding asset untouched — there is no swap to link to.
  const converts = recipient?.payout_type !== "direct";
  const live = schedule.status === "active" || schedule.status === "paused";

  async function act(action: "pause" | "resume" | "cancel") {
    if (!schedule?.onchain_id) return;
    setError(null);
    setBusy(action === "cancel" ? "Cancelling…" : "Updating…");
    try {
      const hash =
        action === "cancel"
          ? await writeContractAsync({
              address: EXECUTOR_ADDRESS,
              abi: executorAbi,
              functionName: "cancelSchedule",
              args: [BigInt(schedule.onchain_id)],
              ...txOverrides(),
            })
          : await writeContractAsync({
              address: EXECUTOR_ADDRESS,
              abi: executorAbi,
              functionName: "setScheduleActive",
              args: [BigInt(schedule.onchain_id), action === "resume"],
              ...txOverrides(),
            });
      await waitForTransactionReceipt(wagmiConfig, { hash });

      // The contract is already the authority; this mirrors it so the executor
      // loop stops picking the schedule up on its next tick.
      await supabase()
        .from("schedules")
        .update({
          status: action === "cancel" ? "cancelled" : action === "pause" ? "paused" : "active",
        })
        .eq("id", schedule.id);

      await queryClient.invalidateQueries({ queryKey: ["schedule", schedule.id] });
      await queryClient.invalidateQueries({ queryKey: ["schedules"] });
      if (action === "cancel") router.push("/");
    } catch (e) {
      const msg = (e as Error).message;
      setError(/User rejected|denied/i.test(msg) ? "You cancelled the signature." : msg.split("\n")[0]);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold">
              {schedule.label || recipient?.display_name}
            </h1>
            <p className="mt-0.5 text-xs text-black/50">
              {isBank
                ? `${recipient?.account_name} · ${recipient?.account_number}`
                : shortAddress(recipient?.wallet_address ?? undefined)}
            </p>
          </div>
          <SchedulePill status={schedule.status} />
        </div>

        <dl className="mt-4 divide-y divide-black/5 text-sm">
          <Row label="Each transfer">
            <span className="mono">
              {formatUnits(schedule.amount_in, tokenFor(schedule.token_address).decimals)}{" "}
              {tokenFor(schedule.token_address).symbol}
            </span>
          </Row>
          <Row label="Frequency">{intervalLabel(schedule.interval_seconds)}</Row>
          <Row label="Rate floor">
            ₦{rateToNairaPerUsd(schedule.min_rate_e6).toFixed(0)} per USDT
          </Row>
          <Row label="Next run">
            {schedule.status === "active" ? relativeTime(schedule.next_run_at) : "—"}
          </Row>
          {schedule.onchain_id && (
            <Row label="On-chain id">
              <span className="mono">#{schedule.onchain_id}</span>
            </Row>
          )}
        </dl>
      </div>

      {/* The contract's own answer, not our mirror of it. If these disagree, the
          contract is right and the sender needs to know which one is blocking. */}
      {runnability && live && (
        <div className="card">
          <p className="label">Readiness, straight from the contract</p>
          <ul className="space-y-1.5 text-sm">
            <Check ok={runnability.funded} label="Wallet holds enough USDT" fix="Top up your wallet." />
            <Check
              ok={runnability.approved}
              label="Allowance covers the next run"
              fix="Re-approve USDT to resume."
            />
            <Check
              ok={runnability.due || schedule.status !== "active"}
              label="Due to run"
              fix={`Next attempt ${relativeTime(Number(runnability.nextRunAt))}.`}
              neutral
            />
          </ul>
        </div>
      )}

      {live && (
        <div className="flex gap-2">
          <button
            className="btn-ghost flex-1"
            disabled={Boolean(busy)}
            onClick={() => act(schedule.status === "active" ? "pause" : "resume")}
          >
            {schedule.status === "active" ? "Pause" : "Resume"}
          </button>
          <button
            className="btn-ghost flex-1 border-red-200 text-red-700 hover:bg-red-50"
            disabled={Boolean(busy)}
            onClick={() => act("cancel")}
          >
            Cancel permanently
          </button>
        </div>
      )}
      {busy && <p className="text-center text-sm text-black/50">{busy}</p>}
      {error && <div className="card border-red-300 bg-red-50 text-sm text-red-800">{error}</div>}

      <section>
        <h2 className="mb-2 text-sm font-medium text-black/60">History</h2>
        {!runs?.length ? (
          <div className="card text-sm text-black/50">No runs yet.</div>
        ) : (
          <ul className="space-y-2">
            {runs.map((r) => (
              <RunRow key={r.id} run={r} isBank={isBank} converts={converts} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function RunRow({ run, isBank, converts }: { run: Run; isBank: boolean; converts: boolean }) {
  return (
    <li className="card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm">
            <span className="mono">
              {formatUnits(run.amount_in, tokenFor(run.token_address).decimals)}
            </span>{" "}
            {tokenFor(run.token_address).symbol}
            {run.amount_out && run.amount_out !== run.amount_in && (
              <>
                {" → "}
                <span className="mono text-naira">
                  ₦{formatUnits(run.amount_out, CNGN.decimals, 0)}
                </span>
              </>
            )}
          </p>
          <p className="mt-0.5 text-xs text-black/50">
            Run #{run.attempt} · {relativeTime(run.started_at)}
          </p>
        </div>
        <RunPill status={run.status} isBank={isBank} />
      </div>

      {/* The distinction this whole design exists to preserve: the swap landing
          is not the recipient being paid. */}
      {isBank && run.status === "redeeming" && (
        <p className="mt-2 rounded bg-sky-50 p-2 text-xs text-sky-900">
          cNGN has been delivered and the naira payout is in progress. This is not settled
          until the bank confirms it.
        </p>
      )}

      {run.failure_reason && <WhatHappened reason={run.failure_reason} />}

      <div className="mt-2 flex flex-wrap gap-3 text-xs">
        {run.tx_hash && (
          <a
            className="text-black/50 underline underline-offset-2 hover:text-ink"
            href={`${EXPLORER}/tx/${run.tx_hash}`}
            target="_blank"
            rel="noreferrer"
          >
            {converts ? "Swap transaction" : "Transaction"}
          </a>
        )}
        {run.cngn_trx_ref && (
          <span className="mono text-black/40">cNGN {run.cngn_trx_ref}</span>
        )}
      </div>
    </li>
  );
}

function Check({
  ok,
  label,
  fix,
  neutral,
}: {
  ok: boolean;
  label: string;
  fix: string;
  neutral?: boolean;
}) {
  return (
    <li className="flex items-start gap-2">
      <span className={ok ? "text-emerald-600" : neutral ? "text-black/30" : "text-red-600"}>
        {ok ? "✓" : neutral ? "•" : "✕"}
      </span>
      <span>
        {label}
        {!ok && <span className="block text-xs text-black/50">{fix}</span>}
      </span>
    </li>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-2.5">
      <dt className="text-black/50">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

/// The backend's reason, rewritten for the person reading it.
///
/// The raw string is still rendered first and never replaced — it is what
/// actually happened, and it is what someone will quote when asking for help.
/// The assistant's version sits underneath as a reading aid, and if the call
/// fails or is not configured nothing is shown and nothing is lost.
function WhatHappened({ reason }: { reason: string }) {
  const { data } = useQuery({
    queryKey: ["explain", reason],
    queryFn: () => explainRun(reason),
    // Reasons repeat across runs and the wording is not time-sensitive, so this
    // is cached hard rather than re-asked per render.
    staleTime: 24 * 3600 * 1000,
    gcTime: 24 * 3600 * 1000,
    retry: false,
  });

  return (
    <div className="mt-2 rounded bg-red-50 p-2 text-xs text-red-800">
      <p>{reason}</p>
      {data && (
        <p className="mt-1.5 border-t border-red-200 pt-1.5 text-red-900">
          <span className="font-medium">{data.title}.</span> {data.detail}
          {data.action && <span className="font-medium"> {data.action}.</span>}
        </p>
      )}
    </div>
  );
}
