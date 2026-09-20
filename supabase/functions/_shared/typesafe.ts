/// TypeSafe (Jev) — typed judgments, not generated text.
///
/// Why this exists beside `llm.ts`: DeepSeek writes sentences, and a sentence
/// written by a model about someone's money is a liability. Jev answers a fixed
/// question with a label and a probability distribution, so Remesso keeps the
/// wording and the model only picks between answers we defined.
///
/// Rules for every caller here, without exception:
///   - Nothing on the money path reads these answers. The contract decides what
///     pays; this layer only chooses which sentence a sender reads, or whether
///     to ask them a question.
///   - A failure is silence, never a guess. Every call is wrapped so an outage,
///     a missing key or a slow response leaves the caller with `null`.
///
/// API: POST https://api.typesafe.ai/v1/systemone, bearer key, one request
/// carrying `state` plus a map of independent questions evaluated in parallel.
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";

/// A judgment is worth a moment, never a page load. Past this the caller shows
/// what it would have shown without an answer.
const TIMEOUT_MS = 4000;

export type Choice = { type: "choice"; instructions: string; criteria: Record<string, unknown> };
export type Score = { type: "score"; instructions: string; criteria: unknown[] };
export type Noul = { type: "noul"; instructions: string; criteria?: Record<string, string> };
export type Question = Choice | Score | Noul;

export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
export type ScoreAnswer = {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
};
export type NoulAnswer = { type: "noul"; noul: number };
export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export const isConfigured = (): boolean => Boolean(Deno.env.get("TYPESAFE_API_KEY"));

/// Ask a set of independent questions about one state.
///
/// Returns `null` rather than throwing: no answer is a supported outcome
/// everywhere this is used, and a caller that has to try/catch around an
/// optional opinion eventually forgets to.
export async function ask(
  state: unknown,
  questions: Record<string, Question>,
): Promise<Record<string, Answer> | null> {
  const key = Deno.env.get("TYPESAFE_API_KEY");
  if (!key) return null;

  const abort = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, state, questions }),
      signal: abort,
    });
    if (!res.ok) {
      // 401 and 422 are ours to fix and should be loud in the logs; 429 and 529
      // are theirs and pass as a shrug. Neither reaches the sender.
      console.error("typesafe", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const body = await res.json() as { answers?: Record<string, Answer> };
    return body.answers ?? null;
  } catch (e) {
    console.error("typesafe unavailable:", (e as Error).message);
    return null;
  }
}

/// A choice answer only when the model is concentrated enough to act on, and
/// never for the opt-out option every question carries.
///
/// The threshold is the caller's decision because the consequence is: picking
/// the wrong sentence for a failure is a nuisance, pre-filling the wrong
/// payment frequency is not. TypeSafe's own guidance is >0.9 act, 0.5-0.9
/// confirm, <0.5 do not act.
export function decided(
  a: Answer | undefined,
  minConfidence: number,
  noMatch = "other",
): { choice: string; confidence: number } | null {
  if (!a || a.type !== "choice") return null;
  if (a.choice === noMatch || a.confidence < minConfidence) return null;
  return { choice: a.choice, confidence: a.confidence };
}
