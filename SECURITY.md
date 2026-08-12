# Security

## Supported security boundary

This contract can establish a shared GenLayer decision about a bounded fictional game-state transition. It cannot establish that a real-world event happened, prove ownership of an off-chain account, validate arbitrary game code, or make unrestricted narrative decisions.

The deploying address is the immutable controller and sole adjudication caller. A game must authenticate players and validate deterministic gameplay before its controller submits an event. The event remains a controller assertion, not independent evidence that anything happened outside the configured fictional world.

Do not attach financial settlement, valuable minting, or irreversible external execution until the GenLayer transaction is finalized and the integration has verified the expected deployment and decision fields.

## Threats and mitigations

### Prompt injection

Canon text, transition descriptions, events, and state strings can contain hostile instructions. Both semantic prompts identify the entire case as untrusted quoted game data. The output schema is closed; extra fields, unknown IDs, invented state keys, invalid status/reason pairs, and missing citations are rejected. Controls, bidi overrides, and common invisible formatting characters are rejected. The validator independently audits substance rather than trusting a leader explanation.

No prompt defense is perfect. Keep canon and transition descriptions concise, test hostile fixtures, and avoid giving semantic models access to tools or external side effects.

### Model error and correlated failure

Multiple validators can share misconceptions or model families. Consensus is not proof of objective truth. Use explicit canon rules, small state, narrow transition descriptions, obvious prerequisites, and an uncertainty-preserving `AMBIGUOUS` result. High-value applications should monitor appeals and may add delayed execution or human escalation.

### State overreach

The model never generates or selects state effects. Each immutable transition contains exact required values and an exact patch. Deterministic code derives the complete next state and requires the controller's full-state submission to match it exactly. Deletion, type substitution, different values, and extra changes fail before inference. A valid semantic result activates only this exact patch and must provide exact configured citations.

### Concurrent transitions

Every request binds the current state digest. Once a valid transition changes state, competing transactions using the old digest fail with `STALE_STATE`. State digests also bind the predecessor and applying request digest. Controllers must re-read state before resubmitting.

### Replay and record confusion

Length-framed request digests bind the controller and all material inputs. Completed request digests cannot be replayed, and every completed request reference is globally unique. Configuration and hash-chained state digests bind records to the chain and deployment. Integrators must still verify contract address and finality.

### Resource exhaustion

Inputs, canon rules, transitions, state keys, scalar values, arrays, event text, changed keys, citations, and prompt size are bounded. Constructor validation rejects transitions that cannot fit their mandatory citation set. JSON duplicate keys, floats, nulls, nested collections, control/invisible characters, and oversized signed integers are rejected.

### Privacy

All canon, state, proposed events, next states, and decisions are public on-chain data. Do not submit secrets, private messages, personal data, or unpublished intellectual property.

### Configuration mistakes

Policy is immutable. A mistaken controller, canon rule, exact prerequisite, patch, applicable-rule list, missing transition, or ambiguous description cannot be repaired in place. Audit constructor inputs and deploy a replacement contract when policy changes.

## Integration checklist

- Pin the expected contract address and `config_digest`.
- Verify the immutable `controller` is the expected game/controller address.
- Read the latest `state_digest` immediately before submission.
- Wait for transaction finality, not merely acceptance.
- Verify `status == VALID_TRANSITION` and `applied == true`.
- Verify the expected transition, request reference, versions, and state digest.
- Verify the supplied complete next state equals the registered patch result; never treat it as caller discretion.
- Never infer additional effects from the event prose.
- Treat citations as audit aids, not independent proof.
- Cap the consequence of one transition outside this contract.

## Reporting

Open a private security report with the repository maintainer. Include the contract version, minimal reproduction, expected behavior, actual behavior, and whether a deployed instance is affected. Do not include secrets in an on-chain reproduction.
