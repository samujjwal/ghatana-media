#!/usr/bin/env python3
"""Generate a CycloneDX-lite SBOM for the document-intelligence worker (I6-43).

Components are drawn from three authority sources:

- ``uv.lock`` — every ``[[package]]`` block contributes a ``library``
  component pinned by name + version (purl ``pkg:pypi/<name>@<version>``);
- the model manifests — every artifact/model entry with an
  ``artifactSha256`` contributes a ``machine-learning-model`` component
  pinned by SHA-256;
- the tesseract provisioning record — each deb package contributes a
  ``library`` component and the runtime executable an ``application``
  component, all pinned by SHA-256.

Output is ``deployment/sbom/sbom.v1.json`` (atomic write). ``generatedAt``
is the only volatile field: ``--check`` regenerates the SBOM and compares
everything except ``generatedAt``, so drift in any pinned component fails
closed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tomllib
from datetime import datetime, timezone
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]

SBOM_SCHEMA = "document-intelligence.sbom.v1"
MODEL_MANIFESTS = ("models/model-manifest.yaml", "models/increment4a/model-manifest.yaml")


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _uv_components(root: Path) -> list[dict]:
    lock = root / "uv.lock"
    if not lock.is_file():
        raise FileNotFoundError("uv.lock missing — cannot enumerate python components")
    data = tomllib.loads(lock.read_text(encoding="utf-8"))
    components = []
    for package in data.get("package", []) or []:
        name, version = package.get("name"), package.get("version")
        if not name or not version:
            continue
        components.append(
            {
                "type": "library",
                "name": name,
                "version": version,
                "purl": f"pkg:pypi/{name}@{version}",
                "source": "uv.lock",
            }
        )
    return components


def _model_components(root: Path) -> list[dict]:
    components: dict[tuple[str, str], dict] = {}
    for rel in MODEL_MANIFESTS:
        path = root / rel
        if not path.is_file():
            continue
        manifest = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        for entry in (manifest.get("artifacts") or []) + (manifest.get("models") or []):
            if not isinstance(entry, dict):
                continue
            sha = entry.get("artifactSha256")
            if not sha:
                continue
            name = entry.get("modelRef") or entry.get("artifactId") or "unknown"
            version = str(
                entry.get("modelRevision") or entry.get("modelVersion") or "unknown"
            )
            key = (str(name), sha)
            component = components.setdefault(
                key,
                {
                    "type": "machine-learning-model",
                    "name": str(name),
                    "version": version,
                    "providerRef": entry.get("providerRef"),
                    "hashes": [{"alg": "SHA-256", "content": sha}],
                    "source": rel,
                },
            )
            if rel not in component["source"]:
                component["source"] = component["source"] + f",{rel}"
    return list(components.values())


def _native_components(root: Path) -> list[dict]:
    path = root / "models/increment4a/model-manifest.yaml"
    if not path.is_file():
        return []
    manifest = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    components = []
    for entry in manifest.get("models") or []:
        if not isinstance(entry, dict):
            continue
        provisioning = entry.get("provisioning") or {}
        for pkg, record in (provisioning.get("packages") or {}).items():
            if not isinstance(record, dict):
                continue
            comp = {
                "type": "library",
                "name": str(pkg),
                "version": str(record.get("version") or "unknown"),
                "purl": f"pkg:deb/ubuntu/{pkg}@{record.get('version')}",
                "source": "models/increment4a/model-manifest.yaml",
            }
            if record.get("sha256"):
                comp["hashes"] = [{"alg": "SHA-256", "content": record["sha256"]}]
            components.append(comp)
        executable = entry.get("executable") or {}
        if executable.get("command"):
            comp = {
                "type": "application",
                "name": str(executable["command"]),
                "version": str(executable.get("version") or "unknown"),
                "source": "models/increment4a/model-manifest.yaml",
            }
            if executable.get("sha256"):
                comp["hashes"] = [{"alg": "SHA-256", "content": executable["sha256"]}]
            components.append(comp)
    return components


def generate(root: Path) -> dict:
    components = _uv_components(root) + _model_components(root) + _native_components(root)
    components.sort(key=lambda c: (c["type"], c["name"], c.get("version", "")))
    pyproject = root / "pyproject.toml"
    project_version = "0.1.0"
    if pyproject.is_file():
        for line in pyproject.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped.startswith("version"):
                project_version = stripped.split("=", 1)[1].strip().strip('"')
                break
    return {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "schemaVersion": SBOM_SCHEMA,
        "generatedAt": datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
        "metadata": {
            "component": {
                "type": "application",
                "name": "ghatana-document-intelligence",
                "version": project_version,
            }
        },
        "components": components,
        "componentCount": len(components),
    }


def _comparable(doc: dict) -> dict:
    return {k: v for k, v in doc.items() if k != "generatedAt"}


def check(root: Path, output_path: Path) -> dict:
    errors: list[str] = []
    if not output_path.is_file():
        return {"sbom": "FAIL", "errors": [f"SBOM missing: {output_path}"]}
    try:
        stored = json.loads(output_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return {"sbom": "FAIL", "errors": [f"SBOM invalid json: {exc}"]}
    try:
        regenerated = generate(root)
    except FileNotFoundError as exc:
        return {"sbom": "FAIL", "errors": [str(exc)]}
    if _comparable(stored) != _comparable(regenerated):
        stored_components = {
            json.dumps(c, sort_keys=True) for c in stored.get("components", [])
        }
        regen_components = {
            json.dumps(c, sort_keys=True) for c in regenerated.get("components", [])
        }
        for item in sorted(regen_components - stored_components)[:10]:
            errors.append(f"component missing from stored SBOM: {item[:160]}")
        for item in sorted(stored_components - regen_components)[:10]:
            errors.append(f"stale component in stored SBOM: {item[:160]}")
        if _comparable({k: v for k, v in stored.items() if k != "components"}) != _comparable(
            {k: v for k, v in regenerated.items() if k != "components"}
        ):
            errors.append("SBOM metadata drift beyond component set")
    return {"sbom": "FAIL" if errors else "PASS", "errors": errors}


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument(
        "--output", type=Path, default=None,
        help="SBOM output (default: <root>/deployment/sbom/sbom.v1.json)",
    )
    parser.add_argument("--check", action="store_true", help="read-only re-verification")
    args = parser.parse_args(argv)

    root = args.root.resolve()
    output = args.output or root / "deployment/sbom/sbom.v1.json"

    if args.check:
        result = check(root, output)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result["sbom"] == "PASS" else 2

    try:
        sbom = generate(root)
    except FileNotFoundError as exc:
        print(json.dumps({"sbom": "FAIL", "errors": [str(exc)]}, indent=2))
        return 2
    _atomic_write(output, json.dumps(sbom, indent=2, sort_keys=True) + "\n")
    print(
        json.dumps(
            {
                "sbom": "DECLARED",
                "path": str(output),
                "components": sbom["componentCount"],
                "sbomSha256": f"sha256:{_sha256_file(output)}",
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
