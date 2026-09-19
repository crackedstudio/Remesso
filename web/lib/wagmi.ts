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

/// Whether this is MiniPay, waiting for the provider if it is not there yet.
///
/// Reading `isMiniPay()` once at mount is not enough. When the provider is
/// injected after our first render, that read says "not MiniPay", the page
/// renders a Connect button MiniPay's listing rules forbid, and auto-connect
/// never runs. Seen on device 2026-09-19.
///
/// A provider that is already present answers immediately either way — a
/// desktop wallet is not made to wait. Only a missing one is waited for, via
/// the `ethereum#initialized` event wallets fire on late injection, with a
/// poll as a backstop.
let detected: Promise<boolean> | null = null;
export function detectMiniPay(timeoutMs = 3000): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (detected) return detected;
  detected = new Promise<boolean>((resolve) => {
    const eth = () => (window as unknown as { ethereum?: { isMiniPay?: boolean } }).ethereum;
    if (eth()) return resolve(Boolean(eth()!.isMiniPay));

    const done = (v: boolean) => {
      clearInterval(poll);
      clearTimeout(timer);
      window.removeEventListener("ethereum#initialized", onInit);
      resolve(v);
    };
    const onInit = () => done(Boolean(eth()?.isMiniPay));
    const poll = setInterval(() => eth() && done(Boolean(eth()!.isMiniPay)), 100);
    const timer = setTimeout(() => done(Boolean(eth()?.isMiniPay)), timeoutMs);
    window.addEventListener("ethereum#initialized", onInit, { once: true });
  });
  return detected;
}
