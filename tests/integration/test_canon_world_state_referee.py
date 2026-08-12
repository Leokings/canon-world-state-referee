import json

import pytest
from gltest import get_contract_factory
from gltest.assertions import tx_execution_succeeded
from gltest.types import TransactionStatus


CANON = [
    {
        "id": "RULE-EMBER-KEY",
        "text": "Only a fire mage holding the Ember Key may awaken the Ember Dragon.",
    }
]
STATE = {
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


def _compact(value):
    return json.dumps(value, separators=(",", ":"))


def _deploy():
    factory = get_contract_factory("CanonWorldStateReferee")
    contract = factory.deploy(
        args=[
            "EMBER-INTEGRATION",
            "CANON-V1",
            _compact(CANON),
            _compact(STATE),
            _compact(TRANSITIONS),
        ],
        wait_transaction_status=TransactionStatus.FINALIZED,
    )
    print(f"contract_address={contract.address}")
    return contract


def test_deployment_exposes_immutable_policy_and_initial_state():
    contract = _deploy()
    policy = contract.get_policy().call()
    state = contract.get_world_state().call()

    assert policy["policy_version"] == "CANON_WORLD_STATE_TRANSITION_V2"
    assert policy["scope"] == "ONE_EVENT_ONE_PREDEFINED_TRANSITION"
    assert policy["world_id"] == "EMBER-INTEGRATION"
    assert json.loads(policy["transition_ids_json"]) == ["AWAKEN_DRAGON"]
    assert state["state_version"] == 0
    assert json.loads(state["state_json"]) == STATE
    assert len(state["state_digest"]) == 64


@pytest.mark.semantic
def test_exact_valid_transition_result_under_full_consensus():
    """Runs leader plus validators and asserts the complete bounded result."""
    contract = _deploy()
    before = contract.get_world_state().call()
    proposed = dict(STATE)
    proposed["dragon_awake"] = True

    receipt = contract.adjudicate_transition(
        args=[
            "EXACT-VALID-001",
            before["state_digest"],
            "The active fire mage presents the held Ember Key and awakens the sleeping Ember Dragon.",
            "AWAKEN_DRAGON",
            _compact(proposed),
        ]
    ).transact(wait_transaction_status=TransactionStatus.FINALIZED)
    assert tx_execution_succeeded(receipt), receipt

    decision = contract.get_decision(args=[1]).call()
    after = contract.get_world_state().call()
    print(
        "decision_id=1 "
        f"status={decision['status']} reason={decision['reason_code']} "
        f"state_version={after['state_version']}"
    )

    assert decision["status"] == "VALID_TRANSITION"
    assert decision["reason_code"] == "TRANSITION_SUPPORTED"
    assert decision["applied"] is True
    assert decision["state_version_before"] == 0
    assert decision["state_version_after"] == 1
    assert json.loads(decision["canon_rule_ids_json"]) == ["RULE-EMBER-KEY"]
    assert set(json.loads(decision["state_keys_json"])) == {
        "active_hero_class",
        "dragon_awake",
        "ember_key_held",
    }
    assert json.loads(decision["changed_keys_json"]) == ["dragon_awake"]
    assert after["state_version"] == 1
    assert json.loads(after["state_json"]) == proposed
    assert after["state_digest"] == decision["state_digest_after"]
    historical = contract.get_state_at(args=[1]).call()
    assert historical["previous_state_digest"] == before["state_digest"]
    assert historical["request_digest"] == decision["request_digest"]
