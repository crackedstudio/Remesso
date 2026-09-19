"use client";

import { useState } from "react";
import { parseSchedule, type Draft } from "@/lib/ai";
import { DIRECT_TOKENS } from "@/lib/config";
import { TEST_INTERVALS_ENABLED } from "@/lib/format";

/// Type the remittance in a sentence; the assistant fills the form in.
///
/// It fills the form and stops there. Nothing is submitted, nothing is signed,
/// and every field it sets is one the sender can see and change on the next two
/// screens. Anything it could not read with certainty — an address that was not
/// a complete 0x..., an asset we do not support — is left blank and named in
/// `missing`, because a plausible guess in a payment form is worse than a gap.

/// Phrasings the parser reliably understands, offered as taps.
///
/// A sender should not have to discover that "every week" parses and "weekly-ish"
/// does not. These are appended to whatever they already wrote, so the sentence
/// stays theirs and only the part the parser could not read gets filled in.
const FREQUENCY_WORDS = [
  ...(TEST_INTERVALS_ENABLED ? [{ label: "Every 5 minutes", words: "every 5 minutes" }] : []),
  { label: "Every week", words: "every week" },
  { label: "Every month", words: "every month" },
];

const COUNT_WORDS = [
  { label: "Just once", words: "one transfer only" },
  { label: "6 times", words: "for 6 transfers" },
  { label: "Until I stop", words: "until I stop it" },
];

/// Shown before anything is typed, to teach the shape of a sentence that works.
const STARTERS = [
  "Send 5 USDT to 0x… every week for 8 transfers",
  "Send 20 USDC to 0x… every month",
];

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
  const [openEnded, setOpenEnded] = useState(false);

  /// Append a phrase the parser understands and read the sentence again, so the
  /// sender never has to learn the wording.
  function addWords(words: string) {
    const next = `${text.trim()} ${words}`.trim();
    setText(next);
    run(next);
  }

  async function run(override?: string) {
    const t = (override ?? text).trim();
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    setMissing([]);
    setOpenEnded(false);
    try {
      const r = await parseSchedule(t);
      onDraft(r.draft);
      setNote(r.note);
      setMissing(r.missing);
      // Not "missing" — running until stopped is a real choice. But a sender who
      // simply did not say should be shown that the choice exists, rather than
      // discovering later that it renews indefinitely.
      setOpenEnded(r.missing.length === 0 && r.draft.maxRuns === null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-7 rounded-2xl bg-sand/70 p-4">
      <label className="label" htmlFor="describe">
        Or just say it
      </label>
      <textarea
        id="describe"
        className="field min-h-[76px] resize-none"
        value={text}
        placeholder="Send 20 USDT to 0x… every month for 6 months"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            run();
          }
        }}
      />
      {!text.trim() ? (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {STARTERS.map((example) => (
            <button
              key={example}
              type="button"
              className="chip h-auto py-1.5 text-left leading-snug"
              onClick={() => setText(example)}
            >
              {example}
            </button>
          ))}
        </div>
      ) : (
        <button
          type="button"
          className="btn-ink mt-2.5 w-full"
          disabled={busy}
          onClick={() => run()}
        >
          {busy ? "Reading…" : "Fill in the form"}
        </button>
      )}

      {note && <p className="mt-3 text-[13px] leading-relaxed text-ink-2">{note}</p>}

      {openEnded && (
        <div className="notice-info mt-3 animate-rise">
          <p>This will keep going until you stop it.</p>
          <Chips label="Limit it?" options={COUNT_WORDS} onPick={addWords} disabled={busy} />
        </div>
      )}

      {missing.length > 0 && (
        <div className="notice-warn mt-3 animate-rise">
          <p>Still needed: {missing.join(", ")}.</p>

          {/* Only frequency and count can be added by tapping. An amount and an
              address are specific to this payment — there is nothing sensible to
              offer, and a tappable address is a way to send money to the wrong
              person by accident. */}
          {missing.includes("frequency") && (
            <Chips
              label="How often?"
              options={FREQUENCY_WORDS}
              onPick={addWords}
              disabled={busy}
            />
          )}

          {(missing.includes("amount") || missing.includes("recipient address")) && (
            <p className="mt-2 text-ink-2">
              Add the {[
                missing.includes("amount") ? "amount" : null,
                missing.includes("recipient address") ? "address" : null,
              ].filter(Boolean).join(" and ")} to the sentence, or type it into the form below.
            </p>
          )}
        </div>
      )}

      {error && <p className="notice-danger mt-3">{error}</p>}

      <p className="mt-3 text-[12px] text-ink-3">
        This only fills in the form. You check every detail and sign it yourself.
      </p>
    </div>
  );
}

function Chips({
  label,
  options,
  onPick,
  disabled,
}: {
  label: string;
  options: ReadonlyArray<{ label: string; words: string }>;
  onPick: (words: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="mt-2">
      <span className="text-ink-2">{label}</span>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o.words}
            type="button"
            disabled={disabled}
            className="chip bg-surface"
            onClick={() => onPick(o.words)}
          >
            {o.label}
          </button>
        ))}
      </div>
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
