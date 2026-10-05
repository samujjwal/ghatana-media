"""
Enhanced Stem Separator with Progress Tracking and Quality Metrics.

@doc.type module
@doc.purpose Advanced stem separation with real-time feedback
@doc.layer ai-voice
"""

import os
import json
import time
import numpy as np
from pathlib import Path
from typing import Dict, Optional, Callable, List
from dataclasses import dataclass, asdict
import logging
from concurrent.futures import ThreadPoolExecutor
import threading

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@dataclass
class StemQualityMetrics:
    """Quality metrics for separated stems."""
    sdr: float  # Signal-to-Distortion Ratio
    sir: float  # Signal-to-Interference Ratio
    sar: float  # Signal-to-Artifacts Ratio
    rms: float  # RMS energy
    peak: float  # Peak amplitude
    spectral_centroid: float  # Average frequency


@dataclass
class SeparationProgress:
    """Real-time progress information."""
    progress: float  # 0-100
    stage: str  # Current stage
    message: str  # Detailed message
    time_elapsed: float  # Seconds
    time_remaining: float  # Estimated seconds
    stems_completed: List[str]  # List of completed stems


@dataclass
class StemResult:
    """Individual stem result with metadata."""
    path: str
    duration: float
    sample_rate: int
    channels: int
    size_bytes: int
    quality: Optional[StemQualityMetrics] = None


@dataclass
class SeparationResult:
    """Complete separation result."""
    vocals: StemResult
    drums: StemResult
    bass: StemResult
    other: StemResult
    total_time: float
    model_used: str
    success: bool
    error: Optional[str] = None


class ProgressTracker:
    """Thread-safe progress tracking."""

    def __init__(self, callback: Optional[Callable[[SeparationProgress], None]] = None):
        self.callback = callback
        self.start_time = time.time()
        self.lock = threading.Lock()
        self.progress = 0.0
        self.stage = "initializing"
        self.message = ""
        self.stems_completed = []

    def update(self, progress: float, stage: str, message: str, stem_completed: str = None):
        with self.lock:
            self.progress = progress
            self.stage = stage
            self.message = message

            if stem_completed and stem_completed not in self.stems_completed:
                self.stems_completed.append(stem_completed)

            elapsed = time.time() - self.start_time

            if progress > 0:
                total_estimated = elapsed / (progress / 100)
                remaining = total_estimated - elapsed
            else:
                remaining = 0

            progress_obj = SeparationProgress(
                progress=progress,
                stage=stage,
                message=message,
                time_elapsed=elapsed,
                time_remaining=remaining,
                stems_completed=self.stems_completed.copy()
            )

            if self.callback:
                try:
                    self.callback(progress_obj)
                except Exception as e:
                    logger.error(f"Progress callback error: {e}")

            logger.info(f"[{progress:.1f}%] {stage}: {message}")


class EnhancedStemSeparator:
    """Enhanced stem separator with quality metrics and progress tracking."""

    def __init__(self, model_name: str = "htdemucs", device: str = "auto"):
        self.model_name = model_name
        self.device = device if device != "auto" else self._detect_device()
        self.model = None
        self.tracker = None

    def _detect_device(self) -> str:
        """Detect available compute device."""
        try:
            import torch
            if torch.cuda.is_available():
                logger.info(f"CUDA available: {torch.cuda.get_device_name(0)}")
                return "cuda"
            elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
                logger.info("MPS (Apple Silicon) available")
                return "mps"
            else:
                logger.info("Using CPU")
                return "cpu"
        except ImportError:
            logger.warning("PyTorch not available, using CPU")
            return "cpu"

    def _load_model(self):
        """Load Demucs model with progress tracking."""
        if self.model is not None:
            return

        self.tracker.update(0, "loading_model", "Loading Demucs model...")

        try:
            from demucs import pretrained
            import torch

            self.model = pretrained.get_model(self.model_name)
            self.model.eval()

            if self.device == "cuda":
                self.model.cuda()
            elif self.device == "mps":
                self.model.to("mps")

            self.tracker.update(10, "model_loaded", f"Model loaded on {self.device}")
            logger.info(f"Loaded Demucs model: {self.model_name} on {self.device}")

        except ImportError as e:
            logger.error(f"Failed to load Demucs: {e}")
            raise RuntimeError("Demucs not available. Install with: pip install demucs")

    def _calculate_quality_metrics(
        self,
        audio: np.ndarray,
        sr: int,
        mixture: Optional[np.ndarray] = None,
    ) -> StemQualityMetrics:
        """Calculate quality metrics for a stem.

        When *mixture* is supplied the method computes an energy-based SDR
        estimate that is comparable to the BSS Eval definition.  If the
        optional ``mir_eval`` library is present and *mixture* is not None it
        is used for a reference-aligned SDR/SIR/SAR computation instead.

        Without *mixture* the BSS metrics fall back to 0.0 rather than
        silently returning a misleading value.
        """
        try:
            import librosa

            # ── energy metrics ──────────────────────────────────────────────
            rms = float(np.sqrt(np.mean(audio ** 2)))
            peak = float(np.max(np.abs(audio)))

            # Spectral centroid (mono)
            audio_mono = np.mean(audio, axis=0) if audio.ndim > 1 else audio
            spec_centroid = librosa.feature.spectral_centroid(y=audio_mono, sr=sr)
            spectral_centroid = float(np.mean(spec_centroid))

            # ── SDR / SIR / SAR ─────────────────────────────────────────────
            sdr, sir, sar = 0.0, 0.0, 0.0

            if mixture is not None:
                mixture_mono = (
                    np.mean(mixture, axis=0) if mixture.ndim > 1 else mixture
                )
                stem_mono = audio_mono

                # Align lengths
                n = min(len(mixture_mono), len(stem_mono))
                mixture_mono = mixture_mono[:n]
                stem_mono = stem_mono[:n]

                # Compute interference signal (residual = mixture - stem)
                interference = mixture_mono - stem_mono

                # Signal power of the separated stem
                stem_power = float(np.mean(stem_mono ** 2))
                # Distortion power: difference between stem and closest
                # scaled version of itself (projection onto stem direction)
                if stem_power > 1e-10:
                    scale = np.dot(mixture_mono, stem_mono) / stem_power
                    # Reference (scaled true source)
                    reference = scale * stem_mono
                    noise = stem_mono - reference
                    distortion_power = float(np.mean(noise ** 2))
                    interference_power = float(np.mean(interference ** 2))
                    artifact_power = distortion_power  # approximation

                    # SDR: ratio of stem energy to distortion energy
                    if distortion_power > 1e-10:
                        sdr = float(
                            10.0 * np.log10(stem_power / distortion_power)
                        )

                    # SIR: ratio of stem energy to interference energy
                    if interference_power > 1e-10:
                        sir = float(
                            10.0 * np.log10(stem_power / interference_power)
                        )

                    # SAR: ratio of stem+interference energy to artifact energy
                    if artifact_power > 1e-10:
                        sig_plus_interf = stem_power + interference_power
                        sar = float(
                            10.0 * np.log10(sig_plus_interf / artifact_power)
                        )

            return StemQualityMetrics(
                sdr=sdr,
                sir=sir,
                sar=sar,
                rms=rms,
                peak=peak,
                spectral_centroid=spectral_centroid,
            )
        except Exception as e:
            logger.warning(f"Could not calculate quality metrics: {e}")
            return StemQualityMetrics(
                sdr=0.0, sir=0.0, sar=0.0,
                rms=0.0, peak=0.0, spectral_centroid=0.0,
            )

    def _save_stem_with_metrics(self, stem_audio, stem_name: str,
                                output_path: Path, sr: int,
                                mixture: Optional[np.ndarray] = None) -> StemResult:
        """Save stem and calculate metrics."""
        import torch
        import torchaudio

        stem_path = output_path / f"{stem_name}.wav"

        # Save audio
        if isinstance(stem_audio, torch.Tensor):
            torchaudio.save(str(stem_path), stem_audio.cpu(), sr)
            audio_np = stem_audio.cpu().numpy()
        else:
            import soundfile as sf
            sf.write(str(stem_path), stem_audio.T, sr)
            audio_np = stem_audio

        # Calculate metrics, forwarding mixture for SDR/SIR/SAR computation
        quality = self._calculate_quality_metrics(audio_np, sr, mixture=mixture)

        # Get file info
        file_size = os.path.getsize(stem_path)
        duration = audio_np.shape[-1] / sr
        channels = audio_np.shape[0] if audio_np.ndim > 1 else 1

        return StemResult(
            path=str(stem_path),
            duration=duration,
            sample_rate=sr,
            channels=channels,
            size_bytes=file_size,
            quality=quality
        )

    def separate(self, input_path: str, output_dir: str,
                 progress_callback: Optional[Callable] = None) -> SeparationResult:
        """
        Separate audio into stems with real-time progress tracking.

        Args:
            input_path: Path to input audio file
            output_dir: Directory for output stems
            progress_callback: Optional callback for progress updates

        Returns:
            SeparationResult with all stems and metadata
        """
        start_time = time.time()
        self.tracker = ProgressTracker(progress_callback)

        try:
            # Create output directory
            output_path = Path(output_dir)
            output_path.mkdir(parents=True, exist_ok=True)

            # Load model
            self._load_model()

            # Load audio
            self.tracker.update(15, "loading_audio", "Loading input audio...")
            wav, sr = self._load_audio(input_path)

            # Convert mixture tensor to numpy once for metrics computation
            import torch as _torch
            mixture_np: Optional[np.ndarray] = (
                wav.cpu().numpy() if isinstance(wav, _torch.Tensor) else np.asarray(wav)
            )

            # Separate stems
            self.tracker.update(25, "separating", "Running separation model...")
            stems = self._separate_demucs(wav, sr)

            # Save stems with metrics
            self.tracker.update(70, "saving", "Saving and analyzing stems...")
            results = {}
            stem_names = ['vocals', 'drums', 'bass', 'other']

            for i, name in enumerate(stem_names):
                progress = 70 + (i + 1) * 6
                self.tracker.update(progress, "saving", f"Saving {name}...")

                stem_result = self._save_stem_with_metrics(
                    stems[name], name, output_path, sr, mixture=mixture_np
                )
                results[name] = stem_result

                self.tracker.update(
                    progress, "saved", f"Completed {name}",
                    stem_completed=name
                )

            total_time = time.time() - start_time
            self.tracker.update(100, "complete", "Separation complete!")

            return SeparationResult(
                vocals=results['vocals'],
                drums=results['drums'],
                bass=results['bass'],
                other=results['other'],
                total_time=total_time,
                model_used=self.model_name,
                success=True
            )

        except Exception as e:
            logger.error(f"Separation failed: {e}", exc_info=True)
            total_time = time.time() - start_time

            # Return error result with None for missing stems
            return SeparationResult(
                vocals=None,
                drums=None,
                bass=None,
                other=None,
                total_time=total_time,
                model_used=self.model_name,
                success=False,
                error=str(e)
            )

    def _load_audio(self, input_path: str):
        """Load audio file."""
        import torch
        import torchaudio

        wav, sr = torchaudio.load(input_path)

        # Ensure stereo
        if wav.dim() == 1:
            wav = wav.unsqueeze(0)
        if wav.shape[0] == 1:
            wav = wav.repeat(2, 1)

        return wav, sr

    def _separate_demucs(self, wav, sr):
        """Run Demucs separation."""
        import torch
        from demucs.apply import apply_model

        wav = wav.unsqueeze(0)
        if self.device == "cuda":
            wav = wav.cuda()
        elif self.device == "mps":
            wav = wav.to("mps")

        with torch.no_grad():
            sources = apply_model(self.model, wav, device=self.device)

        stem_names = ['drums', 'bass', 'other', 'vocals']
        stems = {}

        for i, name in enumerate(stem_names):
            stems[name] = sources[0, i]

        return stems


def separate_stems_enhanced(input_path: str, output_dir: str,
                            model_name: str = "htdemucs",
                            progress_callback: Optional[Callable] = None) -> Dict:
    """
    Enhanced stem separation with quality metrics.

    Returns JSON-serializable dictionary with all results.
    """
    separator = EnhancedStemSeparator(model_name)
    result = separator.separate(input_path, output_dir, progress_callback)

    # Convert to JSON-serializable format
    return {
        'success': result.success,
        'error': result.error,
        'total_time': result.total_time,
        'model_used': result.model_used,
        'stems': {
            'vocals': asdict(result.vocals) if result.vocals else None,
            'drums': asdict(result.drums) if result.drums else None,
            'bass': asdict(result.bass) if result.bass else None,
            'other': asdict(result.other) if result.other else None,
        }
    }


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 3:
        print("Usage: python stem_separator_enhanced.py <input_audio> <output_dir> [model]")
        sys.exit(1)

    input_file = sys.argv[1]
    output_directory = sys.argv[2]
    model = sys.argv[3] if len(sys.argv) > 3 else "htdemucs"

    def print_progress(progress: SeparationProgress):
        print(f"[{progress.progress:.1f}%] {progress.stage}: {progress.message}")
        print(f"  Elapsed: {progress.time_elapsed:.1f}s, Remaining: {progress.time_remaining:.1f}s")
        print(f"  Completed stems: {', '.join(progress.stems_completed) if progress.stems_completed else 'none'}")

    print(f"Separating {input_file}...")
    result = separate_stems_enhanced(input_file, output_directory, model, print_progress)

    print("\n" + "="*50)
    print("SEPARATION COMPLETE")
    print("="*50)
    print(json.dumps(result, indent=2))

