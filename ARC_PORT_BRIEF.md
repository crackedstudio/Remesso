# Remesso → Arc: agent briefing

You are picking up a **live, working product on Celo mainnet** and evaluating or
executing a port to **Arc** (Circle's stablecoin L1). Read this whole file before
touching anything. It contains the traps that cost real time to find.

Sources for Arc: https://docs.arc.io/build, https://docs.arc.io/ai/skills,
https://docs.arc.io/arc/references/evm-differences.md.

**Install the Circle skills before you start:**
```
/plugin marketplace add circlefin/skills
/plugin install circle-skills@circle      # Claude Code
npx skills add circlefin/skills           # other agents
```
`use-arc` covers chain config, deployment and viem/wagmi; `use-usdc`,
`bridge-stablecoin`, `use-gateway` and `swap-tokens` cover the money movement.

---

## 1. What Remesso is

Automated recurring stablecoin remittances. A sender authorises a schedule
**once, on-chain**; a backend key can then trigger individual runs, but only
inside the envelope the sender signed. The sender's funds never leave their own
wallet until a run executes, and the backend can never redirect a payment.

Three payout rails:

| Rail | What it does | Status |
|---|---|---|
| `Direct` | Forwards the funding asset untouched (USDT/USDC/cUSD) | **Working, proven on mainnet** |
| `Wallet` | Swaps USDT→cNGN via Uniswap V3, sends cNGN to a wallet | Built, works |
| `BankRedemption` | Swaps to cNGN, redeems to a Nigerian bank account via the cNGN API | Blocked on KYB |

## 2. Current state — this all works

Celo mainnet (chain 42220). **Do not assume this is a prototype.**

- `RemessoExecutorV3` at `0xd2e68acd875fb1b3a98dc0d72659910b05e7e08f`, verified.
- 5 Supabase Edge Functions; `pg_cron` invokes `execute-due-runs` **every minute**
  (verified: 60 runs/hour, 0 failures, via `public.cron_health()`).
- Next.js 14 + wagmi v2 + viem frontend, MiniPay-targeted.
- 37/37 Foundry tests. An 11-test mainnet e2e harness (`scripts/e2e-agent-test.ts`).
- A DeepSeek assistant layer (`ai-assist`) that drafts schedules from a sentence
  and explains failures. **Advisory only — it cannot move money.**

Proven end to end on mainnet: three schedules, five runs, every one delivered,
driven by cron with no human involvement.

Read `CLAUDE.md` first. Its "Traps" section is load-bearing and was written from
incidents, not theory.

## 3. Architecture

```
Sender (MiniPay)                Supabase                    Celo
  │ approve(executor, N×amt)      │                          │
  │ createSchedule(...) ──────────┼──────────────────────────► RemessoExecutorV3
  │                               │                          │   (sender's signed envelope)
  │                          pg_cron every 1m                 │
  │                               │                          │
  │                     execute-due-runs ────────────────────► executeRun(id, minOut)
  │                               │   reads runnability()     │   pulls via transferFrom
  │                               │   (the contract is the    │   pays destination
  │                               │    authority, not the DB) │
```

**The invariant that matters:** the contract is the authority; Postgres mirrors
it. Anything that tells a sender a run will go through reads `runnability()`
on-chain. `destination` is immutable per schedule.

## 4. What Arc is, and the traps

Arc is an EVM L1 (Reth execution, Malachite BFT consensus) purpose-built for
stablecoin finance. `viem` ships `arc` and `arcTestnet` built in.

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | `5042` | `5042002` |
| RPC | `https://rpc.mainnet.arc.io` | `https://rpc.testnet.arc.io` |
| Explorer | `https://explorer.arc.io` | `https://explorer.testnet.arc.io` |
| USDC (ERC-20) | `0x3600000000000000000000000000000000000000` | same |
| Faucet | — | `https://faucet.circle.com` |

### Traps — read these twice

1. **USDC is the native gas token, and it has two decimal scales.**
   Native interface: **18 decimals**. ERC-20 interface: **6 decimals**. Same
   balance, two views, a 10¹² difference in raw value. Arc's own docs say never
   record balances from the 6-decimal value — truncation loses money — and a
   zero `balanceOf` does **not** mean zero native balance.

   Remesso is already decimal-sensitive (`CLAUDE.md` trap #1 is a 10¹² decimal
   confusion that cost real time). `web/lib/config.ts` holds a per-token decimals
   map; every amount goes through `parseUnits(input, decimals)`. **Never mix
   `msg.value` with `USDC.balanceOf()` anywhere.**

2. **20 Gwei minimum `maxFeePerGas`, enforced at the mempool.** Below it,
   transactions are *silently dropped* — no receipt, never in a block. If runs
   stop with no error, check this first.

3. **Block timestamps are non-decreasing, not strictly increasing.** Sub-second
   blocks can share a timestamp. `RemessoExecutorV3` schedules on
   `block.timestamp` (`nextRunAt = block.timestamp + interval`). Intervals are
   ≥300s so this is almost certainly fine, but verify rather than assume, and
   order by block number, never by timestamp.

4. **Transfers to `address(0)` revert** ("Zero address not allowed"). The
   contract already rejects `uint160(destination) < 0x10000`, so this is covered
   — do not remove that check.

5. **Blocklist reverts consume gas and produce no receipt.** A blocklisted
   sender or destination will burn executor gas on every attempt. Add a
   pre-flight check or the executor bleeds gas on a stuck schedule.

6. **Finality is instant on inclusion.** `execute-due-runs` waits for
   `confirmations: 2` (a Celo choice). One is sufficient on Arc — halves run
   latency.

7. **No EIP-4844, `PREVRANDAO` is always 0, EIP-7702 is supported.** None of
   these affect Remesso today; do not introduce dependencies on them.

## 5. What breaks, and what it means

### 5.1 MiniPay does not exist on Arc — this is the big one

MiniPay is **Celo-only**. It is also the entire distribution strategy: the
`Direct` rail exists *because* MiniPay shows only USDT/USDC/cUSD and cannot
display cNGN. A large amount of this codebase is MiniPay-shaped:

- `web/lib/tx.ts` forces legacy (type-0) transactions — MiniPay rejects EIP-1559.
  **On Arc this must be removed**; Arc wants EIP-1559 with the 20 Gwei floor.
- Injected-only connector, no WalletConnect, no message signing (so no SIWE —
  senders bind to an anonymous Supabase session).
- Generated display names instead of addresses, and no free-text address input,
  both MiniPay listing requirements.

**Porting to Arc means choosing a new distribution channel and a new wallet
story.** Do not treat this as a config change. If the goal is "also on Arc"
rather than "instead of Celo", say so explicitly — multi-chain is a different,
larger piece of work than a port.

### 5.2 cNGN does not exist on Arc

Both swap rails convert USDT→cNGN and the bank rail redeems cNGN to naira
through the cNGN API. On Arc there is no cNGN, **and no DEX or router is
documented**. So:

- `Wallet` and `BankRedemption` rails have **no venue and no asset**.
- Everything in `supabase/functions/_shared/cngn.ts` — AES-256-CBC request
  encryption, Ed25519 sealed responses, the IP-whitelist proxy on a DigitalOcean
  droplet — is Celo/cNGN-specific and does not port.

Arc offers `FxEscrow` (StableFX) and EURC instead. **The naira question is
unanswered and is a product decision, not an implementation detail.** Resolve it
before writing code: what does a Nigerian recipient actually receive, and who
converts it?

### 5.3 What ports cleanly

- `RemessoExecutorV3.sol` is standard Solidity. The `Direct` rail needs no
  logic change — only the token allowlist (`setDirectTokenAllowed`) repointed at
  Arc's USDC, and `tokenIn`/router constructor args rethought given no DEX.
- The whole scheduling model: `createSchedule`, `runnability`, `executeRun`,
  expiry, `maxRuns`, pause, the owner's deliberately narrow powers.
- Supabase: schema, `pg_cron`, `execute-due-runs`, backoff, reconciliation.
  Only `_shared/celo.ts` (chain + contract access) needs a chain swap.
- The DeepSeek assistant layer, unchanged.
- The frontend, minus everything MiniPay-specific.

## 6. Known open items (inherited, not caused by the port)

- **`RemessoExecutorV3` is unaudited.** A 12-agent Pashov-style review covered
  V1 and found 8 defects including a total failure of bank payouts; V2 fixed
  them. The V3 `Direct` rail — which is what moves real money today — has never
  been audited. **Do not deploy it to Arc without auditing it first.**
- `/api/ai` has no rate limit.
- Regulatory: instructing naira payouts to third parties is a money-transmission
  question. Unresolved, and it does not get simpler on Arc.

## 7. Your task

Unless told otherwise, produce a **migration plan, not a migration**. In order:

1. Install the Circle skills. Read `use-arc`, `use-usdc`, `swap-tokens`.
2. Confirm or correct every Arc fact in §4 against the live docs — they change.
3. Answer the two blocking product questions:
   - **Distribution:** what replaces MiniPay on Arc?
   - **Naira:** what does the recipient receive, and who converts it?
4. Only then: scope the code. Deploy to **Arc testnet (5042002)** first, with
   the faucet. Nothing reaches Arc mainnet before an audit.
5. Keep the invariants in `CLAUDE.md` §"Invariants — do not break". They are the
   product, not implementation detail.

**Report honestly.** If the port does not make sense — if it costs MiniPay
distribution and the naira rail for benefits that do not materialise — say so
plainly with reasons. That is a more useful answer than a plan.
