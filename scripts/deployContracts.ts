import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ContractFactory,
  JsonRpcProvider,
  Wallet,
  type BytesLike,
  type JsonFragment,
  type FetchRequest,
} from "ethers";
import { Command } from "commander";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface StorageArtifact {
  abi: JsonFragment[];
  bytecode: string;
}

interface ChainEntry {
  sourcifyName?: string;
  supported?: boolean;
  rpc?: (string | { type: string; url: string; headers?: unknown[] })[];
}

const program = new Command();
program
  .description(
    "Script to deploy Sourcify's (sourcify.dev) sample Storage contract on a new chain",
  )
  .helpOption("-h, --help", "Output the help message.")
  .usage("--chainId=<chainId> --privateKey=<privateKey>")
  .requiredOption(
    "--chainId <chainId>",
    "Chain ID of the chain to deploy the contract.",
  )
  .requiredOption(
    "--privateKey <privateKey>",
    "Private key of the account that will deploy the contract",
  )
  .option(
    "--immutableValue <uint256>",
    "Value to be stored as the immutable value. (DEPRECATED)",
  )
  .showSuggestionAfterError()
  .showHelpAfterError("(add --help for additional information)");

program.parse();
const options = program.opts<{ chainId: string; privateKey: string }>();

const chainsMap = JSON.parse(
  readFileSync(resolve(__dirname, "../sourcify-chains-default.json"), "utf8"),
) as Record<string, ChainEntry>;

const chain = chainsMap[options.chainId];
if (!chain) {
  console.error(
    `Chain config for chainId "${options.chainId}" not found in sourcify-chains-default.json, abort.`,
  );
  process.exit(1);
}
if (!chain.supported) {
  console.warn(
    `Warning: chain ${chain.sourcifyName ?? options.chainId} is not marked as supported.`,
  );
}

const StorageArtifact = JSON.parse(
  readFileSync(
    resolve(__dirname, "fixtures/storage.artifact.json"),
    "utf8",
  ),
) as StorageArtifact;

const firstRpc = chain.rpc?.[0];
if (!firstRpc) {
  console.error(
    `No RPC URL found for chain ${chain.sourcifyName ?? options.chainId} (${options.chainId}) in sourcify-chains-default.json.`,
  );
  process.exit(1);
}

let provider: JsonRpcProvider;
if (typeof firstRpc === "string") {
  console.log("Using rpc: " + firstRpc);
  provider = new JsonRpcProvider(firstRpc);
} else {
  console.log("Using rpc: " + firstRpc.url);
  provider = new JsonRpcProvider(firstRpc.url);
}

console.log("Deploying the Storage contract...");
const signer = new Wallet(options.privateKey, provider);
const factory = new ContractFactory(
  StorageArtifact.abi,
  StorageArtifact.bytecode as BytesLike,
  signer,
);
const deployment = await factory.deploy();
await deployment.waitForDeployment();
const address = await deployment.getAddress();

console.log(
  `Contract deployed at ${address} on ${chain.sourcifyName ?? options.chainId} (${options.chainId})`,
);
console.log(
  `\nAdd this entry to tests/fixtures/storage-contract-chain-addresses.json:\n  "${options.chainId}": "${address}"`,
);
