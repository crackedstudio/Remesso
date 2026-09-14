"use client";

import { useQuery } from "@tanstack/react-query";
import { useAccount, useReadContract, useSimulateContract } from "wagmi";
import { supabase } from "./supabase";
import { executorAbi, erc20Abi, quoterAbi } from "./abi";
import { CNGN, EXECUTOR_ADDRESS, POOL_FEE, QUOTER, USDT, isConfigured } from "./config";
import type { Numeric, Run, Schedule } from "./types";

/// The `senders` row for the connected wallet. Everything else keys off it, so
/// it is fetched once and shared rather than re-derived per component.
export function useSenderId() {
  const { address } = useAccount();
  return useQuery({
    queryKey: ["sender", address],
    enabled: Boolean(address),
    queryFn: async () => {
      const { data, error } = await supabase()
        .from("senders")
        .select("id")
        .eq("wallet_address", address!.toLowerCase())
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data?.id as string | undefined) ?? null;
    },
  });
}

export function useSchedules() {
  const { data: senderId } = useSenderId();
  return useQuery({
    queryKey: ["schedules", senderId],
    enabled: Boolean(senderId),
    queryFn: async () => {
      const { data, error } = await supabase()
        .from("schedules")
        .select("*, recipients(*)")
        .eq("sender_id", senderId!)
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as Schedule[];
    },
  });
}

export function useSchedule(id: string) {
  return useQuery({
    queryKey: ["schedule", id],
    queryFn: async () => {
      const { data, error } = await supabase()
        .from("schedules")
        .select("*, recipients(*)")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as Schedule | null) ?? null;
    },
  });
}

export function useRuns(scheduleId: string) {
  return useQuery({
    queryKey: ["runs", scheduleId],
    // An in-flight bank payout changes state without any action from this
    // browser, so poll rather than waiting for a refocus.
    refetchInterval: (q) => {
      const runs = q.state.data as Run[] | undefined;
      const open = runs?.some((r) =>
        ["pending", "swapping", "redeeming"].includes(r.status),
      );
      return open ? 15_000 : false;
    },
    queryFn: async () => {
      const { data, error } = await supabase()
        .from("runs")
        .select("*")
        .eq("schedule_id", scheduleId)
        .order("attempt", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as Run[];
    },
  });
}

/// The contract's own view of whether a schedule can run. This is the authority
/// — the database mirrors it — so anything that tells a sender "your next
/// payment will go through" reads from here, not from a row.
export function useRunnability(onchainId: Numeric | null) {
  return useReadContract({
    address: EXECUTOR_ADDRESS,
    abi: executorAbi,
    functionName: "runnability",
    args: onchainId ? [BigInt(onchainId)] : undefined,
    query: {
      enabled: Boolean(onchainId) && isConfigured(),
      refetchInterval: 30_000,
      select: (r) => ({
        due: r[0],
        funded: r[1],
        approved: r[2],
        floor: r[3],
        nextRunAt: r[4],
      }),
    },
  });
}

/// The sender's USDT allowance to the executor contract.
///
/// This is the outermost cap on everything Remesso can ever do, and it is
/// revocable without our cooperation — so the UI shows it as a running balance
/// rather than a setup step that disappears once completed.
export function useAllowance() {
  const { address } = useAccount();
  return useReadContract({
    address: USDT.address,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, EXECUTOR_ADDRESS] : undefined,
    query: { enabled: Boolean(address) && isConfigured(), refetchInterval: 20_000 },
  });
}

export function useUsdtBalance() {
  const { address } = useAccount();
  return useReadContract({
    address: USDT.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address), refetchInterval: 20_000 },
  });
}

/// A live USDT -> cNGN rate from the one pool that exists on Celo.
///
/// Shown so the sender's floor rate is set against the actual market rather
/// than a number they guessed. Quoted at the real trade size, because the pool
/// holds around $95k and a large run does not get the headline rate.
export function useMarketRate(amountIn: bigint) {
  const sim = useSimulateContract({
    address: QUOTER,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: USDT.address,
        tokenOut: CNGN.address,
        amountIn: amountIn > 0n ? amountIn : 1_000_000n,
        fee: POOL_FEE,
        sqrtPriceLimitX96: 0n,
      },
    ],
    query: { enabled: isConfigured(), refetchInterval: 60_000, retry: 1 },
  });

  const amountOut = sim.data?.result?.[0];
  const effective = amountIn > 0n && amountOut !== undefined
    ? (amountOut * 1_000_000n) / amountIn
    : undefined;

  return {
    /// Floor-rate units: cNGN base units out per 1e6 USDT base units in.
    rateE6: effective,
    amountOut,
    isLoading: sim.isLoading,
    error: sim.error,
  };
}
