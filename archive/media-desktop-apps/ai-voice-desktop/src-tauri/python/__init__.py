"""
AI Voice Production Studio - Python ML Modules

This package provides Python-based ML functionality for:
- Voice model training (RVC)
- Voice conversion
- Stem separation (Demucs)
- Phrase detection
"""

from .voice_trainer import VoiceModelTrainer, TrainingConfig, train_voice_model
from .voice_converter import VoiceConverter, ConversionConfig, convert_voice
from .stem_separator import StemSeparator, separate_stems
from .phrase_detector import PhraseDetector, detect_phrases

__all__ = [
    'VoiceModelTrainer',
    'TrainingConfig', 
    'train_voice_model',
    'VoiceConverter',
    'ConversionConfig',
    'convert_voice',
    'StemSeparator',
    'separate_stems',
    'PhraseDetector',
    'detect_phrases',
]
