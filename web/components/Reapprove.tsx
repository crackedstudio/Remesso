"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BaseError, InsufficientFundsError, UserRejectedRequestError } from "viem";
import { useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { erc20Abi } from "@/lib/abi";
import { EXECUTOR_ADDRESS, tokenFor, type TokenInfo } from "@/lib/config";
import { formatUnits } from "@/lib/format";
import { useAllowance, useSchedules } from "@/lib/hooks";
import { txOverrides } from "@/lib/tx";
import { wagmiConfig } from "@/lib/wagmi";

/// Runs one approval covers. Same default as creating a schedule: long enough
/// not to nag, short enough that a forgotten schedule cannot drain a wallet.
const RUNS_PER_APPROVAL = 12n;

/// Where the sender's approval stands for one funding asset, measured against
/// the active schedules that draw on it.
///
/// `stuck` is the state the home screen used to hide: an active schedule with
/// a next date, and an allowance too small for even one of its payments, so
/// every run is skipped. The contract says so (`runnability().approved`); the
/// list did not.
export function useApprovalCover(token: TokenInfo) {
  const { data: schedules } = useSchedules();
  const { data: allowance } = useAllowance(token.address);
  const active = (schedules ?? []).filter(
    (s) => s.status === "active" && tokenFor(s.token_address).symbol === token.symbol,
  );
  const amounts = active.map((s) => BigInt(s.amount_in));
  const smallest = amounts.length ? amounts.reduce((a, b) => (b < a ? b : a)) : undefined;
  const stuck = allowance !== undefined && smallest !== undefined && allowance < smallest;
  // Added to what is there, never replacing it: `approve` sets the allowance
  // outright, so approving one schedule's need alone would erase the headroom
  // every other schedule on this asset was counting on.
  const topUp = amounts.reduce((a, b) => a + b, 0n) * RUNS_PER_APPROVAL;
  return { allowance, active, stuck, target: (allowance ?? 0n) + topUp, topUp };
}

/// Approve again from inside Remesso.
///
/// "Re-approve in your wallet" is not an instruction a MiniPay user can act on:
/// there is no approvals screen in MiniPay to send them to, and no other place
/// that calls `approve` for them. So the way back for a stuck schedule has to
/// be here.
export function ReapproveButton({ token }: { token: TokenInfo }) {
  const { target, topUp } = useApprovalCover(token);
  const { refetch } = useAllowance(token.address);
  const qc = useQueryClient();
  const { writeContractAsync } = useWriteContract();
  const [state, setState] = useState<"idle" | "pending" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setError(null);
    setState("pending");
    try {
      const hash = await writeContractAsync({
        address: token.address,
        abi: erc20Abi,
        functionName: "approve",
        args: [EXECUTOR_ADDRESS, target],
        ...txOverrides(),
      });
      // Success means mined, not submitted: a reverted approval that we had
      // already called "done" would leave the schedule stuck with a green tick.
      const receipt = await waitForTransactionReceipt(wagmiConfig, { hash });
      if (receipt.status !== "success") throw new Error("The approval did not go through.");
      await refetch();
      // Each schedule page reads the contract's own view; make them re-ask.
      await qc.invalidateQueries({
        predicate: (q) =>
          q.queryKey[0] === "readContract" &&
          (q.queryKey[1] as { functionName?: string } | undefined)?.functionName === "runnability",
      });
      setState("done");
    } catch (e) {
      // Mapped from error types, not message text: wallets word the same
      // rejection differently, and MiniPay's review checks for exactly this.
      const is = (T: new (...a: never[]) => Error) =>
        e instanceof BaseError && Boolean(e.walk((x) => x instanceof T));
      setError(
        is(UserRejectedRequestError)
          ? "You cancelled the approval."
          : is(InsufficientFundsError)
            ? `Not enough ${token.symbol} to pay the network fee.`
            : "The approval didn’t go through. Try again.",
      );
      setState("idle");
    }
  }

  if (topUp === 0n) return null;
  return (
    <div className="mt-3">
      <button
        type="button"
        className="btn-ink btn-sm"
        disabled={state === "pending"}
        onClick={approve}
      >
        {state === "pending" ? "Approving…" : state === "done" ? "Approved" : "Approve again"}
      </button>
      <p className="mt-2 text-[12px] text-ink-2">
        Adds {formatUnits(topUp, token.decimals)} {token.symbol} — a year of these payments.
      </p>
      {error && <p className="mt-1 text-[13px] text-danger">{error}</p>}
    </div>
  );
}
