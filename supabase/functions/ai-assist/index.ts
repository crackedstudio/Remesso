/// The assistant layer. It drafts and explains; it never pays.
///
/// Two operations, both advisory:
///   parse_schedule — a sentence becomes a DRAFT the sender edits and signs.
///   explain_run    — a machine failure reason becomes something readable.
///
/// The model's output is validated here, not trusted. Every field is clamped to
/// a value the rest of the system already accepts, and anything unrecognised is
/// dropped and reported as missing rather than guessed. The draft still has to
/// pass the form, the database constraints and the contract — this only saves
/// typing, so the worst a bad completion can do is produce a draft the sender
/// rejects.
import { complete, isConfigured, LlmError } from "../_shared/llm.ts";

const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("WEB_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/// Mirrors the frontend's Direct rail. Symbols only — the frontend owns the
/// address map, and duplicating addresses here is how the two drift apart.
const TOKENS = ["USDT", "USDC", "cUSD"] as const;
type Token = typeof TOKENS[number];

/// Must stay a subset of what the picker offers, or the draft cannot be applied.
const INTERVALS: Record<string, number> = {
  "5m": 300,
  weekly: 604_800,
  fortnightly: 1_209_600,
  monthly: 2_592_000,
  quarterly: 7_776_000,
};

const PARSE_SYSTEM = `You convert a remittance request into JSON. Reply with a JSON object only.

Fields:
  amount        string decimal, per transfer, e.g. "50". null if unstated.
  token         one of USDT, USDC, cUSD. null if unstated.
  interval      one of 5m, weekly, fortnightly, monthly, quarterly. null if unstated.
  maxRuns       integer number of transfers, or null for "until I stop".
  destination   a 0x... Ethereum address if one appears verbatim, else null.
  recipientName a short name for the recipient if one appears, else null.
  note          one short sentence, plain language, describing what you understood.

Rules:
- Never invent an address. If no 0x address appears in the text, destination is null.
- Never guess an amount or a token that was not stated. Use null.
- "every month"=monthly, "every week"=weekly, "every two weeks"=fortnightly,
  "every quarter"=quarterly, "every 5 minutes"=5m.
- Do not add fields.`;

const EXPLAIN_SYSTEM = `You explain to a non-technical person what happened to a
scheduled payment. Reply with a JSON object:
  { "title": "under 8 words", "detail": "one or two plain sentences", "action": "under 7 words, or null" }

The reason you are given may describe a NORMAL, EXPECTED outcome — for example a
schedule that has finished all the transfers it was set up for. Do not describe
those as failures, do not imply anything went wrong, and set action to null.
Only frame something as a problem when the reason actually describes one.

Never speculate about causes the reason does not state. Do not mention
contracts, gas, RPCs or function names. Never promise the payment will retry
unless the reason says so.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!isConfigured()) return json({ error: "assistant is not configured" }, 503);

  let body: { op?: string; text?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  try {
    if (body.op === "parse_schedule") {
      const text = (body.text ?? "").trim();
      if (!text) return json({ error: "text is required" }, 400);
      if (text.length > 500) return json({ error: "text is too long" }, 400);
      return json(await parseSchedule(text));
    }

    if (body.op === "explain_run") {
      const reason = (body.reason ?? "").trim();
      if (!reason) return json({ error: "reason is required" }, 400);
      const out = await complete(EXPLAIN_SYSTEM, reason.slice(0, 500)) as Record<string, unknown>;
      return json({
        title: clip(str(out.title), 80) ?? "About this transfer",
        detail: clip(str(out.detail), 400) ?? reason,
        action: clip(str(out.action), 60),
      });
    }

    return json({ error: "unknown op" }, 400);
  } catch (e) {
    const status = e instanceof LlmError ? e.status : 500;
    return json({ error: (e as Error).message }, status);
  }
});

async function parseSchedule(text: string) {
  const out = await complete(PARSE_SYSTEM, text) as Record<string, unknown>;

  // Clamp every field to something the form already accepts. Anything the model
  // returned that is not recognised becomes `missing`, which the UI asks for —
  // far better than a plausible-looking guess the sender might not check.
  const token = TOKENS.find((t) => t.toLowerCase() === str(out.token)?.toLowerCase()) ?? null;
  const intervalKey = str(out.interval)?.toLowerCase() ?? "";
  const intervalSeconds = INTERVALS[intervalKey] ?? null;

  const amountRaw = str(out.amount) ?? (typeof out.amount === "number" ? String(out.amount) : null);
  const amount = amountRaw && /^\d+(\.\d{1,18})?$/.test(amountRaw) && Number(amountRaw) > 0
    ? amountRaw
    : null;

  // An address is either exactly right or absent. A model-repaired address is
  // an irreversible payment to a stranger.
  const destRaw = str(out.destination);
  const destination = destRaw && /^0x[a-fA-F0-9]{40}$/.test(destRaw) ? destRaw : null;

  const maxRunsNum = Number(out.maxRuns);
  const maxRuns = Number.isInteger(maxRunsNum) && maxRunsNum > 0 && maxRunsNum <= 1000
    ? maxRunsNum
    : null;

  const missing: string[] = [];
  if (!amount) missing.push("amount");
  if (!token) missing.push("token");
  if (!intervalSeconds) missing.push("frequency");
  if (!destination) missing.push("recipient address");

  return {
    draft: {
      amount,
      token,
      intervalSeconds,
      maxRuns,
      destination,
      recipientName: str(out.recipientName)?.slice(0, 60) ?? null,
      payoutType: "direct" as const,
    },
    note: str(out.note)?.slice(0, 200) ?? null,
    missing,
  };
}

/// Trim to a length without cutting a word in half. A label that reads
/// "send manu" is worse than one that reads slightly shorter.
function clip(v: string | null, max: number): string | null {
  if (!v) return null;
  if (v.length <= max) return v;
  const cut = v.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd() + "…";
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
