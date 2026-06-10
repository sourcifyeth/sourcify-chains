import YAML from "yaml";

export interface DrpcChainData {
  shortName: string;
}

// chains.yaml shape (only the fields we consume).
interface DrpcYamlChain {
  "chain-id"?: string | number;
  "short-names"?: string[];
}

interface DrpcYamlProtocol {
  type?: string;
  chains?: DrpcYamlChain[];
}

interface DrpcYaml {
  "chain-settings"?: {
    protocols?: DrpcYamlProtocol[];
  };
}

// dRPC's old JSON endpoint (drpc.org/api/blockchains-list) was retired and now
// 404s. dRPC support points consumers at this maintained config file instead.
const DRPC_CHAINS_URL =
  "https://raw.githubusercontent.com/drpcorg/public/main/chains.yaml";

/**
 * Parse a chains.yaml `chain-id` value to a decimal chain id.
 *
 * The YAML parser auto-converts hex literals (e.g. `0xa`) to numbers, so the
 * value usually arrives already decoded. When it's still a string we parse it
 * as hex (all chain-id values in the file are `0x`-prefixed).
 */
function parseChainId(raw: string | number | undefined): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : null;
  if (typeof raw !== "string") return null;
  const id = parseInt(raw, 16);
  return Number.isNaN(id) || id <= 0 ? null : id;
}

/**
 * Fetches the list of EVM chains supported by dRPC from their public
 * chains.yaml config.
 *
 * Each chain exposes a `short-names` array; the first entry is the canonical
 * network slug used in the RPC URL:
 *   https://lb.drpc.org/ogrpc?network={shortName}&dkey={API_KEY}
 *
 * Only `type: eth` protocols are kept. When the same chain id appears more than
 * once (the file has at least one such collision), the first occurrence wins so
 * a mislabelled later entry can't clobber the canonical chain.
 */
export async function fetchDrpcChains(): Promise<Map<number, DrpcChainData>> {
  const response = await fetch(DRPC_CHAINS_URL, {
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(
      `dRPC chains.yaml returned ${response.status}: ${await response.text()}`,
    );
  }

  const doc = YAML.parse(await response.text()) as DrpcYaml;
  const protocols = doc?.["chain-settings"]?.protocols ?? [];
  const result = new Map<number, DrpcChainData>();

  for (const protocol of protocols) {
    if (protocol.type !== "eth") continue;
    for (const chain of protocol.chains ?? []) {
      const chainId = parseChainId(chain["chain-id"]);
      if (chainId === null) continue;

      const shortName = chain["short-names"]?.[0];
      if (!shortName) continue;

      // First occurrence wins — don't let a later mislabelled entry overwrite.
      if (!result.has(chainId)) {
        result.set(chainId, { shortName });
      }
    }
  }

  return result;
}
