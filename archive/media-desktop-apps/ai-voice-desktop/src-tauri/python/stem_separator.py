"""
Stem Separator for AI Voice Production Studio.

This module provides Demucs-based audio stem separation.
"""

import os
import numpy as np
from pathlib import Path
from typing import Dict, Optional, Callable
from dataclasses import dataclass
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@dataclass
class SeparationResult:
    vocals: str
    drums: str
    bass: str
    other: str
    durations: Dict[str, float]


class StemSeparator:
    def __init__(self, model_name: str = "htdemucs", device: str = "auto"):
        self.model_name = model_name
        self.device = device if device != "auto" else self._detect_device()
        self.model = None
        self._progress_callback = None

    def _detect_device(self) -> str:
        try:
            import torch
            return "cuda" if torch.cuda.is_available() else "cpu"
        except ImportError:
            return "cpu"

    def set_progress_callback(self, callback: Callable[[float, str], None]):
        self._progress_callback = callback

    def _report_progress(self, progress: float, message: str):
        if self._progress_callback:
            self._progress_callback(progress, message)
        logger.info(f"[{progress:.1f}%] {message}")

    def _load_model(self):
        if self.model is not None:
            return

        self._report_progress(0, "Loading Demucs model...")
        
        try:
            from demucs import pretrained
            self.model = pretrained.get_model(self.model_name)
            self.model.eval()
            if self.device == "cuda":
                self.model.cuda()
            logger.info(f"Loaded Demucs model: {self.model_name}")
        except ImportError:
            raise RuntimeError(
                "Demucs is not installed. Install the stem-separation dependencies to produce real stems."
            )

    def separate(self, input_path: str, output_dir: str) -> SeparationResult:
        self._load_model()
        
        output_path = Path(output_dir)
        output_path.mkdir(parents=True, exist_ok=True)

        self._report_progress(10, "Loading audio...")

        # Load audio
        try:
            import torchaudio
            wav, sr = torchaudio.load(input_path)
            if wav.dim() == 1:
                wav = wav.unsqueeze(0)
            if wav.shape[0] == 1:
                wav = wav.repeat(2, 1)
        except ImportError:
            try:
                import librosa
                import torch
                audio, sr = librosa.load(input_path, sr=44100, mono=False)
                if audio.ndim == 1:
                    audio = np.stack([audio, audio])
                wav = torch.tensor(audio)
            except ImportError:
                raise RuntimeError(
                    "Neither torchaudio nor librosa is available. Install audio dependencies to run real stem separation."
                )

        self._report_progress(20, "Separating stems...")

        return self._demucs_separate(wav, sr, output_path)

    def _demucs_separate(self, wav, sr, output_path: Path) -> SeparationResult:
        import torch
        from demucs.apply import apply_model

        wav = wav.unsqueeze(0)
        if self.device == "cuda":
            wav = wav.cuda()

        self._report_progress(30, "Running separation model...")

        with torch.no_grad():
            sources = apply_model(self.model, wav, device=self.device)

        self._report_progress(80, "Saving stems...")

        stem_names = ['drums', 'bass', 'other', 'vocals']
        results = {}
        durations = {}

        try:
            import torchaudio
            save_fn = lambda path, audio, sr: torchaudio.save(path, audio.cpu(), sr)
        except ImportError:
            import soundfile as sf
            save_fn = lambda path, audio, sr: sf.write(path, audio.cpu().numpy().T, sr)

        for i, name in enumerate(stem_names):
            stem_path = output_path / f"{name}.wav"
            stem_audio = sources[0, i]
            save_fn(str(stem_path), stem_audio, sr)
            durations[name] = stem_audio.shape[-1] / sr
            results[name] = str(stem_path)
            self._report_progress(80 + (i + 1) * 5, f"Saved {name}")

        self._report_progress(100, "Separation complete!")

        return SeparationResult(
            vocals=results['vocals'],
            drums=results['drums'],
            bass=results['bass'],
            other=results['other'],
            durations=durations
        )

def separate_stems(input_path: str, output_dir: str, 
                   model_name: str = "htdemucs",
                   progress_callback: Optional[Callable] = None) -> Dict:
    separator = StemSeparator(model_name)
    if progress_callback:
        separator.set_progress_callback(progress_callback)
    
    result = separator.separate(input_path, output_dir)
    
    return {
        'vocals': {'path': result.vocals, 'duration': result.durations.get('vocals', 0)},
        'drums': {'path': result.drums, 'duration': result.durations.get('drums', 0)},
        'bass': {'path': result.bass, 'duration': result.durations.get('bass', 0)},
        'other': {'path': result.other, 'duration': result.durations.get('other', 0)},
    }


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 3:
        print("Usage: python stem_separator.py <input_audio> <output_dir>")
        sys.exit(1)
    
    def print_progress(progress, message):
        print(f"[{progress:.1f}%] {message}")
    
    result = separate_stems(sys.argv[1], sys.argv[2], progress_callback=print_progress)
    print("\nResults:")
    for stem, info in result.items():
        print(f"  {stem}: {info['path']} ({info['duration']:.2f}s)")
