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
 * Returns true for an explorer URL the server may talk to. The server sends
 * its Blockscout API key in the query string, so only HTTPS instances qualify.
 */
export function isUsableExplorerUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Parses the chains.blockscout.com payload. The response keys are chain IDs;
 * only purely numeric keys are accepted (some entries like "1__" have
 * suffixes). For each chain the first explorer with a usable HTTPS URL is
 * taken; chains without one are left out.
 */
export function parseBlockscoutChains(
  data: unknown,
): Map<number, BlockscoutChainData> {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Blockscout chains response is not an object");
  }
  const result = new Map<number, BlockscoutChainData>();

  for (const [chainIdStr, entry] of Object.entries(
    data as BlockscoutResponse,
  )) {
    if (!/^\d+$/.test(chainIdStr)) {
      continue;
    }
    const chainId = parseInt(chainIdStr, 10);

    const explorer = entry.explorers?.find((candidate) =>
      isUsableExplorerUrl(candidate?.url),
    );
    if (explorer) {
      result.set(chainId, {
        url: explorer.url,
        hostedBy: explorer.hostedBy,
        name: entry.name,
      });
    }
  }

  return result;
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

  const result = parseBlockscoutChains(await response.json());

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
