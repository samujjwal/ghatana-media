"""
Quality Metrics System

Provides automated quality assessment:
- MOS (Mean Opinion Score) estimation
- WER (Word Error Rate) calculation
- Speaker similarity measurement

@doc.type module
@doc.purpose Audio quality assessment
@doc.layer ai-voice
"""

import numpy as np
import torch
import librosa
from pathlib import Path
from typing import Dict, Optional, Tuple
from dataclasses import dataclass, asdict
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@dataclass
class QualityMetrics:
    """Complete quality assessment results."""
    mos_score: float          # 1-5 scale
    wer: Optional[float]      # 0-1 (0 = perfect)
    speaker_similarity: Optional[float]  # 0-1 (1 = identical)
    snr: float               # Signal-to-noise ratio (dB)
    pesq: Optional[float]    # Perceptual Evaluation of Speech Quality
    stoi: Optional[float]    # Short-Time Objective Intelligibility


class MOSEstimator:
    """
    MOS (Mean Opinion Score) estimator using MOSNet or similar model.

    Predicts subjective quality score (1-5 scale) from audio.
    """

    def __init__(self, device: str = 'auto'):
        """
        Initialize MOS estimator.

        Args:
            device: Device to run on ('auto', 'cuda', 'cpu')
        """
        if device == 'auto':
            device = 'cuda' if torch.cuda.is_available() else 'cpu'

        self.device = device
        self.model = self._load_model()

        logger.info(f"MOSEstimator initialized on {device}")

    def _load_model(self):
        """Load MOS prediction model."""
        # Placeholder - would load actual MOSNet model
        # For now, use a simple feature-based estimator
        return None

    def estimate(self, audio: np.ndarray, sample_rate: int) -> float:
        """
        Estimate MOS score for audio.

        Args:
            audio: Audio signal
            sample_rate: Sample rate in Hz

        Returns:
            MOS score (1-5)
        """
        if self.model is None:
            # Fallback: Feature-based estimation
            return self._feature_based_mos(audio, sample_rate)

        # Preprocess
        if len(audio.shape) > 1:
            audio = audio.mean(axis=0)  # Mono

        # Extract features for model
        features = self._extract_features(audio, sample_rate)

        # Predict
        with torch.no_grad():
            features_tensor = torch.FloatTensor(features).to(self.device)
            mos = self.model(features_tensor).item()

        return np.clip(mos, 1.0, 5.0)

    def _extract_features(self, audio: np.ndarray, sample_rate: int) -> np.ndarray:
        """Extract features for MOS prediction."""
        # MFCCs
        mfccs = librosa.feature.mfcc(y=audio, sr=sample_rate, n_mfcc=13)
        mfcc_mean = mfccs.mean(axis=1)
        mfcc_std = mfccs.std(axis=1)

        # Spectral features
        spectral_centroid = librosa.feature.spectral_centroid(y=audio, sr=sample_rate).mean()
        spectral_bandwidth = librosa.feature.spectral_bandwidth(y=audio, sr=sample_rate).mean()
        spectral_rolloff = librosa.feature.spectral_rolloff(y=audio, sr=sample_rate).mean()

        # Zero crossing rate
        zcr = librosa.feature.zero_crossing_rate(audio).mean()

        features = np.concatenate([
            mfcc_mean,
            mfcc_std,
            [spectral_centroid, spectral_bandwidth, spectral_rolloff, zcr]
        ])

        return features

    def _feature_based_mos(self, audio: np.ndarray, sample_rate: int) -> float:
        """
        Simple feature-based MOS estimation.

        Based on:
        - SNR (signal-to-noise ratio)
        - Spectral flatness
        - Clipping detection
        - Silence ratio
        """
        # SNR estimation
        signal_power = np.mean(audio ** 2)
        noise_floor = np.percentile(np.abs(audio), 10) ** 2
        snr = 10 * np.log10(signal_power / (noise_floor + 1e-10))
        snr_score = min(snr / 40, 1.0)  # 40dB = perfect

        # Clipping detection
        clipping_ratio = np.mean(np.abs(audio) > 0.95)
        clipping_penalty = clipping_ratio * 2.0

        # Spectral flatness (noisy = high, tonal = low)
        spec = np.abs(librosa.stft(audio))
        spectral_flatness = librosa.feature.spectral_flatness(S=spec).mean()
        flatness_score = 1.0 - spectral_flatness

        # Silence ratio
        silence_threshold = 0.01
        silence_ratio = np.mean(np.abs(audio) < silence_threshold)
        silence_penalty = silence_ratio * 0.5

        # Combine scores
        base_score = 3.0  # Neutral
        mos = base_score + snr_score + flatness_score - clipping_penalty - silence_penalty

        return np.clip(mos, 1.0, 5.0)


class WERCalculator:
    """
    WER (Word Error Rate) calculator.

    Uses ASR (Whisper) to transcribe audio and compare to reference.
    """

    def __init__(self, model_size: str = 'base', device: str = 'auto'):
        """
        Initialize WER calculator.

        Args:
            model_size: Whisper model size ('tiny', 'base', 'small', 'medium', 'large')
            device: Device to run on
        """
        if device == 'auto':
            device = 'cuda' if torch.cuda.is_available() else 'cpu'

        self.device = device
        self.model = self._load_whisper(model_size)

        logger.info(f"WERCalculator initialized with {model_size} on {device}")

    def _load_whisper(self, model_size: str):
        """Load Whisper ASR model."""
        try:
            import whisper
            model = whisper.load_model(model_size, device=self.device)
            return model
        except ImportError:
            logger.warning("Whisper not installed, WER calculation disabled")
            return None

    def calculate(
        self,
        audio_path: str,
        reference_text: str,
        language: str = 'en'
    ) -> Tuple[float, str]:
        """
        Calculate WER for audio against reference text.

        Args:
            audio_path: Path to audio file
            reference_text: Ground truth text
            language: Language code

        Returns:
            (wer, hypothesis_text)
        """
        if self.model is None:
            logger.warning("Whisper model not available")
            return 1.0, ""

        # Transcribe
        result = self.model.transcribe(
            audio_path,
            language=language,
            task='transcribe'
        )
        hypothesis = result['text'].strip()

        # Calculate WER
        wer = self._compute_wer(reference_text, hypothesis)

        return wer, hypothesis

    def _compute_wer(self, reference: str, hypothesis: str) -> float:
        """
        Compute Word Error Rate.

        WER = (S + D + I) / N
        where:
        - S = substitutions
        - D = deletions
        - I = insertions
        - N = words in reference
        """
        ref_words = reference.lower().split()
        hyp_words = hypothesis.lower().split()

        # Dynamic programming for edit distance
        d = np.zeros((len(ref_words) + 1, len(hyp_words) + 1))

        for i in range(len(ref_words) + 1):
            d[i][0] = i
        for j in range(len(hyp_words) + 1):
            d[0][j] = j

        for i in range(1, len(ref_words) + 1):
            for j in range(1, len(hyp_words) + 1):
                if ref_words[i-1] == hyp_words[j-1]:
                    d[i][j] = d[i-1][j-1]
                else:
                    d[i][j] = min(
                        d[i-1][j] + 1,    # deletion
                        d[i][j-1] + 1,    # insertion
                        d[i-1][j-1] + 1   # substitution
                    )

        edit_distance = d[len(ref_words)][len(hyp_words)]
        wer = edit_distance / len(ref_words) if len(ref_words) > 0 else 0.0

        return wer


class SpeakerSimilarity:
    """
    Speaker similarity measurement using speaker embeddings.

    Uses ECAPA-TDNN or similar speaker verification model.
    """

    def __init__(self, device: str = 'auto'):
        """
        Initialize speaker similarity calculator.

        Args:
            device: Device to run on
        """
        if device == 'auto':
            device = 'cuda' if torch.cuda.is_available() else 'cpu'

        self.device = device
        self.model = self._load_model()

        logger.info(f"SpeakerSimilarity initialized on {device}")

    def _load_model(self):
        """Load speaker embedding model."""
        try:
            from speechbrain.pretrained import EncoderClassifier
            model = EncoderClassifier.from_hparams(
                source="speechbrain/spkrec-ecapa-voxceleb",
                run_opts={"device": self.device}
            )
            return model
        except ImportError:
            logger.warning("SpeechBrain not installed, speaker similarity disabled")
            return None

    def calculate(self, audio1: np.ndarray, audio2: np.ndarray, sample_rate: int) -> float:
        """
        Calculate speaker similarity between two audio samples.

        Args:
            audio1: First audio signal
            audio2: Second audio signal
            sample_rate: Sample rate

        Returns:
            Cosine similarity (0-1, 1 = identical speaker)
        """
        if self.model is None:
            logger.warning("Speaker model not available")
            return 0.0

        # Extract embeddings
        emb1 = self._extract_embedding(audio1, sample_rate)
        emb2 = self._extract_embedding(audio2, sample_rate)

        # Cosine similarity
        similarity = np.dot(emb1, emb2) / (np.linalg.norm(emb1) * np.linalg.norm(emb2))

        return float(similarity)

    def _extract_embedding(self, audio: np.ndarray, sample_rate: int) -> np.ndarray:
        """Extract speaker embedding."""
        if self.model is None:
            return np.zeros(192)  # Typical embedding size

        # Convert to tensor
        audio_tensor = torch.FloatTensor(audio).to(self.device)

        # Extract embedding
        with torch.no_grad():
            embedding = self.model.encode_batch(audio_tensor.unsqueeze(0))

        return embedding.cpu().numpy().squeeze()


class QualityAssessment:
    """Complete quality assessment system."""

    def __init__(self, device: str = 'auto'):
        """Initialize all quality metrics."""
        self.mos_estimator = MOSEstimator(device)
        self.wer_calculator = WERCalculator(device=device)
        self.speaker_similarity = SpeakerSimilarity(device)

    def assess(
        self,
        audio_path: str,
        reference_text: Optional[str] = None,
        reference_audio: Optional[np.ndarray] = None,
        sample_rate: int = 22050
    ) -> QualityMetrics:
        """
        Perform complete quality assessment.

        Args:
            audio_path: Path to audio file
            reference_text: Optional reference text for WER
            reference_audio: Optional reference audio for speaker similarity
            sample_rate: Sample rate

        Returns:
            QualityMetrics
        """
        # Load audio
        audio, sr = librosa.load(audio_path, sr=sample_rate)

        # MOS estimation
        mos_score = self.mos_estimator.estimate(audio, sr)

        # WER calculation (if reference text provided)
        wer = None
        if reference_text:
            wer, _ = self.wer_calculator.calculate(audio_path, reference_text)

        # Speaker similarity (if reference audio provided)
        speaker_sim = None
        if reference_audio is not None:
            speaker_sim = self.speaker_similarity.calculate(audio, reference_audio, sr)

        # SNR calculation
        signal_power = np.mean(audio ** 2)
        noise_floor = np.percentile(np.abs(audio), 10) ** 2
        snr = 10 * np.log10(signal_power / (noise_floor + 1e-10))

        return QualityMetrics(
            mos_score=mos_score,
            wer=wer,
            speaker_similarity=speaker_sim,
            snr=snr,
            pesq=None,  # Would need PESQ library
            stoi=None   # Would need pystoi library
        )


def assess_audio_quality(
    audio_path: str,
    reference_text: Optional[str] = None,
    reference_audio_path: Optional[str] = None
) -> Dict:
    """
    Main entry point for quality assessment.

    Args:
        audio_path: Path to audio to assess
        reference_text: Optional reference text for WER
        reference_audio_path: Optional reference audio for speaker similarity

    Returns:
        Dictionary with quality metrics
    """
    assessor = QualityAssessment()

    # Load reference audio if provided
    reference_audio = None
    if reference_audio_path:
        reference_audio, _ = librosa.load(reference_audio_path, sr=22050)

    metrics = assessor.assess(audio_path, reference_text, reference_audio)

    return asdict(metrics)


if __name__ == "__main__":
    # Example usage
    import sys

    if len(sys.argv) < 2:
        print("Usage: python quality_metrics.py <audio_file> [reference_text] [reference_audio]")
        sys.exit(1)

    audio_file = sys.argv[1]
    ref_text = sys.argv[2] if len(sys.argv) > 2 else None
    ref_audio = sys.argv[3] if len(sys.argv) > 3 else None

    print(f"Assessing quality of: {audio_file}")

    metrics = assess_audio_quality(audio_file, ref_text, ref_audio)

    print("\nQuality Metrics:")
    print(f"  MOS Score: {metrics['mos_score']:.2f} / 5.0")
    if metrics['wer'] is not None:
        print(f"  WER: {metrics['wer']:.2%}")
    if metrics['speaker_similarity'] is not None:
        print(f"  Speaker Similarity: {metrics['speaker_similarity']:.2%}")
    print(f"  SNR: {metrics['snr']:.1f} dB")

