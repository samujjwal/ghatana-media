"""
Phrase Detector for AI Voice Production Studio.

This module provides automatic detection of vocal phrases in audio.
"""

import numpy as np
from pathlib import Path
from typing import List, Optional, Callable
from dataclasses import dataclass
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@dataclass
class DetectedPhrase:
    start_time: float
    end_time: float
    pitch_contour: List[float]
    energy: float = 0.0
    label: str = "other"


class PhraseDetector:
    def __init__(self, sample_rate: int = 22050, hop_length: int = 512):
        self.sample_rate = sample_rate
        self.hop_length = hop_length
        self.min_phrase_duration = 0.3
        self.min_silence_duration = 0.15
        self.energy_threshold_ratio = 0.5

    def load_audio(self, path: str) -> np.ndarray:
        try:
            import librosa
            audio, _ = librosa.load(path, sr=self.sample_rate, mono=True)
            return audio
        except ImportError:
            import wave
            with wave.open(path, 'rb') as wf:
                audio = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16)
                return audio.astype(np.float32) / 32768.0

    def compute_energy(self, audio: np.ndarray) -> np.ndarray:
        try:
            import librosa
            rms = librosa.feature.rms(y=audio, frame_length=2048, hop_length=self.hop_length)[0]
            return rms
        except ImportError:
            frame_length = 2048
            frames = len(audio) // self.hop_length
            rms = np.zeros(frames)
            for i in range(frames):
                start = i * self.hop_length
                end = min(start + frame_length, len(audio))
                rms[i] = np.sqrt(np.mean(audio[start:end] ** 2))
            return rms

    def extract_pitch(self, audio: np.ndarray, start_sample: int, end_sample: int) -> List[float]:
        segment = audio[start_sample:end_sample]
        
        try:
            import librosa
            f0, _, _ = librosa.pyin(
                segment, fmin=librosa.note_to_hz('C2'),
                fmax=librosa.note_to_hz('C7'),
                sr=self.sample_rate, hop_length=self.hop_length
            )
            f0 = np.nan_to_num(f0)
            return f0[:50].tolist()
        except ImportError:
            return [200.0] * min(50, len(segment) // self.hop_length)

    def detect_phrases(self, audio_path: str) -> List[DetectedPhrase]:
        logger.info(f"Detecting phrases in {audio_path}")
        
        audio = self.load_audio(audio_path)
        energy = self.compute_energy(audio)
        
        try:
            import librosa
            times = librosa.times_like(energy, sr=self.sample_rate, hop_length=self.hop_length)
        except ImportError:
            times = np.arange(len(energy)) * self.hop_length / self.sample_rate

        threshold = np.mean(energy) * self.energy_threshold_ratio
        is_voice = energy > threshold

        phrases = []
        in_phrase = False
        start_time = 0.0
        start_idx = 0

        for i, (t, v) in enumerate(zip(times, is_voice)):
            if v and not in_phrase:
                start_time = t
                start_idx = i
                in_phrase = True
            elif not v and in_phrase:
                duration = t - start_time
                if duration >= self.min_phrase_duration:
                    start_sample = int(start_time * self.sample_rate)
                    end_sample = int(t * self.sample_rate)
                    pitch_contour = self.extract_pitch(audio, start_sample, end_sample)
                    avg_energy = float(np.mean(energy[start_idx:i]))
                    
                    phrases.append(DetectedPhrase(
                        start_time=start_time,
                        end_time=t,
                        pitch_contour=pitch_contour,
                        energy=avg_energy
                    ))
                in_phrase = False

        if in_phrase:
            duration = times[-1] - start_time
            if duration >= self.min_phrase_duration:
                start_sample = int(start_time * self.sample_rate)
                end_sample = len(audio)
                pitch_contour = self.extract_pitch(audio, start_sample, end_sample)
                
                phrases.append(DetectedPhrase(
                    start_time=start_time,
                    end_time=times[-1],
                    pitch_contour=pitch_contour,
                    energy=float(np.mean(energy[start_idx:]))
                ))

        phrases = self._label_phrases(phrases)
        
        logger.info(f"Detected {len(phrases)} phrases")
        return phrases

    def _label_phrases(self, phrases: List[DetectedPhrase]) -> List[DetectedPhrase]:
        if not phrases:
            return phrases

        energies = [p.energy for p in phrases]
        avg_energy = np.mean(energies)
        
        for i, phrase in enumerate(phrases):
            duration = phrase.end_time - phrase.start_time
            
            if i == 0 and phrase.start_time < 5.0:
                phrase.label = "intro"
            elif i == len(phrases) - 1:
                phrase.label = "outro"
            elif phrase.energy > avg_energy * 1.2:
                phrase.label = "chorus"
            elif duration > 4.0:
                phrase.label = "verse"
            else:
                phrase.label = "other"
        
        return phrases


def detect_phrases(audio_path: str, sample_rate: int = 22050) -> List[dict]:
    detector = PhraseDetector(sample_rate=sample_rate)
    phrases = detector.detect_phrases(audio_path)
    
    return [
        {
            'start_time': p.start_time,
            'end_time': p.end_time,
            'pitch_contour': p.pitch_contour,
            'energy': p.energy,
            'label': p.label
        }
        for p in phrases
    ]


if __name__ == "__main__":
    import sys
    import json
    
    if len(sys.argv) < 2:
        print("Usage: python phrase_detector.py <audio_file>")
        sys.exit(1)
    
    phrases = detect_phrases(sys.argv[1])
    print(f"\nDetected {len(phrases)} phrases:")
    for i, p in enumerate(phrases):
        print(f"  {i+1}. [{p['label']}] {p['start_time']:.2f}s - {p['end_time']:.2f}s")
