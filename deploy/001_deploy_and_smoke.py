"""Deploy and record an exact semantic smoke test.

Run from the repository root:
    gltest deploy/001_deploy_and_smoke.py -v -s --network studionet
    gltest deploy/001_deploy_and_smoke.py -v -s --network testnet_bradbury
"""

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path

from gltest import get_contract_factory
from gltest.assertions import tx_execution_succeeded
from gltest.types import TransactionStatus
from gltest.utils import extract_contract_address
from gltest_cli.config.general import get_general_config


ROOT = Path(__file__).resolve().parents[1]
CONTRACT_PATH = ROOT / "contracts" / "CanonWorldStateReferee.py"
PORTABLE_DEPLOYMENT_INPUT_LIMIT = 50_000

CANON = [
    {
        "id": "RULE-EMBER-KEY",
        "text": "Only a fire mage holding the Ember Key may awaken the Ember Dragon.",
    }
]
INITIAL_STATE = {
    "active_hero_class": "FIRE_MAGE",
    "dragon_awake": False,
    "ember_key_held": True,
}
TRANSITIONS = [
    {
        "id": "AWAKEN_DRAGON",
        "description": (
            "Awaken the Ember Dragon only when the active hero is a fire mage, the Ember Key is held, "
            "and the dragon is asleep. The only effect is dragon_awake becoming true."
        ),
        "required_state": {
            "active_hero_class": "FIRE_MAGE",
            "dragon_awake": False,
            "ember_key_held": True,
        },
        "state_patch": {"dragon_awake": True},
        "applicable_canon_rule_ids": ["RULE-EMBER-KEY"],
    }
]
SMOKE_REQUEST_REFERENCE = "DEPLOY-SMOKE-001"
SMOKE_EVENT = "The active fire mage presents the held Ember Key and awakens the sleeping Ember Dragon."
SMOKE_TRANSITION_ID = "AWAKEN_DRAGON"


def _compact(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _expected_smoke_state():
    proposed = dict(INITIAL_STATE)
    proposed["dragon_awake"] = True
    return proposed


def _json_safe(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if hasattr(value, "to_dict"):
        return _json_safe(value.to_dict())
    if hasattr(value, "__dict__"):
        return _json_safe(vars(value))
    return str(value)


def _output_path(network):
    configured = os.environ.get("CANON_DEPLOY_OUTPUT", f"deployments/{network}-smoke.json")
    candidate = (ROOT / configured).resolve()
    deployment_directory = (ROOT / "deployments").resolve()
    if candidate.parent != deployment_directory or candidate.suffix.lower() != ".json":
        raise AssertionError("CANON_DEPLOY_OUTPUT must name a JSON file directly inside deployments/")
    return candidate


def _atomic_write_json(path, value):
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def _source_commit():
    value = os.environ.get("CANON_SOURCE_COMMIT", "")
    if len(value) not in (40, 64) or value.lower() != value or any(
        character not in "0123456789abcdef" for character in value
    ):
        raise AssertionError("CANON_SOURCE_COMMIT must be a full lowercase hexadecimal commit ID")
    return value


def _transaction_identifiers(value):
    result = []
    accepted_keys = {"transaction_hash", "transaction_id", "tx_hash", "tx_id", "hash"}

    def visit(item, path):
        if isinstance(item, dict):
            for key, child in item.items():
                child_path = f"{path}.{key}" if path else str(key)
                if str(key).lower() in accepted_keys and isinstance(child, str):
                    if child.startswith("0x") and len(child) == 66:
                        candidate = {"path": child_path, "value": child.lower()}
                        if candidate not in result:
                            result.append(candidate)
                visit(child, child_path)
        elif isinstance(item, list):
            for index, child in enumerate(item):
                visit(child, f"{path}[{index}]")

    visit(value, "")
    return result


def _assert_resume_record(record, network, chain_id, source_sha256, source_commit, constructor_args):
    assert record.get("project") == "canon-world-state-referee"
    assert record.get("network") == network
    assert record.get("chain_id") == chain_id
    assert record.get("contract_source_sha256") == source_sha256
    assert record.get("source_commit") == source_commit
    constructor = record.get("constructor", {})
    assert constructor.get("world_id") == constructor_args[0]
    assert constructor.get("canon_version") == constructor_args[1]
    assert constructor.get("canon_rules_json") == constructor_args[2]
    assert constructor.get("initial_state_json") == constructor_args[3]
    assert constructor.get("transition_catalog_json") == constructor_args[4]


def _assert_completed_smoke(contract, record, policy):
    smoke = record.get("smoke", {})
    before = smoke.get("state_before", {})
    expected_state = _expected_smoke_state()
    genesis = _json_safe(contract.get_state_at(args=[0]).call())
    decision_count = contract.get_decision_count().call()
    decision = _json_safe(contract.get_decision(args=[1]).call())
    after = _json_safe(contract.get_world_state().call())
    history = _json_safe(contract.get_state_at(args=[1]).call())
    receipt = smoke.get("receipt", {})
    transaction_identifiers = _transaction_identifiers(receipt)

    assert smoke.get("request_reference") == SMOKE_REQUEST_REFERENCE
    assert before.get("world_id") == policy["world_id"]
    assert before.get("canon_version") == policy["canon_version"]
    assert before.get("config_digest") == policy["config_digest"]
    assert before.get("state_version") == 0
    assert before.get("state_json") == genesis["state_json"]
    assert before.get("state_digest") == genesis["state_digest"]
    assert genesis["previous_state_digest"] == "GENESIS"
    assert genesis["request_digest"] == ""

    assert decision_count == 1
    assert decision["decision_id"] == 1
    assert decision["submitter"] == _json_safe(policy["controller"])
    assert decision["request_reference"] == SMOKE_REQUEST_REFERENCE
    assert decision["expected_state_digest"] == before["state_digest"]
    assert decision["event_text"] == SMOKE_EVENT
    assert decision["transition_id"] == SMOKE_TRANSITION_ID
    assert _canonical(json.loads(decision["proposed_next_state_json"])) == _canonical(expected_state)
    assert decision["status"] == "VALID_TRANSITION"
    assert decision["reason_code"] == "TRANSITION_SUPPORTED"
    assert decision["applied"] is True
    assert decision["state_version_before"] == 0
    assert decision["state_version_after"] == 1
    assert json.loads(decision["canon_rule_ids_json"]) == ["RULE-EMBER-KEY"]
    assert json.loads(decision["state_keys_json"]) == [
        "active_hero_class",
        "dragon_awake",
        "ember_key_held",
    ]
    assert json.loads(decision["changed_keys_json"]) == ["dragon_awake"]

    assert after["config_digest"] == policy["config_digest"]
    assert after["state_version"] == 1
    assert _canonical(json.loads(after["state_json"])) == _canonical(expected_state)
    assert after["state_digest"] == decision["state_digest_after"]
    assert history["state_version"] == 1
    assert history["state_json"] == after["state_json"]
    assert history["state_digest"] == after["state_digest"]
    assert history["previous_state_digest"] == before["state_digest"]
    assert history["request_digest"] == decision["request_digest"]

    assert isinstance(receipt, dict) and receipt
    assert transaction_identifiers
    assert smoke.get("transaction_identifiers") == transaction_identifiers
    return decision, after, history


def test_deploy_and_smoke():
    world_id = os.environ.get("CANON_DEPLOY_WORLD_ID", "EMBER-REALM")
    canon_version = os.environ.get("CANON_DEPLOY_CANON_VERSION", "CANON-V1")
    general_config = get_general_config()
    actual_network = general_config.get_network_name()
    configured_network = os.environ.get("CANON_DEPLOY_NETWORK", actual_network)
    if configured_network != actual_network:
        raise AssertionError(
            "CANON_DEPLOY_NETWORK does not match the gltest-selected network: "
            f"{configured_network!r} != {actual_network!r}"
        )
    network = actual_network
    chain_id = int(general_config.get_chain().id)
    source_commit = _source_commit()
    constructor_args = [
        world_id,
        canon_version,
        _compact(CANON),
        _compact(INITIAL_STATE),
        _compact(TRANSITIONS),
    ]
    source = CONTRACT_PATH.read_text(encoding="utf-8")
    source_sha256 = hashlib.sha256(source.encode("utf-8")).hexdigest()
    deployment_input_bytes = len(source.encode("utf-8")) + len(_compact(constructor_args).encode("utf-8"))
    assert deployment_input_bytes <= PORTABLE_DEPLOYMENT_INPUT_LIMIT
    assert source.splitlines()[0].startswith('# { "Depends": "py-genlayer:')
    assert "py-genlayer:test" not in source and "py-genlayer:latest" not in source

    factory = get_contract_factory("CanonWorldStateReferee")
    output = _output_path(network)
    output.parent.mkdir(parents=True, exist_ok=True)
    record = None
    if output.exists():
        if os.environ.get("CANON_RESUME") != "1":
            raise AssertionError("deployment record already exists; set CANON_RESUME=1 to verify or resume it")
        record = json.loads(output.read_text(encoding="utf-8"))
        _assert_resume_record(
            record,
            network,
            chain_id,
            source_sha256,
            source_commit,
            constructor_args,
        )
        contract = factory.build_contract(contract_address=record["contract_address"])
        deployment_receipt = record["deployment_receipt"]
        policy = contract.get_policy().call()
        assert _json_safe(policy) == record["policy"]
        live_state = contract.get_world_state().call()
        if record.get("record_status") == "COMPLETE":
            live_decision, verified_state, live_history = _assert_completed_smoke(contract, record, policy)
            assert _json_safe(live_state) == verified_state == record["smoke"]["state_after"]
            assert live_decision == record["smoke"]["decision"]
            assert live_history == record["smoke"]["state_history_entry"]
            print(f"contract_address={contract.address}")
            print(f"deployment_record={output}")
            return
        before = record["smoke"]["state_before"]
    else:
        deployment_receipt = factory.deploy_contract_tx(
            args=constructor_args,
            wait_transaction_status=TransactionStatus.FINALIZED,
        )
        assert tx_execution_succeeded(deployment_receipt), deployment_receipt
        contract_address = extract_contract_address(deployment_receipt)
        contract = factory.build_contract(contract_address=contract_address)
        policy = contract.get_policy().call()
        before = contract.get_world_state().call()
        record = {
            "schema_version": 2,
            "record_status": "DEPLOYMENT_FINALIZED_SMOKE_PENDING",
            "project": "canon-world-state-referee",
            "network": network,
            "chain_id": chain_id,
            "recorded_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "source_commit": source_commit,
            "contract_address": str(contract.address),
            "contract_source": "contracts/CanonWorldStateReferee.py",
            "contract_source_sha256": source_sha256,
            "runner_dependency": source.splitlines()[0],
            "deployment_input_bytes": deployment_input_bytes,
            "deployment_receipt": _json_safe(deployment_receipt),
            "deployment_transaction_identifiers": _transaction_identifiers(
                _json_safe(deployment_receipt)
            ),
            "constructor": {
                "world_id": world_id,
                "canon_version": canon_version,
                "canon_rules_json": constructor_args[2],
                "initial_state_json": constructor_args[3],
                "transition_catalog_json": constructor_args[4],
            },
            "policy": _json_safe(policy),
            "controller": _json_safe(policy["controller"]),
            "smoke": {
                "request_reference": SMOKE_REQUEST_REFERENCE,
                "receipt": {},
                "transaction_identifiers": [],
                "decision": {},
                "state_before": _json_safe(before),
                "state_after": {},
            },
            "limitations": [
                "The deployment proves only the bundled bounded fixture, not arbitrary game canon.",
                "The controller asserts the fictional event; the contract does not prove an external event occurred.",
                "The exact state patch is immutable and deterministic; only semantic activation uses model consensus.",
                "StudioNet and testnet timing, model routing, and finality may change independently of this repository.",
            ],
        }
        _atomic_write_json(output, record)

    print(f"contract_address={contract.address}")
    assert policy["policy_version"] == "CANON_WORLD_STATE_TRANSITION_V2"
    assert policy["scope"] == "ONE_EVENT_ONE_PREDEFINED_TRANSITION"
    assert policy["world_id"] == world_id
    assert record is not None

    proposed = _expected_smoke_state()
    live_state = contract.get_world_state().call()
    if live_state["state_version"] == 0:
        if output.exists() and record.get("record_status") == "DEPLOYMENT_FINALIZED_SMOKE_PENDING":
            if os.environ.get("CANON_RESUME") == "1" and os.environ.get("CANON_RESUME_SUBMIT") != "1":
                raise AssertionError(
                    "state is still version 0; inspect for a pending smoke transaction, then set "
                    "CANON_RESUME_SUBMIT=1 only when safe to resubmit"
                )
        receipt = contract.adjudicate_transition(
            args=[
                SMOKE_REQUEST_REFERENCE,
                before["state_digest"],
                SMOKE_EVENT,
                SMOKE_TRANSITION_ID,
                _compact(proposed),
            ]
        ).transact(wait_transaction_status=TransactionStatus.FINALIZED)
        assert tx_execution_succeeded(receipt), receipt
    elif live_state["state_version"] == 1:
        receipt = record["smoke"].get("receipt", {})
        if not receipt:
            raise AssertionError(
                "state advanced but the checkpoint has no finalized smoke receipt; this harness cannot safely "
                "prove that an operator-supplied hash belongs to the exact call. Keep this record incomplete and "
                "rerun a fresh deployment with a new output filename."
            )
    else:
        raise AssertionError("resume contract has unexpected state version")

    decision = contract.get_decision(args=[1]).call()
    after = contract.get_world_state().call()
    history = contract.get_state_at(args=[1]).call()
    safe_receipt = _json_safe(receipt)
    record["record_status"] = "COMPLETE"
    record["recorded_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    record["smoke"] = {
        "request_reference": SMOKE_REQUEST_REFERENCE,
        "receipt": safe_receipt,
        "transaction_identifiers": _transaction_identifiers(safe_receipt),
        "decision": _json_safe(decision),
        "state_before": _json_safe(before),
        "state_after": _json_safe(after),
        "state_history_entry": _json_safe(history),
    }
    verified_decision, verified_after, verified_history = _assert_completed_smoke(contract, record, policy)
    assert verified_decision == record["smoke"]["decision"]
    assert verified_after == record["smoke"]["state_after"]
    assert verified_history == record["smoke"]["state_history_entry"]
    _atomic_write_json(output, record)
    print(f"deployment_record={output}")
