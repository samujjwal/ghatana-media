"""
Model Manager - Production ML Model Management

Handles downloading, caching, versioning, and loading of ML models:
- Demucs (stem separation)
- VITS (voice training)
- RVC (voice conversion)
- MOSNet (quality metrics)
- Whisper (ASR for WER)
- ECAPA-TDNN (speaker similarity)

@doc.type module
@doc.purpose ML model lifecycle management
@doc.layer ai-voice
"""

from __future__ import annotations

import os
import json
import hashlib
import time
import traceback
import urllib.request
import urllib.error
from pathlib import Path
from typing import Dict, Optional, Callable, List
from dataclasses import dataclass, asdict
import logging

try:
    import torch
except ImportError:
    torch = None

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


DEMUCS_HTDEMUS_FT_FILES: Dict[str, str] = {
    "drums": "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/f7e0c4bc-ba3fe64a.th",
    "bass": "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/d12395a8-e57c48e6.th",
    "other": "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/92cfc3b6-ef3bcb9c.th",
    "vocals": "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/04573f0d-f3cf25b2.th",
}


@dataclass
class ModelInfo:
    """Information about a model."""
    name: str
    version: str
    url: str
    size_mb: float
    md5: str
    description: str
    dependencies: List[str]


# Model registry
MODEL_REGISTRY: Dict[str, ModelInfo] = {
    'demucs-htdemucs': ModelInfo(
        name='htdemucs',
        version='v4',
        url='https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th',
        size_mb=2400.0,
        md5='placeholder',
        description='Demucs Hybrid Transformer (4-stem)',
        dependencies=['torch', 'torchaudio', 'demucs']
    ),
    'demucs-htdemucs_ft': ModelInfo(
        name='htdemucs_ft',
        version='v4',
        url='https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/f7e0c4bc-ba3fe64a.th',
        size_mb=2400.0,
        md5='placeholder',
        description='Demucs Hybrid Transformer Fine-tuned (downloads 4 per-source models)',
        dependencies=['torch', 'torchaudio', 'demucs']
    ),
    'demucs-htdemucs_6s': ModelInfo(
        name='htdemucs_6s',
        version='v4',
        url='https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/5c90dfd2-34c22ccb.th',
        size_mb=2400.0,
        md5='placeholder',
        description='Demucs Hybrid Transformer (6-stem)',
        dependencies=['torch', 'torchaudio', 'demucs']
    ),
    'vits-base': ModelInfo(
        name='vits-base',
        version='v1',
        url='https://huggingface.co/models/vits/base',  # Placeholder
        size_mb=500.0,
        md5='placeholder',
        description='VITS base model for voice training',
        dependencies=['torch', 'torchaudio']
    ),
    'rvc-base': ModelInfo(
        name='rvc-base',
        version='v2',
        url='https://huggingface.co/models/rvc/base',  # Placeholder
        size_mb=200.0,
        md5='placeholder',
        description='RVC v2 base model for voice conversion',
        dependencies=['torch', 'torchaudio', 'fairseq']
    ),
    'mosnet': ModelInfo(
        name='mosnet',
        version='v1',
        url='https://github.com/models/mosnet',  # Placeholder
        size_mb=50.0,
        md5='placeholder',
        description='MOSNet for quality prediction',
        dependencies=['torch']
    ),
    'whisper-base': ModelInfo(
        name='whisper-base',
        version='v3',
        url='https://openaipublic.azureedge.net/main/whisper/models/ed3a0b6b1c0edf879ad9b11b1af5a0e6ab5db9205f891f668f8b0e6c6326e34e.pt',
        size_mb=139.0,
        md5='placeholder',
        description='Whisper base model for ASR (~139 MB, fastest)',
        dependencies=['torch', 'openai-whisper']
    ),
    'whisper-small': ModelInfo(
        name='whisper-small',
        version='v3',
        url='https://openaipublic.azureedge.net/main/whisper/models/9ecf779972d90ba49c06d968637d720dd632c55bbf19d441fb42bf17a411e794.pt',
        size_mb=461.0,
        md5='placeholder',
        description='Whisper small model for ASR (~461 MB, good accuracy/speed balance)',
        dependencies=['torch', 'openai-whisper']
    ),
    'whisper-medium': ModelInfo(
        name='whisper-medium',
        version='v3',
        url='https://openaipublic.azureedge.net/main/whisper/models/345ae4da62f9b3d59415adc60127b97c714f32e89e936602e85993674d08dcb1.pt',
        size_mb=1457.0,
        md5='placeholder',
        description='Whisper medium model for ASR (~1.4 GB, high accuracy)',
        dependencies=['torch', 'openai-whisper']
    ),
    'whisper-large-v3': ModelInfo(
        name='whisper-large-v3',
        version='v3',
        url='https://openaipublic.azureedge.net/main/whisper/models/e5b1a55b89c1367dacf97e3e19bfd829a01529dbfdeefa8caeb559b47a7f4e7e.pt',
        size_mb=2884.0,
        md5='placeholder',
        description='Whisper large-v3 model for ASR (~2.9 GB, state-of-the-art accuracy, multilingual)',
        dependencies=['torch', 'openai-whisper']
    ),
    'ecapa-tdnn': ModelInfo(
        name='ecapa-tdnn',
        version='v1',
        url='https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb',
        size_mb=80.0,
        md5='placeholder',
        description='ECAPA-TDNN for speaker verification',
        dependencies=['torch', 'speechbrain']
    ),
}

UNSUPPORTED_PLACEHOLDER_MODELS: Dict[str, str] = {
    'vits-base': 'VITS base model download metadata is still placeholder-backed in this runtime.',
    'rvc-base': 'RVC base model download metadata is still placeholder-backed in this runtime.',
    'mosnet': 'MOSNet download metadata is still placeholder-backed in this runtime.',
}


class ModelManager:
    """Manages ML model lifecycle."""

    def _ensure_supported_model(self, model_id: str) -> None:
        reason = UNSUPPORTED_PLACEHOLDER_MODELS.get(model_id)
        if reason is not None:
            raise RuntimeError(f"{reason} Placeholder model download/load is blocked.")

    def _build_download_headers(self) -> Dict[str, str]:
        return {
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/121.0.0.0 Safari/537.36"
            ),
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://github.com/facebookresearch/demucs",
            "Connection": "keep-alive",
        }

    def _download_url_to_file(
        self,
        url: str,
        model_file: Path,
        temp_file: Path,
        expected_md5: str,
        progress_callback: Optional[Callable[[float, str], None]] = None,
        progress_label: str = "Downloading",
    ) -> None:
        if temp_file.exists():
            temp_file.unlink()

        headers = self._build_download_headers()
        request = urllib.request.Request(url, headers=headers)

        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                total_size_header = response.headers.get("Content-Length")
                total_size = int(total_size_header) if total_size_header else 0

                bytes_read = 0
                with open(temp_file, "wb") as f:
                    while True:
                        chunk = response.read(8192)
                        if not chunk:
                            break
                        f.write(chunk)
                        bytes_read += len(chunk)

                        if progress_callback:
                            progress = (bytes_read / total_size) * 100 if total_size > 0 else 0
                            progress_callback(progress, progress_label)
        except urllib.error.HTTPError as e:
            # Some CDNs aggressively block non-browser clients. Retry once with a slightly
            # different header set when we see a 403.
            if e.code == 403:
                retry_headers = {**headers, "User-Agent": "curl/8.0"}
                retry_request = urllib.request.Request(url, headers=retry_headers)
                with urllib.request.urlopen(retry_request, timeout=60) as response:
                    total_size_header = response.headers.get("Content-Length")
                    total_size = int(total_size_header) if total_size_header else 0

                    bytes_read = 0
                    with open(temp_file, "wb") as f:
                        while True:
                            chunk = response.read(8192)
                            if not chunk:
                                break
                            f.write(chunk)
                            bytes_read += len(chunk)

                            if progress_callback:
                                progress = (bytes_read / total_size) * 100 if total_size > 0 else 0
                                progress_callback(progress, progress_label)
            else:
                raise

        # Verify MD5 (optional). Only verify when a full 32-char hex digest is provided.
        # At this stage the bytes are in temp_file, so compute against temp_file.
        if expected_md5 != 'placeholder' and len(expected_md5) == 32:
            actual_md5 = self._calculate_md5(temp_file)
            if actual_md5 != expected_md5:
                if temp_file.exists():
                    temp_file.unlink()
                raise ValueError(f"MD5 mismatch: expected {expected_md5}, got {actual_md5}")

        temp_file.replace(model_file)

    def __init__(self, cache_dir: Optional[str] = None):
        """
        Initialize model manager.

        Args:
            cache_dir: Directory to cache models (default: ~/.cache/ai-voice/models)
        """
        if cache_dir is None:
            cache_dir = os.path.expanduser('~/.cache/ai-voice/models')

        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)

        self.manifest_path = self.cache_dir / 'manifest.json'
        self.manifest = self._load_manifest()

        logger.info(f"ModelManager initialized with cache: {self.cache_dir}")

    def _load_manifest(self) -> Dict:
        """Load manifest of downloaded models."""
        if self.manifest_path.exists():
            with open(self.manifest_path, 'r') as f:
                return json.load(f)
        return {}

    def _save_manifest(self):
        """Save manifest to disk."""
        with open(self.manifest_path, 'w') as f:
            json.dump(self.manifest, f, indent=2)

    def _calculate_md5(self, file_path: Path) -> str:
        """Calculate MD5 hash of file."""
        hash_md5 = hashlib.md5()
        with open(file_path, "rb") as f:
            for chunk in iter(lambda: f.read(4096), b""):
                hash_md5.update(chunk)
        return hash_md5.hexdigest()

    def is_downloaded(self, model_id: str) -> bool:
        """Check if model is downloaded."""
        return model_id in self.manifest

    def get_model_path(self, model_id: str) -> Optional[Path]:
        """Get path to downloaded model."""
        if not self.is_downloaded(model_id):
            return None
        entry = self.manifest.get(model_id) or {}
        if isinstance(entry, dict):
            if isinstance(entry.get('path'), str) and entry.get('path'):
                return Path(entry['path'])
            paths = entry.get('paths')
            if isinstance(paths, list) and paths:
                first = paths[0]
                if isinstance(first, str) and first:
                    return Path(first)
        return None

    def download_model(
        self,
        model_id: str,
        progress_callback: Optional[Callable[[float, str], None]] = None
    ) -> Path:
        """
        Download model from registry.

        Args:
            model_id: Model identifier from registry
            progress_callback: Optional callback for progress updates

        Returns:
            Path to downloaded model
        """
        if model_id not in MODEL_REGISTRY:
            raise ValueError(f"Unknown model: {model_id}")

        self._ensure_supported_model(model_id)

        model_info = MODEL_REGISTRY[model_id]

        # Check if already downloaded
        if self.is_downloaded(model_id):
            logger.info(f"Model {model_id} already downloaded")
            return self.get_model_path(model_id)

        # Check dependencies
        self._check_dependencies(model_info.dependencies)

        # Download (Demucs fine-tuned is a bag of 4 separate models)
        if model_id == 'demucs-htdemucs_ft':
            logger.info(f"Downloading {model_id} (multi-file)")
            downloaded_paths: List[str] = []
            try:
                for source_name, url in DEMUCS_HTDEMUS_FT_FILES.items():
                    url_path = Path(url)
                    ext = url_path.suffix if url_path.suffix else ".th"
                    model_file = self.cache_dir / f"{model_info.name}-{source_name}-{model_info.version}{ext}"
                    temp_file = model_file.with_suffix(model_file.suffix + ".part")

                    logger.info(f"Downloading {model_id}:{source_name}")
                    logger.info(f"Download URL: {url}")
                    logger.info(f"Download destination: {model_file}")

                    self._download_url_to_file(
                        url=url,
                        model_file=model_file,
                        temp_file=temp_file,
                        expected_md5=model_info.md5,
                        progress_callback=progress_callback,
                        progress_label=f"Downloading {model_info.name}:{source_name}",
                    )
                    downloaded_paths.append(str(model_file))

                self.manifest[model_id] = {
                    'paths': downloaded_paths,
                    'info': asdict(model_info),
                    'downloaded_at': str(time.time())
                }
                self._save_manifest()
                logger.info(f"Model {model_id} downloaded successfully")
                return Path(downloaded_paths[0])
            except Exception as e:
                tb = traceback.format_exc()
                for p in downloaded_paths:
                    try:
                        Path(p).unlink(missing_ok=True)
                    except Exception:
                        pass
                raise RuntimeError(f"Failed to download model {model_id}: {e}\n{tb}")

        url_path = Path(model_info.url)
        ext = url_path.suffix if url_path.suffix else ".pth"
        model_file = self.cache_dir / f"{model_info.name}-{model_info.version}{ext}"
        temp_file = model_file.with_suffix(model_file.suffix + ".part")

        logger.info(f"Downloading {model_id} ({model_info.size_mb:.1f} MB)...")
        logger.info(f"Download URL: {model_info.url}")
        logger.info(f"Download destination: {model_file}")

        try:
            self._download_url_to_file(
                url=model_info.url,
                model_file=model_file,
                temp_file=temp_file,
                expected_md5=model_info.md5,
                progress_callback=progress_callback,
                progress_label=f"Downloading {model_info.name}",
            )

            # Update manifest
            self.manifest[model_id] = {
                'path': str(model_file),
                'info': asdict(model_info),
                'downloaded_at': str(time.time())
            }
            self._save_manifest()

            logger.info(f"Model {model_id} downloaded successfully")
            return model_file

        except Exception as e:
            tb = traceback.format_exc()
            if temp_file.exists():
                temp_file.unlink()
            if model_file.exists():
                model_file.unlink()
            raise RuntimeError(f"Failed to download model {model_id}: {e}\n{tb}")

    def _check_dependencies(self, dependencies: List[str]):
        """Check if dependencies are installed."""
        import importlib

        for dep in dependencies:
            try:
                importlib.import_module(dep)
            except ImportError:
                logger.warning(f"Dependency {dep} not installed")

    def load_model(self, model_id: str, device: str = 'auto') -> torch.nn.Module:
        """
        Load model into memory.

        Args:
            model_id: Model identifier
            device: Device to load model on ('auto', 'cuda', 'cpu')

        Returns:
            Loaded PyTorch model
        """
        self._ensure_supported_model(model_id)

        if not self.is_downloaded(model_id):
            logger.info(f"Model {model_id} not found, downloading...")
            self.download_model(model_id)

        model_path = self.get_model_path(model_id)

        if torch is None:
            raise RuntimeError("PyTorch is not installed. Install with: pip install torch")

        # Detect device
        if device == 'auto':
            device = 'cuda' if torch.cuda.is_available() else 'cpu'

        logger.info(f"Loading {model_id} on {device}...")

        try:
            # Load based on model type
            if 'demucs' in model_id:
                return self._load_demucs(model_path, device)
            elif 'vits' in model_id:
                return self._load_vits(model_path, device)
            elif 'rvc' in model_id:
                return self._load_rvc(model_path, device)
            elif 'mosnet' in model_id:
                return self._load_mosnet(model_path, device)
            elif 'whisper' in model_id:
                # Strip registry prefix to get the raw Whisper model name (e.g. 'large-v3')
                whisper_name = model_id.removeprefix('whisper-') if model_id.startswith('whisper-') else model_id
                return self._load_whisper(model_path, device, model_name=whisper_name)
            elif 'ecapa' in model_id:
                return self._load_ecapa(model_path, device)
            else:
                # Generic PyTorch model
                model = torch.load(model_path, map_location=device)
                model.eval()
                return model

        except Exception as e:
            raise RuntimeError(f"Failed to load model {model_id}: {e}")

    def _load_demucs(self, model_path: Path, device: str):
        """Load Demucs model."""
        try:
            from demucs.pretrained import get_model
            model = get_model(model_path.stem)
            model.to(device)
            model.eval()
            return model
        except ImportError:
            logger.error("Demucs not installed: pip install demucs")
            raise

    def _load_vits(self, model_path: Path, device: str):
        """Load VITS model."""
        # Placeholder - will implement with actual VITS
        model = torch.load(model_path, map_location=device)
        model.eval()
        return model

    def _load_rvc(self, model_path: Path, device: str):
        """Load RVC model."""
        # Placeholder - will implement with actual RVC
        model = torch.load(model_path, map_location=device)
        model.eval()
        return model

    def _load_mosnet(self, model_path: Path, device: str):
        """Load MOSNet model."""
        # Placeholder
        model = torch.load(model_path, map_location=device)
        model.eval()
        return model

    def _load_whisper(self, model_path: Path, device: str, model_name: Optional[str] = None):
        """Load Whisper model.

        Resolves the Whisper model name from (in priority order):
        1. ``model_name`` argument supplied by the caller
        2. ``WHISPER_MODEL`` environment variable
        3. The stem of the cached ``model_path`` (e.g. ``whisper-large-v3-v3``)
        4. Fallback: ``"base"`` for lightweight deployments

        Args:
            model_path: Path to the cached model file (used as a hint).
            device: PyTorch device string ('cpu', 'cuda', 'mps', …).
            model_name: Optional explicit Whisper model name to load.
        """
        try:
            import whisper as openai_whisper
        except ImportError:
            logger.error("Whisper not installed: pip install openai-whisper")
            raise

        # Resolve model name
        resolved: str
        if model_name:
            resolved = model_name
        elif os.environ.get("WHISPER_MODEL"):
            resolved = os.environ["WHISPER_MODEL"]
        else:
            # Derive from path stem: e.g. 'whisper-large-v3-v3' -> 'large-v3'
            stem = model_path.stem  # e.g. 'whisper-large-v3-v3'
            # Strip leading 'whisper-' prefix and trailing version suffix '-v\d+'
            import re
            stem = re.sub(r'^whisper-', '', stem)
            stem = re.sub(r'-v\d+$', '', stem)
            resolved = stem if stem else "base"

        logger.info(f"Loading Whisper model '{resolved}' on {device} from {model_path}")
        model = openai_whisper.load_model(resolved, device=device, download_root=str(model_path.parent))
        return model

    def _load_ecapa(self, model_path: Path, device: str):
        """Load ECAPA-TDNN model."""
        try:
            from speechbrain.pretrained import EncoderClassifier
            model = EncoderClassifier.from_hparams(
                source="speechbrain/spkrec-ecapa-voxceleb",
                savedir=str(model_path.parent)
            )
            return model
        except ImportError:
            logger.error("SpeechBrain not installed: pip install speechbrain")
            raise

    def list_models(self) -> List[str]:
        """List all available models."""
        return list(MODEL_REGISTRY.keys())

    def list_downloaded(self) -> List[str]:
        """List downloaded models."""
        return list(self.manifest.keys())

    def delete_model(self, model_id: str):
        """Delete downloaded model."""
        if not self.is_downloaded(model_id):
            logger.warning(f"Model {model_id} not downloaded")
            return

        entry = self.manifest.get(model_id) or {}
        if isinstance(entry, dict) and isinstance(entry.get('paths'), list):
            for p in entry.get('paths'):
                if isinstance(p, str) and p:
                    model_path = Path(p)
                    if model_path.exists():
                        model_path.unlink()
        else:
            model_path = Path(entry.get('path')) if isinstance(entry, dict) and entry.get('path') else None
            if model_path and model_path.exists():
                model_path.unlink()

        del self.manifest[model_id]
        self._save_manifest()

        logger.info(f"Deleted model {model_id}")

    def get_cache_size(self) -> float:
        """Get total cache size in MB."""
        total = 0
        for file in self.cache_dir.glob('**/*'):
            if file.is_file():
                total += file.stat().st_size
        return total / (1024 * 1024)

    def clear_cache(self):
        """Clear all cached models."""
        import shutil
        shutil.rmtree(self.cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.manifest = {}
        self._save_manifest()
        logger.info("Cache cleared")


# Singleton instance
_model_manager: Optional[ModelManager] = None


def get_model_manager(cache_dir: Optional[str] = None) -> ModelManager:
    """Get singleton model manager instance."""
    global _model_manager
    if _model_manager is None:
        _model_manager = ModelManager(cache_dir)
    return _model_manager


if __name__ == "__main__":
    # Example usage
    manager = get_model_manager()

    print("Available models:")
    for model_id in manager.list_models():
        info = MODEL_REGISTRY[model_id]
        print(f"  {model_id}: {info.description} ({info.size_mb:.1f} MB)")

    print("\nDownloaded models:")
    for model_id in manager.list_downloaded():
        print(f"  {model_id}")

    print(f"\nCache size: {manager.get_cache_size():.1f} MB")

    # Download a model
    # manager.download_model('demucs-htdemucs')

    # Load a model
    # model = manager.load_model('demucs-htdemucs', device='auto')

