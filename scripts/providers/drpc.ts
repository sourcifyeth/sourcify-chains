export interface DrpcChainData {
  shortName: string;
}

interface DrpcNetwork {
  network: string;
  blockchain_type: string;
  chain_id: string;
}

interface DrpcApiResponse {
  data: {
    dataMap: Record<string, { networks: DrpcNetwork[] }>;
  };
}

const DRPC_CHAINS_URL = "https://drpc.org/api/blockchains-list";

/**
 * Fetches the list of EVM chains supported by dRPC.
 * RPC URL: https://lb.drpc.org/ogrpc?network={shortName}&dkey={API_KEY}
 */
export async function fetchDrpcChains(): Promise<Map<number, DrpcChainData>> {
  const response = await fetch(DRPC_CHAINS_URL, {
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(
      `dRPC chains API returned ${response.status}: ${await response.text()}`,
    );
  }

  const json = (await response.json()) as DrpcApiResponse;
  const result = new Map<number, DrpcChainData>();

  for (const blockchain of Object.values(json.data.dataMap)) {
    for (const network of blockchain.networks) {
      if (network.blockchain_type !== "eth") continue;

      const chainId = parseInt(network.chain_id, 16);
      if (!chainId || isNaN(chainId)) continue;

      result.set(chainId, { shortName: network.network });
    }
  }

  return result;
}
