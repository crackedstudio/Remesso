// deno test --unstable-sloppy-imports web/lib/history.test.ts
//
// Pins how the chain is allowed to run ahead of the database in a schedule's
// history. The rows here are shaped exactly as `execute-due-runs` leaves them
// at each stage, and the events as the Goldsky instant subgraph reports them.

import { assertEquals } from "jsr:@std/assert@1";
import { mergeHistory } from "./history";
import type { OnchainRun } from "./goldsky";
import type { Run, Schedule } from "./types";

const TX_A = "0x" + "a".repeat(64);
const TX_B = "0x" + "b".repeat(64);

function schedule(payout: "direct" | "wallet" | "ngn_bank"): Schedule {
  return {
    id: "sched-1",
    onchain_id: "7",
    token_address: "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e",
    status: "active",
    recipients: { payout_type: payout } as Schedule["recipients"],
  } as Schedule;
}

function row(over: Partial<Run>): Run {
  return {
    id: `row-${over.attempt ?? 1}`,
    schedule_id: "sched-1",
    attempt: 1,
    status: "pending",
    amount_in: "5000000",
    amount_out: null,
    quoted_rate_e6: null,
    min_out: null,
    tx_hash: null,
    block_number: null,
    cngn_trx_ref: null,
    cngn_deposit_address: null,
    redeemed_at: null,
    failure_reason: null,
    started_at: "2026-09-21T10:00:00.000Z",
    settled_at: null,
    ...over,
  };
}

function event(over: Partial<OnchainRun>): OnchainRun {
  return {
    txHash: TX_A,
    blockNumber: 78_000_000,
    timestamp: Date.parse("2026-09-21T10:00:05.000Z") / 1000,
    amountIn: "5000000",
    amountOut: "5000000",
    runsExecuted: 1,
    nextRunAt: 0,
    ...over,
  };
}

Deno.test("no events, or no subgraph: the database rows come back untouched", () => {
  const rows = [row({ attempt: 2, status: "failed" }), row({ attempt: 1 })];
  assertEquals(mergeHistory(schedule("direct"), rows, null), rows);
  assertEquals(mergeHistory(schedule("direct"), rows, []), rows);
});

Deno.test("an in-flight row is shown settled from the chain before the backend writes it", () => {
  const rows = [row({ attempt: 1, status: "swapping" })];
  const [r] = mergeHistory(schedule("direct"), rows, [event({})]);
  assertEquals(r.id, "row-1");
  assertEquals(r.status, "delivered");
  assertEquals(r.tx_hash, TX_A);
  assertEquals(r.block_number, 78_000_000);
  assertEquals(r.amount_out, "5000000");
  assertEquals(r.settled_at, "2026-09-21T10:00:05.000Z");
});

Deno.test("a bank run's swap landing is `redeeming`, never `delivered`", () => {
  const rows = [row({ attempt: 1, status: "swapping" })];
  const [r] = mergeHistory(schedule("ngn_bank"), rows, [event({ amountOut: "7800000000" })]);
  assertEquals(r.status, "redeeming");
  assertEquals(r.amount_out, "7800000000");
});

Deno.test("a row the backend already settled keeps what it knows", () => {
  const rows = [
    row({
      attempt: 1,
      status: "paid_out",
      tx_hash: TX_A.toUpperCase().replace("0X", "0x"),
      cngn_trx_ref: "RD-123",
      amount_out: "7800000000",
    }),
  ];
  const [r] = mergeHistory(schedule("ngn_bank"), rows, [event({ amountOut: "1" })]);
  assertEquals(r.status, "paid_out");
  assertEquals(r.cngn_trx_ref, "RD-123");
  assertEquals(r.amount_out, "7800000000");
});

Deno.test("failed and skipped rows never absorb an event", () => {
  const rows = [
    row({ attempt: 2, status: "failed", failure_reason: "pool impact 900bps exceeds limit" }),
    row({ attempt: 1, status: "skipped", failure_reason: "allowance 0 below amount" }),
  ];
  const out = mergeHistory(schedule("direct"), rows, [event({})]);
  assertEquals(out.length, 3);
  const synthesised = out.find((r) => r.id === `onchain:${TX_A}`)!;
  assertEquals(synthesised.status, "delivered");
  assertEquals(synthesised.attempt, 1);
  assertEquals(synthesised.token_address, schedule("direct").token_address);
  assertEquals(out.filter((r) => r.status === "failed").length, 1);
  assertEquals(out.filter((r) => r.status === "skipped").length, 1);
});

Deno.test("events pair with in-flight rows oldest-first and by hash when known", () => {
  const rows = [
    row({ attempt: 3, status: "swapping", started_at: "2026-09-21T12:00:00.000Z" }),
    row({ attempt: 2, status: "delivered", tx_hash: TX_A, started_at: "2026-09-21T11:00:00.000Z" }),
    row({ attempt: 1, status: "failed", started_at: "2026-09-21T10:00:00.000Z" }),
  ];
  const events = [
    event({ txHash: TX_B, blockNumber: 78_000_100, runsExecuted: 2 }),
    event({ txHash: TX_A, blockNumber: 78_000_000, runsExecuted: 1 }),
  ];
  const out = mergeHistory(schedule("direct"), rows, events);
  assertEquals(out.map((r) => r.attempt), [3, 2, 1]);
  assertEquals(out[0].tx_hash, TX_B);
  assertEquals(out[0].status, "delivered");
  assertEquals(out[1].tx_hash, TX_A);
  assertEquals(out[2].status, "failed");
});

Deno.test("newest first, with a synthesised row placed by its block time", () => {
  const rows = [row({ attempt: 1, status: "failed", started_at: "2026-09-21T09:00:00.000Z" })];
  const out = mergeHistory(schedule("direct"), rows, [event({})]);
  assertEquals(out[0].id, `onchain:${TX_A}`);
  assertEquals(out[1].id, "row-1");
});
