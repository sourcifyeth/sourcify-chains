import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const BASE_URL = process.env.SOURCIFY_BASE_URL ?? "http://localhost:5555";
export const POLL_INTERVAL = 3000;
export const CONCURRENCY = 20;

export const CREATEX_ADDRESS = "0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed";
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const CREATEX_DEPLOYMENTS_URL =
  "https://raw.githubusercontent.com/pcaversaccio/createx/refs/heads/main/deployments/deployments.json";
export const MULTICALL3_DEPLOYMENTS_URL =
  "https://raw.githubusercontent.com/mds1/multicall3/refs/heads/main/deployments.json";

export interface ChainEntry {
  supported: boolean;
  etherscanApi?: { supported?: boolean };
  [key: string]: unknown;
}

export function loadChains(): Record<string, ChainEntry> {
  const raw = JSON.parse(
    readFileSync(resolve(__dirname, "../sourcify-chains-default.json"), "utf8"),
  ) as Record<string, ChainEntry>;
  return raw;
}

export async function waitForServer(
  baseUrl: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Server at ${baseUrl} did not become healthy within ${timeoutMs}ms`);
}

const RATE_LIMIT_PATTERN = /etherscan_limit|rate limit reached|rate limit/i;
const MAX_RATE_LIMIT_RETRIES = 5;
const RATE_LIMIT_RETRY_BASE_MS = 2000;

class RateLimitError extends Error {}

// Both suites share one Etherscan API key — the chain suite hits Etherscan for
// creation-tx lookups, the etherscan suite for source imports — so transient
// rate-limit errors are expected under load. Retry with exponential backoff
// (2s, 4s, 8s, 16s, 32s) on rate-limit errors only; other errors propagate.
async function retryOnRateLimit<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (
        !(err instanceof RateLimitError) ||
        attempt >= MAX_RATE_LIMIT_RETRIES
      ) {
        throw err;
      }
      await new Promise((r) =>
        setTimeout(r, RATE_LIMIT_RETRY_BASE_MS * 2 ** attempt),
      );
    }
  }
}

export async function verifyAndPoll(
  baseUrl: string,
  chainId: string,
  address: string,
  body: Record<string, unknown>,
  opts: { pollInterval?: number; maxPolls?: number } = {},
): Promise<{ isJobCompleted: boolean; contract?: unknown; error?: unknown }> {
  return retryOnRateLimit(() =>
    verifyAndPollOnce(baseUrl, chainId, address, body, opts),
  );
}

async function verifyAndPollOnce(
  baseUrl: string,
  chainId: string,
  address: string,
  body: Record<string, unknown>,
  opts: { pollInterval?: number; maxPolls?: number } = {},
): Promise<{ isJobCompleted: boolean; contract?: unknown; error?: unknown }> {
  const { pollInterval = POLL_INTERVAL, maxPolls = 20 } = opts;

  const verifyRes = await fetch(`${baseUrl}/v2/verify/${chainId}/${address}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!verifyRes.ok && verifyRes.status !== 202) {
    const text = await verifyRes.text();
    if (verifyRes.status === 429 || RATE_LIMIT_PATTERN.test(text)) {
      throw new RateLimitError(`POST /v2/verify rate limited: ${text}`);
    }
    throw new Error(`POST /v2/verify returned ${verifyRes.status}: ${text}`);
  }

  const verifyBody = (await verifyRes.json()) as { verificationId: string };
  const verificationId = verifyBody.verificationId;

  let polls = 0;
  let jobRes: Response;
  let jobBody: { isJobCompleted: boolean; contract?: unknown; error?: unknown };
  do {
    await new Promise((r) => setTimeout(r, pollInterval));
    jobRes = await fetch(`${baseUrl}/v2/verify/${verificationId}`);
    jobBody = (await jobRes.json()) as typeof jobBody;
    polls++;
  } while (!jobBody.isJobCompleted && polls < maxPolls);

  // The creation-tx lookup runs server-side in the worker, so an Etherscan
  // rate limit there surfaces in the completed job's error, not the POST.
  if (
    jobBody.isJobCompleted &&
    RATE_LIMIT_PATTERN.test(JSON.stringify(jobBody.error ?? ""))
  ) {
    throw new RateLimitError(
      `Verification job rate limited: ${JSON.stringify(jobBody.error)}`,
    );
  }

  return jobBody;
}

export async function etherscanVerifyAndPoll(
  baseUrl: string,
  chainId: string,
  address: string,
  opts: { pollInterval?: number; maxPolls?: number } = {},
): Promise<{ isJobCompleted: boolean; contract?: unknown; error?: unknown }> {
  return retryOnRateLimit(() =>
    etherscanVerifyAndPollOnce(baseUrl, chainId, address, opts),
  );
}

async function etherscanVerifyAndPollOnce(
  baseUrl: string,
  chainId: string,
  address: string,
  opts: { pollInterval?: number; maxPolls?: number } = {},
): Promise<{ isJobCompleted: boolean; contract?: unknown; error?: unknown }> {
  const { pollInterval = POLL_INTERVAL, maxPolls = 20 } = opts;

  const verifyRes = await fetch(
    `${baseUrl}/v2/verify/etherscan/${chainId}/${address}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  );

  if (!verifyRes.ok && verifyRes.status !== 202) {
    const text = await verifyRes.text();
    if (verifyRes.status === 429 || RATE_LIMIT_PATTERN.test(text)) {
      throw new RateLimitError(
        `POST /v2/verify/etherscan rate limited: ${text}`,
      );
    }
    throw new Error(
      `POST /v2/verify/etherscan returned ${verifyRes.status}: ${text}`,
    );
  }

  const verifyBody = (await verifyRes.json()) as { verificationId: string };
  const verificationId = verifyBody.verificationId;

  let polls = 0;
  let jobBody: { isJobCompleted: boolean; contract?: unknown; error?: unknown };
  do {
    await new Promise((r) => setTimeout(r, pollInterval));
    const jobRes = await fetch(`${baseUrl}/v2/verify/${verificationId}`);
    jobBody = (await jobRes.json()) as typeof jobBody;
    polls++;
  } while (!jobBody.isJobCompleted && polls < maxPolls);

  return jobBody;
}

export function toMatchLevel(status: string): "exact_match" | "match" | null {
  if (status === "perfect") return "exact_match";
  if (status === "partial") return "match";
  return null;
}
