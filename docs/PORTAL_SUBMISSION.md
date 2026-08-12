# Portal submission draft

Use these fields only after the private repository has been made reviewable and a real Bradbury deployment record exists. Do not submit placeholders as evidence.

**Title**

```text
Canon-Constrained World-State Referee — Reusable Intelligent Contract
```

**Notes / Description**

```text
Built and deployed an MIT-licensed Canon-Constrained World-State Referee, a reusable GenLayer Intelligent Contract for lore-governed games. The immutable deploying controller submits one fictional event, a current-state digest, one predefined transition, and the complete expected next state. It returns VALID_TRANSITION, CANON_CONFLICT, CURRENT_STATE_CONFLICT, MISSING_PREREQUISITE, AMBIGUOUS, or UNSUPPORTED_EVENT.

This uses real GenLayer consensus, not an AI storyteller. The leader judges only whether the event activates an exact immutable transition; validators independently audit the substantive result and fixed-precedence citations. Deterministic code enforces controller authorization, globally unique references, exact required state and patch-derived next state, stale-state guards, canonical JSON, and hash-chained history before any valid state is applied.

Includes a pinned runner, initial-state-bound config digest, append-only decisions and hash-chained state history, prompt-injection defenses, 68 direct tests, full-consensus tests, deployment tooling, docs, and MIT reuse rights.
```

**Evidence entries**

1. **GitHub Repository**  
   `https://github.com/Leokings/canon-world-state-referee`

2. **GenLayer Explorer Contract**  
   `BRADBURY_EXPLORER_CONTRACT_URL`

3. **GitHub File — exact contract source**  
   `https://github.com/Leokings/canon-world-state-referee/blob/COMMIT_SHA/contracts/CanonWorldStateReferee.py`

4. **GitHub File — finalized deployment proof**  
   `https://github.com/Leokings/canon-world-state-referee/blob/COMMIT_SHA/deployments/bradbury-smoke.json`

**Contribution date**

```text
08/12/2026
```

**Category**

```text
Intelligent Contracts
```

## Before submission

- Replace `COMMIT_SHA` with the immutable deployed source commit.
- Replace the explorer placeholder with the actual Bradbury contract URL.
- Confirm the deployment JSON contains successful execution and finalized consensus evidence.
- Make the repository/evidence accessible to portal reviewers; a private URL they cannot access is not valid evidence.
- Update the direct-test count if the audited suite changes.
- Complete the CAPTCHA manually and submit under **Intelligent Contracts**.
