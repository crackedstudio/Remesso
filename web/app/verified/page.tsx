"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

/// Where Self sends the sender after the app finishes.
///
/// The Self handoff leaves MiniPay for the phone's own browser (see OpenSelf in
/// IdentityCard), so this page opens there, where no wallet is connected. The
/// home page would greet them with "Connect wallet" and read as a dead end.
/// All it needs to say is: done, go back. The result itself reaches MiniPay
/// through the server, not through this page.
export default function VerifiedPage() {
  return (
    <Suspense>
      <Outcome />
    </Suspense>
  );
}

function Outcome() {
  const ok = useSearchParams().get("ok") !== "0";
  return (
    <div className="stagger mt-10">
      <h1 className="font-display text-[34px] leading-[1.05] text-ink">
        {ok ? "You’re verified." : "That didn’t go through."}
      </h1>
      <p className="mt-4 max-w-sm text-[16px] leading-relaxed text-ink-2">
        {ok
          ? "Self has confirmed your passport. Go back to MiniPay — Remesso will show it within a few seconds."
          : "Self couldn’t complete the check. Go back to MiniPay and try again from Remesso. Nothing about your schedules has changed."}
      </p>
      <p className="mt-6 text-[14px] text-ink-3">You can close this tab.</p>
    </div>
  );
}
