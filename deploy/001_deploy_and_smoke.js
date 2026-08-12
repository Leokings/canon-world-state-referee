import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { abi as genlayerAbi } from "genlayer-js";
import { keccak256, stringToHex } from "viem";

const CONTRACT_PATH = path.resolve(process.cwd(), "contracts", "CanonWorldStateReferee.py");
const CONTRACT_VERSION = "0.2.0";
const POLICY_VERSION = "CANON_WORLD_STATE_TRANSITION_V2";
const SCOPE = "ONE_EVENT_ONE_PREDEFINED_TRANSITION";
const RUNNER = "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6";
const DIGEST_DOMAIN = "GENLAYER_CANON_WORLD_STATE_REFEREE";
const FINALIZE_TRANSACTION_SELECTOR = "0xb2efda83";
const DEFAULT_BRADBURY_DEPLOYMENT_GAS = 60_000_000n;
export const FINALITY_POLL_INTERVAL_MS = 5_000;
const STATUS_NAMES = new Map([[5, "ACCEPTED"], [7, "FINALIZED"], [11, "READY_TO_FINALIZE"]]);
const RESULT_NAMES = new Map([[1, "AGREE"], [6, "MAJORITY_AGREE"]]);
const EXECUTION_NAMES = new Map([[1, "FINISHED_WITH_RETURN"]]);

const CANON = [{
  id: "RULE-EMBER-KEY",
  text: "Only a fire mage holding the Ember Key may awaken the Ember Dragon.",
}];
const INITIAL_STATE = {
  active_hero_class: "FIRE_MAGE",
  dragon_awake: false,
  ember_key_held: true,
};
const TRANSITIONS = [{
  id: "AWAKEN_DRAGON",
  description: "Awaken the Ember Dragon only when the active hero is a fire mage, the Ember Key is held, and the dragon is asleep. The only effect is dragon_awake becoming true.",
  required_state: {
    active_hero_class: "FIRE_MAGE",
    dragon_awake: false,
    ember_key_held: true,
  },
  state_patch: { dragon_awake: true },
  applicable_canon_rule_ids: ["RULE-EMBER-KEY"],
}];
const SMOKE_REFERENCE = "DEPLOY-SMOKE-001";
const SMOKE_EVENT = "The active fire mage presents the held Ember Key and awakens the sleeping Ember Dragon.";
const SMOKE_TRANSITION = "AWAKEN_DRAGON";

function jsonString(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
}

function plainValue(value) {
  if (value instanceof Map) {
    return Object.fromEntries([...value].map(([key, item]) => [String(key), plainValue(item)]));
  }
  if (Array.isArray(value)) return value.map(plainValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plainValue(item)]));
  }
  return typeof value === "bigint" ? value.toString() : value;
}

function mapValue(value, key) {
  return value instanceof Map ? value.get(key) : value?.[key];
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

function canonicalText(value) {
  return JSON.stringify(canonicalJson(value));
}

export function contractDigest(tag, parts) {
  let framed = "";
  for (const part of [DIGEST_DOMAIN, tag, ...parts]) {
    const text = String(part);
    framed += `${text.length}:${text}`;
  }
  return keccak256(stringToHex(framed)).slice(2);
}

export function redactRpc(value) {
  try {
    const url = new URL(String(value || ""));
    return `${url.protocol}//${url.host}`;
  } catch {
    return "REDACTED";
  }
}

function normalized(value, names) {
  if (typeof value === "number") return names.get(value) || String(value);
  if (typeof value === "bigint") return names.get(Number(value)) || value.toString();
  return String(value || "").trim().toUpperCase();
}

function assertHash(value, name) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(value || ""))) {
    throw new Error(`${name} is not a transaction hash`);
  }
}

function assertAddress(value, name) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(value || ""))) {
    throw new Error(`${name} is not an address`);
  }
}

function assertLowerHex(value, length, name) {
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(String(value || ""))) {
    throw new Error(`${name} must be ${length} lowercase hexadecimal characters`);
  }
}

function executionSucceeded(value) {
  const result = normalized(value, EXECUTION_NAMES);
  return result === "FINISHED_WITH_RETURN" || result === "SUCCESS";
}

function receiptList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function assertValidatorQuorum(receipt, label) {
  const round = receipt?.lastRound || receipt?.last_round || {};
  const validators = round?.roundValidators || round?.round_validators || [];
  const voteNames = round?.validatorVotesName || round?.validator_votes_name || [];
  const votes = round?.validatorVotes || round?.validator_votes || [];
  const revealed = Number(round?.votesRevealed ?? round?.votes_revealed ?? 0);
  if (!Array.isArray(validators) || validators.length < 3) {
    throw new Error(`${label} did not expose a validator quorum`);
  }
  const positive = validators.reduce((count, _validator, index) => {
    const named = String(voteNames[index] || "").trim().toUpperCase();
    return count + (named === "AGREE" || Number(votes[index]) === 1 ? 1 : 0);
  }, 0);
  if (revealed < validators.length || positive < Math.floor(validators.length / 2) + 1) {
    throw new Error(`${label} lacked revealed majority agreement: ${jsonString(round)}`);
  }
}

function assertPositiveReceipt(receipt, label, allowIdle = false) {
  const status = normalized(receipt?.statusName ?? receipt?.status_name ?? receipt?.status, STATUS_NAMES);
  const result = normalized(receipt?.resultName ?? receipt?.result_name ?? receipt?.result, RESULT_NAMES);
  const consensus = receipt?.consensus_data || {};
  const participants = [...receiptList(consensus.leader_receipt), ...receiptList(consensus.validators)];
  const execution = receipt?.txExecutionResultName ?? receipt?.tx_execution_result_name ??
    receipt?.txExecutionResult ?? participants[0]?.execution_result;
  const provisionalIdle = allowIdle && ["ACCEPTED", "READY_TO_FINALIZE"].includes(status) && result === "IDLE";
  if (!["ACCEPTED", "READY_TO_FINALIZE", "FINALIZED"].includes(status)) {
    throw new Error(`${label} has status ${status}`);
  }
  if (!["AGREE", "MAJORITY_AGREE"].includes(result) && !provisionalIdle) {
    throw new Error(`${label} lacks positive consensus (${result})`);
  }
  if (!executionSucceeded(execution)) throw new Error(`${label} execution failed: ${jsonString(receipt)}`);
  for (const participant of participants) {
    if (participant?.execution_result !== undefined && !executionSucceeded(participant.execution_result)) {
      throw new Error(`${label} participant execution failed`);
    }
  }
  assertValidatorQuorum(receipt, label);
}

function consensusSummary(receipt) {
  const round = receipt?.lastRound || receipt?.last_round || {};
  return {
    status: receipt?.statusName ?? receipt?.status_name ?? receipt?.status ?? null,
    result: receipt?.resultName ?? receipt?.result_name ?? receipt?.result ?? null,
    execution: receipt?.txExecutionResultName ?? receipt?.tx_execution_result_name ??
      receipt?.txExecutionResult ?? null,
    round: round?.round ?? null,
    validators: round?.roundValidators ?? round?.round_validators ?? [],
    votes: round?.validatorVotesName ?? round?.validator_votes_name ?? [],
    votes_revealed: round?.votesRevealed ?? round?.votes_revealed ?? null,
  };
}

function requiredEnvironment(names) {
  const missing = names.filter((name) => !String(process.env[name] || "").trim());
  if (missing.length) throw new Error(`Missing required environment: ${missing.join(", ")}`);
}

export async function assertNetwork(client) {
  const expectedChainId = Number(process.env.CANON_EXPECTED_CHAIN_ID || "");
  const expectedGenVmChainId = Number(process.env.CANON_EXPECTED_GENVM_CHAIN_ID || "");
  const expectedName = String(process.env.CANON_EXPECTED_NETWORK_NAME || "").trim();
  if (!Number.isInteger(expectedChainId) || expectedChainId <= 0) {
    throw new Error("Set CANON_EXPECTED_CHAIN_ID to the intended positive chain ID");
  }
  if (Number(client.chain?.id) !== expectedChainId) {
    throw new Error(`Wrong chain ${client.chain?.id}; expected ${expectedChainId}`);
  }
  if (!Number.isInteger(expectedGenVmChainId) || expectedGenVmChainId <= 0) {
    throw new Error("Set CANON_EXPECTED_GENVM_CHAIN_ID to the positive chain ID visible as gl.message.chain_id");
  }
  if (expectedName && String(client.chain?.name) !== expectedName) {
    throw new Error(`Wrong network ${client.chain?.name}; expected ${expectedName}`);
  }
  let rawLiveChainId;
  try {
    rawLiveChainId = await client.request({ method: "eth_chainId", params: [] });
  } catch (error) {
    throw new Error(`Live eth_chainId query failed: ${String(error)}`);
  }
  if (!/^0x[0-9a-fA-F]+$/.test(String(rawLiveChainId || ""))) {
    throw new Error(`Live eth_chainId returned an invalid value: ${String(rawLiveChainId)}`);
  }
  const liveChainIdBigInt = BigInt(rawLiveChainId);
  if (liveChainIdBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Live eth_chainId exceeds the safe integer range");
  }
  const liveChainId = Number(liveChainIdBigInt);
  if (liveChainId !== expectedChainId || liveChainId !== Number(client.chain?.id)) {
    throw new Error(
      `Live RPC chain ID ${liveChainId} disagrees with expected/static chain ID ` +
      `${expectedChainId}/${String(client.chain?.id)}`,
    );
  }
  return {
    expected_chain_id: expectedChainId,
    sdk_chain_id: Number(client.chain.id),
    rpc_chain_id: liveChainId,
    rpc_chain_id_hex: String(rawLiveChainId).toLowerCase(),
    verified: true,
  };
}

export function verifySourceCommit(code, commit, gitRunner = (args) => execFileSync(
  "git",
  args,
  { cwd: process.cwd(), encoding: null, maxBuffer: 2_000_000 },
)) {
  assertLowerHex(commit, 40, "CANON_SOURCE_COMMIT");
  let objectType;
  let committedSource;
  try {
    objectType = Buffer.from(gitRunner(["cat-file", "-t", commit])).toString("utf8").trim();
    committedSource = Buffer.from(gitRunner([
      "show",
      "--no-ext-diff",
      "--no-textconv",
      `${commit}:contracts/CanonWorldStateReferee.py`,
    ]));
  } catch (error) {
    throw new Error(`CANON_SOURCE_COMMIT cannot be resolved to the contract source: ${String(error)}`);
  }
  if (objectType !== "commit") {
    throw new Error(`CANON_SOURCE_COMMIT resolves to ${objectType || "unknown"}, not a commit`);
  }
  const localSource = Buffer.from(code, "utf8");
  if (!committedSource.equals(localSource)) {
    throw new Error("CANON_SOURCE_COMMIT contract blob differs byte-for-byte from the local contract source");
  }
  return {
    verified: true,
    object_type: objectType,
    blob_sha256: createHash("sha256").update(committedSource).digest("hex"),
    bytes: committedSource.length,
  };
}

function outputPath() {
  const configured = String(process.env.CANON_DEPLOYMENT_OUTPUT || "").trim();
  if (!configured) throw new Error("Set CANON_DEPLOYMENT_OUTPUT");
  const candidate = path.resolve(process.cwd(), configured);
  const directory = path.resolve(process.cwd(), "deployments");
  if (path.dirname(candidate) !== directory || path.extname(candidate).toLowerCase() !== ".json") {
    throw new Error("CANON_DEPLOYMENT_OUTPUT must be a JSON file directly inside deployments/");
  }
  return candidate;
}

function saveCheckpoint(file, checkpoint) {
  checkpoint.recorded_at = new Date().toISOString();
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, { flag: "w" });
  renameSync(temporary, file);
}

function checkpointBase(code, sourceSha256, constructorArgs, client) {
  return {
    schema_version: "2.0",
    project: "canon-world-state-referee",
    status: "IN_PROGRESS",
    recorded_at: new Date().toISOString(),
    network: {
      chain_id: Number(client.chain?.id),
      genvm_chain_id: Number(process.env.CANON_EXPECTED_GENVM_CHAIN_ID),
      name: String(client.chain?.name || ""),
      rpc: redactRpc(client.chain?.rpcUrls?.default?.http?.[0]),
    },
    source: {
      commit: String(process.env.CANON_SOURCE_COMMIT || ""),
      path: "contracts/CanonWorldStateReferee.py",
      sha256: sourceSha256,
      bytes: Buffer.byteLength(code, "utf8"),
      runner: RUNNER,
      contract_version: CONTRACT_VERSION,
      policy_version: POLICY_VERSION,
    },
    constructor_args: constructorArgs,
    deployment: {},
    semantic_smoke: {},
    limitations: [
      "The proof covers one bundled bounded fictional transition, not arbitrary game canon.",
      "The controller supplies the fictional event; the contract does not prove an external event occurred.",
      "The immutable exact patch is deterministic; model consensus decides only semantic activation.",
      "Model routing, network timing, fees, and finality can change independently of this repository.",
    ],
  };
}

export async function prepareProofRun(
  client,
  code,
  constructorArgs,
  file,
  sourceVerifier = verifySourceCommit,
) {
  const networkProof = await assertNetwork(client);
  const sourceCommitProof = sourceVerifier(code, process.env.CANON_SOURCE_COMMIT);
  const sourceSha256 = createHash("sha256").update(code).digest("hex");
  const expectedCheckpoint = checkpointBase(code, sourceSha256, constructorArgs, client);
  Object.assign(expectedCheckpoint.network, {
    rpc_chain_id: networkProof.rpc_chain_id,
    rpc_chain_id_hex: networkProof.rpc_chain_id_hex,
    live_chain_id_verified: true,
  });
  expectedCheckpoint.source.commit_proof = sourceCommitProof;
  const checkpoint = loadCheckpoint(file, expectedCheckpoint);
  checkpoint.network.genvm_chain_id = Number(process.env.CANON_EXPECTED_GENVM_CHAIN_ID);
  Object.assign(checkpoint.network, {
    rpc_chain_id: networkProof.rpc_chain_id,
    rpc_chain_id_hex: networkProof.rpc_chain_id_hex,
    live_chain_id_verified: true,
  });
  checkpoint.source.commit_proof = sourceCommitProof;
  saveCheckpoint(file, checkpoint);
  return { checkpoint, network_proof: networkProof, source_commit_proof: sourceCommitProof };
}

function loadCheckpoint(file, expected) {
  if (!existsSync(file)) return expected;
  let current;
  try {
    current = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Refusing to overwrite an unreadable checkpoint: ${String(error)}`);
  }
  if (
    current?.schema_version !== expected.schema_version || current?.project !== expected.project ||
    current?.network?.chain_id !== expected.network.chain_id ||
    (current?.network?.rpc_chain_id !== undefined &&
      current.network.rpc_chain_id !== expected.network.rpc_chain_id) ||
    (current?.config_digest && current?.network?.genvm_chain_id !== undefined &&
      current.network.genvm_chain_id !== expected.network.genvm_chain_id) ||
    current?.source?.commit !== expected.source.commit || current?.source?.sha256 !== expected.source.sha256 ||
    jsonString(current?.constructor_args) !== jsonString(expected.constructor_args)
  ) {
    throw new Error("Refusing to overwrite a checkpoint for different source, network, or constructor arguments");
  }
  return current;
}

function envOrCheckpoint(envName, checkpointValue) {
  const supplied = String(process.env[envName] || "").trim();
  if (supplied && checkpointValue && supplied.toLowerCase() !== String(checkpointValue).toLowerCase()) {
    throw new Error(`${envName} conflicts with the checkpoint`);
  }
  return supplied || checkpointValue || "";
}

async function retryRead(label, operation, attempts = 24) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  throw new Error(`${label} failed after propagation retries: ${String(lastError)}`);
}

async function waitReceipt(client, hash, status, label, allowIdle = false) {
  const receipt = await client.waitForTransactionReceipt({
    hash,
    status,
    retries: status === "FINALIZED" ? 360 : 240,
    interval: 5_000,
  });
  assertPositiveReceipt(receipt, label, allowIdle);
  return receipt;
}

async function read(client, address, functionName, args = [], variant = "latest-final") {
  return client.readContract({
    address,
    functionName,
    args,
    jsonSafeReturn: true,
    transactionHashVariant: variant,
  });
}

function transactionAddress(transaction) {
  return String(transaction?.recipient ?? transaction?.to_address ?? transaction?.toAddress ?? "").toLowerCase();
}

function transactionSender(transaction) {
  const sender = String(transaction?.sender ?? transaction?.from_address ?? transaction?.fromAddress ?? "");
  assertAddress(sender, "transaction sender");
  return sender;
}

async function verifiedTransaction(client, hash, label, verify) {
  return retryRead(`${label} provenance`, async () => {
    const transaction = await client.getTransaction({ hash });
    if (!transaction) throw new Error("Transaction not found");
    verify(transaction);
    return transaction;
  });
}

export function assertDeploymentProvenance(transaction, address, code, args) {
  const decoded = transaction?.txDataDecoded ?? transaction?.tx_data_decoded;
  const constructorArgs = decoded?.constructorArgs ?? decoded?.constructor_args;
  const leaderOnly = decoded?.leaderOnly ?? decoded?.leader_only;
  if (
    transactionAddress(transaction) !== address.toLowerCase() ||
    String(decoded?.type || "").toLowerCase() !== "deploy" || leaderOnly !== false ||
    decoded?.code !== code ||
    jsonString(plainValue(mapValue(constructorArgs, "args") || [])) !== jsonString(args)
  ) {
    throw new Error("Deployment transaction does not match the exact local source and constructor arguments");
  }
  return transactionSender(transaction);
}

export function assertCallProvenance(transaction, address, args) {
  const decoded = transaction?.txDataDecoded ?? transaction?.tx_data_decoded;
  const callData = decoded?.callData ?? decoded?.call_data;
  const leaderOnly = decoded?.leaderOnly ?? decoded?.leader_only;
  if (
    transactionAddress(transaction) !== address.toLowerCase() ||
    String(decoded?.type || "").toLowerCase() !== "call" || leaderOnly !== false ||
    mapValue(callData, "method") !== "adjudicate_transition" ||
    jsonString(plainValue(mapValue(callData, "args") || [])) !== jsonString(args)
  ) {
    throw new Error("Semantic transaction does not match adjudicate_transition target and exact arguments");
  }
  return transactionSender(transaction);
}

function provenanceSummary(transaction) {
  const decoded = plainValue(transaction?.txDataDecoded ?? transaction?.tx_data_decoded ?? {});
  return {
    sender: transactionSender(transaction),
    recipient: transactionAddress(transaction),
    gas_limit: transaction?.gaslimit ?? transaction?.gasLimit ?? null,
    decoded,
  };
}

function expectedFinalizationCalldata(hash) {
  return `${FINALIZE_TRANSACTION_SELECTOR}${hash.slice(2)}`.toLowerCase();
}

export async function verifyFinalizationEvmTransaction(client, evmHash, transactionHash, label, attempts = 24) {
  assertHash(evmHash, `${label} finalization EVM hash`);
  const consensusAddress = String(client.chain?.consensusMainContract?.address || "").toLowerCase();
  assertAddress(consensusAddress, "consensus contract");
  const expectedInput = expectedFinalizationCalldata(transactionHash);
  return retryRead(`${label} EVM finalization proof`, async () => {
    const transaction = await client.request({ method: "eth_getTransactionByHash", params: [evmHash] });
    const receipt = await client.request({ method: "eth_getTransactionReceipt", params: [evmHash] });
    if (
      !transaction || String(transaction.to || "").toLowerCase() !== consensusAddress ||
      String(transaction.input ?? transaction.data ?? "").toLowerCase() !== expectedInput
    ) {
      throw new Error("Finalization EVM transaction target or calldata mismatch");
    }
    if (
      !receipt || String(receipt.transactionHash || "").toLowerCase() !== evmHash.toLowerCase() ||
      String(receipt.to || "").toLowerCase() !== consensusAddress ||
      String(receipt.status || "").toLowerCase() !== "0x1"
    ) {
      throw new Error("Finalization EVM receipt is absent, reverted, or mismatched");
    }
    return {
      transaction_hash: evmHash,
      consensus_contract: consensusAddress,
      calldata: expectedInput,
      receipt_status: "0x1",
      block_number: receipt.blockNumber ?? null,
    };
  }, attempts);
}

export async function finalizeWhenReady(client, transactionHash, label, step, envPrefix, checkpoint, file, verificationAttempts = 24) {
  let evmHash = envOrCheckpoint(`${envPrefix}_FINALIZATION_EVM_TX`, step.finalization_evm_transaction);
  if (evmHash) {
    step.finalization_evm_proof = await verifyFinalizationEvmTransaction(
      client, evmHash, transactionHash, label, verificationAttempts,
    );
    saveCheckpoint(file, checkpoint);
  }
  for (let attempt = 0; attempt < 720; attempt += 1) {
    const transaction = await retryRead(`${label} finality status`, () => client.getTransaction({ hash: transactionHash }), 3);
    const status = normalized(transaction?.statusName ?? transaction?.status_name ?? transaction?.status, STATUS_NAMES);
    if (status === "FINALIZED") {
      if (Number(client.chain?.id) === 4221 && !evmHash) {
        throw new Error(`${label} is finalized but its EVM finalization hash is absent; resume with ${envPrefix}_FINALIZATION_EVM_TX`);
      }
      if (evmHash) {
        step.finalization_evm_proof = await verifyFinalizationEvmTransaction(
          client, evmHash, transactionHash, label, verificationAttempts,
        );
      }
      const receipt = await waitReceipt(client, transactionHash, "FINALIZED", label);
      Object.assign(step, {
        finality_status: "FINALIZED",
        finalization_evm_transaction: evmHash || null,
        finalized_consensus: consensusSummary(receipt),
        finalized_receipt: plainValue(receipt),
      });
      saveCheckpoint(file, checkpoint);
      return receipt;
    }
    if (status === "READY_TO_FINALIZE") {
      if (!evmHash) {
        try {
          evmHash = await client.finalizeTransaction({ txId: transactionHash });
        } catch (error) {
          throw new Error(
            `${label} finalization broadcast outcome is unknown and will not be retried; recover ` +
            `${envPrefix}_FINALIZATION_EVM_TX or use a fresh proof run. ${String(error)}`,
          );
        }
        assertHash(evmHash, `${envPrefix}_FINALIZATION_EVM_TX`);
        step.finalization_evm_transaction = evmHash;
        saveCheckpoint(file, checkpoint);
        console.log(`${envPrefix}_FINALIZATION_EVM_TX=${evmHash}`);
        step.finalization_evm_proof = await verifyFinalizationEvmTransaction(
          client, evmHash, transactionHash, label, verificationAttempts,
        );
        saveCheckpoint(file, checkpoint);
      }
      await new Promise((resolve) => setTimeout(resolve, FINALITY_POLL_INTERVAL_MS));
      continue;
    }
    if (status !== "ACCEPTED") throw new Error(`${label} entered unexpected status ${status}`);
    await new Promise((resolve) => setTimeout(resolve, FINALITY_POLL_INTERVAL_MS));
  }
  throw new Error(`${label} did not become finalizable`);
}

async function withDeploymentGasCeiling(client, operation) {
  if (Number(client.chain?.id) !== 4221) return operation(null);
  const gasLimit = BigInt(process.env.CANON_DEPLOYMENT_EVM_GAS_LIMIT || DEFAULT_BRADBURY_DEPLOYMENT_GAS);
  if (
    gasLimit <= 0n || gasLimit > 100_000_000n ||
    typeof client.estimateTransactionGas !== "function"
  ) {
    throw new Error("Invalid Bradbury deployment gas ceiling or unsupported client");
  }
  const original = client.estimateTransactionGas;
  client.estimateTransactionGas = async () => gasLimit;
  try {
    return await operation(gasLimit);
  } finally {
    client.estimateTransactionGas = original;
  }
}

export async function submitFreshDeployment(client, code, args, checkpoint, file) {
  const step = checkpoint.deployment;
  if (step.submission_intent_recorded === true) {
    throw new Error(
      "Deployment submission intent exists without a captured hash; recover CANON_DEPLOYMENT_TX " +
      "or use a fresh output file instead of risking a duplicate deployment",
    );
  }
  const intent = {
    source_sha256: checkpoint.source.sha256,
    constructor_args_sha256: createHash("sha256").update(jsonString(args)).digest("hex"),
    leader_only: false,
  };
  Object.assign(step, { submission_intent_recorded: true, submission_intent: intent });
  saveCheckpoint(file, checkpoint);
  let gasCeiling = null;
  let hash;
  try {
    hash = await withDeploymentGasCeiling(client, async (ceiling) => {
      gasCeiling = ceiling ? ceiling.toString() : null;
      return client.deployContract({ code, args, leaderOnly: false });
    });
  } catch (error) {
    throw new Error(
      "Deployment broadcast outcome is unknown and will not be retried; recover CANON_DEPLOYMENT_TX " +
      `or use a fresh output file. ${String(error)}`,
    );
  }
  assertHash(hash, "CANON_DEPLOYMENT_TX");
  Object.assign(step, { transaction: hash, evm_gas_ceiling: gasCeiling });
  saveCheckpoint(file, checkpoint);
  return { hash, gas_ceiling: gasCeiling };
}

function assertSchema(schema) {
  const ctor = ["world_id", "canon_version", "canon_rules_json", "initial_state_json", "transition_catalog_json"];
  const methods = [
    "adjudicate_transition", "get_decision", "get_decision_count", "get_policy",
    "get_state_at", "get_transition", "get_world_state",
  ];
  if (
    schema?.ctor?.params?.length !== ctor.length ||
    schema.ctor.params.some((item, index) => item?.[0] !== ctor[index])
  ) throw new Error(`Unexpected constructor schema: ${jsonString(schema)}`);
  if (
    Object.keys(schema?.methods || {}).length !== methods.length ||
    methods.some((name) => !schema.methods[name])
  ) throw new Error(`Unexpected public schema: ${jsonString(schema)}`);
  if (schema.methods.adjudicate_transition.readonly !== false) {
    throw new Error("adjudicate_transition is unexpectedly readonly");
  }
}

function decodeDecisionId(receipts) {
  const ids = [];
  for (const receipt of receiptList(receipts)) {
    const result = plainValue(receipt?.result);
    if (String(mapValue(result, "status") || "").toLowerCase() !== "return") continue;
    const readable = mapValue(mapValue(result, "payload"), "readable");
    if (!/^[1-9][0-9]*$/.test(String(readable || ""))) {
      throw new Error(`Leader receipt omitted a positive decision ID: ${jsonString(result)}`);
    }
    ids.push(Number(readable));
  }
  if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id !== ids[0])) {
    throw new Error("Leader receipts do not expose one consistent safe decision ID");
  }
  return ids[0];
}

export function returnedDecisionId(transaction) {
  return decodeDecisionId(transaction?.consensus_data?.leader_receipt);
}

const TRACE_RETURN_KEYS = ["data", "events", "fingerprint", "kind", "storage_changes"];

export function decodedTraceDecisionId(decoded) {
  if (!(decoded instanceof Map)) {
    throw new Error("Execution trace return is not a typed top-level GenLayer Map");
  }
  const keys = [...decoded.keys()];
  if (
    keys.length !== TRACE_RETURN_KEYS.length ||
    keys.some((key, index) => key !== TRACE_RETURN_KEYS[index])
  ) {
    throw new Error(`Execution trace return has unexpected top-level keys: ${jsonString(keys)}`);
  }
  if (decoded.get("kind") !== "Return") {
    throw new Error("Execution trace top-level kind is not Return");
  }
  if (!Array.isArray(decoded.get("events"))) {
    throw new Error("Execution trace Return events field is not an array");
  }
  if (!(decoded.get("fingerprint") instanceof Map)) {
    throw new Error("Execution trace Return fingerprint field is not a typed Map");
  }
  if (!Array.isArray(decoded.get("storage_changes"))) {
    throw new Error("Execution trace Return storage_changes field is not an array");
  }
  const data = decoded.get("data");
  if (typeof data !== "bigint" || data < 1n || data > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Execution trace Return data is not a positive safe bigint decision ID");
  }
  return Number(data);
}

export function traceDecisionId(trace) {
  if (trace?.result_code !== 0) throw new Error("Execution trace did not finish with a return");
  const data = String(trace?.return_data || "").trim();
  if (!/^(?:0x)?[0-9a-fA-F]+$/.test(data)) {
    throw new Error("Execution trace omitted hex-encoded GenLayer return calldata");
  }
  const normalizedData = data.startsWith("0x") ? data.slice(2) : data;
  if (normalizedData.length % 2 !== 0) throw new Error("Execution trace return data has odd length");
  let decoded;
  try {
    decoded = genlayerAbi.calldata.decode(Uint8Array.from(Buffer.from(normalizedData, "hex")));
  } catch (error) {
    throw new Error(`Execution trace return calldata could not be decoded: ${String(error)}`);
  }
  return decodedTraceDecisionId(decoded);
}

async function transactionReturnedDecisionId(client, transaction, hash) {
  try {
    return returnedDecisionId(transaction);
  } catch (receiptError) {
    if (typeof client.debugTraceTransaction !== "function") {
      throw new Error(`Semantic return provenance is absent and debug trace is unavailable: ${String(receiptError)}`);
    }
    const round = Number(transaction?.lastRound?.round ?? transaction?.last_round?.round ?? 0);
    if (!Number.isSafeInteger(round) || round < 0) throw new Error("Semantic transaction has invalid round data");
    return retryRead("Semantic return trace", async () => {
      const trace = await client.debugTraceTransaction({ hash, round });
      return traceDecisionId(trace);
    });
  }
}

function expectedStateAfter() {
  return { ...INITIAL_STATE, dragon_awake: true };
}

function expectedSemanticArgs(before) {
  return [
    SMOKE_REFERENCE,
    before.state_digest,
    SMOKE_EVENT,
    SMOKE_TRANSITION,
    canonicalText(expectedStateAfter()),
  ];
}

export function assertGenesisStateBefore(policy, before) {
  const expectedDigest = contractDigest("STATE", [
    policy.config_digest,
    "0",
    "GENESIS",
    "",
    canonicalText(INITIAL_STATE),
  ]);
  if (
    !before || before.world_id !== policy.world_id ||
    before.canon_version !== policy.canon_version || Number(before.state_version) !== 0 ||
    before.state_json !== canonicalText(INITIAL_STATE) || before.state_digest !== expectedDigest ||
    before.config_digest !== policy.config_digest
  ) {
    throw new Error(`Semantic state_before is not the exact immutable genesis state: ${jsonString(before)}`);
  }
  return expectedDigest;
}

export function resumeSemanticInputs(step, policy) {
  if (!step || step.submission_intent_recorded !== true) {
    throw new Error("Captured semantic transaction lacks its durable submission intent");
  }
  const before = plainValue(step.state_before);
  assertGenesisStateBefore(policy, before);
  const expectedArgs = expectedSemanticArgs(before);
  if (!Array.isArray(step.args) || jsonString(plainValue(step.args)) !== jsonString(expectedArgs)) {
    throw new Error("Captured semantic transaction checkpoint args do not match the exact genesis-bound call");
  }
  return { before, args: expectedArgs };
}

function expectedConstructorArgs() {
  const worldId = String(process.env.CANON_WORLD_ID || "EMBER-REALM");
  const canonVersion = String(process.env.CANON_VERSION || "CANON-V1");
  return [worldId, canonVersion, JSON.stringify(CANON), JSON.stringify(INITIAL_STATE), JSON.stringify(TRANSITIONS)];
}

export function expectedConfigDigest(genVmChainId, address, controller, args) {
  return contractDigest("CONFIG", [
    String(genVmChainId), address.toLowerCase(), controller.toLowerCase(), args[0], args[1],
    canonicalText(CANON), canonicalText(INITIAL_STATE), canonicalText(TRANSITIONS), POLICY_VERSION,
  ]);
}

export function assertPolicy(policy, genVmChainId, address, controller, args) {
  const configDigest = expectedConfigDigest(genVmChainId, address, controller, args);
  if (
    policy?.contract_version !== CONTRACT_VERSION || policy?.policy_version !== POLICY_VERSION ||
    policy?.scope !== SCOPE || String(policy?.controller || "").toLowerCase() !== controller.toLowerCase() ||
    policy?.world_id !== args[0] || policy?.canon_version !== args[1] ||
    policy?.canon_rules_json !== canonicalText(CANON) ||
    policy?.transition_catalog_json !== canonicalText(TRANSITIONS) ||
    policy?.transition_ids_json !== JSON.stringify([SMOKE_TRANSITION]) ||
    policy?.config_digest !== configDigest
  ) throw new Error(`Finalized policy does not match the exact deployment: ${jsonString(policy)}`);
  return configDigest;
}

function expectedRequestDigest(configDigest, sender, args) {
  return contractDigest("REQUEST", [configDigest, sender.toLowerCase(), ...args]);
}

export function assertExactSemanticRecord({ policy, before, decision, after, history, decisionId, sender, args }) {
  const proposed = expectedStateAfter();
  const requestDigest = expectedRequestDigest(policy.config_digest, sender, args);
  const expectedAfterDigest = contractDigest("STATE", [
    policy.config_digest, "1", before.state_digest, requestDigest, canonicalText(proposed),
  ]);
  const expectedGenesisDigest = contractDigest("STATE", [
    policy.config_digest, "0", "GENESIS", "", canonicalText(INITIAL_STATE),
  ]);
  if (
    before?.world_id !== policy.world_id || before?.canon_version !== policy.canon_version ||
    Number(before?.state_version) !== 0 || before?.state_json !== canonicalText(INITIAL_STATE) ||
    before?.state_digest !== expectedGenesisDigest || before?.config_digest !== policy.config_digest
  ) throw new Error(`Unexpected finalized state before semantic call: ${jsonString(before)}`);
  if (
    Number(decision?.decision_id) !== decisionId || decisionId !== 1 ||
    String(decision?.submitter || "").toLowerCase() !== sender.toLowerCase() ||
    decision?.request_reference !== SMOKE_REFERENCE || decision?.request_digest !== requestDigest ||
    decision?.expected_state_digest !== before.state_digest || decision?.event_text !== SMOKE_EVENT ||
    decision?.transition_id !== SMOKE_TRANSITION || decision?.proposed_next_state_json !== canonicalText(proposed) ||
    decision?.status !== "VALID_TRANSITION" || decision?.reason_code !== "TRANSITION_SUPPORTED" ||
    decision?.canon_rule_ids_json !== JSON.stringify(["RULE-EMBER-KEY"]) ||
    decision?.state_keys_json !== JSON.stringify(["active_hero_class", "dragon_awake", "ember_key_held"]) ||
    decision?.changed_keys_json !== JSON.stringify(["dragon_awake"]) ||
    Number(decision?.state_version_before) !== 0 || Number(decision?.state_version_after) !== 1 ||
    decision?.state_digest_after !== expectedAfterDigest || decision?.applied !== true ||
    decision?.config_digest !== policy.config_digest || decision?.policy_version !== POLICY_VERSION ||
    decision?.scope !== SCOPE
  ) throw new Error(`Unexpected exact semantic decision: ${jsonString(decision)}`);
  if (
    after?.world_id !== policy.world_id || after?.canon_version !== policy.canon_version ||
    Number(after?.state_version) !== 1 || after?.state_json !== canonicalText(proposed) ||
    after?.state_digest !== expectedAfterDigest || after?.config_digest !== policy.config_digest
  ) throw new Error(`Unexpected state after semantic call: ${jsonString(after)}`);
  if (
    Number(history?.state_version) !== 1 || history?.state_json !== after.state_json ||
    history?.state_digest !== after.state_digest || history?.previous_state_digest !== before.state_digest ||
    history?.request_digest !== requestDigest
  ) throw new Error(`State-history lineage mismatch: ${jsonString(history)}`);
  return { request_digest: requestDigest, state_digest_after: expectedAfterDigest };
}

export async function submitAndProveSemantic(client, address, policy, checkpoint, file) {
  const step = checkpoint.semantic_smoke;
  let hash = envOrCheckpoint("CANON_SEMANTIC_TX", step.transaction);
  if (hash) assertHash(hash, "CANON_SEMANTIC_TX");
  let before;
  let args;
  if (hash) {
    ({ before, args } = resumeSemanticInputs(step, policy));
  } else {
    before = await retryRead(
      "Finalized state before fresh semantic call",
      () => read(client, address, "get_world_state"),
    );
    const countBefore = Number(await retryRead(
      "Finalized decision count before fresh semantic call",
      () => read(client, address, "get_decision_count"),
    ));
    assertGenesisStateBefore(policy, before);
    if (countBefore !== 0) {
      throw new Error("Fresh semantic submission requires exactly zero prior decisions");
    }
    args = expectedSemanticArgs(before);
  }
  if (!hash) {
    if (step.submission_intent_recorded === true) {
      throw new Error(
        "Semantic submission intent exists without a captured hash; recover CANON_SEMANTIC_TX or use a fresh deployment/output",
      );
    }
    Object.assign(step, { submission_intent_recorded: true, args, state_before: plainValue(before) });
    saveCheckpoint(file, checkpoint);
    hash = await client.writeContract({
      address,
      functionName: "adjudicate_transition",
      args,
      value: 0n,
      leaderOnly: false,
    });
    assertHash(hash, "CANON_SEMANTIC_TX");
    step.transaction = hash;
    saveCheckpoint(file, checkpoint);
    console.log(`CANON_SEMANTIC_TX=${hash}`);
  }
  const accepted = await waitReceipt(client, hash, "ACCEPTED", "Exact semantic transition");
  const transaction = await verifiedTransaction(
    client, hash, "Exact semantic transition", (candidate) => assertCallProvenance(candidate, address, args),
  );
  const sender = transactionSender(transaction);
  if (sender.toLowerCase() !== String(policy.controller).toLowerCase()) {
    throw new Error("Semantic transaction sender is not the immutable controller");
  }
  const decisionId = await transactionReturnedDecisionId(client, transaction, hash);
  const decision = await retryRead(
    "Transaction-bound nonfinal decision", () => read(client, address, "get_decision", [decisionId], "latest-nonfinal"),
  );
  const after = await retryRead("Nonfinal world state", () => read(client, address, "get_world_state", [], "latest-nonfinal"));
  const history = await retryRead(
    "Nonfinal state-history entry", () => read(client, address, "get_state_at", [1], "latest-nonfinal"),
  );
  const lineage = assertExactSemanticRecord({ policy, before, decision, after, history, decisionId, sender, args });
  Object.assign(step, {
    submission_intent_recorded: true,
    transaction: hash,
    args,
    sender,
    decision_id: decisionId,
    transaction_provenance: provenanceSummary(transaction),
    accepted_consensus: consensusSummary(accepted),
    accepted_receipt: plainValue(accepted),
    state_before: plainValue(before),
    decision: plainValue(decision),
    state_after: plainValue(after),
    state_history_entry: plainValue(history),
    lineage,
  });
  saveCheckpoint(file, checkpoint);
  await finalizeWhenReady(client, hash, "Exact semantic transition", step, "CANON_SEMANTIC", checkpoint, file);
  const finalDecision = await retryRead(
    "Finalized transaction-bound decision", () => read(client, address, "get_decision", [decisionId]),
  );
  const finalAfter = await retryRead("Finalized world state", () => read(client, address, "get_world_state"));
  const finalHistory = await retryRead("Finalized state-history entry", () => read(client, address, "get_state_at", [1]));
  const finalCount = Number(await retryRead("Finalized decision count", () => read(client, address, "get_decision_count")));
  if (finalCount !== 1) throw new Error(`Finalized decision count is ${finalCount}, expected exactly 1`);
  assertExactSemanticRecord({
    policy,
    before,
    decision: finalDecision,
    after: finalAfter,
    history: finalHistory,
    decisionId,
    sender,
    args,
  });
  Object.assign(step, {
    decision: plainValue(finalDecision),
    state_after: plainValue(finalAfter),
    state_history_entry: plainValue(finalHistory),
    latest_final_verified: true,
  });
  saveCheckpoint(file, checkpoint);
}

export default async function deployAndSmoke(client) {
  requiredEnvironment([
    "CANON_SOURCE_COMMIT",
    "CANON_DEPLOYMENT_OUTPUT",
    "CANON_EXPECTED_GENVM_CHAIN_ID",
  ]);
  assertLowerHex(process.env.CANON_SOURCE_COMMIT, 40, "CANON_SOURCE_COMMIT");
  const file = outputPath();
  const code = readFileSync(CONTRACT_PATH, "utf8");
  if (!code.startsWith(`# { "Depends": "${RUNNER}" }`)) throw new Error("Pinned runner header mismatch");
  const args = expectedConstructorArgs();
  const deploymentBytes = Buffer.byteLength(code, "utf8") + Buffer.byteLength(jsonString(args), "utf8");
  if (deploymentBytes >= 50_000) throw new Error(`Deployment input is ${deploymentBytes} bytes; portable limit is below 50,000`);
  const { checkpoint } = await prepareProofRun(client, code, args, file);

  let deploymentHash = envOrCheckpoint("CANON_DEPLOYMENT_TX", checkpoint.deployment.transaction);
  let gasCeiling = checkpoint.deployment.evm_gas_ceiling || null;
  if (deploymentHash) assertHash(deploymentHash, "CANON_DEPLOYMENT_TX");
  if (!deploymentHash) {
    const submitted = await submitFreshDeployment(client, code, args, checkpoint, file);
    deploymentHash = submitted.hash;
    gasCeiling = submitted.gas_ceiling;
    console.log(`CANON_DEPLOYMENT_TX=${deploymentHash}`);
  }

  const accepted = await waitReceipt(client, deploymentHash, "ACCEPTED", "Deployment", true);
  const receiptAddress = accepted?.data?.contract_address ?? accepted?.txDataDecoded?.contractAddress ??
    accepted?.tx_data_decoded?.contract_address ?? "";
  const configuredAddress = envOrCheckpoint("CANON_CONTRACT_ADDRESS", checkpoint.deployment.contract_address);
  const address = String(receiptAddress || configuredAddress);
  assertAddress(address, "deployed contract address");
  if (configuredAddress && configuredAddress.toLowerCase() !== address.toLowerCase()) {
    throw new Error("CANON_CONTRACT_ADDRESS conflicts with the deployment receipt");
  }
  const transaction = await verifiedTransaction(
    client,
    deploymentHash,
    "Deployment",
    (candidate) => assertDeploymentProvenance(candidate, address, code, args),
  );
  const deployer = transactionSender(transaction);
  Object.assign(checkpoint.deployment, {
    transaction: deploymentHash,
    contract_address: address,
    deployer,
    evm_gas_ceiling: gasCeiling,
    transaction_provenance: provenanceSummary(transaction),
    accepted_consensus: consensusSummary(accepted),
    accepted_receipt: plainValue(accepted),
  });
  checkpoint.deployment_input_bytes = deploymentBytes;
  saveCheckpoint(file, checkpoint);
  console.log(`CANON_CONTRACT_ADDRESS=${address}`);
  await finalizeWhenReady(client, deploymentHash, "Deployment", checkpoint.deployment, "CANON_DEPLOYMENT", checkpoint, file);

  const deployedCode = await retryRead("Finalized deployed source", () => client.getContractCode(address));
  if (deployedCode !== code) throw new Error("Finalized deployed source differs from exact local source");
  assertSchema(await retryRead("Finalized contract schema", () => client.getContractSchema(address)));
  const policy = await retryRead("Finalized immutable policy", () => read(client, address, "get_policy"));
  const configDigest = assertPolicy(
    policy,
    Number(process.env.CANON_EXPECTED_GENVM_CHAIN_ID),
    address,
    deployer,
    args,
  );
  const genesis = await retryRead("Finalized genesis history", () => read(client, address, "get_state_at", [0]));
  const expectedGenesis = contractDigest("STATE", [configDigest, "0", "GENESIS", "", canonicalText(INITIAL_STATE)]);
  if (
    Number(genesis?.state_version) !== 0 || genesis?.state_json !== canonicalText(INITIAL_STATE) ||
    genesis?.state_digest !== expectedGenesis || genesis?.previous_state_digest !== "GENESIS" || genesis?.request_digest !== ""
  ) throw new Error(`Finalized genesis state is not bound to the exact constructor: ${jsonString(genesis)}`);
  Object.assign(checkpoint, { config_digest: configDigest, policy: plainValue(policy), genesis: plainValue(genesis) });
  saveCheckpoint(file, checkpoint);

  await submitAndProveSemantic(client, address, policy, checkpoint, file);
  checkpoint.status = "FINALIZED";
  saveCheckpoint(file, checkpoint);
  console.log(`CANON_DEPLOYMENT_RESULT=${jsonString(checkpoint)}`);
}
