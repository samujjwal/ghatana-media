#!/usr/bin/env python3
"""Emit a ghatana.media.local-model-manifest.v1 for an installed local model.

The manifest records what is actually on disk (SHA-256 and size of every listed file) plus the
operator-supplied provenance fields. It does not download anything and it does not decide whether a
licence is acceptable: the Java verifier (LocalModelManifest.verify) enforces the owner-approved SPDX
identifier per modality (STT: MIT, TTS: Apache-2.0) and the verbatim owner decision.

Usage:
  make_manifest.py --model-root DIR --key KEY --modality SPEECH_TO_TEXT|TEXT_TO_SPEECH --model-id ID \
     --source-url URL --revision REV --spdx ID --license-source-url URL \
     --file ROLE:relative/path [--file ...] [--runtime-name N --runtime-version V --runtime-revision R \
     --runtime-exe PATH] [--language en ...] --notice TEXT [--notice-required] --out manifest.json
"""
import argparse
import datetime
import hashlib
import json
import os
import sys

OWNER_DECISION_DATE = "2026-11-14"
OWNER_DECISION_QUOTE = (
    "Local open models (Recommended): Whisper large-v3-turbo via whisper.cpp for speech-to-text (MIT). "
    "Kokoro-82M for text-to-speech (Apache-2.0, no voice cloning). Florence-2 for vision (MIT). "
    "Qwen2.5-VL-7B for multimodal (Apache-2.0). Media stays on this machine, with no per-use cost."
)
OWNER_LICENSE_STATEMENT = "we will abide by all license requirements."
ROLES = {"WEIGHTS", "CONFIG", "VOICE", "LICENSE", "MODEL_CARD"}


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-root", required=True)
    parser.add_argument("--key", required=True)
    parser.add_argument("--modality", required=True, choices=["SPEECH_TO_TEXT", "TEXT_TO_SPEECH"])
    parser.add_argument("--model-id", required=True)
    parser.add_argument("--source-url", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--spdx", required=True)
    parser.add_argument("--license-source-url", required=True)
    parser.add_argument("--file", action="append", required=True, help="ROLE:relative/path")
    parser.add_argument("--language", action="append", default=[])
    parser.add_argument("--notice", required=True)
    parser.add_argument("--notice-required", action="store_true")
    parser.add_argument("--scope", default="ARTIFACT_IDENTITY_AND_LICENSE_ONLY")
    parser.add_argument("--runtime-name")
    parser.add_argument("--runtime-version")
    parser.add_argument("--runtime-revision", default="")
    parser.add_argument("--runtime-exe")
    parser.add_argument("--voice-cloning", default="")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    files = []
    for spec in args.file:
        role, _, rel = spec.partition(":")
        if role not in ROLES or not rel:
            sys.exit("bad --file " + spec)
        path = os.path.join(args.model_root, rel)
        if not os.path.isfile(path) or os.path.islink(path):
            sys.exit("not a regular file: " + path)
        files.append({"role": role, "path": rel, "sha256": sha256(path), "sizeBytes": os.path.getsize(path)})

    manifest = {
        "schema": "ghatana.media.local-model-manifest.v1",
        "modelKey": args.key,
        "modality": args.modality,
        "modelId": args.model_id,
        "source": {"url": args.source_url, "revision": args.revision},
        "files": files,
        "license": {
            "spdx": args.spdx,
            "licenseSourceUrl": args.license_source_url,
            "verifiedOn": datetime.date.today().isoformat(),
        },
        "ownerDecision": {
            "date": OWNER_DECISION_DATE,
            "quote": OWNER_DECISION_QUOTE,
            "licenseStatement": OWNER_LICENSE_STATEMENT,
        },
        "attribution": {"noticeRequired": args.notice_required, "notice": args.notice},
        "admission": {"scope": args.scope, "productionEligible": False},
        "verifiedLanguages": args.language,
    }
    if args.voice_cloning:
        manifest["voiceCloning"] = args.voice_cloning
    if args.runtime_name:
        runtime = {"name": args.runtime_name, "version": args.runtime_version, "revision": args.runtime_revision}
        if args.runtime_exe:
            runtime["executableSha256"] = sha256(args.runtime_exe)
        manifest["runtime"] = runtime
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
        handle.write("\n")


if __name__ == "__main__":
    main()
