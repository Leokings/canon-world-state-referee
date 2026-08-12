# Portal submission draft

Use these finalized fields after the private repository has been made accessible to portal reviewers.

**Title**

```text
Canon-Constrained World-State Referee — Reusable Intelligent Contract
```

**Notes / Description**

```text
Built and deployed an MIT-licensed Canon-Constrained World-State Referee, a reusable GenLayer IC for lore-governed games. A controller submits an event, state digest, predefined transition and complete next state. It returns VALID_TRANSITION, CANON_CONFLICT, CURRENT_STATE_CONFLICT, MISSING_PREREQUISITE, AMBIGUOUS or UNSUPPORTED_EVENT.

This uses real GenLayer consensus, not an AI storyteller. The leader decides only whether the event activates an immutable transition; validators independently audit the verdict and bounded citations. Deterministic code enforces controller-only writes, unique references, exact prerequisites and patch-derived next state, stale-state guards, canonical JSON and hash-chained history.

Includes a pinned runner, commit- and chain-bound proof harness, prompt-injection defenses, 68 direct and 14 harness tests. Bradbury deployment and exact semantic smoke finalized as VALID_TRANSITION, moving state 0→1, with four AGREE votes and one TIMEOUT.
```

**Evidence entries**

1. **GitHub Repository**  
   `https://github.com/Leokings/canon-world-state-referee`

2. **GenLayer Explorer Contract**  
   `https://explorer-bradbury.genlayer.com/address/0x16979e840253025C089eB59419dD97f222E3143C`

3. **GitHub File — exact contract source**  
   `https://github.com/Leokings/canon-world-state-referee/blob/08ebea007c5a936a89f12603deef86b15d28928d/contracts/CanonWorldStateReferee.py`

4. **GitHub File — finalized deployment proof**  
   `https://github.com/Leokings/canon-world-state-referee/blob/89c4e7a70d710fb069da320e1105eb6a0c6d77ae/deployments/bradbury-2026-08-12.json`

**Contribution date**

```text
08/12/2026
```

**Category**

```text
Intelligent Contracts
```

The repository is private, so grant portal reviewers access or make it public before submitting. Complete the CAPTCHA manually and submit under **Intelligent Contracts**.
