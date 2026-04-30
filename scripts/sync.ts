/**
 * Stability-filtered chain sync script.
 *
 * Sits between `generate.ts` and the PR step in CI. Reads the raw snapshot
 * (freshly written to sourcify-chains-default.json by generate.ts), compares
 * it against the committed baseline, and applies a stability threshold:
 *
 *   - Additive changes (new chain, new RPC, new fetchUsing key, etc.) →
 *     included immediately (threshold = 1 run)
 *   - Reductive/mutating changes (chain removed, RPC removed, traceSupport
 *     changed) → included only after 5 consecutive runs showing the same change
 *
 * If a reductive change disappears between runs (API flake recovered), its
 * counter resets and it is NOT included.
 *
 * Reads:
 *   sourcify-chains-default.json  (raw snapshot in CWD, written by generate.ts)
 *   --baseline <file>             (committed version before generate ran)
 *   --history  <file>             (change-history.json from chain-sync-state branch)
 *
 * Writes:
 *   sourcify-chains-default.json  (overwritten with stabilized output)
 *   change-history.json           (updated counters)
 *   pr-description.txt            (PR body markdown)
 *
 * Run via: npm run sync
 *
 * ---------------------------------------------------------------------------
 * Internal flow
 * ---------------------------------------------------------------------------
 *
 * 1. diffSnapshots(baseline, snapshot)
 *    Walks every chain ID that appears in either version. For each chain it
 *    compares the following fields and classifies every observed difference:
 *
 *    Field                        Additive (immediate)     Reductive (needs threshold)
 *    -------------------------    --------------------     ---------------------------
 *    Chain presence               new chain added          chain removed
 *    rpc[]                        RPC added                RPC removed
 *    rpc[].traceSupport           traceSupport added       traceSupport changed/removed
 *    fetchContractCreationTxUsing key added                key removed, value changed
 *    etherscanApi                 etherscanApi added       etherscanApi removed
 *    discoveredBy[]               source added             source removed
 *
 *    RPCs are compared by provider (drpc / quicknode / override / public) via
 *    rpcMap(), which converts the rpc array into a Map<providerKey, RpcEntry>.
 *    This lets the diff detect per-provider additions and removals without
 *    caring about array position.
 *
 *    Returns:
 *      addDescriptions   — human-readable strings for immediately included changes
 *      reductiveChanges  — structured records, each with a stable string key
 *                          (e.g. "remove-rpc-1-drpc", "change-traceSupport-137-quicknode")
 *
 * 2. updateHistory(history, reductiveChanges, now)
 *    Merges the current run's reductive changes into the persisted history:
 *      - Change seen this run and already in history → increment consecutiveRuns
 *      - Change seen this run but not in history     → add with consecutiveRuns = 1
 *      - Change in history but NOT seen this run     → remove (flake recovered)
 *    A change is "stabilized" (ready to include) when consecutiveRuns >= THRESHOLD (5).
 *    Returns the list of stabilized change keys.
 *
 * 3. buildStabilizedOutput(snapshot, baseline, stabilized, pendingChanges)
 *    Starts from the raw snapshot (which reflects the latest generation run) and
 *    reverts any reductive change that has NOT yet stabilized back to its baseline
 *    value. In other words:
 *      output = snapshot, except for unstable reductive changes which use baseline values
 *    Stabilized changes are left as-is in the snapshot (they are intentionally included).
 *    The result is written back to sourcify-chains-default.json and is what gets
 *    committed in the chore/regenerate-chains PR.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const THRESHOLD = 5; // consecutive runs required before a reductive change is included

// ---------------------------------------------------------------------------
// Types (mirrors generate.ts output format)
// ---------------------------------------------------------------------------

export type RpcEntry =
  | string
  | {
      type: "BaseRPC" | "APIKeyRPC" | "FetchRequest";
      url: string;
      apiKeyEnvName?: string;
      subDomainEnvName?: string;
      traceSupport?: string;
      headers?: Array<{ headerName: string; headerEnvName?: string; headerValue?: string }>;
    };

export interface ChainEntry {
  sourcifyName: string;
  supported: boolean;
  discoveredBy: string[];
  etherscanApi?: { supported: boolean; apiKeyEnvName: string };
  fetchContractCreationTxUsing?: Record<string, unknown>;
  rpc?: RpcEntry[];
}

export type Snapshot = Record<string, ChainEntry>;

export type ChangeType =
  | "remove-chain"
  | "remove-rpc"
  | "change-traceSupport"
  | "remove-fetchUsing"
  | "change-fetchUsing"
  | "remove-etherscanApi"
  | "remove-discoveredBy";

export interface PendingChange {
  type: ChangeType;
  chainId: number;
  consecutiveRuns: number;
  firstSeenAt: string;
  lastSeenAt: string;
  // Optional fields depending on type
  provider?: string;    // for remove-rpc, change-traceSupport
  key?: string;         // for remove-fetchUsing
  from?: string | null; // for change-traceSupport: baseline traceSupport
  to?: string | null;   // for change-traceSupport: snapshot traceSupport
}

export interface ChangeHistory {
  lastRunAt: string;
  pendingChanges: Record<string, PendingChange>;
}

// ---------------------------------------------------------------------------
// RPC helpers
// ---------------------------------------------------------------------------

/** JSON.stringify with keys sorted recursively so key-order differences don't
 *  produce false positives when comparing fetchContractCreationTxUsing values. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return JSON.stringify(v);
  return (
    "{" +
    Object.keys(v as object)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + stableStringify((v as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}

/** Human-readable provider category for an RPC entry (used in descriptions). */
function rpcProvider(rpc: RpcEntry): string {
  if (typeof rpc === "string") return "public";
  if (rpc.type === "FetchRequest") return "override";
  if (rpc.apiKeyEnvName === "DRPC_API_KEY") return "drpc";
  if (rpc.apiKeyEnvName === "QUICKNODE_API_KEY") return "quicknode";
  return `unknown:${rpc.apiKeyEnvName ?? rpc.url}`;
}

/** Unique URL key for an RPC entry — used as the map key so multiple RPCs of
 *  the same provider category (e.g. two public string RPCs) are tracked
 *  individually rather than collapsing to the same slot. */
function rpcUrl(rpc: RpcEntry): string {
  return typeof rpc === "string" ? rpc : rpc.url;
}

/** Return the traceSupport value for an RPC entry (undefined if not set). */
function rpcTraceSupport(rpc: RpcEntry): string | undefined {
  if (typeof rpc === "string") return undefined;
  return rpc.traceSupport;
}

/** Build a map from URL → RPC entry for diffing. Keying by URL (not provider
 *  category) ensures multiple RPCs of the same category are each tracked. */
function rpcMap(rpcs: RpcEntry[] | undefined): Map<string, RpcEntry> {
  const m = new Map<string, RpcEntry>();
  for (const rpc of rpcs ?? []) {
    m.set(rpcUrl(rpc), rpc);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Diff logic
// ---------------------------------------------------------------------------

export interface AddressedChange {
  key: string;
  pending: Omit<PendingChange, "consecutiveRuns" | "firstSeenAt" | "lastSeenAt">;
}

/**
 * Diff snapshot vs baseline and return:
 *   addDescriptions: human-readable lines for additions (immediate)
 *   reductiveChanges: changes that need stability tracking
 */
export function diffSnapshots(
  baseline: Snapshot,
  snapshot: Snapshot,
): {
  addDescriptions: string[];
  reductiveChanges: AddressedChange[];
} {
  const addDescriptions: string[] = [];
  const reductiveChanges: AddressedChange[] = [];

  const allChainIds = new Set([...Object.keys(baseline), ...Object.keys(snapshot)]);

  for (const chainId of allChainIds) {
    const base = baseline[chainId];
    const snap = snapshot[chainId];
    const chainNum = parseInt(chainId, 10);
    const chainName = snap?.sourcifyName ?? base?.sourcifyName ?? `Chain ${chainId}`;

    if (!base && snap) {
      // New chain — additive
      addDescriptions.push(`Added chain ${chainId} (${chainName})`);
      continue;
    }

    if (base && !snap) {
      // Chain removed — reductive
      reductiveChanges.push({
        key: `remove-chain-${chainId}`,
        pending: { type: "remove-chain", chainId: chainNum },
      });
      continue;
    }

    // Both exist — diff fields
    const baseRpcs = rpcMap(base!.rpc);
    const snapRpcs = rpcMap(snap!.rpc);

    for (const [url, snapRpc] of snapRpcs) {
      const providerLabel = rpcProvider(snapRpc);
      if (!baseRpcs.has(url)) {
        addDescriptions.push(`Added ${providerLabel} RPC for chain ${chainId} (${chainName})`);
      } else {
        // Check traceSupport change
        const baseTrace = rpcTraceSupport(baseRpcs.get(url)!) ?? null;
        const snapTrace = rpcTraceSupport(snapRpc) ?? null;
        if (baseTrace !== snapTrace) {
          if (snapTrace && !baseTrace) {
            // traceSupport added — additive
            addDescriptions.push(
              `Added traceSupport (${snapTrace}) on ${providerLabel} RPC for chain ${chainId} (${chainName})`,
            );
          } else {
            // traceSupport changed or removed — reductive
            reductiveChanges.push({
              key: `change-traceSupport-${chainId}-${url}`,
              pending: {
                type: "change-traceSupport",
                chainId: chainNum,
                provider: url,
                from: baseTrace,
                to: snapTrace,
              },
            });
          }
        }
      }
    }

    for (const [url] of baseRpcs) {
      if (!snapRpcs.has(url)) {
        reductiveChanges.push({
          key: `remove-rpc-${chainId}-${url}`,
          pending: { type: "remove-rpc", chainId: chainNum, provider: url },
        });
      }
    }

    // fetchContractCreationTxUsing
    const baseFetch = base!.fetchContractCreationTxUsing ?? {};
    const snapFetch = snap!.fetchContractCreationTxUsing ?? {};

    for (const key of Object.keys(snapFetch)) {
      if (!(key in baseFetch)) {
        addDescriptions.push(`Added ${key} to fetchContractCreationTxUsing for chain ${chainId} (${chainName})`);
      } else if (stableStringify(baseFetch[key]) !== stableStringify(snapFetch[key])) {
        // Key exists in both but value changed — reductive
        reductiveChanges.push({
          key: `change-fetchUsing-${chainId}-${key}`,
          pending: { type: "change-fetchUsing", chainId: chainNum, key },
        });
      }
    }
    for (const key of Object.keys(baseFetch)) {
      if (!(key in snapFetch)) {
        reductiveChanges.push({
          key: `remove-fetchUsing-${chainId}-${key}`,
          pending: { type: "remove-fetchUsing", chainId: chainNum, key },
        });
      }
    }

    // discoveredBy
    const baseDiscovered = new Set(base!.discoveredBy ?? []);
    const snapDiscovered = new Set(snap!.discoveredBy ?? []);

    for (const source of snapDiscovered) {
      if (!baseDiscovered.has(source)) {
        addDescriptions.push(`Added ${source} to discoveredBy for chain ${chainId} (${chainName})`);
      }
    }
    for (const source of baseDiscovered) {
      if (!snapDiscovered.has(source)) {
        reductiveChanges.push({
          key: `remove-discoveredBy-${chainId}-${source}`,
          pending: { type: "remove-discoveredBy", chainId: chainNum, key: source },
        });
      }
    }

    // etherscanApi
    if (!base!.etherscanApi && snap!.etherscanApi) {
      addDescriptions.push(`Added etherscanApi for chain ${chainId} (${chainName})`);
    } else if (base!.etherscanApi && !snap!.etherscanApi) {
      reductiveChanges.push({
        key: `remove-etherscanApi-${chainId}`,
        pending: { type: "remove-etherscanApi", chainId: chainNum },
      });
    }
  }

  return { addDescriptions, reductiveChanges };
}

// ---------------------------------------------------------------------------
// History update
// ---------------------------------------------------------------------------

export function updateHistory(
  history: ChangeHistory,
  reductiveChanges: AddressedChange[],
  now: string,
): { updatedHistory: ChangeHistory; stabilized: string[]; pendingSummary: string[] } {
  const seenKeys = new Set(reductiveChanges.map((c) => c.key));
  const updated: ChangeHistory = { lastRunAt: now, pendingChanges: {} };
  const stabilized: string[] = [];
  const pendingSummary: string[] = [];

  // Increment existing pending entries that were observed this run
  for (const [key, existing] of Object.entries(history.pendingChanges)) {
    if (seenKeys.has(key)) {
      const newCount = existing.consecutiveRuns + 1;
      updated.pendingChanges[key] = { ...existing, consecutiveRuns: newCount, lastSeenAt: now };
    }
    // Keys not observed this run are dropped (counter resets)
  }

  // Add new pending entries
  for (const change of reductiveChanges) {
    if (!(change.key in updated.pendingChanges)) {
      updated.pendingChanges[change.key] = {
        ...change.pending,
        consecutiveRuns: 1,
        firstSeenAt: now,
        lastSeenAt: now,
      };
    }
  }

  // Classify: stabilized vs still-pending
  for (const [key, entry] of Object.entries(updated.pendingChanges)) {
    if (entry.consecutiveRuns >= THRESHOLD) {
      stabilized.push(key);
    } else {
      pendingSummary.push(`${key}: ${entry.consecutiveRuns}/${THRESHOLD} runs (since ${entry.firstSeenAt})`);
    }
  }

  return { updatedHistory: updated, stabilized, pendingSummary };
}

// ---------------------------------------------------------------------------
// Build stabilized output
// ---------------------------------------------------------------------------

/**
 * Start with the full snapshot (has all additions). For each pending reductive
 * change with count < THRESHOLD, revert that specific piece to the baseline value.
 */
export function buildStabilizedOutput(
  baseline: Snapshot,
  snapshot: Snapshot,
  pendingChanges: Record<string, PendingChange>,
): Snapshot {
  // Deep copy snapshot
  const output: Snapshot = JSON.parse(JSON.stringify(snapshot));

  for (const [, entry] of Object.entries(pendingChanges)) {
    if (entry.consecutiveRuns >= THRESHOLD) continue; // stabilized — keep snapshot value

    const chainId = entry.chainId.toString();

    if (entry.type === "remove-chain") {
      // Restore the chain from baseline
      if (baseline[chainId]) {
        output[chainId] = JSON.parse(JSON.stringify(baseline[chainId]));
      }
    } else if (entry.type === "remove-rpc" && entry.provider) {
      // Restore the specific RPC entry from baseline
      const baseRpc = rpcMap(baseline[chainId]?.rpc).get(entry.provider);
      if (baseRpc !== undefined && output[chainId]) {
        // Remove any existing entry for this provider from output, then re-add baseline
        output[chainId].rpc = (output[chainId].rpc ?? []).filter(
          (r) => rpcUrl(r) !== entry.provider,
        );
        output[chainId].rpc!.push(JSON.parse(JSON.stringify(baseRpc)));
        // Re-sort: override first, then drpc, then quicknode, then public
        output[chainId].rpc = sortRpcs(output[chainId].rpc!);
      }
    } else if (entry.type === "change-traceSupport" && entry.provider) {
      // Restore traceSupport on the matching RPC entry
      if (output[chainId]?.rpc) {
        for (const rpc of output[chainId].rpc!) {
          if (typeof rpc !== "string" && rpcUrl(rpc) === entry.provider) {
            if (entry.from) {
              (rpc as { traceSupport?: string }).traceSupport = entry.from;
            } else {
              delete (rpc as { traceSupport?: string }).traceSupport;
            }
          }
        }
      }
    } else if (entry.type === "remove-fetchUsing" && entry.key) {
      // Restore the fetchUsing key from baseline
      const baseVal = baseline[chainId]?.fetchContractCreationTxUsing?.[entry.key];
      if (baseVal !== undefined && output[chainId]) {
        if (!output[chainId].fetchContractCreationTxUsing) {
          output[chainId].fetchContractCreationTxUsing = {};
        }
        output[chainId].fetchContractCreationTxUsing![entry.key] = JSON.parse(JSON.stringify(baseVal));
      }
    } else if (entry.type === "remove-etherscanApi") {
      // Restore etherscanApi from baseline
      if (baseline[chainId]?.etherscanApi && output[chainId]) {
        output[chainId].etherscanApi = JSON.parse(JSON.stringify(baseline[chainId].etherscanApi));
      }
    } else if (entry.type === "change-fetchUsing" && entry.key) {
      // Restore the fetchUsing value from baseline
      const baseVal = baseline[chainId]?.fetchContractCreationTxUsing?.[entry.key];
      if (baseVal !== undefined && output[chainId]?.fetchContractCreationTxUsing) {
        output[chainId].fetchContractCreationTxUsing![entry.key] = JSON.parse(JSON.stringify(baseVal));
      }
    } else if (entry.type === "remove-discoveredBy" && entry.key) {
      // Restore the source to the discoveredBy array
      if (output[chainId] && !output[chainId].discoveredBy.includes(entry.key)) {
        output[chainId].discoveredBy = [...output[chainId].discoveredBy, entry.key];
      }
    }
  }

  // Normalize ordering for all chains: sort discoveredBy alphabetically, sort rpc by provider priority
  for (const entry of Object.values(output)) {
    if (entry.discoveredBy) {
      entry.discoveredBy = [...entry.discoveredBy].sort();
    }
    if (entry.rpc) {
      entry.rpc = sortRpcs(entry.rpc);
    }
  }

  // Sort by numeric chain ID
  const sorted: Snapshot = {};
  for (const key of Object.keys(output).sort((a, b) => parseInt(a) - parseInt(b))) {
    sorted[key] = output[key];
  }
  return sorted;
}

/** Sort RPC entries: override first, then drpc, then quicknode, then public. */
function sortRpcs(rpcs: RpcEntry[]): RpcEntry[] {
  const order: Record<string, number> = { override: 0, drpc: 1, quicknode: 2, public: 3 };
  return [...rpcs].sort((a, b) => {
    const pa = order[rpcProvider(a)] ?? 99;
    const pb = order[rpcProvider(b)] ?? 99;
    return pa - pb;
  });
}

// ---------------------------------------------------------------------------
// PR description
// ---------------------------------------------------------------------------

export interface ReappearedChain {
  chainId: number;
  name: string;
  seenIn: string[];
}

export interface NewEtherscanChain {
  chainId: number;
  name: string;
}

export function buildPrDescription(
  addDescriptions: string[],
  stabilized: string[],
  pendingSummary: string[],
  pendingChanges: Record<string, PendingChange>,
  reappearedDeprecated: ReappearedChain[] = [],
  newEtherscanChains: NewEtherscanChain[] = [],
): string {
  const lines: string[] = ["## Changes", ""];

  if (addDescriptions.length > 0) {
    lines.push("### Immediately included (new)");
    for (const desc of addDescriptions) lines.push(`- ${desc}`);
    lines.push("");
  }

  if (stabilized.length > 0) {
    lines.push(`### Included after stabilization (${THRESHOLD} consecutive runs)`);
    for (const key of stabilized) {
      const entry = pendingChanges[key];
      lines.push(`- ${key}: stable since ${entry.firstSeenAt}`);
    }
    lines.push("");
  }

  if (addDescriptions.length === 0 && stabilized.length === 0) {
    lines.push("_No ready changes in this run._");
    lines.push("");
  }

  if (pendingSummary.length > 0) {
    lines.push("### Pending (tracking, not yet included)");
    for (const summary of pendingSummary) lines.push(`- ${summary}`);
    lines.push("");
  }

  if (reappearedDeprecated.length > 0) {
    lines.push("### ⚠️ Deprecated chains reappeared in trusted sources");
    lines.push("These chains are in `deprecated-chains.json` but are now returned by API sources.");
    lines.push("Consider removing them from `deprecated-chains.json` if they are genuinely back.");
    for (const { chainId, name, seenIn } of reappearedDeprecated) {
      lines.push(`- #${chainId} ${name} — seen in: ${seenIn.join(", ")}`);
    }
    lines.push("");
  }

  if (newEtherscanChains.length > 0) {
    lines.push("### 🔑 New Etherscan chains require a dedicated API key");
    lines.push(
      "These chains were added with the generic `ETHERSCAN_API_KEY` fallback." +
        " Add a dedicated entry to `etherscan-api-keys.json`, the corresponding secret to GitHub Actions, and the GCP service.",
    );
    for (const { chainId, name } of newEtherscanChains) {
      lines.push(`- #${chainId} ${name}`);
    }
    lines.push("");
  }

  lines.push("🤖 Auto-generated by CI");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(): { baselinePath: string; historyPath: string } {
  const args = process.argv.slice(2);
  let baselinePath = "";
  let historyPath = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--baseline" && args[i + 1]) {
      baselinePath = args[++i];
    } else if (args[i] === "--history" && args[i + 1]) {
      historyPath = args[++i];
    }
  }

  if (!baselinePath) {
    console.error("Error: --baseline <file> is required");
    process.exit(1);
  }
  if (!historyPath) {
    console.error("Error: --history <file> is required");
    process.exit(1);
  }
  return { baselinePath, historyPath };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { baselinePath, historyPath } = parseArgs();
  const now = new Date().toISOString();

  const snapshotPath = path.join(REPO_ROOT, "sourcify-chains-default.json");
  const outputHistoryPath = path.join(REPO_ROOT, "change-history.json");
  const outputDescPath = path.join(REPO_ROOT, "pr-description.txt");
  const outputStatusPath = path.join(REPO_ROOT, "sync-status.json");

  // Load inputs
  const snapshot: Snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  const baseline: Snapshot = JSON.parse(fs.readFileSync(baselinePath, "utf8"));

  let history: ChangeHistory = { lastRunAt: "", pendingChanges: {} };
  if (fs.existsSync(historyPath) && historyPath !== "/dev/null") {
    try {
      history = JSON.parse(fs.readFileSync(historyPath, "utf8"));
    } catch {
      console.warn(`Warning: could not parse ${historyPath}, starting with empty history`);
    }
  }

  // Diff
  console.log("Diffing snapshot vs baseline...");
  const { addDescriptions, reductiveChanges } = diffSnapshots(baseline, snapshot);

  console.log(`  ${addDescriptions.length} additive change(s) — included immediately`);
  console.log(`  ${reductiveChanges.length} reductive/mutating change(s) — tracking with threshold ${THRESHOLD}`);

  // Update history
  const { updatedHistory, stabilized, pendingSummary } = updateHistory(history, reductiveChanges, now);

  console.log(`  ${stabilized.length} stabilized (>= ${THRESHOLD} consecutive runs) — included`);
  console.log(`  ${pendingSummary.length} pending (< ${THRESHOLD} runs) — held back`);

  // Build stabilized output
  const stabilizedOutput = buildStabilizedOutput(baseline, snapshot, updatedHistory.pendingChanges);

  // Auto-deprecate chains whose removal has stabilized
  const deprecatedPath = path.join(REPO_ROOT, "deprecated-chains.json");
  const deprecated: Record<string, string> = JSON.parse(fs.readFileSync(deprecatedPath, "utf8"));
  let newlyDeprecated = 0;
  for (const key of stabilized) {
    const entry = updatedHistory.pendingChanges[key];
    if (entry.type === "remove-chain") {
      const chainId = entry.chainId.toString();
      if (!(chainId in deprecated)) {
        deprecated[chainId] = baseline[chainId]?.sourcifyName ?? `Chain ${chainId}`;
        newlyDeprecated++;
      }
    }
  }
  if (newlyDeprecated > 0) {
    const sortedDeprecated = Object.fromEntries(
      Object.entries(deprecated).sort(([a], [b]) => Number(a) - Number(b)),
    );
    fs.writeFileSync(deprecatedPath, JSON.stringify(sortedDeprecated, null, 2) + "\n");
    console.log(`Updated deprecated-chains.json (+${newlyDeprecated} chain(s))`);
  }

  // Write outputs
  fs.writeFileSync(snapshotPath, JSON.stringify(stabilizedOutput, null, 2) + "\n");
  console.log(`Wrote stabilized sourcify-chains-default.json (${Object.keys(stabilizedOutput).length} chains)`);

  fs.writeFileSync(outputHistoryPath, JSON.stringify(updatedHistory, null, 2) + "\n");
  console.log(`Wrote change-history.json (${Object.keys(updatedHistory.pendingChanges).length} pending entries)`);

  const reappearedPath = path.join(REPO_ROOT, "deprecated-reappeared.json");
  const reappearedDeprecated: ReappearedChain[] = fs.existsSync(reappearedPath)
    ? (JSON.parse(fs.readFileSync(reappearedPath, "utf8")) as ReappearedChain[])
    : [];

  // Detect new chains that landed with the generic ETHERSCAN_API_KEY fallback
  const newEtherscanChains: NewEtherscanChain[] = [];
  for (const [chainId, chain] of Object.entries(stabilizedOutput)) {
    if (!(chainId in baseline) && chain.etherscanApi?.apiKeyEnvName === "ETHERSCAN_API_KEY") {
      newEtherscanChains.push({ chainId: Number(chainId), name: chain.sourcifyName });
    }
  }

  const prDesc = buildPrDescription(addDescriptions, stabilized, pendingSummary, updatedHistory.pendingChanges, reappearedDeprecated, newEtherscanChains);
  fs.writeFileSync(outputDescPath, prDesc);
  console.log(`Wrote pr-description.txt`);

  const hasReadyChanges = addDescriptions.length > 0 || stabilized.length > 0;
  fs.writeFileSync(outputStatusPath, JSON.stringify({ hasReadyChanges }, null, 2) + "\n");
  console.log(`Wrote sync-status.json (hasReadyChanges: ${hasReadyChanges})`);

  // Print pending summary for CI logs
  if (pendingSummary.length > 0) {
    console.log("\nPending changes (not included):");
    for (const s of pendingSummary) console.log(`  ${s}`);
  }
}

// Only run when invoked directly (not when imported by tests)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
