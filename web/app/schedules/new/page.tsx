"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { parseEventLogs } from "viem";
import { wagmiConfig } from "@/lib/wagmi";
import { erc20Abi, executorAbi, PayoutType } from "@/lib/abi";
import {
  CNGN_REDEMPTION_ADDRESS,
  EXECUTOR_ADDRESS,
  USDT,
  isConfigured,
} from "@/lib/config";
import { supabase, ensureSender } from "@/lib/supabase";
import { useAllowance, useMarketRate, useUsdtBalance } from "@/lib/hooks";
import { formatUnits6, intervalLabel, rateToNairaPerUsd } from "@/lib/format";
import {
  RecipientStep,
  emptyRecipient,
  recipientIsComplete,
  type RecipientDraft,
} from "@/components/RecipientStep";
import { TermsStep, amountInUnits, defaultTerms, type TermsDraft } from "@/components/TermsStep";

const STEPS = ["Recipient", "Terms", "Authorise"] as const;

export default function NewSchedulePage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { address, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();

  const [step, setStep] = useState(0);
  const [recipient, setRecipient] = useState<RecipientDraft>(emptyRecipient);
  const [terms, setTerms] = useState<TermsDraft>(defaultTerms);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const amountIn = amountInUnits(terms);
  const { data: allowance } = useAllowance();
  const { data: balance } = useUsdtBalance();
  const market = useMarketRate(amountIn ?? 0n);

  // Unlimited schedules still need a finite allowance. A year of runs is a
  // defensible default: long enough not to nag, short enough that a forgotten
  // schedule cannot drain a wallet indefinitely.
  const runsToCover = terms.maxRuns ? Number(terms.maxRuns) : 12;
  const requiredAllowance = amountIn ? amountIn * BigInt(runsToCover) : 0n;
  const needsApproval = allowance !== undefined && allowance < requiredAllowance;

  const canContinue =
    step === 0 ? recipientIsComplete(recipient) : step === 1 ? Boolean(amountIn) : true;

  if (!isConfigured()) {
    return <Warn>The executor contract address is not configured.</Warn>;
  }
  if (!isConnected) {
    return <Warn>Connect your wallet to create a schedule.</Warn>;
  }

  async function authorise() {
    setError(null);
    if (!amountIn || !address) return;

    const floorE6 = market.rateE6
      ? (market.rateE6 * BigInt(100 - terms.floorPercent)) / 100n
      : null;
    if (!floorE6) {
      setError("Could not read a live rate from the pool. Try again in a moment.");
      return;
    }

    const destination =
      recipient.payoutType === "wallet"
        ? (recipient.walletAddress as `0x${string}`)
        : (CNGN_REDEMPTION_ADDRESS as `0x${string}`);

    if (!destination) {
      setError("No destination address. Bank payouts are not configured.");
      return;
    }

    try {
      setBusy("Preparing…");
      const senderId = await ensureSender(address);
      const sb = supabase();

      // Written before the transaction, deliberately. If the sender signs and
      // then closes the tab, the bank details and the policy still exist and
      // the schedule can be reconciled from `schedulesOf(address)`. The row is
      // inert until `onchain_id` is set, and `due_schedules` skips it.
      const { data: recipientRow, error: rErr } = await sb
        .from("recipients")
        .insert({
          sender_id: senderId,
          display_name: recipient.displayName.trim(),
          payout_type: recipient.payoutType,
          wallet_address:
            recipient.payoutType === "wallet" ? recipient.walletAddress.toLowerCase() : null,
          bank_code: recipient.payoutType === "ngn_bank" ? recipient.bankCode : null,
          account_number: recipient.payoutType === "ngn_bank" ? recipient.accountNumber : null,
          account_name: recipient.payoutType === "ngn_bank" ? recipient.accountName : null,
          bank_verified_at:
            recipient.payoutType === "ngn_bank" ? new Date().toISOString() : null,
        })
        .select("id")
        .single();
      if (rErr) throw new Error(rErr.message);

      const expiresAt = terms.expiresAt
        ? BigInt(Math.floor(new Date(`${terms.expiresAt}T23:59:59Z`).getTime() / 1000))
        : 0n;

      const { data: scheduleRow, error: sErr } = await sb
        .from("schedules")
        .insert({
          sender_id: senderId,
          recipient_id: recipientRow.id,
          // Schedule ids are per-contract, so a row is only identified by the
          // pair. Without this a redeploy collides with the old contract's ids.
          executor_address: EXECUTOR_ADDRESS,
          amount_in: amountIn.toString(),
          interval_seconds: terms.intervalSeconds,
          min_rate_e6: floorE6.toString(),
          max_runs: terms.maxRuns ? Number(terms.maxRuns) : 0,
          expires_at: terms.expiresAt ? new Date(`${terms.expiresAt}T23:59:59Z`).toISOString() : null,
          status: "pending_authorization",
          label: recipient.displayName.trim(),
        })
        .select("id")
        .single();
      if (sErr) throw new Error(sErr.message);

      if (needsApproval) {
        setBusy("Approve USDT in your wallet…");
        const approveHash = await writeContractAsync({
          address: USDT.address,
          abi: erc20Abi,
          functionName: "approve",
          args: [EXECUTOR_ADDRESS, requiredAllowance],
        });
        setBusy("Waiting for the approval to confirm…");
        await waitForTransactionReceipt(wagmiConfig, { hash: approveHash });
      }

      setBusy("Sign the authorisation…");
      const hash = await writeContractAsync({
        address: EXECUTOR_ADDRESS,
        abi: executorAbi,
        functionName: "createSchedule",
        args: [
          destination,
          amountIn,
          BigInt(terms.intervalSeconds),
          floorE6,
          terms.maxRuns ? Number(terms.maxRuns) : 0,
          expiresAt,
          terms.startNow ? 0n : BigInt(Math.floor(Date.now() / 1000) + terms.intervalSeconds),
          recipient.payoutType === "wallet" ? PayoutType.Wallet : PayoutType.BankRedemption,
        ],
      });

      setBusy("Confirming on Celo…");
      const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, confirmations: 1 });

      // The id comes from the event, not from a return value: a transaction's
      // return data is not available to a wallet, only its logs are.
      const [created] = parseEventLogs({
        abi: executorAbi,
        eventName: "ScheduleCreated",
        logs: receipt.logs,
      });
      if (!created) throw new Error("Transaction confirmed but no ScheduleCreated event was found");

      const onchainId = created.args.id.toString();

      setBusy("Saving…");
      const { error: uErr } = await sb
        .from("schedules")
        .update({
          onchain_id: onchainId,
          authorized_tx_hash: hash,
          status: "active",
          next_run_at: terms.startNow
            ? new Date().toISOString()
            : new Date(Date.now() + terms.intervalSeconds * 1000).toISOString(),
        })
        .eq("id", scheduleRow.id);
      if (uErr) throw new Error(uErr.message);

      await queryClient.invalidateQueries({ queryKey: ["schedules"] });
      router.push(`/schedules/${scheduleRow.id}`);
    } catch (e) {
      setError(friendly((e as Error).message));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      <ol className="flex items-center gap-2 text-xs">
        {STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            <span
              className={`rounded-full px-2.5 py-1 ${
                i === step ? "bg-ink text-white" : i < step ? "bg-emerald-100 text-emerald-800" : "bg-black/5 text-black/40"
              }`}
            >
              {s}
            </span>
            {i < STEPS.length - 1 && <span className="text-black/20">›</span>}
          </li>
        ))}
      </ol>

      <div className="card">
        {step === 0 && <RecipientStep value={recipient} onChange={setRecipient} />}
        {step === 1 && <TermsStep value={terms} onChange={setTerms} />}
        {step === 2 && (
          <Review
            recipient={recipient}
            terms={terms}
            amountIn={amountIn}
            marketRateE6={market.rateE6}
            requiredAllowance={requiredAllowance}
            needsApproval={needsApproval}
            balance={balance}
          />
        )}
      </div>

      {error && (
        <div className="card border-red-300 bg-red-50 text-sm text-red-800">{error}</div>
      )}

      <div className="flex gap-2">
        {step > 0 && (
          <button className="btn-ghost" disabled={Boolean(busy)} onClick={() => setStep(step - 1)}>
            Back
          </button>
        )}
        {step < 2 ? (
          <button
            className="btn-primary flex-1"
            disabled={!canContinue}
            onClick={() => setStep(step + 1)}
          >
            Continue
          </button>
        ) : (
          <button className="btn-primary flex-1" disabled={Boolean(busy)} onClick={authorise}>
            {busy ?? (needsApproval ? "Approve & authorise" : "Authorise")}
          </button>
        )}
      </div>
    </div>
  );
}

function Review({
  recipient,
  terms,
  amountIn,
  marketRateE6,
  requiredAllowance,
  needsApproval,
  balance,
}: {
  recipient: RecipientDraft;
  terms: TermsDraft;
  amountIn: bigint | null;
  marketRateE6?: bigint;
  requiredAllowance: bigint;
  needsApproval: boolean;
  balance?: bigint;
}) {
  const floorE6 = marketRateE6
    ? (marketRateE6 * BigInt(100 - terms.floorPercent)) / 100n
    : undefined;
  const short = balance !== undefined && amountIn !== null && balance < amountIn;

  return (
    <div className="space-y-4">
      <dl className="divide-y divide-black/5 text-sm">
        <Row label="To">
          {recipient.displayName}
          <span className="block text-xs text-black/50">
            {recipient.payoutType === "wallet"
              ? recipient.walletAddress
              : `${recipient.accountName} · ${recipient.accountNumber}`}
          </span>
        </Row>
        <Row label="Each transfer">
          <span className="mono">{amountIn ? formatUnits6(amountIn) : "—"} USDT</span>
        </Row>
        <Row label="Frequency">{intervalLabel(terms.intervalSeconds)}</Row>
        <Row label="Rate floor">
          {floorE6 ? `₦${rateToNairaPerUsd(floorE6).toFixed(0)} per USDT` : "—"}
          <span className="block text-xs text-black/50">
            {terms.floorPercent}% below the current rate. Runs below this are skipped, not
            executed.
          </span>
        </Row>
        <Row label="Transfers">{terms.maxRuns || "Until you stop it"}</Row>
        <Row label="Expires">{terms.expiresAt || "Never"}</Row>
        <Row label="You will approve">
          <span className="mono">{formatUnits6(requiredAllowance)} USDT</span>
          <span className="block text-xs text-black/50">
            {needsApproval
              ? "One approval covers every run. Revoke it any time to stop everything."
              : "Your existing allowance already covers this."}
          </span>
        </Row>
      </dl>

      {short && (
        <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
          Your wallet holds {formatUnits6(balance!)} USDT, less than one transfer. The
          schedule will be created but runs will be skipped until you top up.
        </p>
      )}

      <p className="rounded-lg bg-black/[0.03] p-3 text-xs leading-relaxed text-black/60">
        Signing fixes the destination, the amount, the cadence and the floor rate on Celo.
        Remesso&rsquo;s backend can only trigger a run inside those limits — it cannot change
        any of them, and it cannot send anywhere else.
      </p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-2.5">
      <dt className="shrink-0 text-black/50">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

function Warn({ children }: { children: React.ReactNode }) {
  return <div className="card border-amber-300 bg-amber-50 text-sm text-amber-900">{children}</div>;
}

/// Wallet errors are long and mostly internal. Surface the part a sender can
/// act on and keep the rest in the console.
function friendly(msg: string): string {
  if (/User rejected|User denied/i.test(msg)) return "You cancelled the signature.";
  if (/insufficient funds/i.test(msg)) return "Not enough CELO to pay gas for this transaction.";
  if (/duplicate key|unique/i.test(msg)) return "That wallet is already registered in another session.";
  return msg.split("\n")[0].slice(0, 300);
}
