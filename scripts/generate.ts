/**
 * Chain configuration generation script.
 *
 * Fetches chain data from multiple provider and block explorer APIs,
 * merges with chain-overrides.json and additional-chains.json, and writes
 * sourcify-chains-default.json in the SourcifyChainExtension format.
 *
 * Run via: npm run generate
 *
 * Auto-supported chains = union of QuickNode + dRPC + Blockscout + Routescan.
 * Etherscan alone does not qualify a chain for inclusion (it's used for
 * etherscanApi and fetchContractCreationTxUsing configuration only).
 *
 * RPC priority for each chain:
 *   1. Manual override RPCs (from chain-overrides.json)
 *   2. QuickNode APIKeyRPC
 *   3. dRPC APIKeyRPC
 *   4. Public RPCs from chainid.network (non-template URLs only)
 */

import dotenv from "dotenv";
dotenv.config();

import { fetchQuickNodeChains } from "./providers/quicknode.js";
import type { QuickNodeChainData } from "./providers/quicknode.js";
import { fetchDrpcChains } from "./providers/drpc.js";
import { fetchEtherscanChains } from "./block-explorers/etherscan.js";
import { fetchBlockscoutChains } from "./block-explorers/blockscout.js";
import { fetchRoutescanChains } from "./block-explorers/routescan.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const CHAINID_NETWORK_URL = "https://chainid.network/chains.json";

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
  etherscanApi?: {
    supported: boolean;
    apiKeyEnvName: string;
  };
  fetchContractCreationTxUsing?: Record<string, unknown>;
  rpc?: Array<string | RpcEntry>;
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
  supported?: boolean;
  etherscanApiKeyEnvName?: string;
  fetchContractCreationTxUsing?: Record<string, unknown>;
  traceSupport?: string;
  rpc?: Array<string | RpcEntry>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FetchResult<T> = { name: string; data: Map<number, T> | null; error?: string };

async function safeFetch<T>(
  name: string,
  fetchFn: () => Promise<Map<number, T>>,
): Promise<FetchResult<T>> {
  try {
    const data = await fetchFn();
    console.log(`  ${name}: ${data.size} chains`);
    return { name, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  ${name}: FAILED — ${message}`);
    return { name, data: null, error: message };
  }
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
      rpc.startsWith("https://"),
  );
}

function buildQuickNodeRpc(
  qn: QuickNodeChainData,
  traceSupport?: string,
): RpcEntry {
  return {
    type: "APIKeyRPC",
    url: `https://{SUBDOMAIN}.${qn.networkSlug}.quiknode.pro/{API_KEY}/`,
    apiKeyEnvName: "QUICKNODE_API_KEY",
    subDomainEnvName: "QUICKNODE_SUBDOMAIN",
    ...(traceSupport ? { traceSupport } : {}),
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
  const quicknodeApiKey = process.env.QUICKNODE_CONSOLE_API_KEY;
  if (!quicknodeApiKey) {
    console.warn(
      "Warning: QUICKNODE_CONSOLE_API_KEY not set — QuickNode data will be skipped",
    );
  }

  console.log("Fetching chain list and provider/explorer data in parallel...");
  const [
    chainListResult,
    quicknodeResult,
    drpcResult,
    etherscanResult,
    blockscoutResult,
    routescanResult,
  ] = await Promise.all([
    safeFetch("chainid.network", fetchChainList),
    quicknodeApiKey
      ? safeFetch("QuickNode", () => fetchQuickNodeChains(quicknodeApiKey))
      : Promise.resolve<FetchResult<QuickNodeChainData>>({
          name: "QuickNode",
          data: null,
          error: "No API key",
        }),
    safeFetch("dRPC", fetchDrpcChains),
    safeFetch("Etherscan", fetchEtherscanChains),
    safeFetch("Blockscout", fetchBlockscoutChains),
    safeFetch("Routescan", fetchRoutescanChains),
  ]);

  const chainList = chainListResult.data;

  // Load source files
  const chainOverrides = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "chain-overrides.json"), "utf8"),
  ) as Record<string, ChainOverride>;

  const additionalChains = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "additional-chains.json"), "utf8"),
  ) as Record<string, SourcifyChainExtension>;

  const deprecatedChains = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "deprecated-chains.json"), "utf8"),
  ) as Record<string, string>;

  const deprecatedSet = new Set<number>(Object.keys(deprecatedChains).map(Number));

  // Auto-supported = union of QuickNode + dRPC + Blockscout + Routescan (not Etherscan alone)
  const autoChainIds = new Set<number>();
  for (const result of [quicknodeResult, drpcResult, blockscoutResult, routescanResult]) {
    if (result.data) {
      for (const chainId of result.data.keys()) {
        if (!deprecatedSet.has(chainId)) {
          autoChainIds.add(chainId);
        }
      }
    }
  }
  // Also include chains explicitly listed in chain-overrides.json (they may not be auto-discovered)
  for (const chainIdStr of Object.keys(chainOverrides)) {
    const chainId = parseInt(chainIdStr, 10);
    if (!deprecatedSet.has(chainId)) {
      autoChainIds.add(chainId);
    }
  }

  console.log(`\nBuilding output for ${autoChainIds.size} auto-discovered/override chains...`);

  const output: Record<string, SourcifyChainExtension> = {};

  for (const chainId of [...autoChainIds].sort((a, b) => a - b)) {
    const override = chainOverrides[chainId.toString()] as ChainOverride | undefined;
    const meta = chainList?.get(chainId);
    const qn = quicknodeResult.data?.get(chainId);
    const drpc = drpcResult.data?.get(chainId);
    const etherscan = etherscanResult.data?.get(chainId);
    const blockscout = blockscoutResult.data?.get(chainId);
    const routescan = routescanResult.data?.get(chainId);

    const sourcifyName =
      override?.sourcifyName ?? meta?.name ?? `Chain ${chainId}`;

    // Build RPC list
    const rpcs: Array<string | RpcEntry> = [];

    // 1. Manual override RPCs (priority — e.g. ethpandaops)
    if (override?.rpc?.length) {
      rpcs.push(...override.rpc);
    }

    // 2. QuickNode
    if (qn) {
      rpcs.push(buildQuickNodeRpc(qn, override?.traceSupport));
    }

    // 3. dRPC
    if (drpc) {
      rpcs.push(buildDrpcRpc(drpc.shortName));
    }

    // 4. Public RPCs from chainid.network (fallback)
    if (meta?.rpc?.length) {
      rpcs.push(...filterPublicRpcs(meta.rpc));
    }

    // Build etherscanApi
    const etherscanApi = etherscan
      ? {
          supported: true,
          apiKeyEnvName:
            override?.etherscanApiKeyEnvName ?? "ETHERSCAN_API_KEY",
        }
      : undefined;

    // Build fetchContractCreationTxUsing
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
      // routescan workspace is e.g. "mainnet", "testnet"
      fetchUsing["routescanApi"] = { type: routescan.workspace };
    }

    const entry: SourcifyChainExtension = {
      sourcifyName,
      supported: override?.supported ?? true,
      ...(Object.keys(fetchUsing).length > 0
        ? { fetchContractCreationTxUsing: fetchUsing }
        : {}),
      ...(etherscanApi ? { etherscanApi } : {}),
      ...(rpcs.length > 0 ? { rpc: rpcs } : {}),
    };

    output[chainId.toString()] = entry;
  }

  // Add additional-chains.json entries (full definitions, not auto-discovered)
  for (const [chainIdStr, entry] of Object.entries(additionalChains)) {
    if (!deprecatedSet.has(parseInt(chainIdStr, 10))) {
      output[chainIdStr] = entry;
    }
  }

  // Sort output by numeric chain ID
  const sorted: Record<string, SourcifyChainExtension> = {};
  for (const key of Object.keys(output).sort((a, b) => parseInt(a) - parseInt(b))) {
    sorted[key] = output[key];
  }

  const outputPath = path.join(REPO_ROOT, "sourcify-chains-default.json");
  fs.writeFileSync(outputPath, JSON.stringify(sorted, null, 2) + "\n");

  const total = Object.keys(sorted).length;
  const withRpc = Object.values(sorted).filter((e) => e.rpc && e.rpc.length > 0).length;
  const withEtherscan = Object.values(sorted).filter((e) => e.etherscanApi).length;
  const withFetchUsing = Object.values(sorted).filter(
    (e) => e.fetchContractCreationTxUsing && Object.keys(e.fetchContractCreationTxUsing).length > 0,
  ).length;

  console.log(`\nWrote ${outputPath}`);
  console.log(`  Total chains: ${total}`);
  console.log(`  With RPCs: ${withRpc}`);
  console.log(`  With Etherscan API: ${withEtherscan}`);
  console.log(`  With fetchContractCreationTxUsing: ${withFetchUsing}`);

  const failures = [chainListResult, quicknodeResult, drpcResult, etherscanResult, blockscoutResult, routescanResult]
    .filter((r) => r.data === null);
  if (failures.length > 0) {
    console.warn(`\nWarning: ${failures.length} source(s) failed:`);
    failures.forEach((f) => console.warn(`  - ${f.name}: ${f.error}`));
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
