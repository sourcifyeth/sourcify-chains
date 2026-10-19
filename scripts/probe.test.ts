import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { checkLiveness, fetchReportedChainId } from "./probe.js";

// A fake JSON-RPC node. `handlers` maps a method name to what the server sends
// back for it: a JSON-RPC result, a JSON-RPC error, or a raw HTTP response.
type Reply =
  | { result: unknown }
  | { error: { code: number; message: string } }
  | { http: { status: number; body: string } };

type Handlers = Record<string, Reply>;

const healthy: Handlers = {
  eth_getBlockByNumber: { result: { number: "0x10", transactions: [] } },
  eth_chainId: { result: "0x3e7" },
  eth_getCode: { result: "0x" },
};

function startFakeNode(nodes: Record<string, Handlers>): Promise<{ baseUrl: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const handlers = nodes[req.url ?? "/"];
      const { method } = JSON.parse(body) as { method: string };
      const reply: Reply | undefined = handlers?.[method];
      if (!reply) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } }));
        return;
      }
      if ("http" in reply) {
        res.writeHead(reply.http.status);
        res.end(reply.http.body);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, ...reply }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

describe("checkLiveness", () => {
  let baseUrl: string;
  let close: () => void;

  before(async () => {
    ({ baseUrl, close } = await startFakeNode({
      "/healthy": healthy,
      // Answers eth_getCode with JSON-RPC "method not found".
      "/no-getcode": { ...healthy, eth_getCode: { error: { code: -32601, message: "Method not found" } } },
      // The shape QuickNode's Hyperliquid endpoints have: blocks and eth_chainId
      // work, eth_getCode is an HTTP 404 with an empty body.
      "/hyperliquid": { ...healthy, eth_getCode: { http: { status: 404, body: "" } } },
      // XRP-style endpoint: eth_chainId "succeeds" but the result is not a hex string.
      "/xrp": { ...healthy, eth_chainId: { result: { error: "unknownCmd" } } },
    }));
  });
  after(() => close());

  it("returns the latest block number for a healthy RPC", async () => {
    assert.equal(await checkLiveness(`${baseUrl}/healthy`, () => {}, 999), 16);
  });

  it("treats an RPC that rejects eth_getCode as dead", async () => {
    const lines: string[] = [];
    assert.equal(await checkLiveness(`${baseUrl}/no-getcode`, (m) => lines.push(m), 999), null);
    assert.ok(lines.some((l) => l.includes("eth_getCode") && l.includes("dead")), lines.join("\n"));
  });

  it("treats an RPC that answers eth_getCode with an empty HTTP 404 as dead (Hyperliquid)", async () => {
    const lines: string[] = [];
    assert.equal(await checkLiveness(`${baseUrl}/hyperliquid`, (m) => lines.push(m), 999), null);
    assert.ok(lines.some((l) => l.includes("eth_getCode") && l.includes("dead")), lines.join("\n"));
  });

  it("still rejects a chain id mismatch before checking eth_getCode", async () => {
    let reported: number | undefined;
    assert.equal(await checkLiveness(`${baseUrl}/healthy`, () => {}, 1, (r) => (reported = r)), null);
    assert.equal(reported, 999);
  });

  it("fetchReportedChainId returns null when the result is not a hex chain id", async () => {
    assert.equal(await fetchReportedChainId(`${baseUrl}/xrp`), null);
    assert.equal(await fetchReportedChainId(`${baseUrl}/healthy`), 999);
  });
});
