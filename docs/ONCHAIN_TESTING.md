# On-chain testing

## Prerequisites

Install the pinned Python dependencies and configure `gltest` credentials for the desired network. StudioNet does not require GEN. Bradbury requires a funded configured account.

```powershell
python -m pip install -r requirements.txt
```

Run local checks before any hosted transaction:

```powershell
genvm-lint check contracts/CanonWorldStateReferee.py
genvm-lint typecheck contracts/CanonWorldStateReferee.py
genvm-lint schema contracts/CanonWorldStateReferee.py --json
pytest tests/direct -q
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

After StudioNet succeeds and the account is funded:

```powershell
$env:CANON_DEPLOY_NETWORK = "testnet_bradbury"
$env:CANON_DEPLOY_OUTPUT = "deployments/bradbury-smoke.json"
$env:CANON_SOURCE_COMMIT = "FULL_SOURCE_COMMIT_SHA"
gltest deploy/001_deploy_and_smoke.py -v -s --network testnet_bradbury
```

The environment label and CLI `--network` must agree. Review the generated record and independently confirm the contract address and transactions in the Bradbury explorer before committing it.

The harness refuses to overwrite an existing record. It checkpoints a finalized deployment before the semantic smoke call. To verify or resume that exact address, set `CANON_RESUME=1`. If the checkpoint still shows state version 0, inspect the explorer for a pending transaction before setting `CANON_RESUME_SUBMIT=1`. If state already advanced but the process stopped before saving the finalized smoke receipt, the harness deliberately leaves that proof record incomplete: a bare operator-supplied hash cannot prove the exact recipient, sender, calldata, execution, and finality. Preserve the incomplete record for diagnosis, then use a new output filename and fresh deployment for the publishable proof run.

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
