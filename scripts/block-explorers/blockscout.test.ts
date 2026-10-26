import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isUsableExplorerUrl,
  parseBlockscoutChains,
  parseBlockscoutProApiChains,
} from "./blockscout.js";

describe("parseBlockscoutProApiChains", () => {
  it("collects the numeric chain ID keys", () => {
    const chains = parseBlockscoutProApiChains({
      "1": "https://eth.blockscout.com",
      "8453": "https://base.blockscout.com",
    });
    assert.deepEqual([...chains].sort((a, b) => a - b), [1, 8453]);
  });

  it("ignores keys that are not chain IDs", () => {
    const chains = parseBlockscoutProApiChains({
      "1": "https://eth.blockscout.com",
      "1__": "https://eth-2.blockscout.com",
      "$schema": "x",
    });
    assert.deepEqual([...chains], [1]);
  });

  it("rejects a config that is not an object", () => {
    assert.throws(() => parseBlockscoutProApiChains(["1"]));
    assert.throws(() => parseBlockscoutProApiChains(null));
  });
});

describe("parseBlockscoutChains", () => {
  it("takes the first explorer with an HTTPS URL", () => {
    const chains = parseBlockscoutChains({
      "1": {
        name: "Ethereum",
        explorers: [{ url: "https://eth.blockscout.com", hostedBy: "blockscout" }],
      },
      "1__": {
        name: "Duplicate",
        explorers: [{ url: "https://dup.blockscout.com", hostedBy: "blockscout" }],
      },
      "7": {
        name: "Mixed",
        explorers: [
          { url: "http://plain.example", hostedBy: "self" },
          { url: "https://secure.example", hostedBy: "self" },
        ],
      },
    });
    assert.deepEqual(
      [...chains.entries()].sort(([a], [b]) => a - b),
      [
        [1, { url: "https://eth.blockscout.com", hostedBy: "blockscout", name: "Ethereum" }],
        [7, { url: "https://secure.example", hostedBy: "self", name: "Mixed" }],
      ],
    );
  });

  it("leaves out chains that only have plain HTTP explorers", () => {
    // The server puts its API key in the query string, so an HTTP instance
    // would receive it in cleartext (e.g. Arc Testnet, chain 5042002).
    const chains = parseBlockscoutChains({
      "5042002": {
        name: "Arc Testnet",
        explorers: [{ url: "http://explorer.testnet.arc.io", hostedBy: "self" }],
      },
      "8": { name: "No explorers", explorers: [] },
      "9": { name: "Broken url", explorers: [{ url: "not a url", hostedBy: "self" }] },
    });
    assert.equal(chains.size, 0);
  });

  it("rejects a payload that is not an object", () => {
    assert.throws(() => parseBlockscoutChains(null));
    assert.throws(() => parseBlockscoutChains([]));
  });
});

describe("isUsableExplorerUrl", () => {
  it("only accepts HTTPS URLs", () => {
    assert.equal(isUsableExplorerUrl("https://eth.blockscout.com"), true);
    assert.equal(isUsableExplorerUrl("http://eth.blockscout.com"), false);
    assert.equal(isUsableExplorerUrl("ftp://eth.blockscout.com"), false);
    assert.equal(isUsableExplorerUrl(""), false);
    assert.equal(isUsableExplorerUrl(undefined), false);
  });
});
