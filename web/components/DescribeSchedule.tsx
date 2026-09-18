"use client";

import { useState } from "react";
import { parseSchedule, type Draft } from "@/lib/ai";
import { DIRECT_TOKENS } from "@/lib/config";

/// Type the remittance in a sentence; the assistant fills the form in.
///
/// It fills the form and stops there. Nothing is submitted, nothing is signed,
/// and every field it sets is one the sender can see and change on the next two
/// screens. Anything it could not read with certainty — an address that was not
/// a complete 0x..., an asset we do not support — is left blank and named in
/// `missing`, because a plausible guess in a payment form is worse than a gap.
export function DescribeSchedule({
  onDraft,
}: {
  onDraft: (d: Draft) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[]>([]);

  async function run() {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    setMissing([]);
    try {
      const r = await parseSchedule(t);
      onDraft(r.draft);
      setNote(r.note);
      setMissing(r.missing);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-5 rounded-xl border border-black/10 bg-black/[0.02] p-3">
      <label className="label">Describe it instead</label>
      <p className="hint mb-2">
        e.g. “Send 20 USDT to 0xa09d… every week for 8 weeks”
      </p>
      <textarea
        className="field min-h-[72px] resize-none"
        value={text}
        placeholder="Say what you want to send, to whom, and how often."
        onChange={(e) => setText(e.target.value)}
      />
      <button
        type="button"
        className="btn-primary mt-2 w-full"
        disabled={busy || !text.trim()}
        onClick={run}
      >
        {busy ? "Reading…" : "Fill in the form"}
      </button>

      {note && <p className="mt-2 text-xs text-black/60">{note}</p>}

      {missing.length > 0 && (
        <p className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-900">
          Still needed: {missing.join(", ")}. Add {missing.length > 1 ? "them" : "it"} below.
        </p>
      )}

      {error && (
        <p className="mt-2 rounded bg-red-50 p-2 text-xs text-red-800">{error}</p>
      )}

      <p className="mt-2 text-[11px] text-black/40">
        Fills the form only. You review every detail and sign it yourself.
      </p>
    </div>
  );
}

/// Map a draft's token symbol onto the real TokenInfo. The assistant returns a
/// symbol rather than an address on purpose: an address is the one field where
/// a confident-sounding mistake is irreversible, so the browser resolves it
/// from a list it already trusts.
export function tokenFromSymbol(symbol: Draft["token"]) {
  return DIRECT_TOKENS.find((t) => t.symbol === symbol) ?? null;
}
