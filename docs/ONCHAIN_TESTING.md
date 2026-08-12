# On-chain testing

## Prerequisites

Install the pinned Python dependencies and configure `gltest` credentials for the desired network. StudioNet does not require GEN. Bradbury requires a funded configured account.

```powershell
python -m pip install -r requirements.txt
npm ci --ignore-scripts
```

Run local checks before any hosted transaction:

```powershell
genvm-lint check contracts/CanonWorldStateReferee.py
genvm-lint typecheck contracts/CanonWorldStateReferee.py
genvm-lint schema contracts/CanonWorldStateReferee.py --json
pytest tests/direct -q
npm run check:deploy
npm run test:tooling
```

## StudioNet

First prove deployment and deterministic reads:

```powershell
gltest tests/integration/test_canon_world_state_referee.py::test_deployment_exposes_immutable_policy_and_initial_state -v -s --network studionet
```

Then run the exact semantic path:

```powershell
gltest tests/integration/test_canon_world_state_referee.py::test_exact_valid_transition_result_under_full_consensus -v -s --network studionet -m semantic
```

Finally create a persistent smoke record:

```powershell
$env:CANON_DEPLOY_NETWORK = "studionet"
$env:CANON_DEPLOY_OUTPUT = "deployments/studionet-smoke.json"
$env:CANON_SOURCE_COMMIT = "FULL_SOURCE_COMMIT_SHA"
gltest deploy/001_deploy_and_smoke.py -v -s --network studionet
```

## Bradbury

After StudioNet succeeds and the account is funded, use the JavaScript proof
harness for portal evidence. It requires an explicit network identity and source
commit, then checkpoints deployment, finalization, semantic-call, return-value,
and state-lineage provenance:

```powershell
genlayer network set testnet-bradbury
$env:CANON_EXPECTED_CHAIN_ID = "4221"
$env:CANON_EXPECTED_GENVM_CHAIN_ID = "1"
$env:CANON_EXPECTED_NETWORK_NAME = "Genlayer Bradbury Testnet"
$env:CANON_SOURCE_COMMIT = "FULL_LOWERCASE_40_HEX_COMMIT_SHA"
$env:CANON_DEPLOYMENT_OUTPUT = "deployments/bradbury-YYYY-MM-DD.json"
genlayer deploy
```

The chain ID, network name, local source, decoded constructor, deployed source,
schema, immutable policy, configuration digest, controller, and genesis digest
must all match before the harness submits the semantic call. Review the generated
record and independently confirm the address and transactions in the Bradbury
explorer before committing it.

### Resume the accepted 2026-08-12 deployment

The harness can resume the already accepted exact-source deployment without
deploying a second contract:

```powershell
$env:CANON_EXPECTED_CHAIN_ID = "4221"
$env:CANON_EXPECTED_GENVM_CHAIN_ID = "1"
$env:CANON_EXPECTED_NETWORK_NAME = "Genlayer Bradbury Testnet"
$env:CANON_SOURCE_COMMIT = "08ebea007c5a936a89f12603deef86b15d28928d"
$env:CANON_DEPLOYMENT_OUTPUT = "deployments/bradbury-2026-08-12.json"
$env:CANON_DEPLOYMENT_TX = "0xf4ac0e3a237a980f8aaed6dce3e1257e25d12b1936feafbec9d7413019c72806"
$env:CANON_CONTRACT_ADDRESS = "0x16979e840253025C089eB59419dD97f222E3143C"
$env:CANON_DEPLOYMENT_FINALIZATION_EVM_TX = "0x5f5f413dd2942ffdb36606baf82d0e159d0a4bd63afe25c41ac3323c4fe70542"
genlayer deploy
```

The supplied hash and address are not trusted assertions. Before finalization,
the harness decodes that transaction and requires its recipient, deploy type,
`leaderOnly=false`, complete source text, and every constructor argument to
match the current repository exactly.

`CANON_EXPECTED_CHAIN_ID` binds the outer Bradbury EVM network used by the SDK.
`CANON_EXPECTED_GENVM_CHAIN_ID` independently binds the value exposed to the
contract as `gl.message.chain_id`, which is `1` for this finalized Bradbury
deployment. The latter—not outer chain ID `4221`—is included in the immutable
configuration digest. The harness records both and refuses a missing or invalid
GenVM chain ID.

Bradbury block `17287921` contains two transactions with the deployment's exact
finalization calldata. The configured hash above is the transaction at index 1
with receipt status `0x1`. Transaction
`0x2ce0f737f503ab1e1eb4b9e9d7173643a4cd789f83aaf5d7c279c21f957a501f`
is a duplicate at index 2 with status `0x0`; it is not valid finalization
evidence. The harness independently checks the configured hash and will reject
the reverted duplicate.

The script prints and checkpoints each new hash. To resume after a captured
transaction, set `CANON_DEPLOYMENT_FINALIZATION_EVM_TX`, `CANON_SEMANTIC_TX`, or
`CANON_SEMANTIC_FINALIZATION_EVM_TX` to the exact printed value. A semantic
submission intent without a captured GenLayer hash fails closed: recover the
original hash or start with a fresh deployment and output file. The harness will
not risk a duplicate call and later claim that transaction as original proof.

On Bradbury, a transaction already marked `FINALIZED` without a known matching
EVM finalization hash is also left incomplete. Supply the correct hash so the
harness can verify the consensus-contract target, exact
`finalizeTransaction(txId)` calldata, successful receipt, and transaction ID.

The original Python harness remains available for StudioNet and diagnostic
`gltest` runs:

```powershell
$env:CANON_DEPLOY_NETWORK = "testnet_bradbury"
$env:CANON_DEPLOY_OUTPUT = "deployments/bradbury-python-smoke.json"
$env:CANON_SOURCE_COMMIT = "FULL_SOURCE_COMMIT_SHA"
gltest deploy/001_deploy_and_smoke.py -v -s --network testnet_bradbury
```

The Python harness refuses to overwrite an existing record. It checkpoints a
finalized deployment before the semantic smoke call. To verify or resume that
exact address with Python, set `CANON_RESUME=1`. If the checkpoint still shows
state version 0, inspect the explorer for a pending transaction before setting
`CANON_RESUME_SUBMIT=1`.

## Required evidence

Record:

- Network and chain
- Immutable controller and source commit
- Contract address
- Deployment and adjudication transaction identifiers when exposed by the receipt
- Constructor inputs and configuration digest
- State digest before and after
- Previous-state and applying-request digest links
- Complete bounded decision
- Execution success
- Consensus/finality status and validator votes when exposed
- Test timestamp, source commit, and limitations

`ACCEPTED` and `FINALIZED` are lifecycle statuses, not proof that contract execution succeeded. The harness uses `tx_execution_succeeded` before treating state as authoritative.

## Failure triage

- `STALE_STATE`: re-read `get_world_state()` and rebuild the request.
- `CONTROLLER_ONLY`: submit from the same address that deployed the contract.
- `REQUEST_REFERENCE_REPLAY`: select a new globally unique reference; completed references cannot be reused.
- `NEXT_STATE_NOT_EXACT_PATCH`: rebuild the full proposed state as current state plus the registered exact patch.
- `STATUS_PRECEDENCE`: a model ignored a deterministic prerequisite conflict or the closed failure ordering.
- `LLM_ERROR`: a leader returned malformed or unsafe output; do not normalize it off-chain.
- Validator disagreement: inspect whether canon or transition prose is genuinely ambiguous before retrying.
- Missing contract after deployment: inspect execution success before attributing it to explorer lag.
