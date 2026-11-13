#!/usr/bin/env python3
"""Provision only declared model artifacts; never download during inference."""
from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


def tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(item for item in root.rglob('*') if item.is_file() and item.name not in {'PROVISIONING_REQUIRED', '.artifact.sha256'}):
        digest.update(str(path.relative_to(root)).encode('utf-8'))
        digest.update(path.read_bytes())
    return digest.hexdigest()


def download_declared(entry: dict, target: Path) -> None:
    provider = entry['providerRef']
    target.mkdir(parents=True, exist_ok=True)
    if provider == 'ghatana.docling':
        subprocess.run(['docling-tools', 'models', 'download', 'layout', 'tableformer', '--output-dir', str(target)], check=True)
    elif provider == 'ghatana.gliner':
        from huggingface_hub import snapshot_download
        snapshot_download(repo_id=entry['modelRef'], revision=entry['modelRevision'], local_dir=target)
        snapshot_download(repo_id='microsoft/mdeberta-v3-base', revision='main', cache_dir=target / 'hf-cache')
    elif provider == 'ghatana.minilm':
        from huggingface_hub import snapshot_download
        snapshot_download(repo_id=entry['modelRef'], revision=entry['modelRevision'], local_dir=target)
    elif provider == 'ghatana.paddleocr':
        from paddleocr import PaddleOCR
        language = entry['language']
        PaddleOCR(lang=language, ocr_version='PP-OCRv5', use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False)
        official = Path.home() / '.paddlex/official_models'
        recognition = 'en_PP-OCRv5_mobile_rec' if language == 'en' else 'devanagari_PP-OCRv5_mobile_rec'
        shutil.copytree(official / 'PP-OCRv5_server_det', target / 'detection', dirs_exist_ok=True)
        shutil.copytree(official / recognition, target / 'recognition', dirs_exist_ok=True)
    else:
        raise SystemExit(f"unsupported declared provider: {provider}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--cache-root', default=os.getenv('DOCUMENT_INTELLIGENCE_MODEL_CACHE', str(ROOT / '.models')))
    parser.add_argument('--source-root', default=os.getenv('DOCUMENT_INTELLIGENCE_LOCAL_MODEL_SOURCE'))
    parser.add_argument('--download', action='store_true')
    args = parser.parse_args()
    manifest = yaml.safe_load((ROOT / 'models/model-manifest.yaml').read_text())
    cache = Path(args.cache_root); cache.mkdir(parents=True, exist_ok=True)
    source = Path(args.source_root) if args.source_root else None
    for entry in manifest.get('models', []):
        key = f"{entry['providerRef']}__{entry['modelRef']}__{entry['modelRevision']}".replace('/', '_')
        target = cache / key
        if target.exists() and (target / '.artifact.sha256').exists() and not args.download:
            continue
        if args.download:
            (target / 'PROVISIONING_REQUIRED').unlink(missing_ok=True)
            download_declared(entry, target)
        elif source is None:
            target.mkdir(mode=0o700)
            (target / 'PROVISIONING_REQUIRED').write_text('Place the pinned offline artifact here before readiness.\n')
            continue
        else:
            candidate = source / key
            if not candidate.exists():
                raise SystemExit(f'missing declared local artifact: {candidate}')
            (target / 'PROVISIONING_REQUIRED').unlink(missing_ok=True)
            shutil.copytree(candidate, target, dirs_exist_ok=True)
        if not any(path.is_file() for path in target.rglob('*')):
            raise SystemExit(f'empty declared local artifact: {target}')
        (target / '.artifact.sha256').write_text(tree_digest(target) + '\n', encoding='utf-8')
    print(f'provisioned {len(manifest.get("models", []))} declared model entries under {cache}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
