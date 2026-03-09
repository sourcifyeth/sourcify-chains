export type TraceMethod = "trace_transaction" | "debug_traceTransaction";

/**
 * Result of probing a chain on a specific provider:
 *   - "trace_transaction" / "debug_traceTransaction" — alive, trace method detected
 *   - "none"  — alive (tx found in scan window), but neither trace method available
 *   - null    — provider doesn't serve this chain, or no tx found in scan window
 *
 * null chains are excluded from the provider's RPC list entirely.
 * "none" chains are included but without a traceSupport field.
 */
export type TraceCacheValue = TraceMethod | "none" | null;

const SCAN_START_OFFSET = 50; // Start scanning this many blocks behind latest (avoid unindexed traces)
const SCAN_END_OFFSET = 550; // Stop scanning at this many blocks behind latest (500-block window)

const TRACE_PROBE_RETRIES = 4; // 5 attempts total per trace method
const TRACE_PROBE_RETRY_DELAY = 10_000; // ms between trace probe retries

interface JsonRpcResponse<T = unknown> {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

interface BlockResult {
  number: string; // hex block number
  transactions: string[]; // tx hashes (when called with fullTransactions=false)
}

async function rpcCall<T>(
  url: string,
  method: string,
  params: unknown[],
  timeoutMs = 3_000,
  retries = 2,
): Promise<JsonRpcResponse<T>> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return resp.json() as Promise<JsonRpcResponse<T>>;
    } catch (e) {
      lastError = e;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
  throw lastError;
}

/**
 * Finds a transaction hash by scanning blocks [latest-SCAN_START_OFFSET .. latest-SCAN_END_OFFSET].
 * Returns null if the provider doesn't serve this chain or no tx is found in the scan window.
 */
async function findRecentTxHash(
  url: string,
  log: (msg: string) => void,
): Promise<string | null> {
  // Fetch the latest block, retrying on transient errors (e.g. rate limits).
  let latestResp: JsonRpcResponse<BlockResult> | null = null;
  for (let attempt = 0; attempt <= TRACE_PROBE_RETRIES; attempt++) {
    let resp: JsonRpcResponse<BlockResult>;
    try {
      resp = await rpcCall<BlockResult>(url, "eth_getBlockByNumber", ["latest", false]);
    } catch (e) {
      log(`    eth_getBlockByNumber(latest): exception: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
    if (!resp.error) {
      latestResp = resp;
      break;
    }
    if (attempt < TRACE_PROBE_RETRIES) {
      log(`    eth_getBlockByNumber(latest): retry ${attempt + 1}/${TRACE_PROBE_RETRIES} — error ${resp.error.code ?? "?"} ${resp.error.message ?? ""}`);
      await new Promise((r) => setTimeout(r, TRACE_PROBE_RETRY_DELAY));
    } else {
      log(`    eth_getBlockByNumber(latest): error ${resp.error.code ?? "?"} ${resp.error.message ?? ""}`);
      return null;
    }
  }
  if (!latestResp?.result) {
    log(`    eth_getBlockByNumber(latest): null result`);
    return null;
  }

  const latestNum = parseInt(latestResp.result.number, 16);
  log(`    Latest block: #${latestNum}, scanning #${latestNum - SCAN_START_OFFSET}–#${latestNum - SCAN_END_OFFSET}`);

  // Skip the most recent blocks — their traces may not be indexed yet.
  // Scan from SCAN_START_OFFSET to SCAN_END_OFFSET blocks behind latest.
  for (let i = SCAN_START_OFFSET; i <= SCAN_END_OFFSET; i++) {
    const blockHex = "0x" + (latestNum - i).toString(16);
    const resp = await rpcCall<BlockResult>(url, "eth_getBlockByNumber", [blockHex, false]);
    if (resp.error || !resp.result) continue;
    const txs = resp.result.transactions;
    if (txs.length > 0) {
      const tx = txs[0];
      log(`    Block #${latestNum - i}: ${txs.length} txs, using tx: ${typeof tx === "string" ? tx : JSON.stringify(tx).slice(0, 80)}`);
      return typeof tx === "string" ? tx : null;
    }
  }

  log(`    No transactions found in blocks #${latestNum - SCAN_START_OFFSET}–#${latestNum - SCAN_END_OFFSET}`);
  return null;
}

/**
 * Probes a provider RPC URL for chain liveness and trace method support.
 *
 * Step 1 — liveness: find a real transaction by scanning blocks
 *   [latest - SCAN_START_OFFSET .. latest - SCAN_END_OFFSET] (500-block window).
 *   Skipping the most recent blocks avoids using transactions whose traces
 *   are not yet indexed by the provider.
 *   - Provider error (e.g. "Unknown network") or no tx found → null
 *     Null chains are excluded from the provider's RPC list entirely.
 *
 * Step 2 — trace support (only if alive): call trace_transaction then
 *   debug_traceTransaction with the found tx hash. Each method is attempted
 *   up to TRACE_PROBE_RETRIES+1 times:
 *   - -32601: Method not found → definitive, try next method (no retry)
 *   - result present → method supported → return it
 *   - any error response → possibly transient → retry up to TRACE_PROBE_RETRIES times
 *   - Neither method available after all retries → "none"
 *
 * Callers pass a `log` callback so concurrent probes can buffer their output
 * and flush it atomically, preventing interleaved log lines.
 */
export async function probeChain(
  url: string,
  log: (msg: string) => void = () => {},
): Promise<TraceCacheValue> {
  let txHash: string | null;
  try {
    txHash = await findRecentTxHash(url, log);
  } catch {
    return null;
  }

  if (!txHash) return null; // Provider doesn't serve this chain or chain is inactive

  for (const method of [
    "trace_transaction",
    "debug_traceTransaction",
  ] as TraceMethod[]) {
    const params =
      method === "trace_transaction"
        ? [txHash]
        : [txHash, { tracer: "callTracer" }];

    for (let attempt = 0; attempt <= TRACE_PROBE_RETRIES; attempt++) {
      let d: { result?: unknown; error?: { code: number; message: string; data?: unknown } };
      try {
        d = await rpcCall<unknown>(url, method, params) as typeof d;
      } catch (e) {
        // rpcCall already retried internally on network errors; all attempts exhausted
        log(`    ${method}: ✗ (exception: ${e instanceof Error ? e.message : String(e)})`);
        break; // try next method
      }

      if (d.error?.code === -32601) {
        // Standard JSON-RPC "method not found" — definitive, no retry
        log(`    ${method}: ✗ not found (-32601: "${d.error.message}")`);
        break;
      }

      if (d.result !== undefined && d.result !== null) {
        // Got a real result — method is supported
        const preview = JSON.stringify(d.result).slice(0, 120);
        log(`    ${method}: ✓ result ${preview}`);
        return method;
      }

      if (d.error) {
        const code = d.error.code;
        // Any error response — possibly transient; retry
        if (attempt < TRACE_PROBE_RETRIES) {
          log(`    ${method}: ? retry ${attempt + 1}/${TRACE_PROBE_RETRIES} — (${code}: "${d.error.message}")`);
          await new Promise((r) => setTimeout(r, TRACE_PROBE_RETRY_DELAY));
          continue;
        }
        log(`    ${method}: ? skip after ${TRACE_PROBE_RETRIES + 1} attempts — (${code}: "${d.error.message}")`);
        break;
      }

      // result is null/undefined and no error — ambiguous, retry
      if (attempt < TRACE_PROBE_RETRIES) {
        log(`    ${method}: ? retry ${attempt + 1}/${TRACE_PROBE_RETRIES} — null result, no error`);
        await new Promise((r) => setTimeout(r, TRACE_PROBE_RETRY_DELAY));
        continue;
      }
      log(`    ${method}: ? skip after ${TRACE_PROBE_RETRIES + 1} attempts — null result, no error`);
      break;
    }
  }
  return "none"; // Chain is alive but neither trace method is available
}

/**
 * Runs async tasks with a maximum concurrency limit.
 */
export async function withConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return results;
}
