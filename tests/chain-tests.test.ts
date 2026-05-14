import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASE_URL,
  CONCURRENCY,
  CREATEX_ADDRESS,
  CREATEX_DEPLOYMENTS_URL,
  loadChains,
  MULTICALL3_ADDRESS,
  MULTICALL3_DEPLOYMENTS_URL,
  POLL_INTERVAL,
  toMatchLevel,
  verifyAndPoll,
} from "./helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TEST_TIME = parseInt(process.env.TEST_TIME ?? "60000");

const createXInput = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/createX.input.json"), "utf8"),
) as object;
const multicallInput = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/multicall.input.json"), "utf8"),
) as object;
const storageInput = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/storage.input.json"), "utf8"),
) as object;
const storageAddresses = JSON.parse(
  readFileSync(
    resolve(__dirname, "fixtures/storage-contract-chain-addresses.json"),
    "utf8",
  ),
) as Record<string, string>;
const testEtherscanContracts = JSON.parse(
  readFileSync(
    resolve(__dirname, "fixtures/etherscanInstanceContracts.json"),
    "utf8",
  ),
) as Record<string, unknown[]>;

interface ContractInput {
  address: string;
  stdJsonInput: object;
  compilerVersion: string;
  contractIdentifier: string;
}

const CREATEX_CONTRACT: Omit<ContractInput, "address"> = {
  stdJsonInput: createXInput,
  compilerVersion: "0.8.23+commit.f704f362",
  contractIdentifier: "src/CreateX.sol:CreateX",
};

const MULTICALL3_CONTRACT: Omit<ContractInput, "address"> = {
  stdJsonInput: multicallInput,
  compilerVersion: "0.8.12+commit.f00d7308",
  contractIdentifier: "Multicall3.sol:Multicall3",
};

const STORAGE_CONTRACT: Omit<ContractInput, "address"> = {
  stdJsonInput: storageInput,
  compilerVersion: "0.8.7+commit.e28d00a7",
  contractIdentifier: "contracts/1_Storage.sol:Storage",
};

let newAddedChainIds: string[] = [];
if (process.env.NEW_CHAIN_ID) {
  newAddedChainIds = process.env.NEW_CHAIN_ID.split(",");
}

const allChains = loadChains();
const chainsToTest = Object.entries(allChains)
  .filter(([id, chain]) => {
    if (!chain.supported) return false;
    if (id === "1337" || id === "31337") return false;
    if (newAddedChainIds.length && !newAddedChainIds.includes(id)) return false;
    return true;
  })
  .map(([id]) => id);

// Chains explicitly added via additional-chains.json or chain-overrides.json
// must have a test contract — there's no provider maintaining their liveness.
// Auto-discovered chains (quicknode/drpc/etherscan/blockscout) with no test
// contract are skipped rather than failed: their discovery source is assumed
// to keep them alive.
const REQUIRE_TEST_CONTRACT_SOURCES = ["additional-chains", "chain-overrides"];
function requiresTestContract(discoveredBy: string[] = []): boolean {
  return discoveredBy.some((s) => REQUIRE_TEST_CONTRACT_SOURCES.includes(s));
}

describe("Test Supported Chains", { timeout: TEST_TIME }, () => {
  const chainResults = new Map<string, unknown>();
  const chainErrors = new Map<string, string>();
  const noTestContract = new Set<string>();
  const skippedChains = new Set<string>();
  let createXChainIds: Set<string>;
  let multicall3ChainIds: Set<string>;

  before(async () => {
    const [createXRes, multicall3Res] = await Promise.all([
      fetch(CREATEX_DEPLOYMENTS_URL),
      fetch(MULTICALL3_DEPLOYMENTS_URL),
    ]);
    const createXDeployments = (await createXRes.json()) as {
      chainId: string;
    }[];
    const multicall3Deployments = (await multicall3Res.json()) as {
      chainId: string;
    }[];

    createXChainIds = new Set(createXDeployments.map((d) => d.chainId.toString()));
    multicall3ChainIds = new Set(
      multicall3Deployments.map((d) => d.chainId.toString()),
    );

    const pending = new Set<Promise<void>>();
    for (const chainId of chainsToTest) {
      const contract = pickTestContract(chainId);
      if (!contract) {
        // Decision (skip vs fail) is deferred to the per-chain test, which has
        // access to the chain's discoveredBy.
        noTestContract.add(chainId);
        continue;
      }
      const task = (async () => {
        try {
          const result = await verifyAndPoll(
            BASE_URL,
            chainId,
            contract.address,
            {
              stdJsonInput: contract.stdJsonInput,
              compilerVersion: contract.compilerVersion,
              contractIdentifier: contract.contractIdentifier,
            },
            {
              pollInterval: POLL_INTERVAL,
              maxPolls: Math.floor(TEST_TIME / POLL_INTERVAL),
            },
          );
          chainResults.set(chainId, result);
        } catch (err: unknown) {
          chainErrors.set(
            chainId,
            err instanceof Error ? err.message : String(err),
          );
        }
      })();

      const tracked = task.finally(() => {
        pending.delete(tracked);
      });
      pending.add(tracked);

      if (pending.size >= CONCURRENCY) {
        await Promise.race(pending);
      }
    }
    await Promise.all(pending);
  }, { timeout: 300_000 });

  let anyTestsPass = false;

  after(() => {
    if (!anyTestsPass && newAddedChainIds.length) {
      throw new Error(
        "There needs to be at least one passing test. Did you forget to add a test for your new chain with the id(s) " +
          newAddedChainIds.join(",") +
          "?",
      );
    }
  });

  const testedChains = new Set<string>();

  for (const chainId of chainsToTest) {
    if (newAddedChainIds.length && !newAddedChainIds.includes(chainId)) continue;

    const chainName = (allChains[chainId] as { sourcifyName?: string })
      ?.sourcifyName ?? chainId;

    it(`should verify a contract on ${chainName} (${chainId})`, (t) => {
      if (noTestContract.has(chainId)) {
        const discoveredBy = allChains[chainId]?.discoveredBy ?? [];
        if (requiresTestContract(discoveredBy)) {
          throw new Error(
            `No test contract found for chain ${chainName} (${chainId}). ` +
              `Chains added via additional-chains.json or chain-overrides.json must have a test contract.`,
          );
        }
        skippedChains.add(chainId);
        t.skip(
          `No test contract; liveness assumed maintained by discovery source [${discoveredBy.join(", ")}]`,
        );
        return;
      }

      const error = chainErrors.get(chainId);
      if (error) throw new Error(error);

      const result = chainResults.get(chainId) as {
        isJobCompleted: boolean;
        contract: { match: unknown };
        error?: { message: string };
      } | undefined;
      assert.ok(result, "No verification result found");
      assert.ok(result.isJobCompleted, "Verification timed out");
      assert.notEqual(
        result.contract?.match,
        null,
        result.error?.message ?? JSON.stringify(result),
      );

      anyTestsPass = true;
      testedChains.add(chainId);
    });
  }

  it("should have included Etherscan contracts for all testedChains having etherscanAPI", () => {
    const missingEtherscanTests: string[] = [];
    for (const chainId of chainsToTest) {
      if (!testedChains.has(chainId)) continue;
      const chain = allChains[chainId];
      if (
        chain?.etherscanApi &&
        (chain.etherscanApi as { supported?: boolean }).supported &&
        !Object.prototype.hasOwnProperty.call(testEtherscanContracts, chainId)
      ) {
        const name =
          (chain as { sourcifyName?: string }).sourcifyName ?? chainId;
        missingEtherscanTests.push(`${name} (${chainId})`);
      }
    }
    assert.equal(
      missingEtherscanTests.length,
      0,
      `There are missing Etherscan tests for chains: ${missingEtherscanTests.join(",\n")}`,
    );
  });

  it("should have tested all supported chains", { skip: newAddedChainIds.length > 0 }, () => {
    // A chain is covered if it was verified or legitimately skipped (no test
    // contract, and not from a source that requires one).
    const untestedChains = chainsToTest.filter(
      (id) => !testedChains.has(id) && !skippedChains.has(id),
    );
    assert.equal(
      untestedChains.length,
      0,
      `There are untested chains!: ${untestedChains
        .map((id) => {
          const name =
            (allChains[id] as { sourcifyName?: string }).sourcifyName ?? id;
          return `${name} (${id})`;
        })
        .join(",\n")}`,
    );
  });

  // Picks the test contract for a chain, or null if none is available.
  function pickTestContract(chainId: string): ContractInput | null {
    if (createXChainIds.has(chainId)) {
      return { address: CREATEX_ADDRESS, ...CREATEX_CONTRACT };
    }
    if (multicall3ChainIds.has(chainId)) {
      return { address: MULTICALL3_ADDRESS, ...MULTICALL3_CONTRACT };
    }
    if (storageAddresses[chainId] !== undefined) {
      return { address: storageAddresses[chainId], ...STORAGE_CONTRACT };
    }
    return null;
  }
});
