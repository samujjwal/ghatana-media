"""
Voice Conversion Pipeline - Production-grade voice conversion.

Handles:
1. Pitch extraction and manipulation
2. Timing alignment (DTW)
3. Prosody transfer
4. Quality enhancement

@doc.type module
@doc.purpose Voice conversion engine
@doc.layer ai-voice
"""

import numpy as np
from pathlib import Path
from typing import Dict, Optional, Callable, Tuple
from dataclasses import dataclass, asdict
import logging
import time

try:
    import torch
    TORCH_AVAILABLE = True
except ImportError:
    TORCH_AVAILABLE = False
    logger = logging.getLogger(__name__)
    logger.warning("torch not available, voice conversion runtime is unavailable")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class ConversionDependencyError(RuntimeError):
    """Raised when voice conversion runtime dependencies are unavailable."""


@dataclass
class ConversionConfig:
    """Configuration for voice conversion."""
    source_audio: str
    target_voice: str
    output_path: str
    pitch_shift: float = 0.0  # Semitones
    formant_shift: float = 1.0  # Multiplier
    preserve_timing: bool = True
    enhance_quality: bool = True
    target_sample_rate: int = 22050


@dataclass
class ConversionProgress:
    """Real-time conversion progress."""
    progress: float  # 0-100
    stage: str
    message: str
    time_elapsed: float
    time_remaining: float


@dataclass
class ConversionResult:
    """Result of voice conversion."""
    success: bool
    output_path: str
    duration: float
    rtf: float  # Real-time factor
    quality_score: float
    error: Optional[str] = None


class PitchExtractor:
    """Extract and manipulate pitch information."""

    def __init__(self, sample_rate: int = 22050):
        self.sample_rate = sample_rate

    def extract_f0(self, audio: np.ndarray, method: str = 'crepe') -> np.ndarray:
        """
        Extract F0 (pitch) contour.

        Args:
            audio: Audio signal
            method: 'crepe', 'pyin', or 'harvest'

        Returns:
            F0 contour in Hz
        """
        try:
            if method == 'crepe':
                return self._extract_crepe(audio)
            elif method == 'pyin':
                return self._extract_pyin(audio)
            else:
                return self._extract_harvest(audio)
        except Exception as e:
            logger.warning(f"F0 extraction failed: {e}, using fallback")
            return self._extract_fallback(audio)

    def _extract_crepe(self, audio: np.ndarray) -> np.ndarray:
        """Extract F0 using CREPE (most accurate)."""
        try:
            import crepe

            # CREPE expects 16kHz
            if self.sample_rate != 16000:
                import librosa
                audio_16k = librosa.resample(audio, orig_sr=self.sample_rate, target_sr=16000)
            else:
                audio_16k = audio

            time, frequency, confidence, activation = crepe.predict(
                audio_16k,
                sr=16000,
                viterbi=True
            )

            return frequency
        except ImportError:
            logger.warning("CREPE not available, falling back")
            return self._extract_fallback(audio)

    def _extract_pyin(self, audio: np.ndarray) -> np.ndarray:
        """Extract F0 using pYIN (librosa)."""
        try:
            import librosa

            f0 = librosa.pyin(
                audio,
                fmin=librosa.note_to_hz('C2'),
                fmax=librosa.note_to_hz('C7'),
                sr=self.sample_rate
            )[0]

            return np.nan_to_num(f0, nan=0.0)
        except ImportError:
            return self._extract_fallback(audio)

    def _extract_harvest(self, audio: np.ndarray) -> np.ndarray:
        """Extract F0 using HARVEST (PyWorld)."""
        try:
            import pyworld as pw

            audio_double = audio.astype(np.float64)
            f0, _ = pw.harvest(audio_double, self.sample_rate)

            return f0
        except ImportError:
            return self._extract_fallback(audio)

    def _extract_fallback(self, audio: np.ndarray) -> np.ndarray:
        """Fallback F0 extraction (simple autocorrelation)."""
        # Very simple pitch tracking
        frame_length = int(0.05 * self.sample_rate)  # 50ms frames
        hop_length = int(0.01 * self.sample_rate)    # 10ms hop

        num_frames = (len(audio) - frame_length) // hop_length
        f0 = np.zeros(num_frames)

        for i in range(num_frames):
            frame = audio[i * hop_length : i * hop_length + frame_length]
            # Autocorrelation
            corr = np.correlate(frame, frame, mode='full')
            corr = corr[len(corr)//2:]

            # Find first peak
            peaks = np.where((corr[1:-1] > corr[:-2]) & (corr[1:-1] > corr[2:]))[0] + 1
            if len(peaks) > 0:
                period = peaks[0]
                f0[i] = self.sample_rate / period if period > 0 else 0

        return f0

    def shift_pitch(self, f0: np.ndarray, semitones: float) -> np.ndarray:
        """
        Shift pitch by semitones.

        Args:
            f0: Original F0 contour
            semitones: Shift in semitones

        Returns:
            Shifted F0 contour
        """
        ratio = 2 ** (semitones / 12)
        return f0 * ratio


class TimingAligner:
    """Align timing between source and target using DTW."""

    def align(self, source_features: np.ndarray,
             target_features: np.ndarray) -> np.ndarray:
        """
        Align source to target using Dynamic Time Warping.

        Args:
            source_features: Source audio features
            target_features: Target audio features

        Returns:
            Alignment path (indices)
        """
        try:
            from dtaidistance import dtw

            # Compute DTW distance and path
            distance, paths = dtw.warping_paths(source_features, target_features)
            best_path = dtw.best_path(paths)

            return np.array(best_path)
        except ImportError:
            logger.warning("DTW library not available, using linear alignment")
            return self._linear_alignment(len(source_features), len(target_features))

    def _linear_alignment(self, source_len: int, target_len: int) -> np.ndarray:
        """Fallback linear alignment."""
        source_indices = np.linspace(0, source_len - 1, target_len, dtype=int)
        target_indices = np.arange(target_len)
        return np.column_stack([source_indices, target_indices])


class QualityEnhancer:
    """Enhance converted audio quality."""

    def __init__(self):
        pass

    def enhance(self, audio: np.ndarray, sample_rate: int) -> np.ndarray:
        """
        Apply quality enhancements.

        Steps:
        1. Noise gate
        2. EQ normalization
        3. Compression
        4. De-essing
        """
        audio = self._noise_gate(audio)
        audio = self._normalize(audio)
        audio = self._compress(audio)
        audio = self._deess(audio, sample_rate)

        return audio

    def _noise_gate(self, audio: np.ndarray, threshold: float = 0.01) -> np.ndarray:
        """Apply noise gate."""
        mask = np.abs(audio) > threshold
        return audio * mask

    def _normalize(self, audio: np.ndarray, target_level: float = 0.9) -> np.ndarray:
        """Normalize audio level."""
        peak = np.max(np.abs(audio))
        if peak > 0:
            return audio * (target_level / peak)
        return audio

    def _compress(self, audio: np.ndarray, threshold: float = 0.5,
                  ratio: float = 4.0) -> np.ndarray:
        """Apply compression."""
        compressed = audio.copy()
        above_threshold = np.abs(compressed) > threshold

        excess = np.abs(compressed[above_threshold]) - threshold
        compressed[above_threshold] = (
            np.sign(compressed[above_threshold]) *
            (threshold + excess / ratio)
        )

        return compressed

    def _deess(self, audio: np.ndarray, sample_rate: int) -> np.ndarray:
        """Remove sibilance (de-essing)."""
        try:
            from scipy import signal

            # High-pass filter for sibilance (6-10 kHz)
            sos = signal.butter(4, 6000, 'hp', fs=sample_rate, output='sos')
            sibilance = signal.sosfilt(sos, audio)

            # Reduce sibilance
            sibilance_reduced = sibilance * 0.5

            # Subtract reduced sibilance
            return audio - (sibilance - sibilance_reduced)
        except ImportError:
            return audio


class VoiceConverter:
    """Main voice conversion engine."""

    def __init__(self, config: ConversionConfig):
        self.config = config
        self.pitch_extractor = PitchExtractor(config.target_sample_rate)
        self.timing_aligner = TimingAligner()
        self.quality_enhancer = QualityEnhancer()

    def convert(self, progress_callback: Optional[Callable] = None) -> ConversionResult:
        """
        Perform voice conversion.

        Args:
            progress_callback: Optional callback for progress updates

        Returns:
            ConversionResult
        """
        start_time = time.time()

        try:
            # Load audio
            if progress_callback:
                progress_callback(ConversionProgress(
                    progress=10,
                    stage='loading',
                    message='Loading audio...',
                    time_elapsed=0,
                    time_remaining=0
                ))

            source_audio, sr = self._load_audio(self.config.source_audio)

            # Extract pitch
            if progress_callback:
                progress_callback(ConversionProgress(
                    progress=30,
                    stage='pitch_extraction',
                    message='Extracting pitch...',
                    time_elapsed=time.time() - start_time,
                    time_remaining=0
                ))

            source_f0 = self.pitch_extractor.extract_f0(source_audio)

            # Shift pitch if needed
            if self.config.pitch_shift != 0:
                source_f0 = self.pitch_extractor.shift_pitch(
                    source_f0,
                    self.config.pitch_shift
                )

            # Convert with model
            if progress_callback:
                progress_callback(ConversionProgress(
                    progress=60,
                    stage='converting',
                    message='Converting voice...',
                    time_elapsed=time.time() - start_time,
                    time_remaining=0
                ))

            converted_audio = self._apply_voice_model(source_audio, source_f0)

            # Enhance quality
            if self.config.enhance_quality:
                if progress_callback:
                    progress_callback(ConversionProgress(
                        progress=80,
                        stage='enhancing',
                        message='Enhancing quality...',
                        time_elapsed=time.time() - start_time,
                        time_remaining=0
                    ))

                converted_audio = self.quality_enhancer.enhance(converted_audio, sr)

            # Save result
            if progress_callback:
                progress_callback(ConversionProgress(
                    progress=90,
                    stage='saving',
                    message='Saving output...',
                    time_elapsed=time.time() - start_time,
                    time_remaining=0
                ))

            self._save_audio(converted_audio, self.config.output_path, sr)

            # Calculate metrics
            duration = len(converted_audio) / sr
            elapsed = time.time() - start_time
            rtf = elapsed / duration

            if progress_callback:
                progress_callback(ConversionProgress(
                    progress=100,
                    stage='complete',
                    message='Conversion complete!',
                    time_elapsed=elapsed,
                    time_remaining=0
                ))

            return ConversionResult(
                success=True,
                output_path=self.config.output_path,
                duration=duration,
                rtf=rtf,
                quality_score=self._calculate_quality_score(converted_audio, sr),
                error=None
            )

        except Exception as e:
            logger.error(f"Conversion failed: {e}", exc_info=True)
            return ConversionResult(
                success=False,
                output_path='',
                duration=0,
                rtf=0,
                quality_score=0,
                error=str(e)
            )

    def _load_audio(self, path: str) -> Tuple[np.ndarray, int]:
        """Load audio file."""
        try:
            import librosa
            audio, sr = librosa.load(path, sr=self.config.target_sample_rate)
            return audio, sr
        except ImportError as exc:
            raise ConversionDependencyError(
                "Voice conversion requires the Python dependency 'librosa' to load source audio."
            ) from exc

    def _apply_voice_model(self, audio: np.ndarray, f0: np.ndarray) -> np.ndarray:
        """
        Apply voice conversion model.
        """
        raise ConversionDependencyError(
            "Voice conversion model inference is not available in this runtime yet. "
            "Placeholder conversion output is blocked."
        )

    def _save_audio(self, audio: np.ndarray, path: str, sample_rate: int):
        """Save audio file."""
        try:
            import soundfile as sf
            sf.write(path, audio, sample_rate)
        except ImportError as exc:
            raise ConversionDependencyError(
                "Voice conversion requires the Python dependency 'soundfile' to write converted audio."
            ) from exc

    def _calculate_quality_score(self, audio: np.ndarray, sample_rate: int) -> float:
        """Estimate output quality from simple waveform health metrics."""
        if audio.size == 0:
            return 0.0

        rms = float(np.sqrt(np.mean(np.square(audio, dtype=np.float64))))
        peak = float(np.max(np.abs(audio)))
        clipping_ratio = float(np.mean(np.abs(audio) >= 0.999))
        dynamic_range = peak - float(np.min(np.abs(audio)))

        loudness_score = min(1.0, rms / 0.2)
        clipping_penalty = min(1.0, clipping_ratio * 10.0)
        dynamics_score = min(1.0, dynamic_range)

        score = (0.5 * loudness_score) + (0.35 * dynamics_score) + (0.15 * (1.0 - clipping_penalty))
        return float(np.clip(score, 0.0, 1.0))


def convert_voice(config_dict: Dict) -> Dict:
    """
    Main entry point for voice conversion.

    Args:
        config_dict: Configuration dictionary

    Returns:
        Conversion result dictionary
    """
    config = ConversionConfig(**config_dict)
    converter = VoiceConverter(config)
    result = converter.convert()

    return asdict(result)


if __name__ == "__main__":
    import json

    config = {
        'source_audio': 'input.wav',
        'target_voice': 'voice_model',
        'output_path': 'output.wav',
        'pitch_shift': 0.0,
        'preserve_timing': True,
        'enhance_quality': True
    }

    result = convert_voice(config)
    print(json.dumps(result, indent=2))

