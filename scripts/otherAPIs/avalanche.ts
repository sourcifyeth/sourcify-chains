interface AvalancheChain {
  chainId: string;
}

interface AvalancheResponse {
  chains: AvalancheChain[];
}

const AVALANCHE_CHAINS_URL = "https://glacier-api.avax.network/v1/chains";

/**
 * Fetches the list of EVM chains supported by the Avalanche Glacier API.
 * Used to auto-set fetchContractCreationTxUsing.avalancheApi: true.
 */
export async function fetchAvalancheChains(): Promise<Set<number>> {
  const response = await fetch(AVALANCHE_CHAINS_URL);

  if (!response.ok) {
    throw new Error(
      `Avalanche API returned ${response.status}: ${await response.text()}`,
    );
  }

  const data = (await response.json()) as AvalancheResponse;
  const result = new Set<number>();

  for (const chain of data.chains) {
    const chainId = parseInt(chain.chainId, 10);
    if (!isNaN(chainId) && chainId > 0) {
      result.add(chainId);
    }
  }

  return result;
}
