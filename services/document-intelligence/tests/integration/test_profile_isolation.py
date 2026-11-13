"""Cross-profile isolation regression for the freeze program.

The Increment-4A profile must extend the admitted capability surface without
mutating the canonical default authority.  This test proves it across distinct
worker processes and run identities: start a default-profile worker, capture
its provider catalog and authority fingerprints, stop it; start the
increment4a-profile worker, capture its extended catalog, stop it; then start a
fresh default-profile worker and require a byte-identical catalog and identical
authority fingerprints.  Global model/provider caches must not contaminate a
later default process.
"""
from __future__ import annotations

import hashlib
import json
import os
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
INCREMENT4A_PROFILE = ROOT / "profiles/increment4a.yaml"
READY_TIMEOUT_S = 420.0
POLL_INTERVAL_S = 0.25

pytestmark = pytest.mark.integration


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _worker_env(port: int, profile: Path | None) -> dict[str, str]:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(ROOT / "src")
    env["DOCUMENT_INTELLIGENCE_PORT"] = str(port)
    env["DOCUMENT_INTELLIGENCE_MODEL_CACHE"] = str(ROOT / ".models")
    env["DOCUMENT_INTELLIGENCE_OFFLINE"] = "true"
    env["HF_HUB_OFFLINE"] = "1"
    env["TRANSFORMERS_OFFLINE"] = "1"
    env["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    if profile is None:
        env.pop("DOCUMENT_INTELLIGENCE_PROFILE_PATH", None)
        env["DOCUMENT_INTELLIGENCE_PROFILE_ID"] = "default"
        env["DOCUMENT_INTELLIGENCE_ENABLED_PROVIDERS"] = "ghatana.docling,ghatana.paddleocr,ghatana.gliner,ghatana.minilm"
        env["DOCUMENT_INTELLIGENCE_ENABLED_LANGUAGES"] = "en,ne"
    else:
        env["DOCUMENT_INTELLIGENCE_PROFILE_PATH"] = str(profile)
        env["DOCUMENT_INTELLIGENCE_PROFILE_ID"] = "increment4a"
        env.pop("DOCUMENT_INTELLIGENCE_ENABLED_PROVIDERS", None)
        env.pop("DOCUMENT_INTELLIGENCE_ENABLED_LANGUAGES", None)
    return env


def _canonical_sha256(payload: Any) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def _get_json(base_url: str, path: str) -> tuple[int, Any]:
    request = urllib.request.Request(f"{base_url}{path}")
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8") or "{}")


def _run_worker_once(profile: Path | None) -> dict[str, Any]:
    """Start one worker process, capture its authority surface, stop it."""
    port = _free_port()
    base_url = f"http://127.0.0.1:{port}"
    python = ROOT / ".venv/bin/python"
    command = [
        str(python if python.is_file() else "python3"),
        "-m",
        "uvicorn",
        "document_intelligence.app:app",
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
    ]
    with tempfile.TemporaryFile(mode="w+t", encoding="utf-8") as log:
        process = subprocess.Popen(command, cwd=ROOT, env=_worker_env(port, profile), stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + READY_TIMEOUT_S
            ready_payload: dict[str, Any] | None = None
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    log.flush()
                    log.seek(0)
                    raise AssertionError(f"worker exited during startup:\n{log.read()[-4000:]}")
                try:
                    status, payload = _get_json(base_url, "/readyz")
                    if status == 200 and isinstance(payload, dict) and payload.get("status") == "ready":
                        ready_payload = payload
                        break
                except (urllib.error.URLError, ConnectionError, json.JSONDecodeError):
                    pass
                time.sleep(POLL_INTERVAL_S)
            if ready_payload is None:
                raise AssertionError(f"worker did not become ready on {base_url} within {READY_TIMEOUT_S}s")

            health_status, health = _get_json(base_url, "/healthz")
            assert health_status == 200 and isinstance(health, dict) and health.get("status") == "ok"
            catalog_status, catalog = _get_json(base_url, "/v1/providers")
            assert catalog_status == 200 and isinstance(catalog, dict)
            return {
                "baseUrl": base_url,
                "health": health,
                "readyz": ready_payload,
                "catalog": catalog,
                "catalogSha256": _canonical_sha256(catalog),
            }
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=10)


def _provider_refs(catalog: dict[str, Any]) -> set[str]:
    providers = catalog.get("providers")
    assert isinstance(providers, list)
    return {item["providerRef"] for item in providers}


def test_increment4a_profile_does_not_mutate_default_authority() -> None:
    if os.getenv("DOCUMENT_INTELLIGENCE_RUN_REAL_PROVIDERS") != "1":
        pytest.skip("cross-profile regression requires explicitly provisioned real providers")

    first_default = _run_worker_once(None)
    assert first_default["health"].get("profileId") == "default"
    default_refs = _provider_refs(first_default["catalog"])
    assert default_refs == {"ghatana.docling", "ghatana.paddleocr", "ghatana.gliner", "ghatana.minilm"}

    increment4a = _run_worker_once(INCREMENT4A_PROFILE)
    assert increment4a["health"].get("profileId") == "increment4a"
    extended_refs = _provider_refs(increment4a["catalog"])
    assert default_refs < extended_refs, "increment4a must extend — not replace — the admitted provider surface"
    assert increment4a["health"].get("observedProviderCatalogFingerprint") != first_default["health"].get(
        "observedProviderCatalogFingerprint"
    )

    second_default = _run_worker_once(None)
    assert second_default["health"].get("profileId") == "default"
    assert second_default["catalogSha256"] == first_default["catalogSha256"], (
        "selecting the increment4a profile must not mutate default authority: "
        "the restarted default catalog differs from the first default catalog"
    )
    for key in ("expectedProviderCatalogFingerprint", "observedProviderCatalogFingerprint", "expectedModelManifestFingerprint", "observedModelManifestFingerprint"):
        assert second_default["health"].get(key) == first_default["health"].get(key), f"default authority drifted after increment4a run: {key}"
