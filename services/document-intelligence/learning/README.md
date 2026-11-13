# Increment 5 — Governed Learning Authority

Learning may consume human corrections; it may never silently mutate active
authority, and it may never train online inside production execution.

```
feedback/        feedback-event loading, verification, tombstones (I5-07)
datasets/        deterministic dataset builder: dedup + split + leakage + stats (I5-08..12)
calibration/     confidence-calibration evaluation + candidate emission (I5-13/14)
templates/       template-discovery candidates from review evidence (I5-15/16)
policy/          GLiNER extraction-policy candidates (I5-17)
models/          model-candidate hook for externally trained artifacts (I5-18)
active_learning/ review prioritization scoring + governed queue (I5-19/20)
candidates/      governed registry + dependency graph + offline evaluator +
                 regression budget + shadow-evaluation receipts (I5-21..25)
promotion/       authorized promotion to new authority revisions + rollback (I5-26..28)
audit.py         append-only privacy-safe learning audit trail (I5-30)
retention.py     per-artifact-class retention policy enforcement (I5-31)
policies/        checked-in policy artifacts (eligibility, dataset, budget, retention)
schemas/         versioned JSON Schemas for every learning artifact (I5-02)
```

Artifact roots (created lazily, all append-only):

```
learning/feedback/events/<root>/events|tombstones/
learning/datasets/out/<datasetId>/r<revision>/   manifest.json + .complete
learning/registry/candidates/<candidateId>/      manifest.json + artifact + transitions/
learning/authority/revisions/ + receipts/ + active.json
```

Rules:

- Every artifact validates against its schema before atomic publication.
- A completed dataset revision is never overwritten — a new revision is issued.
- A promoted authority revision is immutable; rollback re-selects an earlier
  already-qualified revision, never rebuilds one from mutable inputs.
- `scripts/verify_increment5.py` re-verifies all of the above read-only.
