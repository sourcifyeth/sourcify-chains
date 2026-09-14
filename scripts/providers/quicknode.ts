export interface QuickNodeChainData {
  networkSlug: string;
  name: string;
}

interface QuickNodeNetwork {
  slug: string;
  name: string;
  chain_id: number | null;
}

interface QuickNodeChainGroup {
  slug: string;
  networks: QuickNodeNetwork[];
}

export interface QuickNodeResponse {
  data: QuickNodeChainGroup[];
  error: string | null;
}

/**
 * Resolves the chain id a QuickNode network slug serves by asking the RPC
 * (eth_chainId). Returns null when the endpoint does not answer eth_chainId
 * with a chain id — i.e. it is not an EVM chain.
 */
export type QuickNodeChainIdResolver = (networkSlug: string) => Promise<number | null>;

// QuickNode slugs that require an /ext/bc/C/rpc/ path suffix (Avalanche/Flare subnets)
const QUICKNODE_SUBNET_SLUGS = new Set(["avalanche-mainnet", "avalanche-testnet", "flare-mainnet", "flare-coston2"]);

/**
 * Builds the RPC URL template for a QuickNode network slug. `{SUBDOMAIN}` and
 * `{API_KEY}` are placeholders filled in by the Sourcify server (APIKeyRPC) or
 * by the generator when probing.
 */
export function buildQuickNodeRpcUrl(networkSlug: string): string {
  if (networkSlug === "mainnet") {
    // Ethereum mainnet: slug is not embedded in the subdomain
    return `https://{SUBDOMAIN}.quiknode.pro/{API_KEY}/`;
  }
  if (QUICKNODE_SUBNET_SLUGS.has(networkSlug)) {
    // Avalanche/Flare: require /ext/bc/C/rpc/ path suffix
    return `https://{SUBDOMAIN}.${networkSlug}.quiknode.pro/{API_KEY}/ext/bc/C/rpc/`;
  }
  return `https://{SUBDOMAIN}.${networkSlug}.quiknode.pro/{API_KEY}/`;
}

const RESOLVE_CONCURRENCY = 10;

/**
 * Turns a QuickNode /v0/chains response into a chain id → network map.
 *
 * The API returns `chain_id: null` for every non-EVM network (Solana, Bitcoin,
 * Sui, ...) but also for a number of EVM networks (Robinhood, Monad, Ink,
 * Soneium, ...). A null chain id alone therefore can't tell the two apart.
 * When a `resolveChainId` callback is given, every null-chain-id network is
 * asked for its chain id via eth_chainId; networks that answer are EVM chains
 * and are included, networks that don't are skipped as non-EVM. Without a
 * resolver (no RPC credentials) null-chain-id networks are skipped entirely.
 *
 * A chain id that the API reports explicitly always wins over a resolved one,
 * and among resolved networks the first one wins — a later duplicate can't
 * clobber an earlier mapping.
 */
export async function parseQuickNodeResponse(
  data: QuickNodeResponse,
  resolveChainId?: QuickNodeChainIdResolver,
  log: (msg: string) => void = () => {},
): Promise<Map<number, QuickNodeChainData>> {
  const result = new Map<number, QuickNodeChainData>();
  const unresolved: QuickNodeChainData[] = [];

  for (const chainGroup of data.data) {
    for (const network of chainGroup.networks) {
      const entry: QuickNodeChainData = { networkSlug: network.slug, name: network.name };
      if (network.chain_id !== null) {
        result.set(network.chain_id, entry);
      } else {
        unresolved.push(entry);
      }
    }
  }

  if (!resolveChainId || unresolved.length === 0) return result;

  log(`  QuickNode: resolving ${unresolved.length} network(s) with a null chain_id via eth_chainId...`);
  const resolved: Array<{ entry: QuickNodeChainData; chainId: number | null }> = new Array(unresolved.length);
  let next = 0;
  const worker = async () => {
    while (next < unresolved.length) {
      const i = next++;
      const entry = unresolved[i];
      resolved[i] = { entry, chainId: await resolveChainId(entry.networkSlug) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(RESOLVE_CONCURRENCY, unresolved.length) }, worker));

  let added = 0;
  let skipped = 0;
  for (const { entry, chainId } of resolved) {
    if (chainId === null) {
      skipped++;
      continue;
    }
    const existing = result.get(chainId);
    if (existing) {
      log(
        `  QuickNode: ${entry.networkSlug} resolved to chain ${chainId}, already mapped to ${existing.networkSlug} — keeping ${existing.networkSlug}`,
      );
      continue;
    }
    result.set(chainId, entry);
    added++;
    log(`  QuickNode: ${entry.networkSlug} → chain ${chainId} (${entry.name})`);
  }
  log(`  QuickNode: resolved ${added} EVM network(s), skipped ${skipped} non-EVM network(s)`);

  return result;
}

/**
 * Parses a locally cached QuickNode API response from a JSON file.
 */
export async function loadQuickNodeChainsFromFile(
  filePath: string,
  resolveChainId?: QuickNodeChainIdResolver,
): Promise<Map<number, QuickNodeChainData>> {
  const fs = await import("fs");
  const data = JSON.parse(
    fs.readFileSync(filePath, "utf8"),
  ) as QuickNodeResponse;
  if (data.error) {
    throw new Error(`QuickNode data error: ${data.error}`);
  }
  return parseQuickNodeResponse(data, resolveChainId);
}

/**
 * Fetches the list of EVM chains supported by QuickNode.
 * Requires a Console API key (different from an RPC endpoint token).
 * RPC URL template: https://{SUBDOMAIN}.{networkSlug}.quiknode.pro/{API_KEY}
 *
 * See parseQuickNodeResponse for how networks the API lists with a null
 * chain_id are handled via `resolveChainId`.
 */
export async function fetchQuickNodeChains(
  consoleApiKey: string,
  resolveChainId?: QuickNodeChainIdResolver,
  log: (msg: string) => void = () => {},
): Promise<Map<number, QuickNodeChainData>> {
  const response = await fetch("https://api.quicknode.com/v0/chains", {
    headers: {
      "x-api-key": consoleApiKey,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(
      `QuickNode API returned ${response.status}: ${await response.text()}`,
    );
  }

  const data = (await response.json()) as QuickNodeResponse;
  if (data.error) {
    throw new Error(`QuickNode API error: ${data.error}`);
  }

  return parseQuickNodeResponse(data, resolveChainId, log);
}
