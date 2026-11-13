from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from document_intelligence.runtime.provider_authority import (  # noqa: E402
    FROZEN_INCREMENT3_PROVIDER_AUTHORITY_SHA256,
    compare_provider_authority,
    normalize_observed_catalog,
    read_authority,
)

DEFAULT_AUTHORITY = ROOT / "evaluation/results/20260919T022904Z-cf9e659f/capabilities.json"


def _get_json(base_url: str, path: str, timeout: float) -> Any:
    request = urllib.request.Request(base_url.rstrip("/") + path, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as response:
        if path == "/readyz" and response.code == 503:
            return json.loads(response.read())
        raise


def _main() -> int:
    parser = argparse.ArgumentParser(description="Compare a live worker catalog with frozen Increment-3 authority.")
    parser.add_argument("--url", default="http://127.0.0.1:8765")
    parser.add_argument("--output", type=Path, default=Path("runtime-provider-authority-diff.json"))
    parser.add_argument("--timeout", type=float, default=2.0)
    parser.add_argument("--authority", type=Path, default=DEFAULT_AUTHORITY)
    parser.add_argument("--authority-sha256", default=FROZEN_INCREMENT3_PROVIDER_AUTHORITY_SHA256)
    args = parser.parse_args()

    expected, expected_source_fingerprint = read_authority(args.authority)
    authority_source_matches = expected_source_fingerprint == args.authority_sha256
    worker_alive = False
    worker_ready = False
    readyz: dict[str, Any] = {}
    observed_catalog: list[dict[str, Any]] = []
    runtime_assets: dict[str, Any] = {}
    failure = None
    try:
        healthz = _get_json(args.url, "/healthz", args.timeout)
        worker_alive = isinstance(healthz, dict) and healthz.get("status") == "ok"
        raw_readyz = _get_json(args.url, "/readyz", args.timeout)
        readyz = raw_readyz if isinstance(raw_readyz, dict) else {}
        worker_ready = readyz.get("status") == "ready"
        observed_catalog = normalize_observed_catalog(_get_json(args.url, "/v1/providers", args.timeout))
        raw_assets = _get_json(args.url, "/v1/runtime-assets", args.timeout)
        runtime_assets = raw_assets if isinstance(raw_assets, dict) else {}
    except (OSError, urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError):
        failure = "WORKER_UNAVAILABLE"

    diff = compare_provider_authority(expected, observed_catalog)
    result = {
        **diff,
        "expectedSourceFingerprint": expected_source_fingerprint,
        "authoritySourceMatches": authority_source_matches,
        "workerAlive": worker_alive,
        "workerReady": worker_ready,
        "readyzReasonCode": readyz.get("reasonCode"),
        "runtimeAssets": runtime_assets,
        "failure": failure or (None if authority_source_matches else "AUTHORITY_SOURCE_FINGERPRINT_MISMATCH"),
        "status": "PASS" if worker_alive and worker_ready and authority_source_matches and failure is None and
        runtime_assets.get("status") == "ready" and
        not diff["missing"] and not diff["unexpected"] and not diff["mismatched"] else "FAIL",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"{result['status']}: provider authority diff written")
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(_main())
