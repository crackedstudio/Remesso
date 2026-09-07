/// Celo / contract access. viem, because MiniPay does not support ethers.
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
} from "npm:viem@2";
import { privateKeyToAccount } from "npm:viem@2/accounts";
import { celo } from "npm:viem@2/chains";
import { CELO, LIMITS } from "./config.ts";

export const publicClient = createPublicClient({
  chain: celo,
  transport: http(CELO.rpcUrl),
});

export function executorAccount() {
  const pk = Deno.env.get("EXECUTOR_PRIVATE_KEY")!;
  return privateKeyToAccount(pk as `0x${string}`);
}

export function walletClient() {
  return createWalletClient({
    account: executorAccount(),
    chain: celo,
    transport: http(CELO.rpcUrl),
  });
}

export const executorAbi = parseAbi([
  "function executeRun(uint256 id, uint256 amountOutMinimum) returns (uint256)",
  "function runnability(uint256 id) view returns (bool due, bool funded, bool approved, uint256 floor, uint64 nextRunAt)",
  "function getSchedule(uint256 id) view returns ((address sender,uint64 interval,uint32 maxRuns,address destination,uint64 nextRunAt,uint32 runsExecuted,uint128 amountIn,uint96 minRateE6,uint64 expiresAt,uint8 payoutType,bool active,bool cancelled))",
]);

const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);

/// Live quote for USDT -> cNGN, plus the slippage bound to hand the contract.
///
/// The contract enforces the sender's own floor rate independently; this is
/// the tighter, market-aware bound on top of it.
export async function quoteUsdtToCngn(amountIn: bigint): Promise<{
  amountOut: bigint;
  minOut: bigint;
  rateE6: bigint;
}> {
  const { result } = await publicClient.simulateContract({
    address: CELO.quoter,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{
      tokenIn: CELO.usdt,
      tokenOut: CELO.cngn,
      amountIn,
      fee: CELO.poolFee,
      sqrtPriceLimitX96: 0n,
    }],
  });

  const amountOut = result[0];
  const minOut = (amountOut * BigInt(10_000 - LIMITS.maxSlippageBps)) / 10_000n;
  const rateE6 = (amountOut * 1_000_000n) / amountIn;
  return { amountOut, minOut, rateE6 };
}

/// The cNGN/USDT pool is the single venue on Celo and holds roughly $95k.
/// Before every run we confirm the pool can still fill it at a sane price —
/// a run that would move the price more than `maxAcceptableImpactBps` is
/// skipped and the sender notified, never executed at any cost.
export async function liquidityIsHealthy(amountIn: bigint): Promise<{
  ok: boolean;
  impactBps: number;
}> {
  const probe = 1_000_000n; // 1 USDT reference trade
  const [small, actual] = await Promise.all([
    quoteUsdtToCngn(probe),
    quoteUsdtToCngn(amountIn),
  ]);
  const impactBps = Number(
    ((small.rateE6 - actual.rateE6) * 10_000n) / small.rateE6,
  );
  return { ok: impactBps <= LIMITS.maxAcceptableImpactBps, impactBps };
}

export type Runnability = {
  due: boolean;
  funded: boolean;
  approved: boolean;
  floor: bigint;
  nextRunAt: bigint;
};

export async function runnability(onchainId: bigint): Promise<Runnability> {
  const r = await publicClient.readContract({
    address: CELO.executor,
    abi: executorAbi,
    functionName: "runnability",
    args: [onchainId],
  }) as readonly [boolean, boolean, boolean, bigint, bigint];
  return { due: r[0], funded: r[1], approved: r[2], floor: r[3], nextRunAt: r[4] };
}

export type OnchainSchedule = {
  sender: Address;
  interval: bigint;
  maxRuns: number;
  destination: Address;
  nextRunAt: bigint;
  runsExecuted: number;
  amountIn: bigint;
  minRateE6: bigint;
  expiresAt: bigint;
  payoutType: number;
  active: boolean;
  cancelled: boolean;
};

/// The sender-signed policy, read from the contract rather than our mirror of
/// it. Used where being wrong costs money — chiefly checking that a cNGN
/// redemption address matches the destination the sender actually authorised.
export async function getSchedule(onchainId: bigint): Promise<OnchainSchedule> {
  return await publicClient.readContract({
    address: CELO.executor,
    abi: executorAbi,
    functionName: "getSchedule",
    args: [onchainId],
  }) as OnchainSchedule;
}

export async function executeRun(onchainId: bigint, minOut: bigint) {
  const wc = walletClient();
  const { request } = await publicClient.simulateContract({
    address: CELO.executor,
    abi: executorAbi,
    functionName: "executeRun",
    args: [onchainId, minOut],
    account: wc.account,
  });
  const hash = await wc.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });
  return { hash, receipt };
}
