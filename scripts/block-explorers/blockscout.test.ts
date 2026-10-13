import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseBlockscoutProApiChains } from "./blockscout.js";

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
