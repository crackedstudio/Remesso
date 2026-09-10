# Remesso

Automated recurring stablecoin remittances on **Celo**, settling in **cNGN**.

A sender authorises a remittance once — recipient, amount, cadence, floor rate.
It then runs unattended, converting USDT to naira-backed cNGN and delivering
either to the recipient's wallet or, via the cNGN API, straight to a Nigerian
bank account. No one holds the sender's keys and no one can move their money
outside the envelope they signed.

---

## Why Celo and cNGN

The original plan targeted moove.xyz. That does not work, and the reason is
structural rather than a matter of timing: Moove's entire public API is two
payment-link endpoints, and its stated design principle — repeated across their
docs and enforced in their key model — is *"no endpoint moves funds."* Money in
is programmable; money out is not. Moove Ramp is additionally first-person only,
so a third party can never trigger a recipient's payout.

Celo is a public blockchain, so there is no permission to ask. cNGN is a
Nigerian-SEC-regulated naira stablecoin that deployed to Celo in August 2026,
and its API does the thing Moove's cannot: `redeemAsset` burns cNGN and pays
naira to an arbitrary bank account.

Everything below was verified on-chain and against live docs on 2026-09-07,
not taken from marketing pages.

| | |
|---|---|
| cNGN (Celo mainnet) | `0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f` — **6 decimals** |
| cNGN (Celo Sepolia) | `0xa188439ccCEe9A6aa0E842f9c17C1b00C7B4dd4D` |
| USDT (funding asset) | `0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e` — 6 decimals |
| Uniswap SwapRouter02 | `0x5615CDAb10dc425a742d643d949a7F474C01abc4` |
| cNGN/USDT pool | `0x6519d56eb0a69fc0338657784c783b169b8f7d32` — 0.01% tier |

> **Decimals.** cNGN is 6dp. Mento's unrelated `NGNm` is 18dp. Confusing them
> is a factor of 10¹².

---

## Architecture

```
Sender wallet                Supabase                      Celo + cNGN
─────────────                ────────                      ───────────
approve(USDT)  ──┐
createSchedule() ─┴──▶ schedules ◀── pg_cron (*/5)
                            │
                            ▼
                   execute-due-runs ──▶ quote (Quoter)
                            │        ──▶ liquidity check
                            │        ──▶ redeemAsset ──▶ cNGN API
                            │        ──▶ executeRun ──▶ RemessoExecutor
                            │                              │
                            │                       swap USDT→cNGN
                            │                              │
                            │                     ┌────────┴────────┐
                            │                     ▼                 ▼
                            │              recipient wallet   redemption addr
                            │                                       │
                   cngn-webhook ◀─── redemption.completed ──────────┘
                            │
                            ▼
                        runs.paid_out
```

### The authorisation model

The sender signs **one on-chain transaction**, not a session key. MiniPay — the
wallet most of this audience actually uses — does not support message signing at
all, so an off-chain permission grant was never viable. An `approve` plus a
`createSchedule` call is also better: it is explicit, auditable, and revocable
by the sender without our cooperation.

What the backend's hot key can do: call `executeRun(id, minOut)`.
What it cannot do, enforced in the contract rather than in our code:

- send to any address except the one the sender fixed at creation
- move more than `amountIn`, or run more often than `interval`
- accept a rate below the sender's `minRateE6` floor
- run after `expiresAt` or past `maxRuns`
- touch a paused or cancelled schedule

The sender's ERC-20 allowance is the outermost cap. Revoking it stops
everything, immediately, with no involvement from us.

### Why bank payouts settle in two steps

`redeemAsset` returns a deposit address; cNGN is then sent there and naira is
paid out. So an `ngn_bank` run goes `pending → swapping → redeeming → paid_out`,
and only the `redemption.completed` webhook advances the last step. A run whose
swap has settled has **not** delivered cash — showing a sender "settled" at that
point is the failure mode this schema is shaped to prevent.

---

## Layout

```
contracts/          Foundry. RemessoExecutor + 17 tests.
supabase/
  migrations/       Schema, RLS, pg_cron triggers.
  functions/
    _shared/        Config, cNGN client, Celo/viem helpers, crypto tests.
    execute-due-runs/       The executor loop.
    cngn-webhook/           Redemption settlement (fast path).
    reconcile-redemptions/  Redemption settlement (authoritative path).
    cngn-proxy/             The frontend's only route to the cNGN API.
    balance-poller/         Funding + liquidity pre-flight warnings.
web/                Next.js sender app. MiniPay-first, wagmi + viem.
  app/api/cngn/     Server-only handlers; forward to cngn-proxy, cache banks.
  lib/              Config, ABI, hooks, formatting.
```

## Getting started

```bash
cp .env.example .env          # fill in secrets; never commit this

cd contracts
forge install                 # forge-std + openzeppelin
forge test                    # 17 passing

# Deploy to testnet FIRST and run a full schedule end to end there.
DEPLOYER_PRIVATE_KEY=0x... EXECUTOR_ADDRESS=0x... \
  forge script script/Deploy.s.sol:Deploy --rpc-url celo_sepolia --broadcast

cd ..
supabase db push
supabase functions deploy execute-due-runs cngn-webhook balance-poller
supabase secrets set --env-file .env
```

Set the cron vault secrets once, so the service-role key never sits in a cron
definition in plain text:

```sql
select vault.create_secret('https://<ref>.supabase.co', 'project_url');
select vault.create_secret('<service-role-key>',        'service_role_key');
```

Point the cNGN dashboard's webhook URL at
`https://<ref>.supabase.co/functions/v1/cngn-webhook` and set the signing
secret to `CNGN_WEBHOOK_SECRET`. Configure the test URL and verify against
sandbox transactions before touching the live one.

Then the sender app:

```bash
cd web
cp .env.local.example .env.local   # public config only; no cNGN secrets here
npm install
npm run dev
```

`web/.env.local` holds nothing sensitive by design. The cNGN API key, AES key
and Ed25519 private key exist only as Supabase secrets, reachable through the
`cngn-proxy` Edge Function — the docs are explicit that they must never reach
client-side code, and cNGN whitelists by IP, so one egress point is also the
only arrangement that can be whitelisted at all.

---

## Liquidity: the live constraint

There is exactly **one** cNGN venue on Celo — the Uniswap V3 pool above. It
holds roughly 118M cNGN and 95k USDT. Measured via QuoterV2 on 2026-09-07:

| Trade | Slippage |
|---|---|
| $100 | 0.02% |
| $1,000 | 0.06% |
| $10,000 | 0.56% |
| $50,000 | 2.68% |
| $100,000 | 13.48% |

Spot was ₦1,368/USDT, sitting sensibly between the official NFEM rate (₦1,329)
and the parallel market (₦1,395–1,410).

For remittance-sized transfers this is effectively free. Two consequences are
baked into the code:

1. `LIMITS.maxRunAmountUsdt` caps a single run well below the point where
   slippage bites, and `liquidityIsHealthy()` aborts a run the pool cannot fill
   cheaply rather than executing it at any price.
2. **About 76% of all cNGN on Celo sits in that one pool.** One LP withdrawal
   removes the entire swap route. Treat the swap as a replaceable component:
   Textile FX (OTC, 78 onboarded Nigerian firms) is the venue for size, and
   minting cNGN directly through ASC is the endgame. Do not let the Uniswap call
   leak beyond `_shared/celo.ts`.

---

## The cNGN integration

Implemented against the published spec at `docs.cngn.co`, not against
assumptions. Four properties of that API drive the code:

**Requests are encrypted, responses are sealed.** POST and PUT bodies go out as
`{content, iv}` — AES-256-CBC under a key derived by SHA-256'ing the dashboard
encryption key. Every *successful* response comes back as
`{status, message, data}` where `data` is a base64 libsodium `crypto_box`
sealed to your Ed25519 public key: `nonce(24) || ciphertext || ephemeral pk(32)`.
It is an opaque string on the wire, so reading a field off it without opening it
first silently yields `undefined`.

`supabase/functions/_shared/cngn.test.ts` verifies both directions against the
docs' own reference implementations — our AES ciphertext is byte-identical to
what Node's `createCipheriv` produces, and the tests play the role of the cNGN
server, sealing payloads to a freshly generated `ssh-keygen` key and requiring
the client to open them. Run it with:

```bash
deno test --allow-env --allow-read --allow-write --allow-run --allow-net \
  supabase/functions/_shared/cngn.test.ts
```

**The rate limit is 20 requests per 60 seconds per API key, and breaching it
blocks the key for another 60 seconds.** That makes the limiter in `cngn.ts` a
correctness feature rather than politeness: one burst of bank-list lookups from
a signup page would otherwise strand an in-flight redemption. Banks and networks
are cached for six hours in the Edge Function and again for twelve in the Next
route handler, which is what the docs advise.

**Webhooks are delivered exactly once.** *"Deliveries are sent once, with a
10-second timeout, and are not automatically retried."* A 500 from us — a cold
start, a deploy landing mid-delivery — loses the event permanently and leaves a
run stuck in `redeeming` while the recipient has in fact been paid. So
`cngn-webhook` persists and acknowledges before doing any work, and
`reconcile-redemptions` polls `/transactions` every ten minutes for anything
still open. The webhook is the fast path; the transactions API is the authority.

**Only four endpoints are on the money path**, and they are deliberately split
by who can reach them:

| | Reachable from | Notes |
|---|---|---|
| `GET /banks` | `cngn-proxy` (signed-in senders) | Cached hard; ~900 rows |
| `POST /account/verify` | `cngn-proxy` (signed-in senders) | At onboarding only, never at payout |
| `POST /redeemAsset` | `execute-due-runs` only | Requires the "Redeem" permission |
| `GET /transactions` | `reconcile-redemptions` only | Settlement of record |

Note the path is `/account/verify`, not `/verifyAccountDetails` — an earlier
draft of this repo had the latter, which does not exist.

---

## Getting cNGN credentials

Everything below comes from the merchant dashboard, and **each environment has
its own complete set**. A `cngn_test_` key with a live encryption key fails; so
does a live key against the SSH key you uploaded for test.

1. **Onboard as a merchant.** Sandbox access needs an account. Live keys are
   issued only after KYB completes: business documents, identity verification
   for account owners, and the onboarding fee. This gates the entire live path,
   so start it early — it is not a same-day step.

2. **API key and encryption key.** Dashboard → **Settings → API Key**. Both are
   already generated; reveal with the eye icon and copy with the clipboard icon.
   The prefix picks the environment (`cngn_test_…` / `cngn_live_…`); the base
   URL is the same either way.
   → `CNGN_API_KEY`, `CNGN_ENCRYPTION_KEY`

3. **Ed25519 keypair — you generate this, not cNGN.**

   ```bash
   ssh-keygen -t ed25519 -C "api@remesso" -f cngn_api_key
   ```

   Paste `cngn_api_key.pub` into the **SSH public key** field on the same tab.
   Keep the private half. Without it every request fails with
   `No Test SSH Key found`, and nothing the API returns is readable.
   → `CNGN_SSH_PRIVATE_KEY` (the private half; escaped `\n` is fine)

   **Take the default of no passphrase.** cNGN's guide offers one, but the
   executor runs unattended and has nothing to prompt with — a passphrase
   encrypts the key body and the private key cannot be loaded at all. If you
   already set one, strip it; the public key is unchanged, so the dashboard
   needs no update:

   ```bash
   ssh-keygen -p -N "" -f cngn_api_key
   ```

   The four ways this goes wrong — passphrase, the `.pub` file pasted instead
   of the private half, an RSA key, and a truncated paste — each fail with a
   message naming the actual problem rather than a generic parse error. They
   are covered in `cngn.test.ts`, because the failure they'd otherwise produce
   is an unexplained key mismatch hours later.

4. **Permissions.** An organisation admin grants these per key. Remesso needs
   **Redeem**. Without it `redeemAsset` returns `{"status": false, "message":
   "Permission denied"}` — note that shape: the HTTP status is not the whole
   story, which is why the client checks both.

5. **IP whitelist.** Dashboard security settings. See below — this is the part
   that does not have a clean answer yet.

6. **Webhook signing secret.** Dashboard → webhooks. Set the URL to
   `https://<ref>.supabase.co/functions/v1/cngn-webhook` and subscribe to
   `redemption.completed` and `transaction.failed` at minimum.
   → `CNGN_WEBHOOK_SECRET`

```bash
# Prove the credentials before wiring anything up. /balance needs no request
# encryption, so a 200 here means the key, the IP and the SSH key are all good.
curl -s -X GET "https://api.cngn.co/v1/api/balance" \
  -H "Authorization: Bearer $CNGN_API_KEY"
```

The `data` field of that response will be an unreadable base64 string. That is
correct — it is sealed to your public key.

### cNGN egress: the IP whitelist problem

cNGN checks the source IP of every request against a dashboard whitelist and
answers `403 IP address not whitelisted` regardless of credentials. Supabase
Edge Functions run on a large, dynamic pool of addresses, so **there is nothing
stable to whitelist.** This is a deployment blocker for the live environment,
not a code problem, and it has three possible answers:

**cNGN confirmed 2026-09-10: static IP only, no CIDR.** That settles it — there
is no arrangement under which Supabase's rotating egress can be whitelisted, so
cNGN traffic has to leave from one fixed address.

1. **A fixed-IP forward proxy — the recommended path.** Set
   `CNGN_EGRESS_PROXY_URL` and `cngn.ts` routes every cNGN call through it,
   throwing a clear error rather than silently going direct if the runtime
   cannot. Verified 2026-09-10 that the Supabase Edge Runtime
   (supabase-edge-runtime-1.76.0, Deno 2.1.4) does expose
   `Deno.createHttpClient` and accepts a proxy config, so this works without
   moving anything. A small VPS running tinyproxy, a Fly.io machine with a
   dedicated IPv4, or a managed static-IP proxy all satisfy it.
2. Move the cNGN-touching functions onto a host that has a static egress IP.

The 403 was reproduced directly: `GET /balance` with the live key returns
`{"status":403,"message":"IP address not whitelisted"}`, and an empty IP Access
List blocks everything rather than allowing everything.

---

## Open items

- **Regulatory posture — unresolved and blocking for launch.** `redeemAsset`
  puts Remesso in the business of instructing naira payouts to third parties.
  That is a money-transmission question, and it needs a Nigerian fintech lawyer
  before this goes near real senders, not after.
- **Bank-payout destination — still the sharpest technical unknown.**
  `redeemAsset` returns a deposit address *per redemption*, while the contract
  fixes `destination` at authorisation. If that address rotates, an `ngn_bank`
  schedule delivers cNGN somewhere the redemption is not watching and the naira
  never arrives. Two things now guard this rather than one comment:
  `execute-due-runs` compares the address cNGN returns against the sender's
  on-chain destination and aborts the run *before spending gas* if they differ,
  and the frontend hides bank payouts entirely unless
  `NEXT_PUBLIC_CNGN_REDEMPTION_ADDRESS` is set. **Confirm stability with cNGN
  before mainnet.** If it does rotate, the envelope needs a sender-approved
  allowlist instead of a single immutable address.
- ~~**cNGN's Celo support is unconfirmed.**~~ **Resolved 2026-09-10:** cNGN
  confirmed *"Celo redemption is supported."* Their `/networks` documentation
  showing only Base and Polygon is an abbreviated example, not a limit.
  `assertCeloSupported()` still runs as a preflight.
- **Sender identity is a claim, not a proof.** MiniPay does not support message
  signing, so SIWE is unavailable to most of this audience and the app binds a
  wallet to an anonymous Supabase session. This does not weaken the money path —
  the contract checks `msg.sender` for pause and cancel, and nothing in the
  database can move funds — but `senders.wallet_address` is first-come, so an
  address can be squatted. The fix, once a signing path exists, is to verify
  ownership from `schedulesOf(address)` and the authorising transaction.
- **The IP whitelist needs a fixed-IP proxy standing up.** cNGN will not
  whitelist a CIDR, and Supabase egresses from the whole AWS `eu-central-1`
  pool — measured: 8 consecutive calls, 8 distinct IPs.
- **cNGN account is not verified.** ₦100,000 one-time fee plus KYB documents,
  and `redeemAsset` does not work until it completes.
- **Webhooks are not yet configurable.** cNGN confirmed 2026-09-10 that support
  ships "next week". Until then `reconcile-redemptions` polling
  `GET /transactions` is the settlement of record — which the redeemAsset
  reference endorses anyway ("Track it via Get Transactions").
- Recipient notifications — one seam left in `balance-poller`.
