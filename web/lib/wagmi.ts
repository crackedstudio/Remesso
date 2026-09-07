// `injected` is imported from wagmi's own re-export rather than from
// `wagmi/connectors`. That barrel pulls in the Coinbase base-account SDK, whose
// optional x402 dependencies do not resolve at build time — and we need exactly
// one connector, so there is nothing to gain from loading all of them.
import { createConfig, http, injected } from "wagmi";
import { celo, celoSepolia } from "wagmi/chains";
import { CHAIN_ID, RPC_URL } from "./config";

/// Injected only, and that is a deliberate choice rather than a shortcut.
///
/// MiniPay is the wallet this audience actually uses, and it injects an EIP-1193
/// provider directly. It does not support WalletConnect, and it does not support
/// message signing at all — which is also why authentication here is not SIWE.
/// Desktop browser wallets inject too, so one connector covers both.
/// Both chains are registered so a wallet already pointed at the other one can
/// be switched rather than just rejected. `activeChain` is the only one this
/// deployment will transact on.
export const activeChain = CHAIN_ID === celo.id ? celo : celoSepolia;

export const wagmiConfig = createConfig({
  chains: [celo, celoSepolia],
  connectors: [injected({ shimDisconnect: true })],
  transports: {
    [celo.id]: http(CHAIN_ID === celo.id ? RPC_URL : undefined),
    [celoSepolia.id]: http(CHAIN_ID === celoSepolia.id ? RPC_URL : undefined),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}

/// MiniPay sets this flag on the injected provider. Inside MiniPay there is
/// exactly one account and no wallet picker, so the UI connects on load and
/// never renders a connect button.
export function isMiniPay(): boolean {
  if (typeof window === "undefined") return false;
  const eth = (window as unknown as { ethereum?: { isMiniPay?: boolean } }).ethereum;
  return Boolean(eth?.isMiniPay);
}
