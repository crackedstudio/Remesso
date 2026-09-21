# indexer — Goldsky subgraph over `RemessoExecutorV3`

An [instant subgraph](https://docs.goldsky.com/subgraphs/reference/instant-subgraph):
generated from the ABI, no mapping handlers. Every event the contract emits
becomes an entity (`runExecuteds`, `scheduleCreateds`, `scheduleCancelleds`,
…) with Goldsky's own `block_number`, `timestamp_`, `transactionHash_`
fields. The event parameter named `id` is exposed as `idParam`, because `id`
is the entity key.

| | |
|---|---|
| project | `project_cmub9zi745rtc01ts1xx66zy6` |
| subgraph | `remesso-celo/1.0.0` — deployed from the dashboard, **no `prod` tag** |
| endpoint | `https://api.goldsky.com/api/public/project_cmub9zi745rtc01ts1xx66zy6/subgraphs/remesso-celo/1.0.0/gn` |
| chain | `celo` (42220), from block `77741897` — V3's deployment block |

Deployed from the Goldsky dashboard, which keeps the name as typed. The CLI
(`--from-abi`) appends the chain instead, which is where a `remesso-celo-celo`
name would come from. Measured 2026-09-21: 4 blocks behind head at Celo's 1s
block time.

**The URL is version-pinned**, because a dashboard deploy creates no tag. A
future `1.1.0` therefore needs `NEXT_PUBLIC_GOLDSKY_SUBGRAPH_URL` changed too,
unless a `prod` tag is created first and the URL switched to it:

```bash
goldsky subgraph tag create remesso-celo/1.1.0 --tag prod
```

## What reads it

`web/lib/goldsky.ts` → `useHistory` in `web/lib/hooks.ts`, merged with the
`runs` table by `web/lib/history.ts`. The frontend only, and only to show a
run sooner than the database does. Nothing that decides whether a run pays
reads it — `execute-due-runs` does not know it exists.

The URL is `NEXT_PUBLIC_GOLDSKY_SUBGRAPH_URL`. Unset it and the history is
the database alone.

## Redeploying

Only needed when the contract changes (a new executor address is a new
instance in `goldsky.json`, with its own start block) or the ABI does.

```bash
cd contracts && forge build
jq '.abi' contracts/out/RemessoExecutorV3.sol/RemessoExecutorV3.json > indexer/abis/RemessoExecutorV3.json
cd indexer && goldsky subgraph deploy remesso-celo/1.1.0 --from-abi goldsky.json
goldsky subgraph tag create remesso-celo-celo/1.1.0 --tag prod
```

Note the CLI appends the chain: deploying `remesso-celo/1.1.0` this way
produces `remesso-celo-celo/1.1.0`, a *different* subgraph from the
dashboard-deployed `remesso-celo/1.0.0` the app currently reads. Tag whichever
one you intend to serve, and point the env var at it.

Deployment block, if it is ever needed again: binary-search `cast code
<addr> --block N` on forno.

## Checking it

```bash
curl -s "$NEXT_PUBLIC_GOLDSKY_SUBGRAPH_URL" -H 'content-type: application/json' \
  -d '{"query":"{ _meta { block { number } hasIndexingErrors } runExecuteds(first:3, orderBy: block_number, orderDirection: desc){ idParam runsExecuted transactionHash_ block_number } }"}' | jq .
```

Compare `_meta.block.number` with `cast block-number --rpc-url https://forno.celo.org`.
