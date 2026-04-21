# sourcify-chains

TODO: Use node v22
TODO: Check why zetachain lost RPC support
TODO: Handle cases when there's blockscout but no RPC.
TODO: Add probing for Etherscan creation tx fetching, some instances don't support free tier
TODO: Add https://docs.nodereal.io/reference/nr_getcontractcreationtransaction probing

Canonical chain configuration for [Sourcify](https://sourcify.dev) — the open-source smart contract verification service. The Sourcify server fetches [`sourcify-chains-default.json`](./sourcify-chains-default.json) from this repository at startup.

## How it works

`sourcify-chains-default.json` is **auto-generated** by a nightly CI job (and on every push to `main`) that:

1. Fetches supported chains from external APIs: **QuickNode**, **dRPC**, **Etherscan**, and **Blockscout**
2. **Probes each QuickNode and dRPC chain** to verify it is alive and detect trace support (see below)
3. Merges with manually maintained config files in this repo
4. Writes the merged result to `sourcify-chains-default.json`

A chain is **auto-included** if it appears in any of:

- QuickNode console API — and is not dead (see probing below)
- dRPC chains API (`https://drpc.org/api/blockchains-list`) — and is not dead (see probing below)
- Etherscan chainlist API
- Blockscout's own hosted instances (where `hostedBy === "blockscout"`)

### RPC liveness and trace probing

Every QuickNode and dRPC chain is probed on each run. Probing:

1. Calls `eth_getBlockByNumber("latest")` on the provider URL to get the current block number. If the provider returns an error (e.g. "Unknown network"), the chain is **dead** on that provider.
2. Looks up a cached transaction hash from `tx-cache.json` (keyed by chain ID). If one exists, it is used directly and the block scan is skipped. Otherwise, scans blocks `[latest-50 .. latest-550]` (a 500-block window) looking for a transaction. Skipping the most recent 50 blocks avoids transactions whose traces may not yet be indexed. If no transaction is found in that window, the chain is treated as **inactive** (dead).
3. If a transaction is found, calls `trace_transaction` then `debug_traceTransaction` on it to detect which trace method the provider supports for that chain.

**Dead** chains (step 1–2 failed) are excluded from the provider's RPC list and do not count as a discovery source. A chain with no remaining active sources is removed from the output entirely.

**Trace support** result per provider:
| Value | Meaning |
|---|---|
| `"trace_transaction"` | Provider supports Parity-style tracing for this chain |
| `"debug_traceTransaction"` | Provider supports Geth-style tracing for this chain |
| `"none"` | Chain is alive but neither trace method is available |
| `null` | Chain is dead on this provider |

QuickNode and dRPC are probed independently — they may expose different trace methods for the same chain. Each probe has a 45 s total timeout (accommodates retries across individual RPC calls).

Routescan and third-party Blockscout instances do **not** qualify a chain for inclusion on their own — they only contribute `fetchContractCreationTxUsing` data. We also make use of the [chainid.network/chains.json](https://chainid.network/chains.json) (a.k.a "chainlist") file to get the public RPCs of the chains if no paid provider RPCs are available.

Beyond auto-discovery, chains can also be manually included or excluded:

- **`additional-chains.json`** — manually include chains that are not auto-discovered
- **`deprecated-chains.json`** — manually exclude chains, even if they appear in provider APIs
- **`chain-overrides.json`** — override or extend fields for any included chain (custom RPCs, trace support, etc.)

## Source files (inputs to generation)

### `chain-overrides.json`

Override or extend fields for any chain. A chain-overrides entry alone is sufficient to include a chain in the output — it does not need to be auto-discovered first. Use this for chains that need non-default configuration (e.g. custom RPCs, trace support, custom `fetchContractCreationTxUsing`).

```json
{
  "1": {
    "sourcifyName": "Ethereum Mainnet",
    "fetchContractCreationTxUsing": { "avalancheApi": true },
    "rpc": [
      {
        "type": "FetchRequest",
        "url": "https://rpc.mainnet.ethpandaops.io",
        "headers": [
          { "headerName": "CF-Access-Client-Id", "headerEnvName": "CF_ACCESS_CLIENT_ID" },
          { "headerName": "CF-Access-Client-Secret", "headerEnvName": "CF_ACCESS_CLIENT_SECRET" }
        ]
      }
    ]
  }
}
```

Allowed fields per entry:

| Field                          | Description                                                               |
| ------------------------------ | ------------------------------------------------------------------------- |
| `sourcifyName`                 | Display name (overrides chainid.network name)                             |
| `fetchContractCreationTxUsing` | Additional fetch methods (`avalancheApi`, `telosApi`, etc.)               |
| `rpc`                          | RPCs defined here have higher priority than auto-discovered provider RPCs |

### `additional-chains.json`

Chains that are **not auto-discovered** but are still supported by Sourcify. Each entry needs only a `sourcifyName`:

```json
{
  "57": { "sourcifyName": "Syscoin Mainnet" },
  "82": { "sourcifyName": "Meter Mainnet" }
}
```

The generator injects `supported: true` and `discoveredBy: ["additional-chains"]` at output time. This file is intentionally minimal — only `sourcifyName` belongs here for easier human inspection. Typically the RPCs of these chains are imported from the [chainid.network/chains.json](https://chainid.network/chains.json) (a.k.a "chainlist") file.

A chain must not appear in `additional-chains.json` if it is already auto-discovered — the generator will throw. If a chain becomes auto-discovered over time, remove it from `additional-chains.json` (and add a `chain-overrides.json` entry if a custom name or config is still needed). A chain must also not appear in both `additional-chains.json` and `deprecated-chains.json` (the generator will throw).

### `deprecated-chains.json`

Chains that should be excluded from the output entirely, even if they appear in provider APIs or are auto-discovered. These will have `"supported": false` in the output:

```json
{
  "3": "Ethereum Ropsten Testnet",
  "4": "Ethereum Rinkeby Testnet"
}
```

### `drpc-ignore.json`

Chains whose dRPC endpoint is too unreliable to probe or use. These chains are excluded from dRPC probing entirely and will not get a dRPC RPC entry in the output, even if they appear in the dRPC chain list. They may still be discovered and served via other providers (QuickNode, Etherscan, Blockscout):

```json
{
  "1284": "Moonbeam",
  "1313161555": "Aurora Testnet"
}
```

### `tx-cache.json`

A cache of known transaction hashes, keyed by chain ID. When a cached hash is available for a chain, the probe skips the 500-block scan entirely and uses it directly. This prevents false "chain inactive" results for low-activity chains where no transaction happens to appear in the scan window.

The cache is updated automatically after each generation run and committed alongside `sourcify-chains-default.json`. It only caches the tx hash — trace probe results are never cached; those are always re-probed fresh each run.

```json
{
  "1": "0xabc123...",
  "137": "0xdef456..."
}
```

### `etherscan-api-keys.json`

Maps chain IDs to the environment variable name holding their Etherscan API key. Chains not listed here fall back to `ETHERSCAN_API_KEY`:

```json
{
  "1": "ETHERSCAN_API_KEY_MAINNET",
  "56": "ETHERSCAN_API_KEY_BSC",
  "137": "ETHERSCAN_API_KEY_POLYGON"
}
```

## Output file

### `sourcify-chains-default.json`

**Do not edit this file directly** — it is auto-generated by the CI pipeline.

Each entry includes:

| Field                          | Description                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `sourcifyName`                 | Human-readable chain name                                                                       |
| `supported`                    | `true` for active chains; `false` for deprecated chains                                         |
| `discoveredBy`                 | Which sources caused this chain to be included (e.g. `["quicknode", "drpc", "etherscan"]`)      |
| `rpc`                          | Ordered list: override RPCs → dRPC (if alive) → QuickNode (if alive) → public (chainid.network) |
| `etherscanApi`                 | Etherscan API config, if the chain is on Etherscan's chainlist                                  |
| `fetchContractCreationTxUsing` | APIs used to look up contract creation transactions                                             |

Example output entry for Ethereum Mainnet:

```json
{
  "sourcifyName": "Ethereum Mainnet",
  "supported": true,
  "discoveredBy": ["quicknode", "drpc", "etherscan", "blockscout", "chain-overrides"],
  "fetchContractCreationTxUsing": {
    "avalancheApi": true,
    "etherscanApi": true,
    "blockscoutApi": { "url": "https://eth.blockscout.com/" }
  },
  "etherscanApi": { "supported": true, "apiKeyEnvName": "ETHERSCAN_API_KEY_MAINNET" },
  "rpc": [
    { "type": "FetchRequest", "url": "https://rpc.mainnet.ethpandaops.io", "headers": [...] },
    { "type": "APIKeyRPC", "url": "https://lb.drpc.org/ogrpc?network=ethereum&dkey={API_KEY}", "apiKeyEnvName": "DRPC_API_KEY", "traceSupport": "trace_transaction" },
    { "type": "APIKeyRPC", "url": "https://{SUBDOMAIN}.quiknode.pro/{API_KEY}/", "apiKeyEnvName": "QUICKNODE_API_KEY", "subDomainEnvName": "QUICKNODE_SUBDOMAIN", "traceSupport": "trace_transaction" }
  ]
}
```

## RPC priority order

For each chain, the generator builds the RPC list in this priority order:

1. **Override RPCs** from `chain-overrides.json` (e.g. ethpandaops `FetchRequest` entries)
2. **dRPC** `APIKeyRPC` (if the chain is on dRPC) — preferred due to lower cost
3. **QuickNode** `APIKeyRPC` (if the chain is on QuickNode)
4. **Public RPCs** from chainid.network — only if none of the above exist

## How to add a chain

### Chain is auto-discovered (appears on QuickNode / dRPC / Etherscan / Blockscout-hosted)

Wait for the next nightly run — it will be picked up automatically. If you need to override a field (e.g. add a custom RPC or `fetchContractCreationTxUsing`), open a PR adding an entry to `chain-overrides.json`.

### Chain is not auto-discovered

If the chain needs only a name and no custom config, add it to `additional-chains.json`:

```json
{
  "12345": { "sourcifyName": "My Chain Mainnet" }
}
```

If the chain also needs custom RPCs or other config, add it to `chain-overrides.json` instead — a chain-overrides entry alone is sufficient to include a chain.

### Deprecating a chain

Add the chain ID and name to `deprecated-chains.json`. If the chain is also in `additional-chains.json`, remove it from there too.

### Custom Etherscan API key env var

Add an entry to `etherscan-api-keys.json` mapping the chain ID to the env var name:

```json
{
  "12345": "ETHERSCAN_API_KEY_MYCHAIN"
}
```

## Stability filtering (sync step)

External APIs are flaky — dRPC sometimes drops chains, Routescan is inconsistent, trace probing returns different results across runs. Without filtering, every flake produces a noisy PR with spurious removals that revert on the next run.

`scripts/sync.ts` sits between `generate.ts` and the PR step. It applies a **consecutive-run threshold** before including reductive changes:

| Change type | Threshold |
|---|---|
| New chain, new RPC, new traceSupport, new fetchUsing key, new etherscanApi, new discoveredBy source | **Immediate** (1 run) |
| Chain removed, RPC removed, traceSupport changed/removed, fetchUsing key removed or value changed, etherscanApi removed, discoveredBy source removed | **5 consecutive runs** |

If a reductive change disappears between runs (API flake recovered), its counter resets and it is not included.

**State** is persisted in `change-history.json` on an orphan branch `chain-sync-state`. The workflow fetches it at the start of each run and pushes the updated counters back at the end.

**Output**: `sync.ts` overwrites `sourcify-chains-default.json` with the stabilized result (snapshot with unstable removals reverted to their baseline values) and writes `pr-description.txt` summarising what is immediately included, what is newly stabilised, and what is still pending.

## CI pipeline

The generation workflow (`.github/workflows/generate.yml`) runs:

- **On push to `main`** when `chain-overrides.json`, `additional-chains.json`, `deprecated-chains.json`, `etherscan-api-keys.json`, or `scripts/**` change
- **Twice daily** at 02:00 and 14:00 UTC (to pick up new chains from provider APIs and accumulate stability-filter counts)
- **Manually** via `workflow_dispatch`

If `sourcify-chains-default.json` or `tx-cache.json` changes after stability filtering, the bot opens a PR from a fixed branch `chore/regenerate-chains` targeting `main`. If a PR for that branch is already open, it force-pushes the update to it instead of opening a new one. The PR body is generated from `pr-description.txt` and lists immediately included changes, newly stabilised removals, and still-pending changes. The PR must be reviewed and merged manually.

Required secrets:

| Secret                      | Purpose                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `QUICKNODE_CONSOLE_API_KEY` | Fetches the list of chains QuickNode supports (Console API, separate from RPC key) |
| `QUICKNODE_API_KEY`         | RPC key used to probe chain liveness and trace support on QuickNode                |
| `QUICKNODE_SUBDOMAIN`       | Subdomain for the QuickNode RPC endpoint                                           |
| `DRPC_API_KEY`              | RPC key used to probe chain liveness and trace support on dRPC                     |

## Running locally

```bash
npm install
QUICKNODE_CONSOLE_API_KEY=<key> \
QUICKNODE_API_KEY=<key> \
QUICKNODE_SUBDOMAIN=<subdomain> \
DRPC_API_KEY=<key> \
npm run generate
```

`QUICKNODE_CONSOLE_API_KEY` is required to fetch the chain list. The RPC keys (`QUICKNODE_API_KEY`, `QUICKNODE_SUBDOMAIN`, `DRPC_API_KEY`) are optional — without them, probing is skipped and no `traceSupport` is set on provider RPCs.

The script probes all QuickNode and dRPC chains, writes `sourcify-chains-default.json`, and prints a summary.
