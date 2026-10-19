import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseQuickNodeResponse, buildQuickNodeRpcUrl } from "./quicknode.js";
import type { QuickNodeResponse } from "./quicknode.js";

// A trimmed-down /v0/chains response. QuickNode reports `chain_id: null` both
// for non-EVM networks (Solana) and for some EVM networks (Robinhood) — the
// shape that motivated the resolver.
const response: QuickNodeResponse = {
  error: null,
  data: [
    {
      slug: "ethereum",
      networks: [{ slug: "mainnet", name: "Ethereum Mainnet", chain_id: 1 }],
    },
    {
      slug: "robinhood",
      networks: [
        { slug: "robinhood-mainnet", name: "Robinhood Chain", chain_id: null },
        { slug: "robinhood-testnet", name: "Robinhood Chain Testnet", chain_id: null },
      ],
    },
    {
      slug: "solana",
      networks: [{ slug: "solana-mainnet", name: "Solana Mainnet", chain_id: null }],
    },
  ],
};

describe("parseQuickNodeResponse", () => {
  it("keeps networks with an explicit chain id and drops null ones without a resolver", async () => {
    const chains = await parseQuickNodeResponse(response);
    assert.deepEqual([...chains.keys()], [1]);
    assert.deepEqual(chains.get(1), { networkSlug: "mainnet", name: "Ethereum Mainnet" });
  });

  it("resolves null chain ids through the resolver and skips networks it rejects", async () => {
    const asked: string[] = [];
    const chains = await parseQuickNodeResponse(response, async (slug) => {
      asked.push(slug);
      if (slug === "robinhood-mainnet") return 4663;
      if (slug === "robinhood-testnet") return 46630;
      return null; // non-EVM
    });

    assert.deepEqual(asked.sort(), ["robinhood-mainnet", "robinhood-testnet", "solana-mainnet"]);
    assert.deepEqual([...chains.keys()].sort((a, b) => a - b), [1, 4663, 46630]);
    assert.deepEqual(chains.get(4663), { networkSlug: "robinhood-mainnet", name: "Robinhood Chain" });
    assert.deepEqual(chains.get(46630), { networkSlug: "robinhood-testnet", name: "Robinhood Chain Testnet" });
  });

  it("does not let a resolved chain id overwrite an explicit one", async () => {
    const chains = await parseQuickNodeResponse(response, async () => 1);
    assert.deepEqual([...chains.keys()], [1]);
    assert.equal(chains.get(1)?.networkSlug, "mainnet");
  });

  it("keeps the first network when two null-chain-id networks resolve to the same id", async () => {
    const chains = await parseQuickNodeResponse(response, async (slug) => (slug.startsWith("robinhood") ? 4663 : null));
    assert.equal(chains.get(4663)?.networkSlug, "robinhood-mainnet");
  });
});

describe("buildQuickNodeRpcUrl", () => {
  it("omits the slug for Ethereum mainnet", () => {
    assert.equal(buildQuickNodeRpcUrl("mainnet"), "https://{SUBDOMAIN}.quiknode.pro/{API_KEY}/");
  });

  it("adds the C-chain path for Avalanche/Flare subnets", () => {
    assert.equal(
      buildQuickNodeRpcUrl("avalanche-mainnet"),
      "https://{SUBDOMAIN}.avalanche-mainnet.quiknode.pro/{API_KEY}/ext/bc/C/rpc/",
    );
  });

  it("embeds the slug in the subdomain for every other network", () => {
    assert.equal(
      buildQuickNodeRpcUrl("robinhood-mainnet"),
      "https://{SUBDOMAIN}.robinhood-mainnet.quiknode.pro/{API_KEY}/",
    );
  });
});
