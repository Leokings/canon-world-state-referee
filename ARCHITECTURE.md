# Architecture

## Boundary

`CanonWorldStateReferee` owns one consensus-critical operation: adjudicating whether one immutable-controller-submitted fictional event activates one selected predefined transition under a deployment's immutable canon and current on-chain state.

The contract does not create stories, generate events, amend canon, choose arbitrary actions, calculate payments, execute external calls, or serve as a generic policy engine. Games own rendering, player authentication, indexing, deterministic move rules, inventories, and any follow-on contract calls. The deploying game/controller is the only address authorized to adjudicate, so those external checks cannot be bypassed by calling this contract directly.

## Flow

```text
Immutable constructor policy
  canon rules + closed transition catalog + initial state
                         |
Controller reads current state digest
                         |
Controller submits event + transition ID + complete next state
                         |
Deterministic checks
  controller authorization, canonical JSON, globally unique reference,
  state-digest guard, transition exists, exact required-state comparison,
  submitted state equals current state plus exact registered patch
                         |
Leader semantic classification
  one closed status + fixed reason + bounded citations
                         |
Independent validator semantic audit
  verify substance against applicable canon, current state, and exact transition
                         |
Append decision
                         |
VALID_TRANSITION? -- yes --> store deterministically derived state and increment version
                  -- no  --> leave world state unchanged
```

## Immutable policy

The constructor canonicalizes and stores:

- `world_id`
- `canon_version`
- deploying `controller`
- 1–16 canon rules with immutable IDs
- 1–16 transition definitions
- the initial bounded state

Each transition declares its semantic description, an exact `required_state` object, an exact nonempty `state_patch`, and the canon-rule IDs applicable to that transition. A transition whose required/patch citation union exceeds the closed output limit is rejected during deployment. There are no policy mutation methods. A changed controller, canon, or catalog requires a new deployment.

The configuration digest binds the chain, contract address, controller, identifiers, canonical canon, initial state, transition catalog, and policy version. It prevents records from being confused across deployments.

## State representation

State is a canonical JSON object containing 1–48 identifier keys. Values may be bounded strings, signed 64-bit integers, booleans, or bounded flat arrays of those scalar types. Floats, nulls, nested objects, and nested arrays are rejected.

The controller submits the **complete** next state, but cannot choose its contents. Deterministic code copies the current state, applies the registered patch, and requires canonical equality with the submission before invoking an LLM. Deletion, type substitution, a different value, or an extra effect fails deterministically. The contract never accepts a model- or caller-generated patch.

Every accepted state version is retained with its digest, prior-state digest, and applying request digest. State digests hash-chain these fields with the exact canonical state. Rejected decisions are append-only records but do not create state versions.

## Consensus result

The leader may return only:

```json
{
  "status": "VALID_TRANSITION",
  "reason_code": "TRANSITION_SUPPORTED",
  "canon_rule_ids": ["RULE-DRAGON-AWAKENING"],
  "state_keys": ["active_hero_class", "dragon_awake", "ember_key_held"]
}
```

Statuses and reason codes are one-to-one closed enums. Canon citations must exist in the transition's explicit applicable-rule set. State citations must exist in current, proposed, required, or patched state keys. A valid result must cite exactly the applicable canon IDs (including an empty set) and the sorted union of required and changed state keys.

Multiple adverse conditions use the fixed precedence `CANON_CONFLICT > CURRENT_STATE_CONFLICT > MISSING_PREREQUISITE > AMBIGUOUS > UNSUPPORTED_EVENT`. Deterministically mismatched required values cannot be downgraded below `CURRENT_STATE_CONFLICT`, and missing configured keys cannot be downgraded below `MISSING_PREREQUISITE`.

Validators do not compare JSON shape alone. A custom `run_nondet_unsafe` validator validates the leader's bounded payload, then independently asks whether the actual event, canon, current state, selected transition, exact delta, and citations support it. Only an exact `{"accept":true}` audit is agreement. Model errors, unknown fields, invented IDs, invalid reason pairs, and malformed audits force disagreement.

## Concurrency and replay

The caller supplies `expected_state_digest`. A stale digest fails deterministically before inference, preventing two events evaluated against one state from both applying after the first changes it.

The request digest uses length-framed values and binds the deployment, controller, request reference, expected state, event, transition ID, and exact derived proposed state. Every completed request is marked seen, including non-valid outcomes. Request references are independently stored in a global uniqueness map, so changing wording cannot reuse an already completed reference.

## Storage

Append-only decisions contain the submitted event, exact proposed state, request and state digests, selected transition, bounded semantic result, citations, changed keys, versions before and after, and whether it applied. Integrators should consume finalized records and verify `config_digest`, `expected_state_digest`, `transition_id`, `status`, and `applied`.

## Upgrade stance

The contract is intentionally immutable. New semantics, canon, enum definitions, or transition catalogs require a new deployment with a new configuration digest. This avoids silently reinterpreting prior decisions.
