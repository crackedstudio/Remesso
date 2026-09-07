/// Browser-visible configuration. Everything here is public by construction:
/// contract addresses, an RPC URL and the Supabase anon key. No cNGN
/// credential of any kind may appear in this file — those live only in the
/// cngn-proxy Edge Function.

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 42220);

export const RPC_URL =
  process.env.NEXT_PUBLIC_CELO_RPC_URL ?? "https://forno.celo.org";

export const EXECUTOR_ADDRESS =
  (process.env.NEXT_PUBLIC_REMESSO_EXECUTOR_ADDRESS ?? "") as `0x${string}`;

/// Both tokens are 6dp. cNGN is *not* Mento's NGNm, which is 18dp — confusing
/// them is a factor of 10^12, so the decimals are pinned next to the address.
export const USDT = {
  address: (process.env.NEXT_PUBLIC_USDT_ADDRESS ??
    "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e") as `0x${string}`,
  decimals: 6,
  symbol: "USDT",
} as const;

export const CNGN = {
  address: (process.env.NEXT_PUBLIC_CNGN_ADDRESS ??
    "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f") as `0x${string}`,
  decimals: 6,
  symbol: "cNGN",
} as const;

/// Uniswap V3 is the only cNGN venue on Celo. The frontend touches it purely to
/// quote a live rate, so the sender's floor is set against the real market
/// rather than a number they guessed.
export const QUOTER = (process.env.NEXT_PUBLIC_UNISWAP_V3_QUOTER ??
  "0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8") as `0x${string}`;

export const POOL_FEE = Number(process.env.NEXT_PUBLIC_POOL_FEE_TIER ?? 100);

/// Where bank payouts are delivered on-chain. Empty means the question in the
/// README is still open, and the UI offers wallet payouts only rather than
/// letting a sender authorise a destination we are not sure of.
export const CNGN_REDEMPTION_ADDRESS = (
  process.env.NEXT_PUBLIC_CNGN_REDEMPTION_ADDRESS ?? ""
).trim() as `0x${string}` | "";

export const BANK_PAYOUTS_ENABLED =
  /^0x[a-fA-F0-9]{40}$/.test(CNGN_REDEMPTION_ADDRESS);

export const EXPLORER =
  CHAIN_ID === 42220 ? "https://celoscan.io" : "https://celo-sepolia.blockscout.com";

export function isConfigured(): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(EXECUTOR_ADDRESS);
}
