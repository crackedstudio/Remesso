import type { RunStatus, ScheduleStatus } from "@/lib/types";

const RUN_STYLES: Record<RunStatus, { label: string; className: string }> = {
  pending: { label: "Starting", className: "bg-black/5 text-black/60" },
  swapping: { label: "Swapping", className: "bg-amber-100 text-amber-800" },
  // A wallet payout is genuinely finished here. A bank payout is not, and never
  // shows this label — see runLabel below.
  delivered: { label: "Delivered", className: "bg-emerald-100 text-emerald-800" },
  redeeming: { label: "Paying out", className: "bg-sky-100 text-sky-800" },
  paid_out: { label: "Paid out", className: "bg-emerald-100 text-emerald-800" },
  failed: { label: "Failed", className: "bg-red-100 text-red-800" },
  skipped: { label: "Skipped", className: "bg-black/5 text-black/50" },
};

const SCHEDULE_STYLES: Record<ScheduleStatus, { label: string; className: string }> = {
  pending_authorization: { label: "Not authorised", className: "bg-amber-100 text-amber-800" },
  active: { label: "Active", className: "bg-emerald-100 text-emerald-800" },
  paused: { label: "Paused", className: "bg-black/5 text-black/60" },
  cancelled: { label: "Cancelled", className: "bg-black/5 text-black/50" },
  completed: { label: "Completed", className: "bg-black/5 text-black/60" },
};

export function RunPill({ status, isBank }: { status: RunStatus; isBank: boolean }) {
  const s = RUN_STYLES[status];
  // The distinction the whole schema exists to protect: for a bank payout,
  // `delivered` means cNGN reached the redemption address, not that anyone has
  // naira. Never let that render as a completed state.
  const label = isBank && status === "delivered" ? "Swapped, awaiting payout" : s.label;
  const className = isBank && status === "delivered" ? "bg-sky-100 text-sky-800" : s.className;
  return <Pill label={label} className={className} />;
}

export function SchedulePill({ status }: { status: ScheduleStatus }) {
  const s = SCHEDULE_STYLES[status];
  return <Pill label={s.label} className={s.className} />;
}

function Pill({ label, className }: { label: string; className: string }) {
  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${className}`}>
      {label}
    </span>
  );
}
