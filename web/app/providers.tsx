"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { WagmiProvider, useAccount, useConnect } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi";
import { useMiniPayState } from "@/lib/hooks";
import { ensureSender } from "@/lib/supabase";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Chain and run state both move on their own; a stale read here
            // shows a sender a payout status that is no longer true.
            staleTime: 10_000,
            refetchOnWindowFocus: true,
            retry: 1,
          },
        },
      }),
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <MiniPayAutoConnect />
        <SenderBinding />
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}

/// Inside MiniPay there is one account and no wallet picker, so asking the user
/// to press "Connect" is a step that can only ever have one outcome.
///
/// Keyed on the detection result rather than a one-off read at mount, so a
/// provider MiniPay injects after our first render still gets connected.
function MiniPayAutoConnect() {
  const { connect, connectors } = useConnect();
  const { isConnected } = useAccount();
  const inMiniPay = useMiniPayState();

  useEffect(() => {
    if (isConnected || inMiniPay !== true) return;
    const injected = connectors.find((c) => c.id === "injected");
    if (injected) connect({ connector: injected });
  }, [isConnected, inMiniPay, connect, connectors]);

  return null;
}

/// Create or re-point the `senders` row whenever the connected wallet changes.
/// Runs once per address; failures surface on the pages that need a sender row
/// rather than as a modal over the whole app.
function SenderBinding() {
  const { address, isConnected } = useAccount();

  useEffect(() => {
    if (!isConnected || !address) return;
    ensureSender(address).catch((e) =>
      console.error("could not bind sender:", e.message),
    );
  }, [address, isConnected]);

  return null;
}
