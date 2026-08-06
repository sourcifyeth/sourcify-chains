import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDrpcChainName } from "./drpc.js";

describe("buildDrpcChainName", () => {
  it("joins the protocol label and the network id", () => {
    // The case that motivated this: chain 61900 is known only to dRPC.
    assert.equal(buildDrpcChainName("Mova", "Mainnet"), "Mova Mainnet");
    assert.equal(buildDrpcChainName("Polygon", "Amoy"), "Polygon Amoy");
  });

  it("does not repeat the label when the network id already starts with it", () => {
    assert.equal(buildDrpcChainName("megaETH", "MegaETH Testnet"), "MegaETH Testnet");
    assert.equal(buildDrpcChainName("Moonriver", "Moonriver"), "Moonriver");
    assert.equal(buildDrpcChainName("Ozean", "Ozean Poseidon Testnet"), "Ozean Poseidon Testnet");
  });

  it("capitalises an all-lowercase network id", () => {
    assert.equal(buildDrpcChainName("Ethereum Classic", "mainnet"), "Ethereum Classic Mainnet");
  });

  it("leaves mixed-case network ids alone", () => {
    assert.equal(buildDrpcChainName("Berachain", "bArtio"), "Berachain bArtio");
  });

  it("returns undefined without a label, and the label alone without a network id", () => {
    assert.equal(buildDrpcChainName(undefined, "Mainnet"), undefined);
    assert.equal(buildDrpcChainName("Mova", undefined), "Mova");
  });
});
