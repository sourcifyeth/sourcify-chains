/**
 * Chain configuration generation script.
 *
 * Fetches chain data from multiple provider and block explorer APIs,
 * merges with chain-overrides.json and additional-chains.json, and writes
 * sourcify-chains-default.json in the SourcifyChainExtension format.
 *
 * Run via: npm run generate
 *
 * Auto-supported chains = union of QuickNode + dRPC + Etherscan +
 * Blockscout chains hosted by Blockscout (hostedBy === "blockscout").
 * Routescan and third-party Blockscout instances do not qualify a chain for
 * inclusion on their own (used for fetchContractCreationTxUsing only).
 *
 * RPC priority for each chain (cost-based):
 *   1. Manual override RPCs (from chain-overrides.json)
 *   2. dRPC APIKeyRPC — preferred due to lower cost
 *   3. QuickNode APIKeyRPC
 *   4. Public RPCs from chainid.network — only if none of the above exist
 */

import dotenv from "dotenv";
dotenv.config();

import { fetchQuickNodeChains } from "./providers/quicknode.js";
import type { QuickNodeChainData } from "./providers/quicknode.js";
import { fetchDrpcChains } from "./providers/drpc.js";
import type { DrpcChainData } from "./providers/drpc.js";
import { fetchAvalancheChains } from "./otherAPIs/avalanche.js";
import { fetchEtherscanChains } from "./block-explorers/etherscan.js";
import type { EtherscanChainData } from "./block-explorers/etherscan.js";
import { fetchBlockscoutChains } from "./block-explorers/blockscout.js";
import type { BlockscoutChainData } from "./block-explorers/blockscout.js";
import { fetchRoutescanChains } from "./block-explorers/routescan.js";
import type { RoutescanChainData } from "./block-explorers/routescan.js";
import { probeChain, withConcurrency, checkLiveness } from "./probe.js";
import type { TraceCacheValue, ProbeChainResult } from "./probe.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const CHAINID_NETWORK_URL = "https://chainid.network/chains.json";
const SOURCIFY_CONTRACTS_URL = "https://sourcify.dev/server/v2/contracts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChainEntry {
  name: string;
  chainId: number;
  shortName?: string;
  rpc: string[];
}

// The SourcifyChainExtension format written into sourcify-chains-default.json
interface SourcifyChainExtension {
  sourcifyName: string;
  supported: boolean;
  discoveredBy: string[];
  etherscanApi?: {
    supported: boolean;
    // Optional for custom Etherscan-compatible explorers that don't require an
    // API key (e.g. BattleChain); registry chains always carry the shared key.
    apiKeyEnvName?: string;
    // Custom base URL for Etherscan-compatible explorers not in the Etherscan
    // registry (e.g. https://block-explorer-api.testnet.battlechain.com).
    url?: string;
  };
  fetchContractCreationTxUsing?: Record<string, unknown>;
  rpc?: Array<string | RpcEntry>;
}

// Input type for additional-chains.json — only the chain name; supported/discoveredBy injected at output time
interface AdditionalChainEntry {
  sourcifyName: string;
}

interface RpcEntry {
  type: "BaseRPC" | "APIKeyRPC" | "FetchRequest";
  url: string;
  apiKeyEnvName?: string;
  subDomainEnvName?: string;
  traceSupport?: string;
  headers?: Array<{ headerName: string; headerEnvName?: string; headerValue?: string }>;
}

// chain-overrides.json entry (small — only override/extension fields)
interface ChainOverride {
  sourcifyName?: string;
  etherscanApi?: { supported: boolean; apiKeyEnvName?: string; url?: string };
  fetchContractCreationTxUsing?: Record<string, unknown>;
  rpc?: Array<string | RpcEntry>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 2000;

async function fetchWithRetry<T>(name: string, fetchFn: () => Promise<Map<number, T>>): Promise<Map<number, T>> {
  for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
    try {
      const data = await fetchFn();
      console.log(`  ${name}: ${data.size} chains`);
      return data;
    } catch (error) {
      const cause = error instanceof Error ? (error as Error & { cause?: Error }).cause : undefined;
      const message = error instanceof Error ? error.message : String(error);
      const detail = cause ? ` (${cause.message})` : "";
      if (attempt < RETRY_COUNT) {
        console.warn(`  ${name}: attempt ${attempt} failed — ${message}${detail}, retrying in ${RETRY_DELAY_MS}ms...`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      } else {
        throw new Error(`${name} failed after ${RETRY_COUNT} attempts: ${message}${detail}`);
      }
    }
  }
  throw new Error("unreachable");
}

async function fetchWithRetrySet(name: string, fetchFn: () => Promise<Set<number>>): Promise<Set<number>> {
  for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
    try {
      const data = await fetchFn();
      console.log(`  ${name}: ${data.size} chains`);
      return data;
    } catch (error) {
      const cause = error instanceof Error ? (error as Error & { cause?: Error }).cause : undefined;
      const message = error instanceof Error ? error.message : String(error);
      const detail = cause ? ` (${cause.message})` : "";
      if (attempt < RETRY_COUNT) {
        console.warn(`  ${name}: attempt ${attempt} failed — ${message}${detail}, retrying in ${RETRY_DELAY_MS}ms...`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      } else {
        throw new Error(`${name} failed after ${RETRY_COUNT} attempts: ${message}${detail}`);
      }
    }
  }
  throw new Error("unreachable");
}

async function fetchChainList(): Promise<Map<number, ChainEntry>> {
  const response = await fetch(CHAINID_NETWORK_URL);
  if (!response.ok) {
    throw new Error(`chainid.network returned ${response.status}`);
  }
  const chains = (await response.json()) as ChainEntry[];
  const map = new Map<number, ChainEntry>();
  for (const chain of chains) {
    map.set(chain.chainId, chain);
  }
  return map;
}

/** Filter public RPCs from chainid.network — drop API key templates like ${INFURA_API_KEY} */
function filterPublicRpcs(rpcs: string[]): string[] {
  return rpcs.filter(
    (rpc) =>
      !rpc.includes("${") &&
      !rpc.startsWith("wss://") && // prefer HTTP
      rpc.startsWith("https://")
  );
}

/**
 * Returns a directly liveness-probeable HTTPS URL for an RPC entry, or null if
 * it can't be probed without secrets — API-key/subdomain templates ({API_KEY},
 * {SUBDOMAIN}) or auth headers. Unprobeable entries are kept as-is.
 */
function getProbeableUrl(rpc: string | RpcEntry): string | null {
  if (typeof rpc === "string") return rpc.includes("{") ? null : rpc;
  if (rpc.apiKeyEnvName || rpc.subDomainEnvName || (rpc.headers && rpc.headers.length > 0)) {
    return null;
  }
  return rpc.url.includes("{") ? null : rpc.url;
}

/**
 * Checks whether a chain has any verified contracts on sourcify.dev. Used to
 * decide, for a chain left with no live RPC, between silent removal (no
 * contracts) and deprecation as supported:false (has contracts). On error,
 * returns true — deprecating is reversible, silent removal loses discoverability.
 */
async function chainHasVerifiedContracts(chainId: number): Promise<boolean> {
  try {
    const resp = await fetch(`${SOURCIFY_CONTRACTS_URL}/${chainId}?limit=1`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      console.warn(`  sourcify.dev contracts check for #${chainId} returned ${resp.status} — assuming deprecate`);
      return true;
    }
    const body = (await resp.json()) as { results?: unknown[] };
    return Array.isArray(body.results) && body.results.length > 0;
  } catch (e) {
    console.warn(
      `  sourcify.dev contracts check for #${chainId} failed (${e instanceof Error ? e.message : String(e)}) — assuming deprecate`
    );
    return true;
  }
}

// QuickNode slugs that require an /ext/bc/C/rpc/ path suffix (Avalanche/Flare subnets)
const QUICKNODE_SUBNET_SLUGS = new Set(["avalanche-mainnet", "avalanche-testnet", "flare-mainnet", "flare-coston2"]);

function buildQuickNodeRpc(qn: QuickNodeChainData): RpcEntry {
  let url: string;
  if (qn.networkSlug === "mainnet") {
    // Ethereum mainnet: slug is not embedded in the subdomain
    url = `https://{SUBDOMAIN}.quiknode.pro/{API_KEY}/`;
  } else if (QUICKNODE_SUBNET_SLUGS.has(qn.networkSlug)) {
    // Avalanche/Flare: require /ext/bc/C/rpc/ path suffix
    url = `https://{SUBDOMAIN}.${qn.networkSlug}.quiknode.pro/{API_KEY}/ext/bc/C/rpc/`;
  } else {
    url = `https://{SUBDOMAIN}.${qn.networkSlug}.quiknode.pro/{API_KEY}/`;
  }
  return {
    type: "APIKeyRPC",
    url,
    apiKeyEnvName: "QUICKNODE_API_KEY",
    subDomainEnvName: "QUICKNODE_SUBDOMAIN",
  };
}

function buildDrpcRpc(shortName: string): RpcEntry {
  return {
    type: "APIKeyRPC",
    url: `https://lb.drpc.org/ogrpc?network=${shortName}&dkey={API_KEY}`,
    apiKeyEnvName: "DRPC_API_KEY",
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // `--only <id1,id2,...>` (or `--only=<ids>`) restricts the run to the given
  // chain IDs, which must be defined in chain-overrides.json / additional-chains.json.
  // All external provider discovery (QuickNode, dRPC, Etherscan, Blockscout,
  // Routescan, Avalanche) is skipped — only chainid.network is used for public
  // RPCs/names — and the output contains ONLY those chains. Used by the
  // test-new-chain CI workflow to build a throwaway config for a brand-new
  // manual chain (which isn't in the committed file yet) without needing
  // provider secrets or a full discovery pass.
  const onlyArgIndex = process.argv.indexOf("--only");
  const onlyArgValue =
    process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length) ??
    (onlyArgIndex !== -1 ? process.argv[onlyArgIndex + 1] : undefined);
  const onlyIds = onlyArgValue
    ? new Set(
        onlyArgValue
          .split(",")
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => !Number.isNaN(n)),
      )
    : null;
  if (onlyArgValue !== undefined && (!onlyIds || onlyIds.size === 0)) {
    throw new Error("--only was given but no valid chain IDs were parsed");
  }
  if (onlyIds) {
    console.log(
      `--only mode: building config for chain(s) ${[...onlyIds].join(", ")} only — skipping provider discovery`,
    );
  }

  const quicknodeApiKey = process.env.QUICKNODE_CONSOLE_API_KEY;
  if (!onlyIds && !quicknodeApiKey) {
    console.warn("Warning: QUICKNODE_CONSOLE_API_KEY not set — QuickNode data will be skipped");
  }

  const quicknodeRpcKey = process.env.QUICKNODE_API_KEY;
  const quicknodeSubdomain = process.env.QUICKNODE_SUBDOMAIN;
  const drpcApiKey = process.env.DRPC_API_KEY;
  const canProbeQuickNode = !onlyIds && !!(quicknodeRpcKey && quicknodeSubdomain);
  const canProbeDrpc = !onlyIds && !!drpcApiKey;
  if (!onlyIds && !canProbeQuickNode && !canProbeDrpc) {
    console.warn(
      "Warning: QUICKNODE_API_KEY+QUICKNODE_SUBDOMAIN and DRPC_API_KEY not set — trace support probing will be skipped"
    );
  }

  // In --only mode every provider/explorer fetch is skipped; only chainid.network
  // is consulted. All other sources resolve to empty so the candidate-building
  // logic below falls back to the manual config in chain-overrides.json /
  // additional-chains.json.
  console.log(
    onlyIds
      ? "Fetching chainid.network only (--only mode)..."
      : "Fetching chain list and provider/explorer data in parallel...",
  );
  const [chainList, quicknodeChains, drpcChains, avalancheChains, etherscanChains, blockscoutChains, routescanChains] =
    await Promise.all([
      fetchWithRetry("chainid.network", fetchChainList),
      onlyIds || !quicknodeApiKey
        ? Promise.resolve<Map<number, QuickNodeChainData> | null>(null)
        : fetchWithRetry("QuickNode", () => fetchQuickNodeChains(quicknodeApiKey)),
      onlyIds ? Promise.resolve(new Map<number, DrpcChainData>()) : fetchWithRetry("dRPC", fetchDrpcChains),
      onlyIds ? Promise.resolve(new Set<number>()) : fetchWithRetrySet("Avalanche", fetchAvalancheChains),
      onlyIds ? Promise.resolve(new Map<number, EtherscanChainData>()) : fetchWithRetry("Etherscan", fetchEtherscanChains),
      onlyIds ? Promise.resolve(new Map<number, BlockscoutChainData>()) : fetchWithRetry("Blockscout", fetchBlockscoutChains),
      onlyIds ? Promise.resolve(new Map<number, RoutescanChainData>()) : fetchWithRetry("Routescan", fetchRoutescanChains),
    ]);

  // Load source files
  const chainOverrides = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "chain-overrides.json"), "utf8")) as Record<
    string,
    ChainOverride
  >;

  const additionalChains = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "additional-chains.json"), "utf8")
  ) as Record<string, AdditionalChainEntry>;

  const deprecatedChains = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "deprecated-chains.json"), "utf8")
  ) as Record<string, string>;

  const etherscanApiKeys = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "etherscan-api-keys.json"), "utf8")
  ) as Record<string, string>;

  const drpcIgnore = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "drpc-ignore.json"), "utf8")) as Record<
    string,
    string
  >;
  const drpcIgnoreSet = new Set<number>(Object.keys(drpcIgnore).map(Number));

  const txCachePath = path.join(REPO_ROOT, "tx-cache.json");
  const txCache: Record<string, string> = fs.existsSync(txCachePath)
    ? (JSON.parse(fs.readFileSync(txCachePath, "utf8")) as Record<string, string>)
    : {};

  const deprecatedSet = new Set<number>(Object.keys(deprecatedChains).map(Number));

  // Detect deprecated chains that have reappeared in trusted sources.
  // Skipped in --only mode: providers aren't fetched (nothing to compare), and
  // we don't want to clobber deprecated-reappeared.json.
  if (!onlyIds) {
    const reappearedDeprecated: { chainId: number; name: string; seenIn: string[] }[] = [];
    for (const [chainIdStr, name] of Object.entries(deprecatedChains)) {
      const chainId = Number(chainIdStr);
      const seenIn: string[] = [];
      if (quicknodeChains?.has(chainId)) seenIn.push("quicknode");
      if (drpcChains?.has(chainId)) seenIn.push("drpc");
      if (etherscanChains?.has(chainId)) seenIn.push("etherscan");
      if (blockscoutChains.get(chainId)?.hostedBy === "blockscout") seenIn.push("blockscout");
      if (seenIn.length > 0) reappearedDeprecated.push({ chainId, name, seenIn });
    }
    const reappearedPath = path.join(REPO_ROOT, "deprecated-reappeared.json");
    fs.writeFileSync(reappearedPath, JSON.stringify(reappearedDeprecated, null, 2) + "\n");
    if (reappearedDeprecated.length > 0) {
      console.warn(
        `\nWarning: ${reappearedDeprecated.length} deprecated chain(s) reappeared in trusted sources:`,
      );
      for (const { chainId, name, seenIn } of reappearedDeprecated) {
        console.warn(`  #${chainId} ${name} — seen in: ${seenIn.join(", ")}`);
      }
    }
  }

  // Auto-supported = union of QuickNode + dRPC + Etherscan +
  // Blockscout chains hosted by Blockscout (hostedBy === "blockscout").
  // Routescan and third-party Blockscout instances do not qualify for inclusion
  // on their own — they are only used for fetchContractCreationTxUsing.
  const autoChainIds = new Set<number>();
  for (const chains of [quicknodeChains, drpcChains, etherscanChains]) {
    if (chains) {
      for (const chainId of chains.keys()) {
        if (!deprecatedSet.has(chainId)) {
          autoChainIds.add(chainId);
        }
      }
    }
  }
  // Only Blockscout-hosted instances qualify
  for (const [chainId, entry] of blockscoutChains.entries()) {
    if (entry.hostedBy === "blockscout" && !deprecatedSet.has(chainId)) {
      autoChainIds.add(chainId);
    }
  }
  // Also include chains explicitly listed in chain-overrides.json (they may not be auto-discovered)
  for (const chainIdStr of Object.keys(chainOverrides)) {
    const chainId = parseInt(chainIdStr, 10);
    if (!deprecatedSet.has(chainId)) {
      autoChainIds.add(chainId);
    }
  }

  // --only: restrict to the requested chain IDs. They must be defined in
  // chain-overrides.json or additional-chains.json (the only manual sources).
  if (onlyIds) {
    const manuallyDefined = new Set<number>([
      ...Object.keys(chainOverrides).map(Number),
      ...Object.keys(additionalChains).map(Number),
    ]);
    const missing = [...onlyIds].filter((id) => !manuallyDefined.has(id));
    if (missing.length > 0) {
      throw new Error(
        `--only chain(s) ${missing.join(", ")} are not defined in chain-overrides.json or additional-chains.json`,
      );
    }
    for (const id of [...autoChainIds]) {
      if (!onlyIds.has(id)) autoChainIds.delete(id);
    }
  }

  // Probe every QuickNode and dRPC chain fresh each run.
  // Results are held in memory — no cache file.
  // QuickNode and dRPC are probed independently: they can expose different trace methods.
  // Values: TraceMethod (alive + trace), "none" (alive, no trace), null (not served/inactive)
  const qnResults = new Map<number, TraceCacheValue>();
  const drpcResults = new Map<number, TraceCacheValue>();

  interface ProbePair {
    chainId: number;
    probeUrl: string;
  }
  const qnProbePairs: ProbePair[] = [];
  const drpcProbePairs: ProbePair[] = [];

  if (canProbeQuickNode && quicknodeChains) {
    for (const [chainId, qn] of quicknodeChains) {
      const url = buildQuickNodeRpc(qn)
        .url.replace("{API_KEY}", quicknodeRpcKey!)
        .replace("{SUBDOMAIN}", quicknodeSubdomain!);
      qnProbePairs.push({ chainId, probeUrl: url });
    }
  }
  if (canProbeDrpc) {
    for (const [chainId, drpc] of drpcChains) {
      if (drpcIgnoreSet.has(chainId)) continue;
      const url = buildDrpcRpc(drpc.shortName).url.replace("{API_KEY}", drpcApiKey!);
      drpcProbePairs.push({ chainId, probeUrl: url });
    }
  }

  const totalToProbe = qnProbePairs.length + drpcProbePairs.length;
  const CHAIN_PROBE_TIMEOUT_MS = 45_000; // 45s per chain (accommodates retries)

  if (totalToProbe > 0) {
    console.log(
      `\nProbing ${qnProbePairs.length} QuickNode + ${drpcProbePairs.length} dRPC chains (concurrency=20, timeout=${
        CHAIN_PROBE_TIMEOUT_MS / 1000
      }s)...`
    );
    const makeTasks = (pairs: ProbePair[], results: Map<number, TraceCacheValue>, provider: "quicknode" | "drpc") =>
      pairs.map(({ chainId, probeUrl }) => async () => {
        const name = chainList.get(chainId)?.name ?? `Chain ${chainId}`;
        const lines: string[] = [];
        let didTimeout = false;
        const timeoutPromise = new Promise<null>((resolve) => {
          const t = setTimeout(() => {
            didTimeout = true;
            resolve(null);
          }, CHAIN_PROBE_TIMEOUT_MS);
          t.unref(); // don't keep the process alive if everything else is done
        });
        const probeResult: ProbeChainResult | null = await Promise.race([
          probeChain(probeUrl, (msg) => lines.push(msg), txCache[chainId.toString()]),
          timeoutPromise,
        ]);
        // Print header + all buffered lines atomically (prevents interleaved output)
        const traceValue = probeResult?.trace ?? null;
        const label = didTimeout ? `null (timed out after ${CHAIN_PROBE_TIMEOUT_MS / 1000}s)` : String(traceValue);
        console.log(`\n[${provider}] #${chainId} ${name} → ${label}`);
        for (const line of lines) console.log(line);
        results.set(chainId, traceValue);
        if (probeResult?.txHash) txCache[chainId.toString()] = probeResult.txHash;
      });

    await withConcurrency(
      [...makeTasks(qnProbePairs, qnResults, "quicknode"), ...makeTasks(drpcProbePairs, drpcResults, "drpc")],
      20
    );
    console.log(`  Done probing.`);
    fs.writeFileSync(txCachePath, JSON.stringify(txCache, null, 2) + "\n");
    console.log(`  Updated tx-cache.json (${Object.keys(txCache).length} cached tx hashes).`);
  }

  console.log(`\nBuilding output for ${autoChainIds.size} auto-discovered/override chains...`);

  // An ordered RPC slot: either kept as-is (API-key RPCs already probed during
  // the QN/dRPC pass, or auth override RPCs) or pending a liveness probe.
  type RpcSlot =
    | { kind: "keep"; value: string | RpcEntry }
    | { kind: "probe"; url: string; value: string | RpcEntry };

  interface Candidate {
    chainId: number;
    sourcifyName: string;
    discoveredBy: string[];
    etherscanApi?: { supported: boolean; apiKeyEnvName?: string; url?: string };
    fetchUsing: Record<string, unknown>;
    rpcSlots: RpcSlot[]; // override + dRPC + QN, in priority order
    publicCandidates: string[]; // chainid.network public RPCs, used only as fallback
  }

  // ---- Pass 1: build candidates (RPC list not yet finalized) ----
  const candidates: Candidate[] = [];
  const candidateIds = new Set<number>();

  for (const chainId of [...autoChainIds].sort((a, b) => a - b)) {
    const override = chainOverrides[chainId.toString()] as ChainOverride | undefined;
    const meta = chainList.get(chainId);
    const qn = quicknodeChains?.get(chainId);
    const drpc = drpcChains.get(chainId);
    const etherscan = etherscanChains.get(chainId);
    const blockscout = blockscoutChains.get(chainId);
    const routescan = routescanChains.get(chainId);

    // A provider only qualifies as a discovery source if it's not dead.
    // Absent from results (keys not probed — e.g. no API keys) is treated as alive.
    const qnProbed = qnResults.get(chainId);
    const drpcProbed = drpcResults.get(chainId);
    const qnQualifies = !!qn && qnProbed !== null;
    const drpcQualifies = !!drpc && drpcProbed !== null && !drpcIgnoreSet.has(chainId);

    // Skip chains where every discovery source is dead or absent
    const hasActiveSource =
      qnQualifies || drpcQualifies || !!etherscan || blockscout?.hostedBy === "blockscout" || !!override;
    if (!hasActiveSource) continue;

    const sourcifyName =
      override?.sourcifyName ??
      etherscan?.chainName ??
      blockscout?.name ??
      meta?.name ??
      `Chain ${chainId}`;

    const rpcSlots: RpcSlot[] = [];

    // 1. Manual override RPCs (priority — e.g. ethpandaops). Simple ones (plain
    //    URL, no auth) are liveness-probed; API-key/header ones are kept as-is.
    if (override?.rpc?.length) {
      for (const rpc of override.rpc) {
        const url = getProbeableUrl(rpc);
        rpcSlots.push(url ? { kind: "probe", url, value: rpc } : { kind: "keep", value: rpc });
      }
    }

    // 2. dRPC — only if alive; set traceSupport if a method was detected
    if (drpcQualifies) {
      const rpc = buildDrpcRpc(drpc!.shortName);
      if (drpcProbed === "trace_transaction" || drpcProbed === "debug_traceTransaction") {
        rpc.traceSupport = drpcProbed;
      }
      rpcSlots.push({ kind: "keep", value: rpc });
    }

    // 3. QuickNode — only if alive; set traceSupport if a method was detected
    if (qnQualifies) {
      const rpc = buildQuickNodeRpc(qn!);
      if (qnProbed === "trace_transaction" || qnProbed === "debug_traceTransaction") {
        rpc.traceSupport = qnProbed;
      }
      rpcSlots.push({ kind: "keep", value: rpc });
    }

    // 4. Public RPCs from chainid.network — fallback, consulted only if nothing
    //    above survives liveness probing. Skipped when a "keep" slot exists
    //    (those never drop, so the fallback would never be reached).
    const hasKeepSlot = rpcSlots.some((s) => s.kind === "keep");
    const publicCandidates = !hasKeepSlot && meta?.rpc?.length ? filterPublicRpcs(meta.rpc) : [];

    // Etherscan support comes from the Etherscan registry, or from a
    // chain-overrides opt-in (`etherscanApi.supported`) for Etherscan-compatible
    // explorers not in the registry — those carry a custom `url`.
    // Registry chains always use the shared Etherscan API key. Custom explorers
    // take an optional `apiKeyEnvName` from the override; if absent, the support
    // is generated without an API key (many, e.g. BattleChain, don't need one).
    let etherscanApi:
      | { supported: boolean; apiKeyEnvName?: string; url?: string }
      | undefined;
    if (etherscan) {
      etherscanApi = {
        supported: true,
        apiKeyEnvName: etherscanApiKeys[chainId.toString()] ?? "ETHERSCAN_API_KEY",
        ...(override?.etherscanApi?.url ? { url: override.etherscanApi.url } : {}),
      };
    } else if (override?.etherscanApi?.supported) {
      etherscanApi = {
        supported: true,
        ...(override.etherscanApi.apiKeyEnvName
          ? { apiKeyEnvName: override.etherscanApi.apiKeyEnvName }
          : {}),
        ...(override.etherscanApi.url ? { url: override.etherscanApi.url } : {}),
      };
    }

    const fetchUsing: Record<string, unknown> = {
      ...(override?.fetchContractCreationTxUsing ?? {}),
    };
    if (etherscan && !fetchUsing["etherscanApi"]) {
      fetchUsing["etherscanApi"] = true;
    }
    if (blockscout?.hostedBy === "blockscout" && !fetchUsing["blockscoutApi"]) {
      fetchUsing["blockscoutApi"] = { url: blockscout.url };
    }
    if (routescan && !fetchUsing["routescanApi"]) {
      fetchUsing["routescanApi"] = { type: routescan.type };
    }
    if (avalancheChains.has(chainId) && !fetchUsing["avalancheApi"]) {
      fetchUsing["avalancheApi"] = true;
    }

    const discoveredBy: string[] = [];
    if (qnQualifies) discoveredBy.push("quicknode");
    if (drpcQualifies) discoveredBy.push("drpc");
    if (etherscan) discoveredBy.push("etherscan");
    if (blockscout?.hostedBy === "blockscout") discoveredBy.push("blockscout");
    if (override) discoveredBy.push("chain-overrides");

    candidates.push({ chainId, sourcifyName, discoveredBy, etherscanApi, fetchUsing, rpcSlots, publicCandidates });
    candidateIds.add(chainId);
  }

  // additional-chains.json — not auto-discovered, only public RPCs from chainid.network
  const additionalOverlapErrors: string[] = [];
  for (const [chainIdStr, entry] of Object.entries(additionalChains)) {
    const chainId = parseInt(chainIdStr, 10);
    if (onlyIds && !onlyIds.has(chainId)) continue;
    if (deprecatedSet.has(chainId)) {
      throw new Error(
        `Chain ${entry.sourcifyName} #${chainIdStr} appears in both additional-chains.json and deprecated-chains.json`
      );
    }
    if (candidateIds.has(chainId)) {
      const existing = candidates.find((c) => c.chainId === chainId)!;
      additionalOverlapErrors.push(
        `  #${chainIdStr} ${entry.sourcifyName} (discoveredBy: [${existing.discoveredBy.join(", ")}])`
      );
      continue;
    }
    const meta = chainList.get(chainId);
    const publicCandidates = meta?.rpc?.length ? filterPublicRpcs(meta.rpc) : [];
    candidates.push({
      chainId,
      sourcifyName: entry.sourcifyName,
      discoveredBy: ["additional-chains"],
      fetchUsing: {},
      rpcSlots: [],
      publicCandidates,
    });
    candidateIds.add(chainId);
  }
  if (additionalOverlapErrors.length > 0) {
    throw new Error(
      `The following chains appear in both additional-chains.json and are auto-discovered. Remove them from additional-chains.json:\n${additionalOverlapErrors.join(
        "\n"
      )}`
    );
  }

  // ---- Liveness-probe every simple-override and public RPC URL concurrently ----
  const livenessUrls = new Set<string>();
  for (const c of candidates) {
    for (const slot of c.rpcSlots) {
      if (slot.kind === "probe") livenessUrls.add(slot.url);
    }
    for (const url of c.publicCandidates) livenessUrls.add(url);
  }

  const livenessResults = new Map<string, boolean>();
  if (livenessUrls.size > 0) {
    console.log(`\nLiveness-probing ${livenessUrls.size} public/override RPC URLs (concurrency=20)...`);
    const urlList = [...livenessUrls];
    await withConcurrency(
      urlList.map((url) => async () => {
        const alive = (await checkLiveness(url)) !== null;
        livenessResults.set(url, alive);
        if (!alive) console.log(`  [dead] ${url}`);
      }),
      20
    );
    const aliveCount = [...livenessResults.values()].filter(Boolean).length;
    console.log(`  Done: ${aliveCount}/${livenessUrls.size} alive.`);
  }

  // ---- Pass 2: finalize RPC lists; collect chains left with none ----
  const output: Record<string, SourcifyChainExtension> = {};
  const noRpcChains: Candidate[] = [];

  for (const c of candidates) {
    const rpcs: Array<string | RpcEntry> = [];
    for (const slot of c.rpcSlots) {
      if (slot.kind === "keep") rpcs.push(slot.value);
      else if (livenessResults.get(slot.url)) rpcs.push(slot.value);
    }
    // Public RPC fallback — only when nothing above survived
    if (rpcs.length === 0) {
      for (const url of c.publicCandidates) {
        if (livenessResults.get(url)) rpcs.push(url);
      }
    }

    if (rpcs.length === 0) {
      noRpcChains.push(c);
      continue;
    }

    output[c.chainId.toString()] = {
      sourcifyName: c.sourcifyName,
      supported: true,
      discoveredBy: c.discoveredBy,
      ...(Object.keys(c.fetchUsing).length > 0 ? { fetchContractCreationTxUsing: c.fetchUsing } : {}),
      ...(c.etherscanApi ? { etherscanApi: c.etherscanApi } : {}),
      rpc: rpcs,
    };
  }

  // ---- Deprecate-or-remove: chains left with no live RPC ----
  // If sourcify.dev already has verified contracts for the chain, keep it as
  // supported:false (deprecated) so those stay discoverable. Otherwise drop it
  // entirely — sync.ts stabilizes the removal over consecutive runs.
  if (noRpcChains.length > 0) {
    console.log(
      `\n${noRpcChains.length} chain(s) have no live RPC — checking sourcify.dev for verified contracts...`
    );
    await withConcurrency(
      noRpcChains.map((c) => async () => {
        const hasContracts = await chainHasVerifiedContracts(c.chainId);
        if (hasContracts) {
          console.log(
            `  [deprecate] #${c.chainId} ${c.sourcifyName} — has verified contracts, keeping as supported:false`
          );
          output[c.chainId.toString()] = {
            sourcifyName: c.sourcifyName,
            supported: false,
            discoveredBy: c.discoveredBy,
          };
        } else {
          console.log(`  [remove] #${c.chainId} ${c.sourcifyName} — no verified contracts, dropping`);
        }
      }),
      10
    );
  }

  // Add deprecated chains as supported: false (skipped in --only mode, which
  // emits only the requested chains)
  if (!onlyIds) {
    for (const [chainIdStr, name] of Object.entries(deprecatedChains)) {
      if (output[chainIdStr]) continue; // already in output (shouldn't happen, but be safe)
      output[chainIdStr] = {
        sourcifyName: name,
        supported: false,
        discoveredBy: ["deprecated"],
      };
    }
  }

  // Sort output by numeric chain ID
  const sorted: Record<string, SourcifyChainExtension> = {};
  for (const key of Object.keys(output).sort((a, b) => parseInt(a) - parseInt(b))) {
    sorted[key] = output[key];
  }

  const outputPath = path.join(REPO_ROOT, "sourcify-chains-default.json");
  fs.writeFileSync(outputPath, JSON.stringify(sorted, null, 2) + "\n");
  if (onlyIds) {
    console.warn(
      "\n⚠️  --only mode: sourcify-chains-default.json now contains ONLY the requested chain(s). " +
        "This is a throwaway build for testing — do NOT commit it.",
    );
  }

  const total = Object.keys(sorted).length;
  const withRpc = Object.values(sorted).filter((e) => e.rpc && e.rpc.length > 0).length;
  const withEtherscan = Object.values(sorted).filter((e) => e.etherscanApi).length;
  const withFetchUsing = Object.values(sorted).filter(
    (e) => e.fetchContractCreationTxUsing && Object.keys(e.fetchContractCreationTxUsing).length > 0
  ).length;

  console.log(`\nWrote ${outputPath}`);
  console.log(`  Total chains: ${total}`);
  console.log(`  With RPCs: ${withRpc}`);
  console.log(`  With Etherscan API: ${withEtherscan}`);
  console.log(`  With fetchContractCreationTxUsing: ${withFetchUsing}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
