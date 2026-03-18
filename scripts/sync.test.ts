import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  diffSnapshots,
  updateHistory,
  buildStabilizedOutput,
  buildPrDescription,
  type Snapshot,
  type ChangeHistory,
  type PendingChange,
} from "./sync.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DRPC_RPC = {
  type: "APIKeyRPC" as const,
  url: "https://lb.drpc.org/ogrpc?network=ethereum&dkey={API_KEY}",
  apiKeyEnvName: "DRPC_API_KEY",
};

const DRPC_RPC_WITH_TRACE = { ...DRPC_RPC, traceSupport: "trace_transaction" };

const QN_RPC = {
  type: "APIKeyRPC" as const,
  url: "https://{SUBDOMAIN}.quiknode.pro/{API_KEY}/",
  apiKeyEnvName: "QUICKNODE_API_KEY",
  subDomainEnvName: "QUICKNODE_SUBDOMAIN",
};

const QN_RPC_WITH_TRACE = { ...QN_RPC, traceSupport: "trace_transaction" };

function chain(overrides: Partial<Snapshot[string]> = {}): Snapshot[string] {
  return {
    sourcifyName: "Test Chain",
    supported: true,
    discoveredBy: ["drpc"],
    ...overrides,
  };
}

function emptyHistory(): ChangeHistory {
  return { lastRunAt: "", pendingChanges: {} };
}

function historyWithEntry(
  key: string,
  entry: Partial<PendingChange> & { type: PendingChange["type"]; chainId: number },
  consecutiveRuns = 1,
): ChangeHistory {
  return {
    lastRunAt: "2026-01-01T00:00:00Z",
    pendingChanges: {
      [key]: {
        consecutiveRuns,
        firstSeenAt: "2026-01-01T00:00:00Z",
        lastSeenAt: "2026-01-01T00:00:00Z",
        ...entry,
      },
    },
  };
}

const NOW = "2026-03-18T10:00:00Z";

// ---------------------------------------------------------------------------
// diffSnapshots
// ---------------------------------------------------------------------------

describe("diffSnapshots", () => {
  it("no changes → empty results", () => {
    const snap: Snapshot = { "1": chain({ rpc: [DRPC_RPC] }) };
    const { addDescriptions, reductiveChanges } = diffSnapshots(snap, snap);
    assert.equal(addDescriptions.length, 0);
    assert.equal(reductiveChanges.length, 0);
  });

  it("new chain → additive", () => {
    const baseline: Snapshot = {};
    const snapshot: Snapshot = { "100": chain() };
    const { addDescriptions, reductiveChanges } = diffSnapshots(baseline, snapshot);
    assert.equal(addDescriptions.length, 1);
    assert.ok(addDescriptions[0].includes("Added chain 100"));
    assert.equal(reductiveChanges.length, 0);
  });

  it("chain removed → reductive remove-chain", () => {
    const baseline: Snapshot = { "1": chain() };
    const snapshot: Snapshot = {};
    const { addDescriptions, reductiveChanges } = diffSnapshots(baseline, snapshot);
    assert.equal(addDescriptions.length, 0);
    assert.equal(reductiveChanges.length, 1);
    assert.equal(reductiveChanges[0].key, "remove-chain-1");
    assert.equal(reductiveChanges[0].pending.type, "remove-chain");
  });

  it("new drpc RPC added → additive", () => {
    const baseline: Snapshot = { "1": chain({ rpc: [QN_RPC] }) };
    const snapshot: Snapshot = { "1": chain({ rpc: [QN_RPC, DRPC_RPC] }) };
    const { addDescriptions, reductiveChanges } = diffSnapshots(baseline, snapshot);
    assert.equal(reductiveChanges.length, 0);
    assert.ok(addDescriptions.some((d) => d.includes("Added drpc RPC")));
  });

  it("drpc RPC removed → reductive remove-rpc", () => {
    const baseline: Snapshot = { "1": chain({ rpc: [DRPC_RPC, QN_RPC] }) };
    const snapshot: Snapshot = { "1": chain({ rpc: [QN_RPC] }) };
    const { addDescriptions, reductiveChanges } = diffSnapshots(baseline, snapshot);
    assert.equal(addDescriptions.length, 0);
    assert.equal(reductiveChanges.length, 1);
    assert.equal(reductiveChanges[0].key, "remove-rpc-1-drpc");
    assert.equal(reductiveChanges[0].pending.type, "remove-rpc");
    assert.equal(reductiveChanges[0].pending.provider, "drpc");
  });

  it("traceSupport added (null → value) → additive", () => {
    const baseline: Snapshot = { "1": chain({ rpc: [DRPC_RPC] }) };
    const snapshot: Snapshot = { "1": chain({ rpc: [DRPC_RPC_WITH_TRACE] }) };
    const { addDescriptions, reductiveChanges } = diffSnapshots(baseline, snapshot);
    assert.equal(reductiveChanges.length, 0);
    assert.ok(addDescriptions.some((d) => d.includes("traceSupport")));
  });

  it("traceSupport removed (value → null) → reductive change-traceSupport", () => {
    const baseline: Snapshot = { "1": chain({ rpc: [DRPC_RPC_WITH_TRACE] }) };
    const snapshot: Snapshot = { "1": chain({ rpc: [DRPC_RPC] }) };
    const { addDescriptions, reductiveChanges } = diffSnapshots(baseline, snapshot);
    assert.equal(addDescriptions.length, 0);
    assert.equal(reductiveChanges.length, 1);
    assert.equal(reductiveChanges[0].key, "change-traceSupport-1-drpc");
    assert.equal(reductiveChanges[0].pending.type, "change-traceSupport");
    assert.equal(reductiveChanges[0].pending.from, "trace_transaction");
    assert.equal(reductiveChanges[0].pending.to, null);
  });

  it("traceSupport changed (one method to another) → reductive change-traceSupport", () => {
    const rpcDebug = { ...DRPC_RPC, traceSupport: "debug_traceTransaction" };
    const baseline: Snapshot = { "1": chain({ rpc: [DRPC_RPC_WITH_TRACE] }) };
    const snapshot: Snapshot = { "1": chain({ rpc: [rpcDebug] }) };
    const { reductiveChanges } = diffSnapshots(baseline, snapshot);
    assert.equal(reductiveChanges.length, 1);
    assert.equal(reductiveChanges[0].pending.from, "trace_transaction");
    assert.equal(reductiveChanges[0].pending.to, "debug_traceTransaction");
  });

  it("fetchUsing key added → additive", () => {
    const baseline: Snapshot = { "1": chain({ fetchContractCreationTxUsing: {} }) };
    const snapshot: Snapshot = {
      "1": chain({ fetchContractCreationTxUsing: { etherscanApi: true } }),
    };
    const { addDescriptions, reductiveChanges } = diffSnapshots(baseline, snapshot);
    assert.equal(reductiveChanges.length, 0);
    assert.ok(addDescriptions.some((d) => d.includes("etherscanApi")));
  });

  it("fetchUsing key removed → reductive remove-fetchUsing", () => {
    const baseline: Snapshot = {
      "1": chain({ fetchContractCreationTxUsing: { etherscanApi: true } }),
    };
    const snapshot: Snapshot = { "1": chain({ fetchContractCreationTxUsing: {} }) };
    const { addDescriptions, reductiveChanges } = diffSnapshots(baseline, snapshot);
    assert.equal(addDescriptions.length, 0);
    assert.equal(reductiveChanges.length, 1);
    assert.equal(reductiveChanges[0].key, "remove-fetchUsing-1-etherscanApi");
    assert.equal(reductiveChanges[0].pending.type, "remove-fetchUsing");
    assert.equal(reductiveChanges[0].pending.key, "etherscanApi");
  });

  it("etherscanApi added → additive", () => {
    const baseline: Snapshot = { "1": chain() };
    const snapshot: Snapshot = {
      "1": chain({ etherscanApi: { supported: true, apiKeyEnvName: "ETHERSCAN_API_KEY" } }),
    };
    const { addDescriptions, reductiveChanges } = diffSnapshots(baseline, snapshot);
    assert.equal(reductiveChanges.length, 0);
    assert.ok(addDescriptions.some((d) => d.includes("etherscanApi")));
  });

  it("etherscanApi removed → reductive remove-etherscanApi", () => {
    const baseline: Snapshot = {
      "1": chain({ etherscanApi: { supported: true, apiKeyEnvName: "ETHERSCAN_API_KEY" } }),
    };
    const snapshot: Snapshot = { "1": chain() };
    const { addDescriptions, reductiveChanges } = diffSnapshots(baseline, snapshot);
    assert.equal(addDescriptions.length, 0);
    assert.equal(reductiveChanges.length, 1);
    assert.equal(reductiveChanges[0].key, "remove-etherscanApi-1");
    assert.equal(reductiveChanges[0].pending.type, "remove-etherscanApi");
  });

  it("sourcifyName changes are not tracked", () => {
    const baseline: Snapshot = { "1": chain({ sourcifyName: "Old Name" }) };
    const snapshot: Snapshot = { "1": chain({ sourcifyName: "New Name" }) };
    const { addDescriptions, reductiveChanges } = diffSnapshots(baseline, snapshot);
    assert.equal(addDescriptions.length, 0);
    assert.equal(reductiveChanges.length, 0);
  });

  it("discoveredBy source added → additive", () => {
    const baseline: Snapshot = { "1": chain({ discoveredBy: ["drpc"] }) };
    const snapshot: Snapshot = { "1": chain({ discoveredBy: ["drpc", "quicknode"] }) };
    const { addDescriptions, reductiveChanges } = diffSnapshots(baseline, snapshot);
    assert.equal(reductiveChanges.length, 0);
    assert.ok(addDescriptions.some((d) => d.includes("quicknode") && d.includes("discoveredBy")));
  });

  it("discoveredBy source removed → reductive remove-discoveredBy", () => {
    const baseline: Snapshot = { "1": chain({ discoveredBy: ["drpc", "quicknode"] }) };
    const snapshot: Snapshot = { "1": chain({ discoveredBy: ["drpc"] }) };
    const { addDescriptions, reductiveChanges } = diffSnapshots(baseline, snapshot);
    assert.equal(addDescriptions.length, 0);
    assert.equal(reductiveChanges.length, 1);
    assert.equal(reductiveChanges[0].key, "remove-discoveredBy-1-quicknode");
    assert.equal(reductiveChanges[0].pending.type, "remove-discoveredBy");
    assert.equal(reductiveChanges[0].pending.key, "quicknode");
  });

  it("fetchUsing value changed (key in both) → reductive change-fetchUsing", () => {
    const baseline: Snapshot = {
      "1": chain({ fetchContractCreationTxUsing: { etherscanApi: { type: "v1" } } }),
    };
    const snapshot: Snapshot = {
      "1": chain({ fetchContractCreationTxUsing: { etherscanApi: { type: "v2" } } }),
    };
    const { addDescriptions, reductiveChanges } = diffSnapshots(baseline, snapshot);
    assert.equal(addDescriptions.length, 0);
    assert.equal(reductiveChanges.length, 1);
    assert.equal(reductiveChanges[0].key, "change-fetchUsing-1-etherscanApi");
    assert.equal(reductiveChanges[0].pending.type, "change-fetchUsing");
    assert.equal(reductiveChanges[0].pending.key, "etherscanApi");
  });

  it("fetchUsing value unchanged → no change", () => {
    const baseline: Snapshot = {
      "1": chain({ fetchContractCreationTxUsing: { etherscanApi: { type: "v1" } } }),
    };
    const snapshot: Snapshot = {
      "1": chain({ fetchContractCreationTxUsing: { etherscanApi: { type: "v1" } } }),
    };
    const { addDescriptions, reductiveChanges } = diffSnapshots(baseline, snapshot);
    assert.equal(addDescriptions.length, 0);
    assert.equal(reductiveChanges.length, 0);
  });
});

// ---------------------------------------------------------------------------
// updateHistory
// ---------------------------------------------------------------------------

describe("updateHistory", () => {
  it("new reductive change → consecutiveRuns = 1", () => {
    const reductiveChanges = [
      {
        key: "remove-chain-1",
        pending: { type: "remove-chain" as const, chainId: 1 },
      },
    ];
    const { updatedHistory, stabilized, pendingSummary } = updateHistory(
      emptyHistory(),
      reductiveChanges,
      NOW,
    );
    assert.equal(updatedHistory.pendingChanges["remove-chain-1"].consecutiveRuns, 1);
    assert.equal(stabilized.length, 0);
    assert.equal(pendingSummary.length, 1);
  });

  it("existing change seen again → counter incremented", () => {
    const history = historyWithEntry("remove-chain-1", { type: "remove-chain", chainId: 1 }, 3);
    const reductiveChanges = [
      { key: "remove-chain-1", pending: { type: "remove-chain" as const, chainId: 1 } },
    ];
    const { updatedHistory } = updateHistory(history, reductiveChanges, NOW);
    assert.equal(updatedHistory.pendingChanges["remove-chain-1"].consecutiveRuns, 4);
  });

  it("existing change NOT seen this run → counter deleted (reset)", () => {
    const history = historyWithEntry("remove-chain-1", { type: "remove-chain", chainId: 1 }, 3);
    const { updatedHistory } = updateHistory(history, [], NOW);
    assert.equal("remove-chain-1" in updatedHistory.pendingChanges, false);
  });

  it("change reaching threshold (5) → in stabilized list", () => {
    const history = historyWithEntry("remove-chain-1", { type: "remove-chain", chainId: 1 }, 4);
    const reductiveChanges = [
      { key: "remove-chain-1", pending: { type: "remove-chain" as const, chainId: 1 } },
    ];
    const { updatedHistory, stabilized, pendingSummary } = updateHistory(
      history,
      reductiveChanges,
      NOW,
    );
    assert.equal(updatedHistory.pendingChanges["remove-chain-1"].consecutiveRuns, 5);
    assert.ok(stabilized.includes("remove-chain-1"));
    assert.equal(pendingSummary.length, 0);
  });

  it("change above threshold stays stabilized", () => {
    const history = historyWithEntry("remove-chain-1", { type: "remove-chain", chainId: 1 }, 7);
    const reductiveChanges = [
      { key: "remove-chain-1", pending: { type: "remove-chain" as const, chainId: 1 } },
    ];
    const { stabilized } = updateHistory(history, reductiveChanges, NOW);
    assert.ok(stabilized.includes("remove-chain-1"));
  });

  it("mixed: one stabilized, one pending, one reset", () => {
    const history: ChangeHistory = {
      lastRunAt: "",
      pendingChanges: {
        "remove-chain-1": {
          type: "remove-chain",
          chainId: 1,
          consecutiveRuns: 4,
          firstSeenAt: NOW,
          lastSeenAt: NOW,
        },
        "remove-chain-2": {
          type: "remove-chain",
          chainId: 2,
          consecutiveRuns: 2,
          firstSeenAt: NOW,
          lastSeenAt: NOW,
        },
        "remove-chain-3": {
          type: "remove-chain",
          chainId: 3,
          consecutiveRuns: 1,
          firstSeenAt: NOW,
          lastSeenAt: NOW,
        },
      },
    };
    // Only chains 1 and 2 are still missing this run (chain 3 flaked back)
    const reductiveChanges = [
      { key: "remove-chain-1", pending: { type: "remove-chain" as const, chainId: 1 } },
      { key: "remove-chain-2", pending: { type: "remove-chain" as const, chainId: 2 } },
    ];
    const { updatedHistory, stabilized, pendingSummary } = updateHistory(
      history,
      reductiveChanges,
      NOW,
    );
    assert.ok(stabilized.includes("remove-chain-1")); // reached 5
    assert.ok(pendingSummary.some((s) => s.includes("remove-chain-2"))); // still pending at 3
    assert.equal("remove-chain-3" in updatedHistory.pendingChanges, false); // reset
  });
});

// ---------------------------------------------------------------------------
// buildStabilizedOutput
// ---------------------------------------------------------------------------

describe("buildStabilizedOutput", () => {
  it("no pending changes → output equals snapshot", () => {
    const baseline: Snapshot = { "1": chain({ rpc: [DRPC_RPC] }) };
    const snapshot: Snapshot = { "1": chain({ rpc: [DRPC_RPC, QN_RPC] }) };
    const output = buildStabilizedOutput(baseline, snapshot, {});
    assert.deepEqual(output["1"].rpc, snapshot["1"].rpc);
  });

  it("pending remove-chain (count < 5) → chain restored from baseline", () => {
    const baseline: Snapshot = { "1": chain({ sourcifyName: "Ethereum" }) };
    const snapshot: Snapshot = {};
    const pending: Record<string, PendingChange> = {
      "remove-chain-1": {
        type: "remove-chain",
        chainId: 1,
        consecutiveRuns: 3,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    };
    const output = buildStabilizedOutput(baseline, snapshot, pending);
    assert.ok("1" in output, "chain 1 should be restored");
    assert.equal(output["1"].sourcifyName, "Ethereum");
  });

  it("stabilized remove-chain (count >= 5) → chain absent from output", () => {
    const baseline: Snapshot = { "1": chain() };
    const snapshot: Snapshot = {};
    const pending: Record<string, PendingChange> = {
      "remove-chain-1": {
        type: "remove-chain",
        chainId: 1,
        consecutiveRuns: 5,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    };
    const output = buildStabilizedOutput(baseline, snapshot, pending);
    assert.equal("1" in output, false);
  });

  it("pending remove-rpc (count < 5) → RPC restored from baseline", () => {
    const baseline: Snapshot = { "1": chain({ rpc: [DRPC_RPC, QN_RPC] }) };
    const snapshot: Snapshot = { "1": chain({ rpc: [QN_RPC] }) }; // drpc dropped
    const pending: Record<string, PendingChange> = {
      "remove-rpc-1-drpc": {
        type: "remove-rpc",
        chainId: 1,
        provider: "drpc",
        consecutiveRuns: 2,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    };
    const output = buildStabilizedOutput(baseline, snapshot, pending);
    const providers = output["1"].rpc!.map((r) =>
      typeof r === "string" ? "public" : r.apiKeyEnvName === "DRPC_API_KEY" ? "drpc" : "quicknode",
    );
    assert.ok(providers.includes("drpc"), "drpc RPC should be restored");
    assert.ok(providers.includes("quicknode"), "quicknode RPC should be kept");
  });

  it("stabilized remove-rpc (count >= 5) → RPC absent from output", () => {
    const baseline: Snapshot = { "1": chain({ rpc: [DRPC_RPC, QN_RPC] }) };
    const snapshot: Snapshot = { "1": chain({ rpc: [QN_RPC] }) };
    const pending: Record<string, PendingChange> = {
      "remove-rpc-1-drpc": {
        type: "remove-rpc",
        chainId: 1,
        provider: "drpc",
        consecutiveRuns: 5,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    };
    const output = buildStabilizedOutput(baseline, snapshot, pending);
    const hasdrpc = output["1"].rpc?.some(
      (r) => typeof r !== "string" && r.apiKeyEnvName === "DRPC_API_KEY",
    );
    assert.equal(hasdrpc, false, "drpc RPC should be absent");
  });

  it("pending change-traceSupport (count < 5) → old value restored", () => {
    const baseline: Snapshot = { "1": chain({ rpc: [DRPC_RPC_WITH_TRACE] }) };
    const snapshot: Snapshot = { "1": chain({ rpc: [DRPC_RPC] }) }; // traceSupport dropped
    const pending: Record<string, PendingChange> = {
      "change-traceSupport-1-drpc": {
        type: "change-traceSupport",
        chainId: 1,
        provider: "drpc",
        from: "trace_transaction",
        to: null,
        consecutiveRuns: 3,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    };
    const output = buildStabilizedOutput(baseline, snapshot, pending);
    const drpcRpc = output["1"].rpc?.find(
      (r) => typeof r !== "string" && r.apiKeyEnvName === "DRPC_API_KEY",
    ) as { traceSupport?: string } | undefined;
    assert.equal(drpcRpc?.traceSupport, "trace_transaction");
  });

  it("stabilized change-traceSupport (count >= 5) → new value kept", () => {
    const baseline: Snapshot = { "1": chain({ rpc: [DRPC_RPC_WITH_TRACE] }) };
    const snapshot: Snapshot = { "1": chain({ rpc: [DRPC_RPC] }) }; // traceSupport dropped
    const pending: Record<string, PendingChange> = {
      "change-traceSupport-1-drpc": {
        type: "change-traceSupport",
        chainId: 1,
        provider: "drpc",
        from: "trace_transaction",
        to: null,
        consecutiveRuns: 5,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    };
    const output = buildStabilizedOutput(baseline, snapshot, pending);
    const drpcRpc = output["1"].rpc?.find(
      (r) => typeof r !== "string" && r.apiKeyEnvName === "DRPC_API_KEY",
    ) as { traceSupport?: string } | undefined;
    assert.equal(drpcRpc?.traceSupport, undefined, "traceSupport should be absent (stabilized removal)");
  });

  it("pending remove-fetchUsing (count < 5) → key restored from baseline", () => {
    const baseline: Snapshot = {
      "1": chain({ fetchContractCreationTxUsing: { etherscanApi: true, routescanApi: { type: "mainnet" } } }),
    };
    const snapshot: Snapshot = {
      "1": chain({ fetchContractCreationTxUsing: { etherscanApi: true } }), // routescanApi dropped
    };
    const pending: Record<string, PendingChange> = {
      "remove-fetchUsing-1-routescanApi": {
        type: "remove-fetchUsing",
        chainId: 1,
        key: "routescanApi",
        consecutiveRuns: 2,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    };
    const output = buildStabilizedOutput(baseline, snapshot, pending);
    assert.ok("routescanApi" in (output["1"].fetchContractCreationTxUsing ?? {}));
    assert.ok("etherscanApi" in (output["1"].fetchContractCreationTxUsing ?? {}));
  });

  it("pending remove-etherscanApi (count < 5) → etherscanApi restored", () => {
    const ethApi = { supported: true, apiKeyEnvName: "ETHERSCAN_API_KEY" };
    const baseline: Snapshot = { "1": chain({ etherscanApi: ethApi }) };
    const snapshot: Snapshot = { "1": chain() }; // etherscanApi dropped
    const pending: Record<string, PendingChange> = {
      "remove-etherscanApi-1": {
        type: "remove-etherscanApi",
        chainId: 1,
        consecutiveRuns: 1,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    };
    const output = buildStabilizedOutput(baseline, snapshot, pending);
    assert.deepEqual(output["1"].etherscanApi, ethApi);
  });

  it("new chain added + pending removal on different chain → addition kept, removal reverted", () => {
    const baseline: Snapshot = { "1": chain() };
    const snapshot: Snapshot = { "1": chain(), "200": chain({ sourcifyName: "New Chain" }) };
    const pending: Record<string, PendingChange> = {
      "remove-chain-1": {
        type: "remove-chain",
        chainId: 1,
        consecutiveRuns: 2,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    };
    // Actually: chain 1 is in snapshot too (not removed), so remove-chain-1 shouldn't be applied.
    // Let's make chain 1 missing from snapshot to properly test.
    const snapshotMissing1: Snapshot = { "200": chain({ sourcifyName: "New Chain" }) };
    const output = buildStabilizedOutput(baseline, snapshotMissing1, pending);
    assert.ok("1" in output, "chain 1 should be restored");
    assert.ok("200" in output, "new chain 200 should be present");
  });

  it("pending change-fetchUsing (count < 5) → old value restored", () => {
    const baseline: Snapshot = {
      "1": chain({ fetchContractCreationTxUsing: { etherscanApi: { type: "v1" } } }),
    };
    const snapshot: Snapshot = {
      "1": chain({ fetchContractCreationTxUsing: { etherscanApi: { type: "v2" } } }),
    };
    const pending: Record<string, PendingChange> = {
      "change-fetchUsing-1-etherscanApi": {
        type: "change-fetchUsing",
        chainId: 1,
        key: "etherscanApi",
        consecutiveRuns: 2,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    };
    const output = buildStabilizedOutput(baseline, snapshot, pending);
    assert.deepEqual(output["1"].fetchContractCreationTxUsing?.["etherscanApi"], { type: "v1" });
  });

  it("stabilized change-fetchUsing (count >= 5) → new value kept", () => {
    const baseline: Snapshot = {
      "1": chain({ fetchContractCreationTxUsing: { etherscanApi: { type: "v1" } } }),
    };
    const snapshot: Snapshot = {
      "1": chain({ fetchContractCreationTxUsing: { etherscanApi: { type: "v2" } } }),
    };
    const pending: Record<string, PendingChange> = {
      "change-fetchUsing-1-etherscanApi": {
        type: "change-fetchUsing",
        chainId: 1,
        key: "etherscanApi",
        consecutiveRuns: 5,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    };
    const output = buildStabilizedOutput(baseline, snapshot, pending);
    assert.deepEqual(output["1"].fetchContractCreationTxUsing?.["etherscanApi"], { type: "v2" });
  });

  it("pending remove-discoveredBy (count < 5) → source restored", () => {
    const baseline: Snapshot = { "1": chain({ discoveredBy: ["drpc", "quicknode"] }) };
    const snapshot: Snapshot = { "1": chain({ discoveredBy: ["drpc"] }) };
    const pending: Record<string, PendingChange> = {
      "remove-discoveredBy-1-quicknode": {
        type: "remove-discoveredBy",
        chainId: 1,
        key: "quicknode",
        consecutiveRuns: 2,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    };
    const output = buildStabilizedOutput(baseline, snapshot, pending);
    assert.ok(output["1"].discoveredBy.includes("quicknode"), "quicknode should be restored");
    assert.ok(output["1"].discoveredBy.includes("drpc"), "drpc should still be present");
  });

  it("stabilized remove-discoveredBy (count >= 5) → source absent", () => {
    const baseline: Snapshot = { "1": chain({ discoveredBy: ["drpc", "quicknode"] }) };
    const snapshot: Snapshot = { "1": chain({ discoveredBy: ["drpc"] }) };
    const pending: Record<string, PendingChange> = {
      "remove-discoveredBy-1-quicknode": {
        type: "remove-discoveredBy",
        chainId: 1,
        key: "quicknode",
        consecutiveRuns: 5,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    };
    const output = buildStabilizedOutput(baseline, snapshot, pending);
    assert.equal(output["1"].discoveredBy.includes("quicknode"), false, "quicknode should be absent");
  });

  it("output is sorted by numeric chain ID", () => {
    const baseline: Snapshot = {};
    const snapshot: Snapshot = {
      "100": chain(),
      "10": chain(),
      "1": chain(),
    };
    const output = buildStabilizedOutput(baseline, snapshot, {});
    assert.deepEqual(Object.keys(output), ["1", "10", "100"]);
  });
});

// ---------------------------------------------------------------------------
// buildPrDescription
// ---------------------------------------------------------------------------

describe("buildPrDescription", () => {
  it("only additions", () => {
    const desc = buildPrDescription(["Added chain 100 (Test Chain)"], [], [], {});
    assert.ok(desc.includes("Immediately included"));
    assert.ok(desc.includes("Added chain 100"));
    assert.ok(!desc.includes("Pending"));
    assert.ok(!desc.includes("No ready changes"));
  });

  it("only stabilized removals", () => {
    const pending: Record<string, PendingChange> = {
      "remove-chain-1": {
        type: "remove-chain",
        chainId: 1,
        consecutiveRuns: 5,
        firstSeenAt: "2026-01-01T00:00:00Z",
        lastSeenAt: NOW,
      },
    };
    const desc = buildPrDescription([], ["remove-chain-1"], [], pending);
    assert.ok(desc.includes("stabilization"));
    assert.ok(desc.includes("remove-chain-1"));
    assert.ok(!desc.includes("No ready changes"));
  });

  it("no ready changes → shows notice", () => {
    const desc = buildPrDescription([], [], ["remove-chain-1: 2/5 runs (since ...)"], {
      "remove-chain-1": {
        type: "remove-chain",
        chainId: 1,
        consecutiveRuns: 2,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    });
    assert.ok(desc.includes("No ready changes"));
    assert.ok(desc.includes("Pending"));
  });

  it("additions + stabilized + pending", () => {
    const pending: Record<string, PendingChange> = {
      "remove-chain-1": {
        type: "remove-chain",
        chainId: 1,
        consecutiveRuns: 5,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
      "remove-rpc-2-drpc": {
        type: "remove-rpc",
        chainId: 2,
        provider: "drpc",
        consecutiveRuns: 3,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    };
    const desc = buildPrDescription(
      ["Added chain 100 (New)"],
      ["remove-chain-1"],
      ["remove-rpc-2-drpc: 3/5 runs (since ...)"],
      pending,
    );
    assert.ok(desc.includes("Immediately included"));
    assert.ok(desc.includes("stabilization"));
    assert.ok(desc.includes("Pending"));
    assert.ok(desc.includes("🤖"));
  });
});
