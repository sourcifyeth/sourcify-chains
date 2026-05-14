import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASE_URL,
  CONCURRENCY,
  etherscanVerifyAndPoll,
  loadChains,
  toMatchLevel,
} from "./helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const testContracts = JSON.parse(
  readFileSync(
    resolve(__dirname, "fixtures/etherscanInstanceContracts.json"),
    "utf8",
  ),
) as Record<string, { address: string; type: string; expectedStatus: string }[]>;

const allChains = loadChains();

let newAddedChainIds: string[] = [];
if (process.env.NEW_CHAIN_ID) {
  newAddedChainIds = process.env.NEW_CHAIN_ID.split(",");
}

// Etherscan allows 5 req/s per API key. Each POST /v2/verify/etherscan makes
// exactly one Etherscan call (getsourcecode) before returning; the polling
// afterwards only hits the Sourcify server. Spacing verification starts
// >= 250ms apart keeps the server's Etherscan usage at ~4 req/s.
const ETHERSCAN_MIN_START_INTERVAL_MS = 250;
let nextStartSlot = 0;
async function rateLimitedStart(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextStartSlot);
  nextStartSlot = slot + ETHERSCAN_MIN_START_INTERVAL_MS;
  if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
}

interface TestContract {
  address: string;
  type: string;
  expectedStatus: string;
}

const chainsToTest: {
  chainId: string;
  chainName: string;
  contracts: TestContract[];
}[] = [];
const testedChains: number[] = [];

for (const chainId in testContracts) {
  if (newAddedChainIds.length && !newAddedChainIds.includes(chainId)) continue;

  const chain = allChains[chainId];
  if (!chain?.supported) continue;
  if (!(chain.etherscanApi as { supported?: boolean } | undefined)?.supported)
    continue;

  testedChains.push(parseInt(chainId));
  const chainName =
    (chain as { sourcifyName?: string }).sourcifyName ?? `chain ${chainId}`;
  chainsToTest.push({ chainId, chainName, contracts: testContracts[chainId] });
}

const resultKey = (chainId: string, address: string) => `${chainId}:${address}`;

describe("Etherscan instance imports", () => {
  const results = new Map<
    string,
    Awaited<ReturnType<typeof etherscanVerifyAndPoll>>
  >();
  const errors = new Map<string, string>();

  before(
    async () => {
      const tasks: { chainId: string; contract: TestContract }[] = [];
      for (const { chainId, contracts } of chainsToTest) {
        for (const contract of contracts) tasks.push({ chainId, contract });
      }

      const pending = new Set<Promise<void>>();
      for (const { chainId, contract } of tasks) {
        const task = (async () => {
          const key = resultKey(chainId, contract.address);
          try {
            await rateLimitedStart();
            const result = await etherscanVerifyAndPoll(
              BASE_URL,
              chainId,
              contract.address,
            );
            results.set(key, result);
          } catch (err: unknown) {
            errors.set(
              key,
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
    },
    { timeout: 600_000 },
  );

  for (const { chainId, chainName, contracts } of chainsToTest) {
    describe(`#${chainId} ${chainName}`, () => {
      for (const contract of contracts) {
        const expectedMatch = toMatchLevel(contract.expectedStatus);

        it(`should import a ${contract.type} contract from Etherscan for chain ${chainName} (${chainId}) and verify the contract, finding a ${expectedMatch}`, () => {
          const key = resultKey(chainId, contract.address);
          const error = errors.get(key);
          if (error) throw new Error(error);

          const result = results.get(key);
          assert.ok(result, "No verification result found");
          assert.ok(result.isJobCompleted, "Verification job did not complete");
          const contractResult = result.contract as
            | { match: string | null }
            | undefined;
          assert.notEqual(contractResult?.match, null, JSON.stringify(result));
          assert.equal(contractResult?.match, expectedMatch);
        });
      }
    });
  }
});

describe("Double check that all supported chains are tested", () => {
  it("should have tested all supported chains", { skip: newAddedChainIds.length > 0 }, () => {
    const supportedEtherscanChains = Object.entries(allChains)
      .filter(([, chain]) => {
        return (
          chain.supported &&
          (chain.etherscanApi as { supported?: boolean } | undefined)?.supported
        );
      })
      .map(([id]) => parseInt(id));

    const untestedChains = supportedEtherscanChains.filter(
      (id) => !testedChains.includes(id),
    );

    assert.equal(
      untestedChains.length,
      0,
      `There are untested supported chains!: ${untestedChains
        .map((id) => {
          const name =
            (allChains[id.toString()] as { sourcifyName?: string })
              ?.sourcifyName ?? id.toString();
          return `${name} (${id})`;
        })
        .join(", ")}`,
    );
  });
});
