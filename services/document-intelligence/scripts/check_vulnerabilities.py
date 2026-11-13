#!/usr/bin/env python3
"""Evaluate a vulnerability scan against deployment/vulnerability-policy.v1.yaml (I6-44).

Input scan JSON: ``{findings: [{id, severity, package, mitigation?}]}``.

Policy dispositions:

- ``block``                              -> finding blocks release (FAIL)
- ``block-unless-mitigation-recorded``   -> blocked unless the finding carries
                                            a non-empty ``mitigation`` string
- ``allowed-with-tracking``              -> passes, reported under trackedFindings
- ``allowed``                            -> passes

Output report (``document-intelligence.vulnerability-report.v1``) records
every finding's disposition plus the policy fingerprint. Exit 0 on PASS,
2 on FAIL.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_POLICY = ROOT / "deployment/vulnerability-policy.v1.yaml"

REPORT_SCHEMA = "document-intelligence.vulnerability-report.v1"
POLICY_SCHEMA = "document-intelligence.vulnerability-policy.v1"


def _canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _fingerprint(value) -> str:
    return "sha256:" + hashlib.sha256(_canonical(value)).hexdigest()


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def evaluate(scan: dict, policy: dict) -> dict:
    if policy.get("schemaVersion") != POLICY_SCHEMA:
        raise ValueError(f"policy schemaVersion must be {POLICY_SCHEMA}")
    severities = policy.get("severities") or {}
    mitigation_field = policy.get("mitigationField", "mitigation")
    tracked = set(policy.get("trackingRequiredFor") or [])

    findings_out = []
    blocked = []
    tracked_findings = []
    for finding in scan.get("findings", []) or []:
        if not isinstance(finding, dict):
            raise ValueError(f"finding is not a mapping: {finding!r}")
        severity = str(finding.get("severity") or "").upper()
        action = severities.get(severity)
        if action is None:
            disposition = "BLOCKED"
            reason = f"unknown severity {severity!r} — fail closed"
        elif action == "block":
            disposition = "BLOCKED"
            reason = "severity policy: block"
        elif action == "block-unless-mitigation-recorded":
            mitigation = finding.get(mitigation_field)
            if isinstance(mitigation, str) and mitigation.strip():
                disposition = "MITIGATED"
                reason = "mitigation recorded"
            else:
                disposition = "BLOCKED"
                reason = "no mitigation recorded"
        elif action == "allowed-with-tracking":
            disposition = "TRACKED"
            reason = "severity policy: allowed-with-tracking"
        elif action == "allowed":
            disposition = "ALLOWED"
            reason = "severity policy: allowed"
        else:
            disposition = "BLOCKED"
            reason = f"unknown policy action {action!r} — fail closed"

        record = {
            "id": finding.get("id"),
            "severity": severity,
            "package": finding.get("package"),
            "disposition": disposition,
            "reason": reason,
        }
        if finding.get(mitigation_field):
            record["mitigation"] = finding[mitigation_field]
        findings_out.append(record)
        if disposition == "BLOCKED":
            blocked.append(record["id"])
        if disposition == "TRACKED" or severity in tracked:
            tracked_findings.append(record["id"])

    status = "FAIL" if blocked else "PASS"
    return {
        "schemaVersion": REPORT_SCHEMA,
        "status": status,
        "evaluatedAt": datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
        "findingCount": len(findings_out),
        "blockedFindings": blocked,
        "trackedFindings": tracked_findings,
        "findings": findings_out,
    }


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scan", type=Path, required=True, help="scan JSON {findings: [...]}")
    parser.add_argument("--policy", type=Path, default=DEFAULT_POLICY)
    parser.add_argument("--out", type=Path, default=None, help="optional report output path")
    args = parser.parse_args(argv)

    try:
        scan = json.loads(args.scan.read_text(encoding="utf-8"))
        policy = yaml.safe_load(args.policy.read_text(encoding="utf-8"))
        report = evaluate(scan, policy or {})
    except (ValueError, json.JSONDecodeError, OSError) as exc:
        print(json.dumps({"status": "FAIL", "errors": [str(exc)]}, indent=2))
        return 2

    report["policyFingerprint"] = f"sha256:{_sha256_file(args.policy)}"
    report["reportFingerprint"] = _fingerprint(
        {k: v for k, v in report.items() if k != "reportFingerprint"}
    )
    text = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.out:
        _atomic_write(args.out, text)
    print(text, end="")
    return 0 if report["status"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
