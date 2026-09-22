import type { RunStatus, ScheduleStatus } from "@/lib/types";

type Tone = "neutral" | "working" | "good" | "warn" | "bad";

const TONES: Record<Tone, { pill: string; dot: string }> = {
  neutral: { pill: "bg-sand text-ink-2", dot: "bg-ink-3" },
  working: { pill: "bg-amber-soft text-ink", dot: "bg-amber animate-pulse2" },
  good: { pill: "bg-naira-soft text-naira", dot: "bg-naira" },
  warn: { pill: "bg-amber-soft text-ink", dot: "bg-amber" },
  bad: { pill: "bg-danger-soft text-danger", dot: "bg-danger" },
};

const RUN_STYLES: Record<RunStatus, { label: string; tone: Tone }> = {
  pending: { label: "Starting", tone: "working" },
  swapping: { label: "Converting", tone: "working" },
  // A wallet payout is genuinely finished here. A bank payout is not, and never
  // shows this label — see RunPill below.
  delivered: { label: "Delivered", tone: "good" },
  redeeming: { label: "Paying out", tone: "working" },
  paid_out: { label: "Paid out", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
  skipped: { label: "Skipped", tone: "neutral" },
};

const SCHEDULE_STYLES: Record<ScheduleStatus, { label: string; tone: Tone }> = {
  pending_authorization: { label: "Not authorised", tone: "warn" },
  active: { label: "Active", tone: "good" },
  paused: { label: "Paused", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  completed: { label: "Completed", tone: "neutral" },
};

export function RunPill(
  { status, isBank, converts = true }: { status: RunStatus; isBank: boolean; converts?: boolean },
) {
  // The distinction the whole schema exists to protect: for a bank payout,
  // `delivered` means cNGN reached the redemption address, not that anyone has
  // naira. Never let that render as a completed state.
  const s = isBank && status === "delivered"
    ? { label: "Awaiting bank", tone: "working" as Tone }
    // `swapping` is one status for both rails, and a Direct run converts
    // nothing — the recipient gets the asset the sender funded. Telling them
    // their money is being converted describes a trade that never happens.
    : !converts && status === "swapping"
    ? { label: "Sending", tone: "working" as Tone }
    : RUN_STYLES[status];
  return <Pill label={s.label} tone={s.tone} />;
}

export function SchedulePill({ status }: { status: ScheduleStatus }) {
  const s = SCHEDULE_STYLES[status];
  return <Pill label={s.label} tone={s.tone} />;
}

export function Pill({ label, tone }: { label: string; tone: Tone }) {
  const t = TONES[tone];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full py-1 pl-2 pr-2.5 text-xs font-medium ${t.pill}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} aria-hidden />
      {label}
    </span>
  );
}
