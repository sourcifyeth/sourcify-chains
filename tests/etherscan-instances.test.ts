import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASE_URL,
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

const testedChains: number[] = [];

for (const chainId in testContracts) {
  if (newAddedChainIds.length && !newAddedChainIds.includes(chainId)) continue;

  const chain = allChains[chainId];
  if (!chain?.supported) continue;
  if (!(chain.etherscanApi as { supported?: boolean } | undefined)?.supported) continue;

  testedChains.push(parseInt(chainId));

  const chainName =
    (chain as { sourcifyName?: string }).sourcifyName ?? `chain ${chainId}`;

  describe(`#${chainId} ${chainName}`, () => {
    for (const contract of testContracts[chainId]) {
      const expectedMatch = toMatchLevel(contract.expectedStatus);

      it(`should import a ${contract.type} contract from Etherscan for chain ${chainName} (${chainId}) and verify the contract, finding a ${expectedMatch}`, async () => {
        const result = await etherscanVerifyAndPoll(
          BASE_URL,
          chainId,
          contract.address,
        );

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
