/// The slice of RemessoExecutor the sender's browser needs.
///
/// Only sender-facing entry points are here. `executeRun` is deliberately
/// absent: it is `onlyExecutor`, and putting it in the frontend ABI would
/// suggest the browser has any business calling it.
export const executorAbi = [
  {
    type: "function",
    name: "createSchedule",
    stateMutability: "nonpayable",
    inputs: [
      { name: "destination", type: "address" },
      { name: "amountIn", type: "uint128" },
      { name: "interval", type: "uint64" },
      { name: "minRateE6", type: "uint96" },
      { name: "maxRuns", type: "uint32" },
      { name: "expiresAt", type: "uint64" },
      { name: "firstRunAt", type: "uint64" },
      { name: "payoutType", type: "uint8" },
      { name: "token", type: "address" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "function",
    name: "setScheduleActive",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "active", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "cancelSchedule",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "schedulesOf",
    stateMutability: "view",
    inputs: [{ name: "sender", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "getSchedule",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "sender", type: "address" },
          { name: "interval", type: "uint64" },
          { name: "maxRuns", type: "uint32" },
          { name: "destination", type: "address" },
          { name: "nextRunAt", type: "uint64" },
          { name: "runsExecuted", type: "uint32" },
          { name: "amountIn", type: "uint128" },
          { name: "minRateE6", type: "uint96" },
          { name: "expiresAt", type: "uint64" },
          { name: "payoutType", type: "uint8" },
          { name: "active", type: "bool" },
          { name: "cancelled", type: "bool" },
          { name: "token", type: "address" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "runnability",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      { name: "due", type: "bool" },
      { name: "funded", type: "bool" },
      { name: "approved", type: "bool" },
      { name: "floor", type: "uint256" },
      { name: "nextRunAt", type: "uint64" },
    ],
  },
  {
    type: "event",
    name: "ScheduleCreated",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "destination", type: "address", indexed: true },
      { name: "amountIn", type: "uint128" },
      { name: "interval", type: "uint64" },
      { name: "minRateE6", type: "uint96" },
      { name: "maxRuns", type: "uint32" },
      { name: "expiresAt", type: "uint64" },
      { name: "payoutType", type: "uint8" },
    ],
  },
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/// Matches the PayoutType enum in RemessoExecutorV3.sol.
/// Direct forwards the funding asset with no swap.
export const PayoutType = { Wallet: 0, BankRedemption: 1, Direct: 2 } as const;

/// QuoterV2. `quoteExactInputSingle` is non-view (it reverts to return data),
/// so it must be simulated rather than read.
export const quoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;
