# Canon-Constrained World-State Referee

An MIT-licensed reusable GenLayer Intelligent Contract that adjudicates whether one controller-submitted fictional event may activate one exact predefined game-state transition under immutable canon and current on-chain state.

The deploying address becomes the immutable controller. It supplies the event, transition ID, expected current-state digest, and complete proposed next state. GenLayer validators judge only whether the event activates that transition. Deterministic contract code checks exact configured prerequisites, derives the next state from the transition's immutable patch, requires the submitted full state to match byte-for-byte after canonicalization, and applies it only after `VALID_TRANSITION`.

This is deliberately not an AI storyteller or a generic rules engine.

## What it does

For each request, the contract returns one bounded status:

- `VALID_TRANSITION`
- `CANON_CONFLICT`
- `CURRENT_STATE_CONFLICT`
- `MISSING_PREREQUISITE`
- `AMBIGUOUS`
- `UNSUPPORTED_EVENT`

It stores a fixed reason code, canon-rule citations, state-key citations, exact changed keys, state versions and digests, and whether the submitted next state was applied.

When more than one non-valid classification appears possible, both leader and validators use the fixed precedence `CANON_CONFLICT > CURRENT_STATE_CONFLICT > MISSING_PREREQUISITE > AMBIGUOUS > UNSUPPORTED_EVENT`.

## What it does not do

- Generate stories, events, canon, state, or transition effects
- Select an unregistered transition
- Let an arbitrary caller adjudicate or mutate world state
- Let a caller choose, delete, retype, or expand a transition effect
- Make arbitrary calls, payments, mints, or external state changes
- Fetch mutable lore from the web
- Replace deterministic game rules such as chess move legality
- Interpret legal or real-world claims

## Why GenLayer

A normal contract can enforce authentication, exact preconditions, exact patches, hashes, replays, and state versions. It cannot reliably determine whether prose such as “the fire mage presents the Ember Key and awakens the dragon” semantically activates the predefined transition without contradicting canon. GenLayer supplies only that consensus-critical language judgment; deterministic code owns every consequence.

The custom validator independently audits the leader's substantive status and citations against the same canon, current state, transition description, event, and exact next-state delta. It does not accept a result merely because its JSON is well formed.

## Contract boundary

```text
controller + event + expected state digest + selected transition + complete next state
                                |
       deterministic authorization, prerequisites, and exact-patch check
                                |
             leader classification + independent validator audit
                                |
          append decision; apply contract-derived next state only if valid
```

See [ARCHITECTURE.md](ARCHITECTURE.md) and [SECURITY.md](SECURITY.md).

## Constructor

```python
CanonWorldStateReferee(
    world_id: str,
    canon_version: str,
    canon_rules_json: str,
    initial_state_json: str,
    transition_catalog_json: str,
)
```

Canon rules use:

```json
{
  "id": "RULE-DRAGON-AWAKENING",
  "text": "The Ember Dragon can awaken only when the active hero is a fire mage holding the Ember Key."
}
```

Transitions use:

```json
{
  "id": "AWAKEN_DRAGON",
  "description": "Awaken the dragon only when all named prerequisites hold. The only effect is dragon_awake becoming true.",
  "required_state": {
    "active_hero_class": "FIRE_MAGE",
    "dragon_awake": false,
    "ember_key_held": true
  },
  "state_patch": {"dragon_awake": true},
  "applicable_canon_rule_ids": ["RULE-DRAGON-AWAKENING"]
}
```

The canon, catalog, controller, and initial state are canonicalized or bound in the constructor and never mutated. Every transition contains exact required values, one exact nonempty patch, and an explicit list of applicable canon rules. A new canon version or controller requires a new deployment.

## Write interface

```python
adjudicate_transition(
    request_reference: str,
    expected_state_digest: str,
    event_text: str,
    transition_id: str,
    proposed_next_state_json: str,
) -> int
```

Only the immutable controller may call this method. Always read `get_world_state()` immediately before submitting and pass its `state_digest`. The proposed next state is the full state, not a patch, and it must exactly equal current state with the registered patch applied. Request references are globally unique and consumed by every completed decision.

## Read interface

```text
get_policy()
get_world_state()
get_state_at(state_version)
get_transition(transition_id)
get_decision_count()
get_decision(decision_id)
```

## State constraints

State is a bounded JSON object. Values may be strings, signed 64-bit integers, booleans, or flat arrays of those scalar types. Floats, nulls, nested objects, nested arrays, duplicate JSON keys, control characters, bidi overrides, and common invisible formatting characters are rejected. These restrictions make hashing, comparison, and validator prompts stable.

State digests form an explicit chain: each non-genesis digest binds the configuration, version, prior state digest, applying request digest, and exact canonical state. `get_state_at()` exposes the predecessor and request links.

## Development

Python 3.11+ is recommended.

```powershell
python -m pip install -r requirements.txt
genvm-lint check contracts/CanonWorldStateReferee.py
genvm-lint typecheck contracts/CanonWorldStateReferee.py
genvm-lint schema contracts/CanonWorldStateReferee.py --json
pytest tests/direct -q
```

The contract pins a concrete production runner in its first line. It does not use `py-genlayer:test` or `py-genlayer:latest`.

## Full-consensus tests

The default integration test deploys and checks immutable state without inference:

```powershell
gltest tests/integration/test_canon_world_state_referee.py::test_deployment_exposes_immutable_policy_and_initial_state -v -s --network studionet
```

The semantic test asserts an exact valid result under leader-plus-validator consensus:

```powershell
gltest tests/integration/test_canon_world_state_referee.py::test_exact_valid_transition_result_under_full_consensus -v -s --network studionet -m semantic
```

StudioNet is gasless but hosted and rate-limited. Bradbury requires a configured funded account:

```powershell
gltest tests/integration/test_canon_world_state_referee.py -v -s --network testnet_bradbury -m semantic
```

Transaction acceptance or finalization alone is not counted as success; integration code asserts successful execution before reading state.

## Deployment and smoke recording

The harness checks the pinned runner and portable deployment-input size, deploys the bounded example, executes an exact semantic transition, verifies the final state, and writes an auditable JSON record:

```powershell
$env:CANON_DEPLOY_NETWORK = "studionet"
$env:CANON_DEPLOY_OUTPUT = "deployments/studionet-smoke.json"
gltest deploy/001_deploy_and_smoke.py -v -s --network studionet
```

For Bradbury, set both the gltest network and `CANON_DEPLOY_NETWORK` to `testnet_bradbury`. Do not label a deployment as Bradbury if the CLI was pointed at StudioNet.

## Repository layout

```text
contracts/       Intelligent Contract
tests/direct/    fast business-logic, validation, and validator-hook tests
tests/integration/ full-consensus deployment and exact semantic test
deploy/          deploy-and-smoke harness
deployments/     record template; generated records are ignored until reviewed
examples/        constructor and call fixtures
docs/            on-chain and portal-submission notes
```

## Current local verification

- GenVM lint and semantic validation: passing
- GenVM typecheck: passing with no diagnostics
- ABI schema extraction: passing
- Direct tests: 64 passing

Hosted StudioNet and Bradbury results must be recorded after they actually run; this repository does not claim an undeployed address or validator vote count.

## Reuse

Copy the repository, replace the example canon, state, and closed transition catalog, preserve the bounded schemas, expand the golden dataset, and deploy a new immutable instance. The MIT license permits modification and commercial reuse.

## License

[MIT](LICENSE)
