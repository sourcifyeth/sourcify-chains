# sourcify-chains

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
2. Scans blocks `[latest-50 .. latest-150]` looking for a transaction. Skipping the most recent 50 blocks avoids transactions whose traces may not yet be indexed. If no transaction is found in that window, the chain is treated as **inactive** (dead).
3. If a transaction is found, calls `trace_transaction` then `debug_traceTransaction` on it to detect which trace method the provider supports for that chain.

**Dead** chains (step 1–2 failed) are excluded from the provider's RPC list and do not count as a discovery source. A chain with no remaining active sources is removed from the output entirely.

**Trace support** result per provider:
| Value | Meaning |
|---|---|
| `"trace_transaction"` | Provider supports Parity-style tracing for this chain |
| `"debug_traceTransaction"` | Provider supports Geth-style tracing for this chain |
| `"none"` | Chain is alive but neither trace method is available |
| `null` | Chain is dead on this provider |

QuickNode and dRPC are probed independently — they may expose different trace methods for the same chain. Each probe has a 10 s total timeout (3 s per individual RPC call).

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

| Field | Description |
|---|---|
| `sourcifyName` | Display name (overrides chainid.network name) |
| `fetchContractCreationTxUsing` | Additional fetch methods (`avalancheApi`, `telosApi`, etc.) |
| `rpc` | RPCs defined here have higher priority than auto-discovered provider RPCs |

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

| Field | Description |
|---|---|
| `sourcifyName` | Human-readable chain name |
| `supported` | Always `true` in output (deprecated chains are excluded entirely) |
| `discoveredBy` | Which sources caused this chain to be included (e.g. `["quicknode", "drpc", "etherscan"]`) |
| `rpc` | Ordered list: override RPCs → QuickNode (if alive) → dRPC (if alive) → public (chainid.network) |
| `etherscanApi` | Etherscan API config, if the chain is on Etherscan's chainlist |
| `fetchContractCreationTxUsing` | APIs used to look up contract creation transactions |

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

## CI pipeline

The generation workflow (`.github/workflows/generate.yml`) runs:

- **On push to `main`** when `chain-overrides.json`, `additional-chains.json`, `deprecated-chains.json`, `etherscan-api-keys.json`, or `scripts/**` change
- **Nightly** at 02:00 UTC (to pick up new chains from provider APIs)
- **Manually** via `workflow_dispatch`

If `sourcify-chains-default.json` changes, the bot opens a PR from a fixed branch `chore/regenerate-chains` targeting `main`. If a PR for that branch is already open, it force-pushes the update to it instead of opening a new one. The PR must be reviewed and merged manually.

Required secrets:

| Secret | Purpose |
|---|---|
| `QUICKNODE_CONSOLE_API_KEY` | Fetches the list of chains QuickNode supports (Console API, separate from RPC key) |
| `QUICKNODE_API_KEY` | RPC key used to probe chain liveness and trace support on QuickNode |
| `QUICKNODE_SUBDOMAIN` | Subdomain for the QuickNode RPC endpoint |
| `DRPC_API_KEY` | RPC key used to probe chain liveness and trace support on dRPC |

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
