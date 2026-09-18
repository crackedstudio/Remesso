/// DeepSeek, kept strictly off the money path.
///
/// Nothing here decides whether a payment happens. The executor loop is
/// deterministic — pg_cron reads `due_schedules`, the contract's `runnability()`
/// is the authority, and `executeRun` enforces the sender's signed envelope.
/// This module only turns intent into a *draft* the sender reviews and signs,
/// and turns machine failure reasons into sentences. A wrong answer here costs
/// a confusing message, never a payment.
///
/// DeepSeek speaks the OpenAI chat-completions dialect, so this is a thin
/// fetch rather than a dependency.

const BASE = Deno.env.get("DEEPSEEK_API_BASE") ?? "https://api.deepseek.com";
const MODEL = Deno.env.get("DEEPSEEK_MODEL") ?? "deepseek-chat";

/// Hard ceiling on a single call. The frontend is waiting on this, and a model
/// that has not answered in 20s is not about to produce a better draft.
const TIMEOUT_MS = 20_000;

export class LlmError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = "LlmError";
  }
}

function apiKey(): string {
  const k = Deno.env.get("DEEPSEEK_API_KEY");
  if (!k) throw new LlmError("DEEPSEEK_API_KEY is not set", 503);
  return k;
}

/// One completion, forced to emit a JSON object.
///
/// `temperature` defaults to 0: these are extraction tasks with a right answer,
/// not creative ones, and a sender re-reading the same sentence should get the
/// same draft twice.
export async function complete(
  system: string,
  user: string,
  { temperature = 0, maxTokens = 700 } = {},
): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      signal: ctl.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey()}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new LlmError(`DeepSeek ${res.status}: ${body.slice(0, 200)}`, 502);
    }

    const payload = await res.json();
    const text = payload?.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new LlmError("DeepSeek returned no message content");

    try {
      return JSON.parse(text);
    } catch {
      // `response_format: json_object` makes this rare, not impossible.
      throw new LlmError("DeepSeek did not return parseable JSON");
    }
  } catch (e) {
    if (e instanceof LlmError) throw e;
    if ((e as Error).name === "AbortError") {
      throw new LlmError(`DeepSeek did not respond within ${TIMEOUT_MS / 1000}s`, 504);
    }
    throw new LlmError((e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

export function isConfigured(): boolean {
  return Boolean(Deno.env.get("DEEPSEEK_API_KEY"));
}
