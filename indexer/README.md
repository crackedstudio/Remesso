# indexer — Goldsky subgraph over `RemessoExecutorV3`

An [instant subgraph](https://docs.goldsky.com/subgraphs/reference/instant-subgraph):
generated from the ABI, no mapping handlers. Every event the contract emits
becomes an entity (`runExecuteds`, `scheduleCreateds`, `scheduleCancelleds`,
…) with Goldsky's own `block_number`, `timestamp_`, `transactionHash_`
fields. The event parameter named `id` is exposed as `idParam`, because `id`
is the entity key.

| | |
|---|---|
| project | `project_cmt8exmp1z5f401z7gnkohrw9` |
| subgraph | `remesso-celo-celo/1.0.0`, tagged `prod` |
| endpoint | `https://api.goldsky.com/api/public/project_cmt8exmp1z5f401z7gnkohrw9/subgraphs/remesso-celo-celo/prod/gn` |
| chain | `celo` (42220), from block `77741897` — V3's deployment block |

Goldsky appends the chain to the name you give it, hence `-celo` twice.
Measured 2026-09-21: 1–2 blocks behind head at Celo's 1s block time.

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

The deploy is against the *un*-suffixed name; the tag against the suffixed
one. `--tag` on the deploy command gets that wrong and fails after deploying,
which is harmless but confusing.

Deployment block, if it is ever needed again: binary-search `cast code
<addr> --block N` on forno.

## Checking it

```bash
curl -s "$NEXT_PUBLIC_GOLDSKY_SUBGRAPH_URL" -H 'content-type: application/json' \
  -d '{"query":"{ _meta { block { number } hasIndexingErrors } runExecuteds(first:3, orderBy: block_number, orderDirection: desc){ idParam runsExecuted transactionHash_ block_number } }"}' | jq .
```

Compare `_meta.block.number` with `cast block-number --rpc-url https://forno.celo.org`.
