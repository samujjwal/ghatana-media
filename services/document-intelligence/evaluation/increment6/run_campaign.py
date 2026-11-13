#!/usr/bin/env python3
"""Increment-6 provider/classifier campaign (I6 qualification wave).

Executes every lane the current authority can measure:

- ``scanned-pdf`` — the classifier contract is page facts -> document class, so
  declared page facts (``corpus/scanned-pdf/page-facts.yaml``) are honest truth:
  the campaign runs the real classifier and measures classification accuracy
  plus hybrid-provenance completeness.
- ``scanned-table-regression`` — negative lane: asserts every fixture yields
  the declared UNSUPPORTED_BY_DESIGN disposition through the capability
  registry + fallback contract, never a silent table reconstruction.
- Remaining lanes (office, hi-mr, complex-layout) — fixture binaries are
  DECLARED_NOT_PRESENT; observations are honest skips, never synthetic passes.

Every run binds CampaignGuard authority: materialFingerprintBefore/After,
networkMode, remoteFetchCount, cache dispositions, provider invocation counts,
and a source-tree snapshot. Output is crash-safe: a RUNNING marker lands first
and the run directory is unpublished until run-manifest.json says COMPLETE.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
WORKER_ROOT = HERE.parents[1]
sys.path.insert(0, str(WORKER_ROOT / "src"))
sys.path.insert(0, str(WORKER_ROOT / "evaluation"))
sys.path.insert(0, str(WORKER_ROOT))

from campaign_guards import CampaignGuard, digest, material_snapshot  # noqa: E402
from evaluation.runner_harness import (  # noqa: E402
    RunContext,
    completed_fixture_ids,
    load_completed_run,
    run_with_infra_retries,
)
from document_intelligence.scanned.classifier import (  # noqa: E402
    classify_document,
    load_scanned_policy,
)
from document_intelligence.scanned.provenance import provenance_record  # noqa: E402
from document_intelligence.runtime.fallback_contract import (  # noqa: E402
    FallbackContract,
    FallbackContractError,
)
from evaluation.increment6.run_qualification import (  # noqa: E402
    evaluate,
    load_lane_fixtures,
    load_manifest,
)


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _load_page_facts() -> dict:
    path = HERE / "corpus/scanned-pdf/page-facts.yaml"
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    return data.get("facts", {})


def _classifier_provenance(policy_fingerprint: str) -> dict:
    return {
        "providerRef": "ghatana.scanned-pdf-classifier",
        "providerVersion": "0.1.0",
        "modelRef": "routing/scanned-pdf.v1.yaml",
        "modelVersion": policy_fingerprint,
    }


def _contract_provenance(contract: FallbackContract) -> dict:
    return {
        "providerRef": "ghatana.fallback-contract",
        "providerVersion": "0.1.0",
        "modelRef": "routing/fallback-contract.v1.yaml",
        "modelVersion": contract.fingerprint,
    }


def _capability_dispositions() -> dict[str, str]:
    registry = yaml.safe_load(
        (WORKER_ROOT / "capabilities/document-intelligence-capabilities.yaml").read_text()
    )
    return {
        cid: cap.get("developmentState", "")
        for cid, cap in (registry.get("capabilities") or {}).items()
    }


def produce(manifest: dict, guard: CampaignGuard, skip: set[str] | None = None) -> list[dict]:
    policy = load_scanned_policy(WORKER_ROOT / "routing/scanned-pdf.v1.yaml")
    contract = FallbackContract(WORKER_ROOT / "routing/fallback-contract.v1.yaml")
    page_facts = _load_page_facts()
    dispositions = _capability_dispositions()
    declared = load_lane_fixtures(manifest)
    skip = skip or set()
    observations: list[dict] = []

    for fixture in declared:
        fixture_id = fixture["fixtureId"]
        lane = fixture["lane"]
        if fixture_id in skip:
            # RUN-06: a leaf recorded COMPLETE in the resumed run is reused
            # verbatim — never re-executed, never partially rewritten.
            continue

        if lane in {"scanned-pdf", "hybrid-provenance"}:
            facts = page_facts.get(fixture_id)
            if facts is None:
                observations.append(
                    {
                        "fixtureId": fixture_id,
                        "lane": lane,
                        "skipped": True,
                        "reason": "page facts not declared",
                    }
                )
                continue
            provider = (
                "ghatana.scanned-pdf-classifier"
                if lane == "scanned-pdf"
                else "ghatana.hybrid-pdf"
            )
            guard.record_invocation(provider, "completed")
            result = classify_document(facts["pages"], policy)
            receipt = provenance_record(result)
            # provenance completeness: every page carries a class + reasonCode.
            completeness = 1.0 if all(
                page.get("class") and page.get("reasonCode")
                for page in receipt.get("pageDecisions", [])
            ) and len(receipt.get("pageDecisions", [])) == len(facts["pages"]) else 0.0
            observations.append(
                {
                    "fixtureId": fixture_id,
                    "lane": lane,
                    "language": fixture.get("language"),
                    "mediaType": fixture.get("mediaType"),
                    "expectedDocumentClass": fixture.get("expectedDocumentClass"),
                    "actualDocumentClass": result.document_class,
                    "pageClasses": [page.classification for page in result.page_classes],
                    "reasonCodes": [page.reason_code for page in result.page_classes],
                    "provenance.completeness": completeness,
                    "provenanceReceiptFingerprint": receipt["receiptFingerprint"],
                    "providerProvenance": (
                        _classifier_provenance(result.policy_fingerprint)
                        if lane == "scanned-pdf"
                        else {
                            "providerRef": "ghatana.hybrid-pdf",
                            "providerVersion": "0.1.0",
                            "modelRef": "routing/scanned-pdf.v1.yaml",
                            "modelVersion": result.policy_fingerprint,
                        }
                    ),
                    "realProviderEvidence": True,
                    "rawObservation": {
                        "pageFacts": facts["pages"],
                        "documentClass": result.document_class,
                        "provenanceReceipt": receipt,
                    },
                }
            )
            continue

        if lane == "scanned-table-regression":
            expected_capability = fixture.get("expectedCapability", "")
            state = dispositions.get(expected_capability, "")
            # The regression assertion: the declared capability must be
            # UNSUPPORTED by authority AND silent table fallback must be
            # contract-rejected — a PASS means the negative disposition held.
            fallback_rejected = False
            try:
                contract.admit(
                    "ghatana.hybrid-pdf",
                    "ghatana.scanned-table-reconstruction",
                    "TABLE_DETECTED",
                    fixture.get("mediaType", "application/pdf"),
                )
            except FallbackContractError:
                fallback_rejected = True
            upheld = state in {"UNSUPPORTED", "UNSUPPORTED_BY_DESIGN"} and fallback_rejected
            guard.record_invocation("ghatana.fallback-contract", "completed")
            observations.append(
                {
                    "fixtureId": fixture_id,
                    "lane": lane,
                    "language": fixture.get("language"),
                    "expectedCapability": expected_capability,
                    "expectedDisposition": fixture.get("expectedDisposition"),
                    "disposition": "UNSUPPORTED_BY_DESIGN" if upheld else "ADMITTED",
                    "capabilityState": state,
                    "fallbackRejected": fallback_rejected,
                    "providerProvenance": _contract_provenance(contract),
                    "realProviderEvidence": True,
                    "rawObservation": {
                        "capabilityState": state,
                        "fallbackRejected": fallback_rejected,
                    },
                    **({} if upheld else {"error": "scanned-table capability was not held unsupported"}),
                }
            )
            continue

        # Lanes whose fixture binaries are declared-not-present: honest skip.
        observations.append(
            {
                "fixtureId": fixture_id,
                "lane": lane,
                "language": fixture.get("language"),
                "skipped": True,
                "reason": f"fixture binary {fixture.get('binaryState', 'DECLARED_NOT_PRESENT')}",
            }
        )
    return observations


def _publication_spec(run_dir: Path) -> dict:
    return {
        "dir": run_dir,
        "required": [
            "summary.json",
            "capabilities.json",
            "observations.json",
            "campaign-attestation.json",
        ],
    }


def _load_publication_helpers():
    spec = importlib.util.spec_from_file_location(
        "build_run_publication",
        WORKER_ROOT / "scripts/build_run_publication.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--run-id", default=None)
    parser.add_argument(
        "--resume",
        type=Path,
        default=None,
        help="prior run dir: fixture leaves recorded COMPLETE are reused (RUN-06)",
    )
    parser.add_argument(
        "--infra-retries",
        type=int,
        default=1,
        help="bounded retry for INFRASTRUCTURE_ERROR runner failures (RUN-05)",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=float,
        default=None,
        help="abort the run and mark ABORTED after this many seconds (RUN-03)",
    )
    args = parser.parse_args(argv)

    prior = load_completed_run(args.resume) if args.resume is not None else None

    run_id = args.run_id or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + f"-{uuid.uuid4().hex[:8]}"
    output = (args.output or HERE / "results" / run_id).resolve()

    publication = _load_publication_helpers()
    spec = _publication_spec(output)
    semantic_environment = WORKER_ROOT / "evaluation/semantic-environment.v1.yaml"
    # ENV-01: bind the declared semantic environment for this process. Only
    # unset variables are filled — an explicit operator override wins.
    semantic_spec = yaml.safe_load(semantic_environment.read_text(encoding="utf-8")) or {}
    for key, value in (semantic_spec.get("environmentVariables") or {}).items():
        os.environ.setdefault(key, str(value))
    context = RunContext(
        output,
        run_id,
        begin=publication.begin_run,
        timeout_seconds=args.timeout_seconds,
    )

    material_paths = [
        HERE / "manifest.yaml",
        HERE / "qualification.yaml",
        HERE / "acceptance.yaml",
        HERE / "environment.yaml",
        semantic_environment,
        HERE / "implementation-material.yaml",
        HERE / "required-tests.yaml",
        HERE / "corpus",
        WORKER_ROOT / "routing/scanned-pdf.v1.yaml",
        WORKER_ROOT / "routing/fallback-contract.v1.yaml",
        WORKER_ROOT / "profiles/increment6.yaml",
        WORKER_ROOT / "src/document_intelligence/scanned",
        WORKER_ROOT / "capabilities/document-intelligence-capabilities.yaml",
    ]
    guard = CampaignGuard(material_paths=material_paths)
    with context:
        # RUN-06: fixture leaves already COMPLETE in the resumed run are
        # carried forward verbatim; everything else executes fresh.
        reused: dict[str, dict] = {}
        if prior is not None:
            complete_ids = completed_fixture_ids(prior)
            reused = {
                item["fixtureId"]: item
                for item in prior.get("observations", [])
                if item.get("fixtureId") in complete_ids
            }
        with guard:
            manifest = load_manifest()
            produced = run_with_infra_retries(
                lambda: produce(manifest, guard, skip=set(reused)),
                retries=args.infra_retries,
            )
            observations = [reused[fid] for fid in sorted(reused)] + produced
            summary, capabilities = evaluate(observations)

        attestation = {
            "schemaVersion": "increment6.provider-campaign-attestation.v1",
            "executionId": uuid.uuid4().hex,
            "runId": run_id,
            "runner": "evaluation/increment6/run_campaign.py",
            "providerCampaignExecution": "EXECUTED",
            "providerExecutionReused": False,
            # RUN-01: the campaign executes providers in-process; no worker
            # subprocess is spawned, so the port is honestly NOT_APPLICABLE.
            "actualPort": (
                context.actual_port
                if context.actual_port is not None
                else "NOT_APPLICABLE_IN_PROCESS_EXECUTION"
            ),
            "materialFingerprintBefore": guard._material_before,
            "materialFingerprintAfter": material_snapshot(material_paths),
            "materialFingerprints": summary.get("materialFingerprints", {}),
            "materialFingerprint": summary.get("materialFingerprint"),
            "semanticEnvironmentRef": "evaluation/semantic-environment.v1.yaml",
            "semanticEnvironmentFingerprint": "sha256:" + hashlib.sha256(
                semantic_environment.read_bytes()
            ).hexdigest(),
            "observationCount": len(observations),
            "observationsFingerprint": summary.get("observationsFingerprint"),
            **guard.authority_fields(),
            "laneExecution": {
                "scanned-pdf": "EXECUTED_DECLARED_PAGE_FACTS",
                "scanned-table-regression": "EXECUTED_DISPOSITION_ASSERTION",
                "office": "NOT_RUN_BINARY_DECLARED_NOT_PRESENT",
                "hi-mr": "NOT_RUN_BINARY_DECLARED_NOT_PRESENT",
                "complex-layout": "NOT_RUN_BINARY_DECLARED_NOT_PRESENT",
            },
            "teardownProof": context.teardown_proof(),
        }
        if prior is not None:
            attestation["resume"] = {
                "fromRunDir": str(args.resume),
                "reusedLeafCount": len(reused),
            }
        attestation["attestationFingerprint"] = digest(attestation)

        from learning.util import atomic_write_json  # noqa: E402

        atomic_write_json(output / "observations.json", observations)
        atomic_write_json(output / "summary.json", summary)
        atomic_write_json(output / "capabilities.json", capabilities)
        atomic_write_json(output / "campaign-attestation.json", attestation)
        raw_values = [item.get("rawObservation", item) for item in observations]
        atomic_write_json(output / "raw-observations.json", raw_values)
        atomic_write_json(
            output / "lineage.json",
            {
                "schemaVersion": "increment6.lineage.v1",
                "runId": run_id,
                "providerCampaignExecution": "EXECUTED",
                "attestationFingerprint": attestation["attestationFingerprint"],
                "materialFingerprint": summary.get("materialFingerprint"),
                "observationsFingerprint": summary.get("observationsFingerprint"),
            },
        )

        run_manifest = publication.build_manifest(run_id, spec)
        # RUN-01/07 additive manifest fields; fingerprint is recomputed over
        # the complete manifest so it still covers every recorded field.
        run_manifest["actualPort"] = (
            context.actual_port
            if context.actual_port is not None
            else "NOT_APPLICABLE_IN_PROCESS_EXECUTION"
        )
        run_manifest["teardownProof"] = context.teardown_proof()
        run_manifest.pop("manifestFingerprint", None)
        run_manifest["manifestFingerprint"] = "sha256:" + hashlib.sha256(
            json.dumps(run_manifest, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        tmp = (output / "run-manifest.json").with_name(
            f"run-manifest.json.{os.getpid()}.tmp"
        )
        tmp.write_text(json.dumps(run_manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        tmp.replace(output / "run-manifest.json")
        marker = output / "RUNNING"
        if marker.exists():
            marker.unlink()

    print(
        json.dumps(
            {
                "runId": run_id,
                "output": str(output),
                "status": summary.get("status"),
                "observations": len(observations),
                "attestationFingerprint": attestation["attestationFingerprint"],
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
