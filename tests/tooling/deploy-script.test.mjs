import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { abi as genlayerAbi } from "genlayer-js";
import {
  assertCallProvenance,
  assertDeploymentProvenance,
  assertExactSemanticRecord,
  canonicalJson,
  contractDigest,
  decodedTraceDecisionId,
  expectedConfigDigest,
  finalizeWhenReady,
  redactRpc,
  returnedDecisionId,
  traceDecisionId,
} from "../../deploy/001_deploy_and_smoke.js";

const contract = readFileSync(
  new URL("../../contracts/CanonWorldStateReferee.py", import.meta.url),
  "utf8",
);
const deployment = readFileSync(
  new URL("../../deploy/001_deploy_and_smoke.js", import.meta.url),
  "utf8",
);

const address = `0x${"1".repeat(40)}`;
const controller = `0x${"2".repeat(40)}`;
const canon = [{
  id: "RULE-EMBER-KEY",
  text: "Only a fire mage holding the Ember Key may awaken the Ember Dragon.",
}];
const initial = {
  active_hero_class: "FIRE_MAGE",
  dragon_awake: false,
  ember_key_held: true,
};
const transitions = [{
  id: "AWAKEN_DRAGON",
  description: "Awaken the Ember Dragon only when the active hero is a fire mage, the Ember Key is held, and the dragon is asleep. The only effect is dragon_awake becoming true.",
  required_state: initial,
  state_patch: { dragon_awake: true },
  applicable_canon_rule_ids: ["RULE-EMBER-KEY"],
}];
const constructorArgs = [
  "EMBER-REALM",
  "CANON-V1",
  JSON.stringify(canon),
  JSON.stringify(initial),
  JSON.stringify(transitions),
];

test("production runner and exact default deployment remain portable", () => {
  assert.match(contract.split(/\r?\n/, 1)[0], /^# \{ "Depends": "py-genlayer:[a-z0-9]+" \}$/);
  assert.doesNotMatch(contract.split(/\r?\n/, 1)[0], /:(test|latest)"/);
  const bytes = Buffer.byteLength(contract, "utf8") + Buffer.byteLength(JSON.stringify(constructorArgs), "utf8");
  assert.ok(bytes < 50_000, `default deployment is ${bytes} bytes`);
});

test("proof harness includes fail-closed resume, provenance, finality, and final reads", () => {
  for (const expected of [
    "CANON_DEPLOYMENT_TX",
    "CANON_CONTRACT_ADDRESS",
    "CANON_SEMANTIC_TX",
    "submission_intent_recorded",
    "exact local source and constructor arguments",
    "FINALIZATION_EVM_TX",
    "broadcast outcome is unknown",
    "latest-final",
    "getContractCode",
    "getContractSchema",
    "state_history_entry",
    "accepted_receipt",
    "finalized_receipt",
  ]) assert.ok(deployment.includes(expected), `missing ${expected}`);
});

test("digest and RPC helpers match stable canonical forms", () => {
  assert.deepEqual(canonicalJson({ z: 1, a: { y: 2, b: 3 } }), { a: { b: 3, y: 2 }, z: 1 });
  assert.equal(
    contractDigest("TEST", ["a", "bc"]),
    "1153dc973ea4dca8a5e65f86c8ba35994b97dc3ea5e1f6e37b75def971d99600",
  );
  assert.equal(redactRpc("https://user:secret@rpc.example.com/key?token=x"), "https://rpc.example.com");
  assert.equal(redactRpc("not a url"), "REDACTED");
  const genVmDigest = expectedConfigDigest(1, address, controller, constructorArgs);
  const outerEvmDigest = expectedConfigDigest(4221, address, controller, constructorArgs);
  assert.match(genVmDigest, /^[0-9a-f]{64}$/);
  assert.notEqual(
    genVmDigest,
    outerEvmDigest,
    "outer EVM chain ID must not be substituted for gl.message.chain_id",
  );
  assert.equal(
    expectedConfigDigest(
      1,
      "0x16979e840253025c089eb59419dd97f222e3143c",
      "0x797d3b25fb2cca0ff93f60df1910267f3822d655",
      constructorArgs,
    ),
    "bb9e89c6bf8e85196463cd6b683984d0aa42301861ef7665998adf9337ff2e24",
    "known Bradbury deployment digest must remain bound to GenVM chain ID 1",
  );
});

test("decoded deployment and semantic call provenance reject mismatches", () => {
  const deploy = {
    recipient: address,
    sender: controller,
    txDataDecoded: {
      type: "deploy",
      leaderOnly: false,
      code: contract,
      constructorArgs: { args: constructorArgs },
    },
  };
  assert.equal(assertDeploymentProvenance(deploy, address, contract, constructorArgs), controller);
  assert.throws(
    () => assertDeploymentProvenance(deploy, address, `${contract}\n`, constructorArgs),
    /exact local source/,
  );
  const args = ["DEPLOY-SMOKE-001", "a".repeat(64), "event", "AWAKEN_DRAGON", "{}"];
  const call = {
    recipient: address,
    sender: controller,
    txDataDecoded: {
      type: "call",
      leaderOnly: false,
      callData: { method: "adjudicate_transition", args },
    },
  };
  assert.equal(assertCallProvenance(call, address, args), controller);
  call.txDataDecoded.callData.method = "get_policy";
  assert.throws(() => assertCallProvenance(call, address, args), /exact arguments/);
});

test("return provenance binds one consensus decision ID", () => {
  assert.equal(returnedDecisionId({
    consensus_data: { leader_receipt: [{ result: { status: "return", payload: { readable: "1" } } }] },
  }), 1);
  assert.throws(
    () => returnedDecisionId({
      consensus_data: { leader_receipt: [
        { result: { status: "return", payload: { readable: "1" } } },
        { result: { status: "return", payload: { readable: "2" } } },
      ] },
    }),
    /consistent safe decision ID/,
  );
  assert.throws(() => traceDecisionId({ result_code: 1, return_data: "0x8901" }), /did not finish/);
});


test("Bradbury typed trace extracts only its exact top-level Return data", () => {
  const actualShape = new Map([
    ["data", 1n],
    ["events", []],
    ["fingerprint", new Map([
      ["frames", [new Map([["func", 130n], ["module_name", "cpython"]])]],
      ["nested", new Map([["data", 999n]])],
    ])],
    ["kind", "Return"],
    ["storage_changes", [new Map([["decision_count", 1n], ["data", 777n]])]],
  ]);
  const encoded = "0x" + Buffer.from(genlayerAbi.calldata.encode(actualShape)).toString("hex");
  assert.equal(traceDecisionId({ result_code: 0, return_data: encoded }), 1);
  assert.equal(decodedTraceDecisionId(actualShape), 1);
  assert.throws(
    () => traceDecisionId({ result_code: 1, return_data: encoded }),
    /did not finish with a return/,
  );
  assert.throws(
    () => traceDecisionId({ result_code: "0", return_data: encoded }),
    /did not finish with a return/,
  );
  assert.throws(
    () => decodedTraceDecisionId(new Map([
      ["events", []],
      ["fingerprint", new Map([["data", 1n]])],
      ["kind", "Return"],
      ["storage_changes", []],
    ])),
    /unexpected top-level keys/,
  );
  assert.throws(
    () => decodedTraceDecisionId(new Map([...actualShape, ["extra", 2n]])),
    /unexpected top-level keys/,
  );
  assert.throws(
    () => decodedTraceDecisionId(new Map([...actualShape].map(([key, value]) => [
      key,
      key === "kind" ? "Rollback" : value,
    ]))),
    /kind is not Return/,
  );
  assert.throws(
    () => decodedTraceDecisionId(new Map([...actualShape].map(([key, value]) => [
      key,
      key === "data" ? BigInt(Number.MAX_SAFE_INTEGER) + 1n : value,
    ]))),
    /positive safe bigint/,
  );
  assert.throws(
    () => decodedTraceDecisionId(new Map([...actualShape].map(([key, value]) => [
      key,
      key === "data" ? 1 : value,
    ]))),
    /positive safe bigint/,
  );
});

test("exact semantic record validates request and state digest lineage", () => {
  const configDigest = expectedConfigDigest(1, address, controller, constructorArgs);
  const policy = {
    config_digest: configDigest,
    world_id: "EMBER-REALM",
    canon_version: "CANON-V1",
  };
  const proposed = { ...initial, dragon_awake: true };
  const proposedJson = JSON.stringify(proposed);
  const beforeDigest = contractDigest("STATE", [configDigest, "0", "GENESIS", "", JSON.stringify(initial)]);
  const args = [
    "DEPLOY-SMOKE-001",
    beforeDigest,
    "The active fire mage presents the held Ember Key and awakens the sleeping Ember Dragon.",
    "AWAKEN_DRAGON",
    proposedJson,
  ];
  const requestDigest = contractDigest("REQUEST", [configDigest, controller, ...args]);
  const afterDigest = contractDigest("STATE", [configDigest, "1", beforeDigest, requestDigest, proposedJson]);
  const before = {
    world_id: policy.world_id,
    canon_version: policy.canon_version,
    state_version: 0,
    state_json: JSON.stringify(initial),
    state_digest: beforeDigest,
    config_digest: configDigest,
  };
  const decision = {
    decision_id: 1,
    submitter: controller,
    request_reference: args[0],
    request_digest: requestDigest,
    expected_state_digest: beforeDigest,
    event_text: args[2],
    transition_id: args[3],
    proposed_next_state_json: proposedJson,
    status: "VALID_TRANSITION",
    reason_code: "TRANSITION_SUPPORTED",
    canon_rule_ids_json: '["RULE-EMBER-KEY"]',
    state_keys_json: '["active_hero_class","dragon_awake","ember_key_held"]',
    changed_keys_json: '["dragon_awake"]',
    state_version_before: 0,
    state_version_after: 1,
    state_digest_after: afterDigest,
    applied: true,
    config_digest: configDigest,
    policy_version: "CANON_WORLD_STATE_TRANSITION_V2",
    scope: "ONE_EVENT_ONE_PREDEFINED_TRANSITION",
  };
  const after = {
    world_id: policy.world_id,
    canon_version: policy.canon_version,
    state_version: 1,
    state_json: proposedJson,
    state_digest: afterDigest,
    config_digest: configDigest,
  };
  const history = {
    state_version: 1,
    state_json: proposedJson,
    state_digest: afterDigest,
    previous_state_digest: beforeDigest,
    request_digest: requestDigest,
  };
  assert.deepEqual(
    assertExactSemanticRecord({ policy, before, decision, after, history, decisionId: 1, sender: controller, args }),
    { request_digest: requestDigest, state_digest_after: afterDigest },
  );
  assert.throws(
    () => assertExactSemanticRecord({
      policy,
      before,
      decision: { ...decision, request_digest: "0".repeat(64) },
      after,
      history,
      decisionId: 1,
      sender: controller,
      args,
    }),
    /semantic decision/,
  );
});

test("invalid EVM finalization proof is not suppressed after broadcast", async () => {
  const directory = mkdtempSync(join(tmpdir(), "canon-finality-"));
  const output = join(directory, "proof.json");
  const transactionHash = `0x${"3".repeat(64)}`;
  const evmHash = `0x${"4".repeat(64)}`;
  const consensus = `0x${"5".repeat(40)}`;
  const client = {
    chain: { id: 4221, consensusMainContract: { address: consensus } },
    getTransaction: async () => ({ statusName: "READY_TO_FINALIZE" }),
    finalizeTransaction: async () => evmHash,
    request: async ({ method }) => method === "eth_getTransactionByHash"
      ? { to: `0x${"6".repeat(40)}`, input: "0x00" }
      : { transactionHash: evmHash, to: consensus, status: "0x1" },
  };
  const step = {};
  try {
    await assert.rejects(
      finalizeWhenReady(client, transactionHash, "Test", step, "CANON_TEST", { test: step }, output, 1),
      /target or calldata mismatch/,
    );
    assert.equal(step.finalization_evm_transaction, evmHash);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unknown finalization broadcast outcome fails closed without retry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "canon-broadcast-"));
  const output = join(directory, "proof.json");
  let broadcasts = 0;
  const client = {
    chain: { id: 4221, consensusMainContract: { address: `0x${"5".repeat(40)}` } },
    getTransaction: async () => ({ statusName: "READY_TO_FINALIZE" }),
    finalizeTransaction: async () => {
      broadcasts += 1;
      throw new Error("timeout after submission");
    },
  };
  try {
    await assert.rejects(
      finalizeWhenReady(
        client,
        `0x${"3".repeat(64)}`,
        "Test",
        {},
        "CANON_TEST",
        { test: {} },
        output,
        1,
      ),
      /will not be retried/,
    );
    assert.equal(broadcasts, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
