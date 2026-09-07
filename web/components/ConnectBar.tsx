"use client";

import { useAccount, useConnect, useDisconnect, useChainId, useSwitchChain } from "wagmi";
import { activeChain, isMiniPay } from "@/lib/wagmi";
import { shortAddress } from "@/lib/format";

export function ConnectBar() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();

  if (!isConnected) {
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
      {!isMiniPay() && (
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
