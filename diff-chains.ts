import { readFileSync } from "fs";
import { isDeepStrictEqual } from "util";

const newChains = JSON.parse(
  readFileSync("sourcify-chains-default.json", "utf-8")
);
const oldChains = JSON.parse(
  readFileSync("sourcify-chains-original.json", "utf-8")
);

const IGNORE_FIELDS = new Set(["discoveredBy"]);

const allIds = new Set([
  ...Object.keys(newChains),
  ...Object.keys(oldChains),
]);

// --- Helpers ---

/** Get a short label for an RPC entry */
function rpcLabel(rpc: any): string {
  if (typeof rpc === "string") return rpc;
  if (rpc?.type === "FetchRequest") return `FetchRequest(${rpc.url})`;
  if (rpc?.type === "APIKeyRPC") return `APIKeyRPC(${rpc.url})`;
  return JSON.stringify(rpc);
}

/** Normalize a URL by stripping trailing slashes */
function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Get a key that identifies an RPC entry for matching */
function rpcKey(rpc: any): string {
  if (typeof rpc === "string") return normalizeUrl(rpc);
  if (rpc?.url) return normalizeUrl(rpc.url);
  return JSON.stringify(rpc);
}

/** Deep-clone an RPC entry with its URL normalized */
function normalizeRpc(rpc: any): any {
  if (typeof rpc === "string") return normalizeUrl(rpc);
  if (rpc?.url) return { ...rpc, url: normalizeUrl(rpc.url) };
  return rpc;
}

/** Diff two RPC arrays, returning human-readable changes */
function diffRpcArrays(
  oldRpcs: any[],
  newRpcs: any[]
): { added: string[]; removed: string[]; changed: string[]; reordered: boolean } {
  const oldByKey = new Map(oldRpcs.map((r) => [rpcKey(r), r]));
  const newByKey = new Map(newRpcs.map((r) => [rpcKey(r), r]));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [key, val] of newByKey) {
    if (!oldByKey.has(key)) {
      added.push(rpcLabel(val));
    } else if (!isDeepStrictEqual(normalizeRpc(oldByKey.get(key)), normalizeRpc(val))) {
      changed.push(`${rpcLabel(val)} (modified)`);
    }
  }
  for (const [key, val] of oldByKey) {
    if (!newByKey.has(key)) {
      removed.push(rpcLabel(val));
    }
  }

  // Check reorder (same set, different order)
  const oldKeys = oldRpcs.map(rpcKey);
  const newKeys = newRpcs.map(rpcKey);
  const reordered =
    added.length === 0 &&
    removed.length === 0 &&
    changed.length === 0 &&
    !isDeepStrictEqual(oldKeys, newKeys);

  return { added, removed, changed, reordered };
}

/** Compact JSON representation */
function shortVal(v: unknown): string {
  if (v === undefined) return "(absent)";
  return JSON.stringify(v);
}

/** Deep diff for fetchContractCreationTxUsing */
function diffFetchUsing(
  oldVal: Record<string, any> | undefined,
  newVal: Record<string, any> | undefined
): string[] {
  if (!oldVal && !newVal) return [];
  if (!oldVal) return [`added: ${shortVal(newVal)}`];
  if (!newVal) return [`removed: ${shortVal(oldVal)}`];

  const allKeys = new Set([...Object.keys(oldVal), ...Object.keys(newVal)]);
  const changes: string[] = [];
  for (const k of allKeys) {
    if (isDeepStrictEqual(oldVal[k], newVal[k])) continue;
    if (oldVal[k] === undefined) {
      changes.push(`+${k}: ${shortVal(newVal[k])}`);
    } else if (newVal[k] === undefined) {
      changes.push(`-${k}: ${shortVal(oldVal[k])}`);
    } else {
      changes.push(`~${k}: ${shortVal(oldVal[k])} → ${shortVal(newVal[k])}`);
    }
  }
  return changes;
}

// --- Main ---

interface ChainDiff {
  chainId: string;
  name: string;
  status: "added" | "removed" | "changed";
  lines?: string[]; // human-readable change lines
}

const diffs: ChainDiff[] = [];

for (const id of [...allIds].sort((a, b) => Number(a) - Number(b))) {
  const oldChain = oldChains[id];
  const newChain = newChains[id];

  if (!oldChain) {
    diffs.push({ chainId: id, name: newChain.sourcifyName ?? "unknown", status: "added" });
    continue;
  }
  if (!newChain) {
    diffs.push({ chainId: id, name: oldChain.sourcifyName ?? "unknown", status: "removed" });
    continue;
  }

  const allFields = new Set([...Object.keys(oldChain), ...Object.keys(newChain)]);
  const lines: string[] = [];

  for (const field of allFields) {
    if (IGNORE_FIELDS.has(field)) continue;
    const oldVal = oldChain[field];
    const newVal = newChain[field];
    if (isDeepStrictEqual(oldVal, newVal)) continue;

    if (field === "rpc") {
      const rd = diffRpcArrays(oldVal ?? [], newVal ?? []);
      if (rd.added.length === 0 && rd.removed.length === 0 && rd.changed.length === 0 && !rd.reordered) continue;
      lines.push(`rpc:`);
      for (const a of rd.added) lines.push(`  + ${a}`);
      for (const r of rd.removed) lines.push(`  - ${r}`);
      for (const c of rd.changed) lines.push(`  ~ ${c}`);
      if (rd.reordered) lines.push(`  (reordered)`);
    } else if (field === "fetchContractCreationTxUsing") {
      const fc = diffFetchUsing(oldVal, newVal);
      if (fc.length === 0) continue;
      // Check if it's only key reordering with same values
      const oldSorted = oldVal ? Object.keys(oldVal).sort() : [];
      const newSorted = newVal ? Object.keys(newVal).sort() : [];
      if (
        isDeepStrictEqual(oldSorted, newSorted) &&
        oldSorted.every((k) => isDeepStrictEqual(oldVal[k], newVal[k]))
      ) {
        lines.push(`fetchContractCreationTxUsing: (key order changed)`);
      } else {
        lines.push(`fetchContractCreationTxUsing:`);
        for (const c of fc) lines.push(`  ${c}`);
      }
    } else if (field === "etherscanApi") {
      // Sub-diff
      const subChanges: string[] = [];
      const oa = oldVal ?? {};
      const na = newVal ?? {};
      const sk = new Set([...Object.keys(oa), ...Object.keys(na)]);
      for (const k of sk) {
        if (!isDeepStrictEqual(oa[k], na[k])) {
          subChanges.push(`${k}: ${shortVal(oa[k])} → ${shortVal(na[k])}`);
        }
      }
      if (subChanges.length) {
        lines.push(`etherscanApi:`);
        for (const s of subChanges) lines.push(`  ${s}`);
      }
    } else {
      lines.push(`${field}: ${shortVal(oldVal)} → ${shortVal(newVal)}`);
    }
  }

  if (lines.length > 0) {
    diffs.push({
      chainId: id,
      name: newChain.sourcifyName ?? oldChain.sourcifyName ?? "unknown",
      status: "changed",
      lines,
    });
  }
}

// --- Output ---

const added = diffs.filter((d) => d.status === "added");
const removed = diffs.filter((d) => d.status === "removed");
const changed = diffs.filter((d) => d.status === "changed");

console.log("=== Chain Diff: sourcify-chains-original → sourcify-chains-default ===\n");
console.log(
  `Summary: ${added.length} added, ${removed.length} removed, ${changed.length} changed (out of ${allIds.size} total)\n`
);

if (added.length) {
  console.log("--- NEW CHAINS ---");
  for (const d of added) console.log(`  + [${d.chainId}] ${d.name}`);
  console.log();
}

if (removed.length) {
  console.log("--- REMOVED CHAINS ---");
  for (const d of removed) console.log(`  - [${d.chainId}] ${d.name}`);
  console.log();
}

if (changed.length) {
  console.log("--- CHANGED CHAINS ---");
  for (const d of changed) {
    console.log(`\n  [${d.chainId}] ${d.name}`);
    for (const l of d.lines!) console.log(`    ${l}`);
  }
  console.log();
}

// --- Category summary ---
const categories = {
  nameChanged: changed.filter((d) => d.lines!.some((l) => l.startsWith("sourcifyName:"))),
  supportedChanged: changed.filter((d) => d.lines!.some((l) => l.startsWith("supported:"))),
  rpcChanged: changed.filter((d) => d.lines!.some((l) => l.startsWith("rpc:"))),
  rpcOnlyReordered: changed.filter(
    (d) => d.lines!.length === 1 && d.lines![0].includes("(reordered)")
  ),
  fetchUsingChanged: changed.filter((d) =>
    d.lines!.some((l) => l.startsWith("fetchContractCreationTxUsing:"))
  ),
  fetchUsingOnlyReorder: changed.filter(
    (d) =>
      d.lines!.some((l) => l.includes("(key order changed)")) &&
      d.lines!.filter((l) => !l.startsWith(" ")).length <=
        d.lines!.filter((l) => l.includes("(key order changed)") || l.includes("(reordered)"))
          .length
  ),
  etherscanChanged: changed.filter((d) => d.lines!.some((l) => l.startsWith("etherscanApi:"))),
};

console.log("--- CHANGE CATEGORIES ---");
console.log(`  Name changed:                   ${categories.nameChanged.length}`);
console.log(`  supported flag changed:          ${categories.supportedChanged.length}`);
console.log(`  RPC list changed:                ${categories.rpcChanged.length}`);
console.log(`  fetchContractCreationTxUsing:     ${categories.fetchUsingChanged.length}`);
console.log(`  etherscanApi changed:             ${categories.etherscanChanged.length}`);
