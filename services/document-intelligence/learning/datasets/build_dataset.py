"""Deterministic learning dataset builder (I5-08..I5-12, I5-34, I5-40).

Inputs:

    --events-root   append-only feedback event root (events/ + tombstones/)
    --policy        dataset policy YAML (dedupPolicy + splitPolicy + refs)
    --out           dataset root output directory
    --dataset-id    stable dataset identity
    --revision      monotonically increasing dataset revision
    --tenant-scope  TENANT_LOCAL (default) | MULTI_TENANT_EXPLICITLY_AUTHORIZED
                    | SYNTHETIC_PUBLIC
    --tenant-ref    tenant partition identity; required for TENANT_LOCAL unless
                    the events root already sits in a tenant partition
    --scope-authorization-ref   required for MULTI_TENANT_EXPLICITLY_AUTHORIZED

Output (atomic, never overwrites a completed revision):

    <out>/<datasetId>/r<revision>/manifest.json   dataset-manifest.v2
    <out>/<datasetId>/r<revision>/train.jsonl
    <out>/<datasetId>/r<revision>/eval.jsonl

Determinism: same event root + same policy + same revision always rebuilds a
byte-identical dataset root; any input change produces a new fingerprint and
requires a new revision.

Verifier delta (declared): manifests are now ``dataset-manifest.v2``. The
sealed ``scripts/verify_increment5.py`` validates revision dirs under
``learning/datasets/out`` against v1 only; v2 manifests materialized there are
verified by the v2-aware increment-6 authority path (see
``learning/policies/tenant-scope.v1.yaml``).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "learning"))

from learning.feedback.events import (  # noqa: E402
    eligible_events,
    event_root_fingerprint,
    exclusion_report,
    load_event_root,
    tombstoned_ids,
)
from learning.datasets.qualification import check_statistical_sufficiency, freeze_holdout  # noqa: E402
from learning.tenant_scope import (  # noqa: E402
    TENANT_LOCAL,
    TENANT_SCOPES,
    assert_event_scope,
    resolve_dataset_tenant,
)
from learning.util import (  # noqa: E402
    atomic_write_json,
    atomic_write_text,
    canonical_json,
    digest,
    load_json,
    validate,
)

BUILDER_VERSION = "learning.dataset-builder.v2"
MANIFEST_SCHEMA = "dataset-manifest.v2.schema.json"
MANIFEST_SCHEMA_VERSION = "document-intelligence.dataset-manifest.v2"


def _group_key(event: dict, group_key: str) -> str:
    if group_key == "reviewLineage":
        lineage = event["review"].get("reprocessLineage")
        if lineage is not None:
            return lineage["handoffId"]
        return event["source"]["reviewRef"]["reviewId"]
    return event["source"].get("sourceContentFingerprint") or event["source"]["executionId"]


def _dedup_key(event: dict, canonical_keys: list[str]) -> tuple:
    parts = []
    for key in canonical_keys:
        if key == "sourceContentFingerprint":
            parts.append(event["source"].get("sourceContentFingerprint", ""))
        elif key == "fieldSchemaIdentity":
            parts.append(
                canonical_json(
                    {
                        "schemaRef": event["authority"]["schemaRef"],
                        "fieldIds": sorted(
                            c["target"]["fieldId"] for c in event["review"]["corrections"]
                        ),
                    }
                )
            )
        elif key == "reviewLineage":
            parts.append(_group_key(event, "reviewLineage"))
    return tuple(parts)


def deduplicate(events: list[dict], canonical_keys: list[str]) -> tuple[list[dict], list[dict]]:
    """Keep the first (lowest eventId) event per canonical key, deterministically."""
    kept: dict[tuple, dict] = {}
    dropped: list[dict] = []
    for event in sorted(events, key=lambda e: e["eventId"]):
        key = _dedup_key(event, canonical_keys)
        if key in kept:
            dropped.append({"eventId": event["eventId"], "reason": "DUPLICATE_CANONICAL_KEY"})
        else:
            kept[key] = event
    return list(kept.values()), dropped


def assign_split(event: dict, policy: dict) -> str:
    """Stable group-hash split: the whole group lands in one partition."""
    split = policy["splitPolicy"]
    key = _group_key(event, split["groupKey"])
    hashed = int.from_bytes(
        hashlib.sha256(f"{split['seed']}:{key}".encode()).digest()[:8], "big"
    ) / float(2**64)
    return "eval" if hashed < split["evalFraction"] else "train"


def check_leakage(train: list[dict], eval_: list[dict]) -> list[dict]:
    checks = []
    train_sources = {e["source"].get("sourceContentFingerprint") for e in train}
    eval_sources = {e["source"].get("sourceContentFingerprint") for e in eval_}
    shared = train_sources & eval_sources - {None}
    checks.append(
        {
            "check": "SAME_SOURCE_ACROSS_SPLITS",
            "status": "FAIL" if shared else "PASS",
            **({"detail": f"{len(shared)} shared source fingerprints"} if shared else {}),
        }
    )
    train_lineage = {_group_key(e, "reviewLineage") for e in train}
    eval_lineage = {_group_key(e, "reviewLineage") for e in eval_}
    shared_lineage = train_lineage & eval_lineage
    checks.append(
        {
            "check": "REVIEW_LINEAGE_ACROSS_SPLITS",
            "status": "FAIL" if shared_lineage else "PASS",
            **({"detail": f"{len(shared_lineage)} shared lineages"} if shared_lineage else {}),
        }
    )
    # Product projectors may provide a governed near-duplicate signature
    # without putting source text into the learning authority.  Exact source
    # fingerprints are checked above; this catches known normalized/near
    # duplicate families as a separate leakage class.
    train_near = {
        e["source"].get("nearDuplicateFingerprint")
        or e["source"].get("contentSimilarityFingerprint")
        for e in train
    }
    eval_near = {
        e["source"].get("nearDuplicateFingerprint")
        or e["source"].get("contentSimilarityFingerprint")
        for e in eval_
    }
    shared_near = (train_near & eval_near) - {None}
    checks.append(
        {
            "check": "NEAR_DUPLICATE_SOURCE",
            "status": "FAIL" if shared_near else "PASS",
            **({"detail": f"{len(shared_near)} shared near-duplicate fingerprints"} if shared_near else {}),
        }
    )
    return checks


def compute_statistics(events: list[dict]) -> dict:
    stats = {
        "languages": {},
        "documentClasses": {},
        "fieldTypes": {},
        "providerSources": {},
        "reviewOutcomes": {},
        "correctionFrequencies": {},
    }
    for event in events:
        authority = event["authority"]
        lang = authority.get("languageHint", "unknown")
        stats["languages"][lang] = stats["languages"].get(lang, 0) + 1
        doc_class = authority["schemaRef"]["schemaId"]
        stats["documentClasses"][doc_class] = stats["documentClasses"].get(doc_class, 0) + 1
        provider = authority["providerCatalogFingerprint"]
        stats["providerSources"][provider] = stats["providerSources"].get(provider, 0) + 1
        outcome = event["review"]["terminalAction"]
        stats["reviewOutcomes"][outcome] = stats["reviewOutcomes"].get(outcome, 0) + 1
        for correction in event["review"]["corrections"]:
            field_id = correction["target"]["fieldId"]
            stats["fieldTypes"][field_id] = stats["fieldTypes"].get(field_id, 0) + 1
            stats["correctionFrequencies"][field_id] = (
                stats["correctionFrequencies"].get(field_id, 0) + 1
            )
    return stats


def _member_record(event: dict) -> dict:
    return {
        "eventId": event["eventId"],
        "schemaRef": event["authority"]["schemaRef"],
        "languageHint": event["authority"].get("languageHint"),
        "terminalAction": event["review"]["terminalAction"],
        "corrections": event["review"]["corrections"],
        "authority": {
            "materialFingerprint": event["authority"]["materialFingerprint"],
            "providerCatalogFingerprint": event["authority"]["providerCatalogFingerprint"],
            "modelManifestFingerprint": event["authority"]["modelManifestFingerprint"],
        },
    }


def _prior_complete_revision(
    out_root: Path, dataset_id: str, revision: int
) -> tuple[int, dict] | None:
    """Highest completed earlier revision of this dataset, if any."""
    dataset_dir = out_root / dataset_id
    best: tuple[int, dict] | None = None
    if not dataset_dir.is_dir():
        return None
    for child in dataset_dir.iterdir():
        if not (child.is_dir() and child.name.startswith("r")):
            continue
        try:
            prior_revision = int(child.name[1:])
        except ValueError:
            continue
        if prior_revision >= revision:
            continue
        manifest_path = child / "manifest.json"
        if not (child / ".complete").exists() or not manifest_path.exists():
            continue
        prior = load_json(manifest_path)
        if best is None or prior_revision > best[0]:
            best = (prior_revision, prior)
    return best


def _revocation_supersedes(
    out_root: Path,
    dataset_id: str,
    revision: int,
    tombstoned: set[str],
) -> dict | None:
    """I5-40: when this revision replaces an earlier one because feedback
    events were revoked, record the relationship. Prior manifests are never
    rewritten — the new revision records ``supersedes`` instead.
    """
    prior = _prior_complete_revision(out_root, dataset_id, revision)
    if prior is None or not tombstoned:
        return None
    prior_revision, prior_manifest = prior
    accepted = set(prior_manifest.get("source", {}).get("acceptedEventIds", []))
    revoked = sorted(accepted & tombstoned)
    if not revoked:
        return None
    return {
        "priorRevision": prior_revision,
        "reason": "REVOCATION",
        "revokedEventIds": revoked,
    }


def build_dataset(
    events_root: Path,
    policy: dict,
    out_root: Path,
    dataset_id: str,
    revision: int,
    created_at: str,
    *,
    tenant_scope: str = TENANT_LOCAL,
    tenant_ref: str | None = None,
    scope_authorization_ref: str | None = None,
) -> dict:
    tenant_ref = resolve_dataset_tenant(
        events_root, tenant_scope, tenant_ref, scope_authorization_ref
    )
    event_root = load_event_root(events_root)
    eligible = list(eligible_events(event_root))
    for event in eligible:
        assert_event_scope(event, tenant_scope, tenant_ref)
    excluded = exclusion_report(event_root)
    kept, duplicates = deduplicate(eligible, policy["dedupPolicy"]["canonicalKeys"])
    excluded = excluded + duplicates

    qualification: dict | None = None
    holdout_ids: set[str] = set()
    holdout_policy = policy.get("qualificationHoldout")
    if isinstance(holdout_policy, dict):
        holdout = freeze_holdout(
            kept,
            holdout_id=str(holdout_policy.get("holdoutId") or f"{dataset_id}-qualification"),
            event_ids=holdout_policy.get("eventIds"),
            fraction=float(holdout_policy.get("fraction", 0.2)),
            group_key=str(holdout_policy.get("groupKey", policy["splitPolicy"]["groupKey"])),
            seed=int(holdout_policy.get("seed", policy["splitPolicy"]["seed"])),
        )
        holdout_ids = set(holdout["eventIds"])
        qualification = {"holdout": holdout}
    train = [e for e in kept if e["eventId"] not in holdout_ids and assign_split(e, policy) == "train"]
    eval_ = [e for e in kept if e["eventId"] not in holdout_ids and assign_split(e, policy) == "eval"]
    checks = check_leakage(train, eval_)
    leakage_status = "PASS" if all(c["status"] != "FAIL" for c in checks) else "FAIL"
    if leakage_status == "FAIL":
        raise ValueError(f"dataset leakage detected: {[c for c in checks if c['status'] == 'FAIL']}")

    manifest = {
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "datasetId": dataset_id,
        "datasetRevision": revision,
        "createdAt": created_at,
        "tenantScope": tenant_scope,
        **({"tenantRef": tenant_ref} if tenant_ref else {}),
        **(
            {"scopeAuthorizationRef": scope_authorization_ref}
            if scope_authorization_ref
            else {}
        ),
        "builder": {
            "implementationFingerprint": digest({"builder": builder_fingerprint_source()}),
            "version": BUILDER_VERSION,
        },
        "policy": {
            "datasetPolicyRef": policy["datasetPolicyRef"],
            "eligibilityPolicyRef": policy["eligibilityPolicyRef"],
            "dedupPolicy": policy["dedupPolicy"],
            "splitPolicy": policy["splitPolicy"],
        },
        "source": {
            "eventRootFingerprint": event_root_fingerprint(event_root),
            "acceptedEventIds": sorted(e["eventId"] for e in kept),
            "excludedEvents": sorted(excluded, key=lambda x: x["eventId"]),
        },
        "splits": {
            "train": {
                "count": len(train),
                "memberFingerprint": digest([e["eventId"] for e in sorted(train, key=lambda x: x["eventId"])]),
            },
            "eval": {
                "count": len(eval_),
                "memberFingerprint": digest([e["eventId"] for e in sorted(eval_, key=lambda x: x["eventId"])]),
            },
        },
        "statistics": compute_statistics(kept),
        "leakage": {"status": leakage_status, "checks": checks},
    }
    minimum_support = policy.get("minimumSupport")
    if isinstance(minimum_support, dict):
        qualification = qualification or {}
        qualification["sufficiency"] = check_statistical_sufficiency(
            [event for event in kept if event["eventId"] not in holdout_ids],
            minimum_support,
        )
    if qualification is not None:
        manifest["qualification"] = qualification
    supersedes = _revocation_supersedes(
        out_root, dataset_id, revision, tombstoned_ids(event_root)
    )
    if supersedes is not None:
        manifest["supersedes"] = supersedes
    manifest["datasetFingerprint"] = digest(manifest)
    validate(manifest, MANIFEST_SCHEMA)

    revision_dir = out_root / dataset_id / f"r{revision}"
    marker = revision_dir / ".complete"
    if marker.exists():
        raise ValueError(f"dataset revision already complete: {revision_dir}")
    if revision_dir.exists():
        raise ValueError(f"dataset revision exists but incomplete: {revision_dir}")
    revision_dir.mkdir(parents=True)
    try:
        atomic_write_json(revision_dir / "manifest.json", manifest)
        for name, members in (("train", train), ("eval", eval_)):
            lines = "".join(
                canonical_json(_member_record(e)) + "\n"
                for e in sorted(members, key=lambda x: x["eventId"])
            )
            atomic_write_text(revision_dir / f"{name}.jsonl", lines)
        atomic_write_text(marker, canonical_json({"datasetFingerprint": manifest["datasetFingerprint"]}) + "\n")
    except BaseException:
        raise
    return manifest


def builder_fingerprint_source() -> list[str]:
    """Files whose content defines builder semantics (for manifest binding)."""
    base = Path(__file__).resolve().parents[1]
    return sorted(
        str(p.relative_to(base))
        for p in (base / "datasets").glob("*.py")
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--events-root", type=Path, required=True)
    parser.add_argument("--policy", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--dataset-id", required=True)
    parser.add_argument("--revision", type=int, required=True)
    parser.add_argument("--created-at", required=True)
    parser.add_argument("--tenant-scope", choices=TENANT_SCOPES, default=TENANT_LOCAL)
    parser.add_argument("--tenant-ref")
    parser.add_argument("--scope-authorization-ref")
    args = parser.parse_args(argv)

    policy = yaml.safe_load(args.policy.read_text(encoding="utf-8"))
    manifest = build_dataset(
        args.events_root,
        policy,
        args.out,
        args.dataset_id,
        args.revision,
        args.created_at,
        tenant_scope=args.tenant_scope,
        tenant_ref=args.tenant_ref,
        scope_authorization_ref=args.scope_authorization_ref,
    )
    print(json.dumps({"datasetFingerprint": manifest["datasetFingerprint"], "splits": manifest["splits"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
