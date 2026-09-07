export type PayoutKind = "wallet" | "ngn_bank";

export type Recipient = {
  id: string;
  sender_id: string;
  display_name: string;
  payout_type: PayoutKind;
  wallet_address: string | null;
  bank_code: string | null;
  account_number: string | null;
  account_name: string | null;
  bank_verified_at: string | null;
  created_at: string;
};

export type ScheduleStatus =
  | "pending_authorization"
  | "active"
  | "paused"
  | "cancelled"
  | "completed";

export type Schedule = {
  id: string;
  sender_id: string;
  recipient_id: string;
  onchain_id: string | null;
  chain_id: number;
  authorized_tx_hash: string | null;
  amount_in: string;
  interval_seconds: number;
  min_rate_e6: string;
  max_runs: number;
  expires_at: string | null;
  next_run_at: string | null;
  status: ScheduleStatus;
  label: string | null;
  created_at: string;
  recipients?: Recipient | Recipient[] | null;
};

export type RunStatus =
  | "pending"
  | "swapping"
  | "delivered"
  | "redeeming"
  | "paid_out"
  | "failed"
  | "skipped";

export type Run = {
  id: string;
  schedule_id: string;
  attempt: number;
  status: RunStatus;
  amount_in: string;
  amount_out: string | null;
  quoted_rate_e6: string | null;
  min_out: string | null;
  tx_hash: string | null;
  block_number: number | null;
  cngn_trx_ref: string | null;
  cngn_deposit_address: string | null;
  redeemed_at: string | null;
  failure_reason: string | null;
  started_at: string;
  settled_at: string | null;
  reconcile_attempts?: number;
};

/// supabase-js types an embedded relation as an array regardless of the
/// relationship's actual cardinality.
export function one<T>(rel: T | T[] | null | undefined): T | null {
  if (!rel) return null;
  return Array.isArray(rel) ? rel[0] ?? null : rel;
}
