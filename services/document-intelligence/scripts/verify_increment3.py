#!/usr/bin/env python3
"""Increment 3 strict gate for the document-intelligence worker.

Every leaf status is derived from authoritative evidence:

- ``sharedContract``: semantic diff of the frozen Shared snapshot against the
  worker's contract lock.
- Test-derived leaves: parsed from a single pytest JUnitXML run (Python) and a
  single vitest JSON run (TypeScript). A leaf is PASS only when every mapped
  authoritative test exists and passed; a missing suite or skipped integration
  test is NOT_RUN, not PASS.
- ``evaluation``: the newest frozen evaluation summary must be PASS, must carry
  the complete I3-11 metric surface, and every frozen fingerprint (manifest,
  corpus, acceptance, environment, model manifest) must match the files on
  disk right now — otherwise the evidence is STALE and non-promotable.
- ``capabilityPromotion``: accepted provider catalog exactly equals the four
  declared providers, comes from the current evaluation run, and every accepted
  provider ref is documented in docs/PROVIDERS.md.
- ``increment3``: PASS only when every other emitted leaf is PASS
  (consumerScaffold may additionally be DEFERRED_TO_INCREMENT_4).

Usage:
    python scripts/verify_increment3.py --strict
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEVELOPMENTS = ROOT.parents[2]
SHARED = ROOT / "shared-contract" / "platform/typescript/document-extraction"
CONTRACT_LOCK = ROOT / "contracts/shared-contract.lock.json"
TS_CLIENT = ROOT / "clients/typescript"
GHARBATAI_SCAFFOLD = DEVELOPMENTS / "gharbatai" / "products/org/apps/api/src/modules/document-extraction"
STRICT_RECEIPT_PATH = ROOT / "docs/evidence/increment3-strict-receipt.json"
STRICT_RECEIPT_SCHEMA = "increment3.strict-receipt.v1"
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "evaluation"))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _digest_json(value: object) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def capture_shared_snapshot() -> dict | None:
    capture = ROOT / "clients/typescript/scripts/capture-shared-contract.mjs"
    env = {**os.environ, "GHATANA_SHARED_ROOT": os.getenv("GHATANA_SHARED_ROOT", str(DEVELOPMENTS / "ghatana-shared"))}
    result = subprocess.run(["node", str(capture), "--stdout", "--no-build"], cwd=ROOT, env=env, text=True, capture_output=True, check=False)
    if result.returncode != 0:
        return None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return None


def shared_contract_check(snapshot: dict | None = None) -> str:
    if not CONTRACT_LOCK.exists():
        return "FAIL"
    actual = capture_shared_snapshot() if snapshot is None else snapshot
    if actual is None:
        return "FAIL"
    expected = json.loads(CONTRACT_LOCK.read_text(encoding="utf-8"))
    return "PASS" if actual == expected else "FAIL"


def run(command: list[str], cwd: Path, env: dict | None = None) -> int:
    result = subprocess.run(command, cwd=cwd, env=env or os.environ.copy())
    return result.returncode


def load_junit(path: Path) -> dict[str, list[str]]:
    """Map test file -> list of per-testcase statuses (passed/failed/error/skipped)."""
    by_file: dict[str, list[str]] = {}
    try:
        tree = ET.parse(path)
    except (OSError, ET.ParseError):
        return by_file
    for case in tree.getroot().iter("testcase"):
        file_name = case.get("file")
        if not file_name:
            classname = case.get("classname", "")
            file_name = classname.replace(".", "/") + ".py" if classname else None
        if not file_name:
            continue
        if case.find("failure") is not None:
            status = "failed"
        elif case.find("error") is not None:
            status = "error"
        elif case.find("skipped") is not None:
            status = "skipped"
        else:
            status = "passed"
        by_file.setdefault(file_name, []).append(status)
    return by_file


def pytest_leaf(by_file: dict[str, list[str]], files: list[str]) -> str:
    statuses = [status for file_name in files for status in by_file.get(file_name, [])]
    if len(statuses) == 0 or any(status == "skipped" for status in statuses):
        return "NOT_RUN"
    return "PASS" if all(status == "passed" for status in statuses) else "FAIL"


def load_vitest(path: Path) -> dict[str, str]:
    """Map assertion title -> status."""
    titles: dict[str, str] = {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return titles
    for suite in data.get("testResults", []):
        for assertion in suite.get("assertionResults", []):
            titles[assertion.get("title", "")] = assertion.get("status", "")
    return titles


CONFORMANCE_FAILURE_STAGES = (
    "startup",
    "publication",
    "clientAdmission",
    "providerInvocation",
    "sharedAdmission",
    "routing",
    "assertion",
)


def classify_conformance_failure(title: str, detail: str = "") -> str:
    """Place a failed conformance case at its first actionable boundary."""
    text = f"{title} {detail}".lower()
    patterns = (
        ("startup", ("bootstrap", "startup", "readyz", "healthz", "readiness")),
        ("publication", ("publish", "persist", "result publication", "execution publication")),
        ("clientAdmission", ("client admission", "adapter admission", "client")),
        ("providerInvocation", ("provider", "docling", "paddle", "gliner", "minilm")),
        ("sharedAdmission", ("shared admission", "shared contract", "shared")),
        ("routing", ("routing", "route", "ambigu", "review")),
    )
    for stage, needles in patterns:
        if any(needle in text for needle in needles):
            return stage
    return "assertion"


def load_vitest_failures(path: Path) -> list[dict[str, str]]:
    """Persist actionable stage attribution alongside the strict gate result."""
    failures: list[dict[str, str]] = []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return failures
    for suite in data.get("testResults", []):
        for assertion in suite.get("assertionResults", []):
            if assertion.get("status") in {"passed", "skipped", "pending"}:
                continue
            title = assertion.get("title", "")
            messages = assertion.get("failureMessages", [])
            detail = "\n".join(message for message in messages if isinstance(message, str))
            failures.append({
                "stage": classify_conformance_failure(title, detail),
                "title": title,
                "status": assertion.get("status", "unknown"),
                "detail": detail,
            })
    if not failures and data.get("numFailedTests", 0):
        # Vitest can report a failed beforeAll/worker startup without an
        # assertion-level entry. Preserve that failure instead of emitting a
        # misleading empty staging record.
        failures.append({
            "stage": "startup",
            "title": "vitest suite failure without assertion result",
            "status": "failed",
            "detail": f"numFailedTests={data.get('numFailedTests')}; numFailedTestSuites={data.get('numFailedTestSuites', 0)}",
        })
    return failures


ENGINE_SCENARIOS = [
    "docling deterministic acceptance",
    "docling and gliner supplementation completes",
    "paddle and gliner low confidence routes to review",
    "ambiguous minilm template match routes to review",
    "provider timeout fails the execution without persisting a result",
    "cancellation during provider execution marks the execution cancelled",
    "malformed provider output fails closed and persists no result",
    "astral unicode evidence spans index exact shared line text after admission",
    "live docling crosses adapter admission and engine to accepted result",
    "live docling and gliner cross adapter admissions and engine to accepted result",
    "live paddle and gliner cross adapter admissions and engine to review",
    "live minilm crosses adapter admission before test-owned similarity routes ambiguity to review",
]

HELPER_CONFORMANCE = [
    "admits a real Docling adapter result through public parser admission",
    "admits GLiNER evidence through public field-extraction admission",
    "admits exactly 384 finite MiniLM dimensions through public embedding admission",
]

PY_LEAF_FILES = {
    "workerContract": [
        "tests/contract/test_protocol_v1.py",
        "tests/runtime/test_health.py",
        "tests/runtime/test_shutdown.py",
        "tests/runtime/test_model_registry.py",
    ],
    "docling": ["tests/providers/test_docling_parser.py", "tests/integration/test_real_providers.py"],
    "paddleEnglish": ["tests/providers/test_paddle_ocr_parser.py", "tests/integration/test_real_providers.py"],
    "paddleNepali": ["tests/providers/test_paddle_ocr_parser.py", "tests/integration/test_real_providers.py"],
    "glinerEnglish": ["tests/providers/test_gliner_extractor.py", "tests/integration/test_real_providers.py"],
    "glinerNepali": ["tests/providers/test_gliner_extractor.py", "tests/integration/test_real_providers.py"],
    "minilm": ["tests/providers/test_minilm_embedder.py", "tests/integration/test_real_providers.py"],
    "cancellation": ["tests/runtime/test_cancellation.py", "tests/runtime/test_concurrency.py"],
    "timeouts": ["tests/runtime/test_deadline.py"],
    "cleanup": ["tests/runtime/test_temporary_files.py"],
    "diagnosticSafety": [
        "tests/runtime/test_logging.py",
        "tests/adversarial/test_fail_closed.py",
        "tests/adversarial/test_fail_closed_transport.py",
        "tests/adversarial/test_provider_output_attacks.py",
        "tests/adversarial/test_resource_and_unicode.py",
    ],
    "offlineRuntime": ["tests/integration/test_offline_runtime.py"],
}

# Increment 3 owns the concrete Docling/PaddleOCR/GLiNER/MiniLM provider
# boundary only. Increment-4A office, fallback, Tesseract, and language-
# qualification suites have separate authority and must not invalidate the
# historical Increment-3 provider gate.
I3_TEST_PATHS = [
    "tests/contract",
    "tests/runtime/test_cancellation.py",
    "tests/runtime/test_concurrency.py",
    "tests/runtime/test_deadline.py",
    "tests/runtime/test_health.py",
    "tests/runtime/test_language_registry.py",
    "tests/runtime/test_logging.py",
    "tests/runtime/test_model_registry.py",
    "tests/runtime/test_provider_executor.py",
    "tests/runtime/test_shutdown.py",
    "tests/runtime/test_temporary_files.py",
    "tests/providers/test_docling_parser.py",
    "tests/providers/test_gliner_extractor.py",
    "tests/providers/test_minilm_embedder.py",
    "tests/providers/test_paddle_ocr_parser.py",
    "tests/adversarial/test_fail_closed.py",
    "tests/adversarial/test_fail_closed_transport.py",
    "tests/adversarial/test_provider_output_attacks.py",
    "tests/adversarial/test_resource_and_unicode.py",
    "tests/integration/test_offline_runtime.py",
    "tests/integration/test_real_providers.py",
]

PARSE_METRICS = [
    "cer", "wer", "layoutIoU", "regionPrecision", "regionRecall",
    "boundingBoxAgreement", "readingOrderCorrectness", "p50LatencyMs",
    "p95LatencyMs", "latencyPerPageMs", "inputBytes", "pageCount", "rssDeltaMb",
    "peakRssMb", "peakRssDeltaMb",
]
DOCLING_METRICS = PARSE_METRICS + [
    "tableStructureAccuracy", "cellTextAccuracy",
    "cellCoordinateAgreement", "cellStructureAccuracy",
]
GLINER_METRICS = [
    "entityF1", "entityPrecision", "entityRecall", "exactMatch",
    "evidenceAccuracy", "abstentionRate", "negativeMaxConfidence",
    "peakRssMb", "peakRssDeltaMb",
]
MINILM_METRICS = [
    "recallAt1", "recallAt5", "stability", "samePairSimilarity",
    "differentPairSimilarity", "sameTemplateCosineMean", "sameTemplateCosineMin",
    "differentTemplateCosineMean", "differentTemplateCosineMax", "retrievalAccuracy",
    "peakRssMb", "peakRssDeltaMb",
]

REQUIRED_EVAL_METRICS = (
    [f"docling.{lang}.{metric}" for lang in ("en", "ne") for metric in DOCLING_METRICS]
    + [f"paddle.{lang}.{metric}" for lang in ("en", "ne") for metric in PARSE_METRICS]
    + [f"gliner.{lang}.{metric}" for lang in ("en", "ne") for metric in GLINER_METRICS]
    + [f"minilm.und.{metric}" for metric in MINILM_METRICS]
    + ["docling.en.cancellationCheckMs", "paddle.en.cancellationCheckMs",
       "gliner.en.cancellationCheckMs", "minilm.und.cancellationCheckMs"]
)


def latest_evaluation() -> tuple[Path | None, dict | None]:
    summaries = sorted((ROOT / "evaluation/results").glob("*/summary.json"))
    if not summaries:
        return None, None
    path = summaries[-1]
    try:
        return path, json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return path, None


def frozen_fingerprints() -> dict[str, str]:
    manifest_path = ROOT / "evaluation/manifest.yaml"
    manifest_data = json.loads(json.dumps(__import__("yaml").safe_load(manifest_path.read_text(encoding="utf-8"))))
    from run_evaluation import corpus_fingerprint, evaluation_implementation_fingerprint, provider_semantics_fingerprint  # noqa: PLC0415

    return {
        "manifestFingerprint": sha256(manifest_path),
        "corpusFingerprint": corpus_fingerprint(manifest_data, ROOT / "evaluation/corpus"),
        "acceptanceFingerprint": sha256(ROOT / "evaluation/acceptance.yaml"),
        "environmentFingerprint": sha256(ROOT / "evaluation/environment.yaml"),
        "modelManifestFingerprint": sha256(ROOT / "models/model-manifest.yaml"),
        "providerSemanticsFingerprint": provider_semantics_fingerprint(),
        "evaluationImplementationFingerprint": evaluation_implementation_fingerprint(),
    }


def _tree_fingerprint(root: Path, paths: list[str]) -> str:
    """Deterministic digest over named files/dirs; build outputs are ignored."""
    digest = hashlib.sha256()
    ignored_parts = {"__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", "node_modules", "dist", "coverage", ".vite"}
    for relative in paths:
        path = root / relative
        if not path.exists():
            digest.update(f"{relative}:MISSING".encode("utf-8"))
            continue
        if path.is_file():
            digest.update(relative.encode("utf-8"))
            digest.update(path.read_bytes())
            continue
        for item in sorted(path.rglob("*")):
            if not item.is_file() or any(part in ignored_parts for part in item.parts):
                continue
            digest.update(str(item.relative_to(root)).encode("utf-8"))
            digest.update(item.read_bytes())
    return digest.hexdigest()


def _pytest_version() -> str:
    try:
        return importlib.metadata.version("pytest")
    except importlib.metadata.PackageNotFoundError:
        return "MISSING"


def _tool_version(command: list[str]) -> str:
    try:
        result = subprocess.run(command, text=True, capture_output=True, check=False)
        return result.stdout.strip() or result.stderr.strip() or "MISSING"
    except OSError:
        return "MISSING"


def strict_input_fingerprints(snapshot: dict | None) -> dict[str, str]:
    """All material inputs the strict execution leaves are allowed to reuse against."""
    return {
        **frozen_fingerprints(),
        "sharedContractLockSha256": sha256(CONTRACT_LOCK) if CONTRACT_LOCK.exists() else "MISSING",
        "sharedContractSnapshotSha256": _digest_json(snapshot) if snapshot is not None else "MISSING",
        "workerClientFingerprint": _tree_fingerprint(TS_CLIENT, ["src", "tests", "scripts", "package.json", "tsconfig.json", "tsconfig.build.json", "vitest.config.ts", "vitest.config.mts"]),
        "testSpecFingerprint": _tree_fingerprint(ROOT, [*I3_TEST_PATHS, "conftest.py", "tests/conftest.py", "pyproject.toml", "pytest.ini", "scripts/verify_increment3.py", "scripts/preflight_increment3.py", "scripts/verify_models.py"]),
        "uvLockSha256": sha256(ROOT / "uv.lock"),
        "profileId": "default",
        "pythonVersion": sys.version.split()[0],
        "pytestVersion": _pytest_version(),
        "nodeVersion": _tool_version(["node", "--version"]),
        "pnpmVersion": _tool_version(["pnpm", "--version"]),
    }


def evaluation_leaf() -> str:
    path, summary = latest_evaluation()
    if path is None or summary is None:
        return "NOT_RUN"
    marker = path.with_name("lineage.json")
    if marker.exists():
        try:
            if json.loads(marker.read_text(encoding="utf-8")).get("status") == "INVALIDATED_NON_PROMOTABLE":
                return "STALE"
        except (OSError, json.JSONDecodeError):
            return "STALE"
    if summary.get("status") != "PASS" or summary.get("executionError") is not None:
        return "FAIL"
    if summary.get("missingModels") or summary.get("missingMetrics"):
        return "FAIL"
    hard = summary.get("hardMetrics")
    if not isinstance(hard, dict) or any(value != 0 for value in hard.values()):
        return "FAIL"
    current = frozen_fingerprints()
    if any(summary.get(key) != value for key, value in current.items()):
        return "STALE"
    metrics = summary.get("metrics", {})
    if any(key not in metrics for key in REQUIRED_EVAL_METRICS):
        return "FAIL"
    return "PASS"


def eval_threshold_pass(summary: dict | None, provider: str, language: str) -> bool:
    if summary is None:
        return False
    entries = summary.get("thresholdResults", {}).get(provider, {}).get(language, {})
    return bool(entries) and all(result.get("status") == "PASS" for result in entries.values())


def capability_leaf(summary: dict | None, eval_status: str) -> str:
    if eval_status != "PASS" or summary is None:
        return eval_status if eval_status != "PASS" else "FAIL"
    path, _ = latest_evaluation()
    if path is None:
        return "NOT_RUN"
    capabilities_path = path.with_name("capabilities.json")
    if not capabilities_path.exists():
        return "FAIL"
    try:
        catalog = json.loads(capabilities_path.read_text(encoding="utf-8")).get("accepted", [])
    except (OSError, json.JSONDecodeError):
        return "FAIL"
    if not isinstance(catalog, list) or not catalog:
        return "FAIL"
    expected = {"ghatana.docling", "ghatana.paddleocr", "ghatana.gliner", "ghatana.minilm"}
    if {item.get("providerRef") for item in catalog} != expected:
        return "FAIL"
    if any(sorted(item.keys()) != ["capabilities", "providerRef"] for item in catalog):
        return "FAIL"
    providers_doc = ROOT / "docs/PROVIDERS.md"
    host_doc = ROOT / "docs/HOST-INTEGRATION.md"
    if not providers_doc.exists() or not host_doc.exists():
        return "FAIL"
    documented = providers_doc.read_text(encoding="utf-8")
    if any(ref not in documented for ref in expected):
        return "FAIL"
    return "PASS"


def engine_leaf(titles: dict[str, str]) -> str:
    required = ENGINE_SCENARIOS + HELPER_CONFORMANCE
    if any(titles.get(title) is None for title in required):
        return "NOT_RUN"
    return "PASS" if all(titles[title] == "passed" for title in required) else "FAIL"


EXECUTED_LEAVES = tuple(PY_LEAF_FILES) + ("pythonTests", "typescriptTests", "typescriptBuild", "sharedEngineConformance")


def pytest_command(junit_path: Path) -> list[str]:
    # no:cacheprovider keeps .pytest_cache out of the source tree so the gate
    # is read-only-clean; JUnitXML is redirected to the caller's tmpdir.
    return [sys.executable, "-m", "pytest", *I3_TEST_PATHS, f"--junitxml={junit_path}", "-p", "no:cacheprovider"]


def vitest_command(report_path: Path) -> list[str]:
    return ["pnpm", "exec", "vitest", "run", "--reporter=json", f"--outputFile={report_path}"]


def typescript_build_command(out_dir: Path) -> list[str]:
    # The build leaf compiles into an ephemeral directory: a strict gate run
    # must not write dist/ (or any build artifact) into the source tree. Use
    # the already-installed local compiler directly: ``pnpm exec`` may invoke
    # its workspace install/status check, which can mutate a read-only source
    # checkout before TypeScript even starts.
    return ["./node_modules/.bin/tsc", "-p", "tsconfig.build.json", "--outDir", str(out_dir)]


def strict_environment() -> dict[str, str]:
    env = os.environ.copy()
    env["DOCUMENT_INTELLIGENCE_RUN_REAL_PROVIDERS"] = "1"
    env["DOCUMENT_INTELLIGENCE_OFFLINE"] = "true"
    env["HF_HUB_OFFLINE"] = "1"
    env["TRANSFORMERS_OFFLINE"] = "1"
    env["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    # Increment-3 strict evidence must be reproducible even when the caller's
    # shell previously selected an Increment-4A profile or another model root.
    # Select the canonical default explicitly so a successful receipt proves
    # the profile boundary, rather than relying on the worker's implicit
    # no-profile fallback.
    env.pop("DOCUMENT_INTELLIGENCE_PROFILE_PATH", None)
    env["DOCUMENT_INTELLIGENCE_PROFILE_ID"] = "default"
    env.pop("DOCUMENT_INTELLIGENCE_CAPABILITIES", None)
    env["DOCUMENT_INTELLIGENCE_MODEL_CACHE"] = str(ROOT / ".models")
    env["DOCUMENT_INTELLIGENCE_ENABLED_PROVIDERS"] = "ghatana.docling,ghatana.paddleocr,ghatana.gliner,ghatana.minilm"
    env["DOCUMENT_INTELLIGENCE_ENABLED_LANGUAGES"] = "en,ne"
    return env


def load_strict_receipt() -> dict:
    try:
        return json.loads(STRICT_RECEIPT_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def strict_receipt_usable(receipt: dict, input_fingerprints: dict[str, str]) -> bool:
    executed = receipt.get("executedLeaves")
    return (
        receipt.get("schemaVersion") == STRICT_RECEIPT_SCHEMA
        and receipt.get("status") == "PASS"
        and receipt.get("inputFingerprints") == input_fingerprints
        and isinstance(executed, dict)
        and all(executed.get(name) == "PASS" for name in EXECUTED_LEAVES)
    )


def write_strict_receipt(
    input_fingerprints: dict[str, str],
    executed_leaves: dict[str, str],
    conformance_failures: list[dict[str, str]] | None = None,
) -> None:
    existing = load_strict_receipt()
    # A receipt for identical inputs and leaf outcomes is the same proof: keep
    # the original runId/completedAt instead of rewriting the artifact.
    if (
        existing.get("schemaVersion") == STRICT_RECEIPT_SCHEMA
        and existing.get("status") == "PASS"
        and existing.get("inputFingerprints") == input_fingerprints
        and existing.get("executedLeaves") == executed_leaves
        and existing.get("conformanceFailureStaging", {}).get("failures", []) == (conformance_failures or [])
    ):
        return
    payload = {
        "schemaVersion": STRICT_RECEIPT_SCHEMA,
        "status": "PASS",
        "runId": datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
        "completedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "inputFingerprints": input_fingerprints,
        "executedLeaves": executed_leaves,
        "conformanceFailureStaging": {
            "schemaVersion": "increment3.conformance-failure-staging.v1",
            "status": "PASS" if not conformance_failures else "FAIL",
            "failures": conformance_failures or [],
        },
    }
    STRICT_RECEIPT_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STRICT_RECEIPT_PATH.with_name(STRICT_RECEIPT_PATH.name + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(STRICT_RECEIPT_PATH)


def main() -> int:
    # Verification imports must never emit bytecode into the source tree.
    sys.dont_write_bytecode = True
    parser = argparse.ArgumentParser()
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()

    snapshot = capture_shared_snapshot()
    checks: dict[str, str] = {"sharedContract": shared_contract_check(snapshot)}

    if not args.strict:
        for leaf in list(PY_LEAF_FILES) + ["evaluation", "consumerScaffold", "sharedEngineConformance", "capabilityPromotion"]:
            checks[leaf] = "NOT_RUN"
        checks["promotion"] = "NOT_RUN"
        checks["increment3"] = "NOT_RUN"
        payload = {"checks": checks, "status": "NOT_RUN"}
        print(json.dumps(payload, indent=2, sort_keys=True))
        return 0

    env = strict_environment()
    strict_inputs = strict_input_fingerprints(snapshot)

    preflight = subprocess.run(
        [sys.executable, "scripts/preflight_increment3.py", "--json"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    try:
        preflight_payload = json.loads(preflight.stdout)
    except json.JSONDecodeError:
        preflight_payload = {"status": "ENVIRONMENT_NOT_READY", "raw": preflight.stdout[-1000:]}
    checks["environmentPreflight"] = "PASS" if preflight.returncode == 0 else "ENVIRONMENT_NOT_READY"
    if preflight.returncode != 0:
        checks["environmentPreflightDetail"] = preflight_payload
        for leaf in list(PY_LEAF_FILES) + ["evaluation", "consumerScaffold", "sharedEngineConformance", "capabilityPromotion"]:
            checks[leaf] = "NOT_RUN"
        checks["promotion"] = "FAIL"
        checks["increment3"] = "FAIL"
        payload = {"checks": dict(sorted(checks.items())), "environment": preflight_payload, "status": "ENVIRONMENT_NOT_READY"}
        print(json.dumps(payload, indent=2, sort_keys=True))
        return 1

    checks["modelAssets"] = "PASS" if run([sys.executable, "scripts/verify_models.py"], ROOT, env) == 0 else "FAIL"

    # Fingerprint-keyed receipt: execution leaves (pytest/vitest/tsc) may reuse
    # a recorded PASS only when every declared material input is unchanged.
    # Artifact leaves (evaluation, capability promotion, scaffold, contract)
    # are always reconciled live because they are cheap and drift-sensitive.
    receipt = load_strict_receipt()
    receipt_ok = strict_receipt_usable(receipt, strict_inputs)
    conformance_failures = (
        receipt.get("conformanceFailureStaging", {}).get("failures", [])
        if receipt_ok and isinstance(receipt.get("conformanceFailureStaging", {}), dict)
        else []
    )

    with tempfile.TemporaryDirectory(prefix="increment3-gate-") as temp_dir:
        if receipt_ok:
            checks.update({name: receipt["executedLeaves"][name] for name in EXECUTED_LEAVES})
        else:
            junit_path = Path(temp_dir) / "pytest.xml"
            vitest_path = Path(temp_dir) / "vitest.json"
            ts_out_dir = Path(temp_dir) / "tsbuild"

            pytest_rc = run(pytest_command(junit_path), ROOT, env)
            checks["pythonTests"] = "PASS" if pytest_rc == 0 else "FAIL"
            by_file = load_junit(junit_path)

            vitest_rc = run(vitest_command(vitest_path), TS_CLIENT, env)
            # One execution is the authority for both the suite result and named
            # engine-conformance leaves. Running pnpm test separately would start
            # the real provider worker twice and double the expensive warm-up.
            checks["typescriptTests"] = "PASS" if vitest_rc == 0 else "FAIL"
            vitest_titles = load_vitest(vitest_path)
            conformance_failures = load_vitest_failures(vitest_path)

            checks["typescriptBuild"] = "PASS" if run(typescript_build_command(ts_out_dir), TS_CLIENT, env) == 0 else "FAIL"

            for leaf, files in PY_LEAF_FILES.items():
                checks[leaf] = pytest_leaf(by_file, files)
            checks["sharedEngineConformance"] = engine_leaf(vitest_titles)

        executed_leaves = {name: checks[name] for name in EXECUTED_LEAVES}

        checks["evaluation"] = evaluation_leaf()
        eval_status = checks["evaluation"]
        _, summary = latest_evaluation()

        # Provider leaves additionally require the measured frozen evaluation
        # thresholds for their provider/language to be PASS.
        provider_thresholds = {
            "docling": eval_threshold_pass(summary, "docling", "en") and eval_threshold_pass(summary, "docling", "ne"),
            "paddleEnglish": eval_threshold_pass(summary, "paddle", "en"),
            "paddleNepali": eval_threshold_pass(summary, "paddle", "ne"),
            "glinerEnglish": eval_threshold_pass(summary, "gliner", "en"),
            "glinerNepali": eval_threshold_pass(summary, "gliner", "ne"),
            "minilm": eval_threshold_pass(summary, "minilm", "und"),
        }
        for leaf, threshold_ok in provider_thresholds.items():
            if checks[leaf] == "PASS" and not threshold_ok:
                checks[leaf] = "FAIL" if eval_status != "NOT_RUN" else "NOT_RUN"

        checks["capabilityPromotion"] = capability_leaf(summary, eval_status)

    scaffold_config = GHARBATAI_SCAFFOLD / "document-intelligence.config.ts"
    checks["consumerScaffold"] = (
        "PASS"
        if (GHARBATAI_SCAFFOLD / "document-extraction.module.ts").exists()
        and (GHARBATAI_SCAFFOLD / "document-extraction.providers.ts").exists()
        and (GHARBATAI_SCAFFOLD / "README.md").exists()
        and scaffold_config.exists()
        and "enabled: false" in scaffold_config.read_text(encoding="utf-8")
        else "DEFERRED_TO_INCREMENT_4"
    )

    promotion_inputs = ("modelAssets", "pythonTests", "typescriptTests", "typescriptBuild", "evaluation", "capabilityPromotion", "offlineRuntime", "sharedEngineConformance")
    checks["promotion"] = "PASS" if all(checks.get(name) == "PASS" for name in promotion_inputs) else "FAIL"

    gate_leaves = {name: status for name, status in checks.items() if name not in {"increment3", "promotion", "modelAssets", "pythonTests", "typescriptTests", "typescriptBuild", "capabilityPromotion", "sharedEngineConformance", "offlineRuntime"}}
    aggregate_ok = all(status == "PASS" for name, status in gate_leaves.items() if name != "consumerScaffold") and gate_leaves.get("consumerScaffold") in {"PASS", "DEFERRED_TO_INCREMENT_4"}
    checks["increment3"] = "PASS" if aggregate_ok and checks["promotion"] == "PASS" else "FAIL"

    if checks["increment3"] == "PASS" and not receipt_ok:
        write_strict_receipt(strict_inputs, executed_leaves, conformance_failures)

    payload = {
        "checks": dict(sorted(checks.items())),
        "status": checks["increment3"],
        "strictReceipt": "REUSED" if receipt_ok else "EXECUTED",
        "conformanceFailureStaging": {
            "schemaVersion": "increment3.conformance-failure-staging.v1",
            "status": "PASS" if not conformance_failures else "FAIL",
            "failures": conformance_failures,
        },
    }
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0 if checks["increment3"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
