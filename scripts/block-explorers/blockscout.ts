export interface BlockscoutChainData {
  url: string;
  hostedBy: string;
  name: string;
}

interface BlockscoutExplorer {
  url: string;
  hostedBy: string;
}

interface BlockscoutChainEntry {
  name: string;
  explorers: BlockscoutExplorer[];
}

type BlockscoutResponse = Record<string, BlockscoutChainEntry>;

const BLOCKSCOUT_CHAINS_URL = "https://chains.blockscout.com/api/chains";

/**
 * Rewrites a plain-HTTP explorer URL to HTTPS. The server sends its Blockscout
 * API key in the query string, so it must never talk to an instance over HTTP.
 */
export function forceHttps(url: string): string {
  return url.replace(/^http:\/\//i, "https://");
}

/**
 * Fetches the list of chains with Blockscout explorers.
 * The response keys are chain IDs.
 */
export async function fetchBlockscoutChains(): Promise<
  Map<number, BlockscoutChainData>
> {
  const response = await fetch(BLOCKSCOUT_CHAINS_URL, {
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(
      `Blockscout chains API returned ${response.status}: ${await response.text()}`,
    );
  }

  const data = (await response.json()) as BlockscoutResponse;
  const result = new Map<number, BlockscoutChainData>();

  for (const [chainIdStr, entry] of Object.entries(data)) {
    // Only accept purely numeric keys (some entries like "1__" have suffixes)
    if (!/^\d+$/.test(chainIdStr)) {
      continue;
    }
    const chainId = parseInt(chainIdStr, 10);

    // Use the first explorer URL
    const explorer = entry.explorers?.[0];
    if (explorer?.url) {
      result.set(chainId, {
        url: forceHttps(explorer.url),
        hostedBy: explorer.hostedBy,
        name: entry.name,
      });
    }
  }

  console.log(`Blockscout: ${result.size} chains, ${Array.from(result.values()).filter(c => c.hostedBy === "blockscout").length} hosted by Blockscout`);

  return result;
}

// Chains served by the Blockscout PRO API gateway (api.blockscout.com).
// This is the source the PRO API docs load their supported-chains list from.
const BLOCKSCOUT_PRO_API_CHAINS_URL =
  "https://raw.githubusercontent.com/blockscout/backend-configs/main/pro-api/prod/chains-config.json";

/**
 * Parses the PRO API chains config. The config maps chain IDs to instance
 * URLs. Only numeric keys are accepted.
 */
export function parseBlockscoutProApiChains(data: unknown): Set<number> {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Blockscout PRO API chains config is not an object");
  }
  const result = new Set<number>();
  for (const chainIdStr of Object.keys(data)) {
    if (/^\d+$/.test(chainIdStr)) {
      result.add(parseInt(chainIdStr, 10));
    }
  }
  return result;
}

/**
 * Fetches the set of chain IDs supported by the Blockscout PRO API.
 * Not every Blockscout-hosted instance is in this set.
 */
export async function fetchBlockscoutProApiChains(): Promise<Set<number>> {
  const response = await fetch(BLOCKSCOUT_PRO_API_CHAINS_URL, {
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(
      `Blockscout PRO API chains config returned ${response.status}: ${await response.text()}`,
    );
  }

  return parseBlockscoutProApiChains(await response.json());
}
