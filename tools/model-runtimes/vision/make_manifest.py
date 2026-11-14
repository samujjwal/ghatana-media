#!/usr/bin/env python3
"""Write ghatana-model-manifest.json for a downloaded local model directory.

The manifest is generated OUTSIDE the repository next to the weights; this script only
hashes what is on disk and records the owner decision and licence facts. It does not
download anything and never claims a licence it cannot see: the SPDX id passed in must
equal the licence recorded in the model card/LICENSE the operator read.
"""
import argparse
import hashlib
import json
import os
import sys

OWNER_QUOTE = ("Local open models (Recommended): Whisper large-v3-turbo via whisper.cpp for speech-to-text (MIT). "
               "Kokoro-82M for text-to-speech (Apache-2.0, no voice cloning). Florence-2 for vision (MIT). "
               "Qwen2.5-VL-7B for multimodal (Apache-2.0). Media stays on this machine, with no per-use cost.")
OWNER_NOTE = "we will abide by all license requirements."


def sha256_file(path):
    d = hashlib.sha256()
    with open(path, "rb") as h:
        for b in iter(lambda: h.read(1 << 20), b""):
            d.update(b)
    return d.hexdigest()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--model-dir", required=True)
    p.add_argument("--model-id", required=True)
    p.add_argument("--role", required=True, choices=["VISION", "MULTIMODAL_QA"])
    p.add_argument("--source-url", required=True)
    p.add_argument("--revision", required=True)
    p.add_argument("--spdx", required=True)
    p.add_argument("--license-file", required=True, help="path relative to model-dir")
    p.add_argument("--license-source", required=True)
    p.add_argument("--remote-code-file", action="append", default=[])
    p.add_argument("--upstream-sha256", action="append", default=[], help="path=sha256 published by the host")
    p.add_argument("--runtime-kind", required=True)
    p.add_argument("--quantization", default="none")
    p.add_argument("--obligation", action="append", default=[])
    p.add_argument("--attribution", required=True)
    p.add_argument("--decided-on", default="2026-11-14")
    a = p.parse_args()
    upstream = dict(x.split("=", 1) for x in a.upstream_sha256)
    skip = {"ghatana-model-manifest.json", "dl.log"}
    files = []
    for name in sorted(os.listdir(a.model_dir)):
        full = os.path.join(a.model_dir, name)
        if name in skip or name.startswith(".") or not os.path.isfile(full):
            continue
        digest = sha256_file(full)
        if name in upstream and upstream[name] != digest:
            sys.exit("on-disk digest differs from upstream-published digest for " + name)
        files.append({"path": name, "sha256": digest, "sizeBytes": os.path.getsize(full),
                      "upstreamSha256Verified": name in upstream})
    if a.license_file not in [f["path"] for f in files]:
        sys.exit("licence file is not in the model directory")
    set_digest = hashlib.sha256(
        "".join(f["path"] + ":" + f["sha256"] + "\n" for f in files).encode()).hexdigest()
    manifest = {
        "schemaVersion": "ghatana.media.local-model-manifest.v1",
        "modelId": a.model_id, "role": a.role, "sourceUrl": a.source_url, "revision": a.revision,
        "spdxLicense": a.spdx,
        "licenseFile": {"path": a.license_file,
                        "sha256": next(f["sha256"] for f in files if f["path"] == a.license_file),
                        "source": a.license_source},
        "files": files, "fileSetSha256": set_digest,
        "remoteCode": {"required": bool(a.remote_code_file),
                       "pinnedRevision": a.revision if a.remote_code_file else None,
                       "files": a.remote_code_file},
        "runtime": {"kind": a.runtime_kind, "quantization": a.quantization},
        "ownerDecision": {"quote": OWNER_QUOTE, "licenseNote": OWNER_NOTE, "decidedOn": a.decided_on,
                          "channel": "user chat"},
        "attribution": a.attribution, "obligations": a.obligation,
    }
    out = os.path.join(a.model_dir, "ghatana-model-manifest.json")
    with open(out, "w", encoding="utf-8") as h:
        json.dump(manifest, h, indent=2, sort_keys=True)
        h.write("\n")
    print(out, set_digest)


if __name__ == "__main__":
    main()
