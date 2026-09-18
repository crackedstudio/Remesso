"use client";

import { useAccount, useConnect, useDisconnect, useChainId, useSwitchChain } from "wagmi";
import { activeChain } from "@/lib/wagmi";
import { useIsMiniPay } from "@/lib/hooks";
import { shortAddress } from "@/lib/format";

export function ConnectBar() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const inMiniPay = useIsMiniPay();

  if (!isConnected) {
    // MiniPay injects one account and connects itself on load (see
    // MiniPayAutoConnect). A button there offers a choice that does not exist,
    // and pressing it races the auto-connect already in flight.
    if (inMiniPay) {
      return <span className="text-xs text-black/40">Connecting…</span>;
    }
    const injected = connectors.find((c) => c.id === "injected");
    return (
      <button
        className="btn-primary"
        disabled={!injected || isPending}
        onClick={() => injected && connect({ connector: injected })}
      >
        {isPending ? "Connecting…" : injected ? "Connect wallet" : "No wallet found"}
      </button>
    );
  }

  if (chainId !== activeChain.id) {
    // MiniPay is Celo-only and cannot switch, so offering the button there is a
    // dead end. It should never happen; say something true if it does.
    if (inMiniPay) {
      return (
        <span className="text-xs text-amber-700">
          Wrong network — expected {activeChain.name}
        </span>
      );
    }
    return (
      <button className="btn-primary" onClick={() => switchChain({ chainId: activeChain.id })}>
        Switch to {activeChain.name}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="mono rounded-lg bg-black/5 px-2.5 py-1.5">{shortAddress(address)}</span>
      {/* MiniPay owns the session; disconnecting inside it just strands the app. */}
      {!inMiniPay && (
        <button
          className="text-xs text-black/40 underline underline-offset-2 hover:text-black/70"
          onClick={() => disconnect()}
        >
          Disconnect
        </button>
      )}
    </div>
  );
}
