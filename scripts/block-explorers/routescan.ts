export interface RoutescanChainData {
  type: "mainnet" | "testnet";
}

interface VanityUrlItem {
  chainId: string;
  url: string;
}

interface VanityUrlResponse {
  items: VanityUrlItem[];
}

interface BlockchainItem {
  chainId: string;
}

interface BlockchainsResponse {
  items: BlockchainItem[];
}

const VANITY_URLS_URL = "https://cdn.routescan.io/api/vanity-urls";
const MAINNET_BLOCKCHAINS_URL =
  "https://api.routescan.io/v2/network/mainnet/evm/all/blockchains";
const TESTNET_BLOCKCHAINS_URL =
  "https://api.routescan.io/v2/network/testnet/evm/all/blockchains";

/**
 * Fetches the list of chains with Routescan explorers, together with their
 * network type (mainnet / testnet).
 *
 * - Chain set comes from the vanity-urls endpoint (all chains with a Routescan
 *   explorer).
 * - Network type is determined by cross-referencing the Routescan mainnet and
 *   testnet blockchain lists. Chains not found in either list are omitted
 *   because without a type we cannot construct the correct API URL.
 *
 * Throws if any of the three requests fail.
 */
export async function fetchRoutescanChains(): Promise<
  Map<number, RoutescanChainData>
> {
  const [vanityRes, mainnetRes, testnetRes] = await Promise.all([
    fetch(VANITY_URLS_URL, { signal: AbortSignal.timeout(15_000) }),
    fetch(MAINNET_BLOCKCHAINS_URL, { signal: AbortSignal.timeout(15_000) }),
    fetch(TESTNET_BLOCKCHAINS_URL, { signal: AbortSignal.timeout(15_000) }),
  ]);

  if (!vanityRes.ok) {
    throw new Error(
      `Routescan vanity-urls API returned ${vanityRes.status}: ${await vanityRes.text()}`,
    );
  }
  if (!mainnetRes.ok) {
    throw new Error(
      `Routescan mainnet blockchains API returned ${mainnetRes.status}: ${await mainnetRes.text()}`,
    );
  }
  if (!testnetRes.ok) {
    throw new Error(
      `Routescan testnet blockchains API returned ${testnetRes.status}: ${await testnetRes.text()}`,
    );
  }

  const vanityData = (await vanityRes.json()) as VanityUrlResponse;
  const mainnetData = (await mainnetRes.json()) as BlockchainsResponse;
  const testnetData = (await testnetRes.json()) as BlockchainsResponse;

  // Build type lookup: mainnet takes precedence if a chain appears in both lists
  const typeMap = new Map<number, "mainnet" | "testnet">();
  for (const item of testnetData.items) {
    const id = parseInt(item.chainId, 10);
    if (!isNaN(id)) typeMap.set(id, "testnet");
  }
  for (const item of mainnetData.items) {
    const id = parseInt(item.chainId, 10);
    if (!isNaN(id)) typeMap.set(id, "mainnet");
  }

  // Build result from the vanity-urls chain set
  const result = new Map<number, RoutescanChainData>();
  for (const item of vanityData.items) {
    const chainId = parseInt(item.chainId, 10);
    if (isNaN(chainId)) continue;

    const type = typeMap.get(chainId);
    if (!type) {
      // Cannot determine network type → skip this chain
      continue;
    }

    if (!result.has(chainId)) {
      result.set(chainId, { type });
    }
  }

  return result;
}
