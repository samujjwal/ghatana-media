"""
Audio Effects Library

Professional audio effects for real-time processing:
- Reverb (convolution and algorithmic)
- Delay/Echo
- Parametric EQ
- Compressor
- Limiter

@doc.type module
@doc.purpose Audio effects processing
@doc.layer ai-voice
"""

import numpy as np
from scipy import signal
from typing import Optional, Dict
from dataclasses import dataclass
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@dataclass
class EffectParams:
    """Base class for effect parameters."""
    bypass: bool = False
    wet: float = 1.0  # 0-1, mix amount


class Reverb:
    """
    Reverb effect with multiple algorithms.
    """

    def __init__(self, sample_rate: int = 44100):
        """
        Initialize reverb.

        Args:
            sample_rate: Sample rate in Hz
        """
        self.sample_rate = sample_rate
        self.room_size = 0.5      # 0-1
        self.damping = 0.5        # 0-1
        self.wet_level = 0.3      # 0-1
        self.dry_level = 0.7      # 0-1
        self.width = 1.0          # 0-1, stereo width

        # Initialize comb filters and allpass filters
        self._initialize_filters()

    def _initialize_filters(self):
        """Initialize Freeverb-style filters."""
        # Comb filter delays (in samples)
        self.comb_delays = [
            int(0.0297 * self.sample_rate),
            int(0.0371 * self.sample_rate),
            int(0.0411 * self.sample_rate),
            int(0.0437 * self.sample_rate),
        ]

        # Allpass filter delays
        self.allpass_delays = [
            int(0.0051 * self.sample_rate),
            int(0.0067 * self.sample_rate),
        ]

        # Initialize buffers
        self.comb_buffers = [np.zeros(d) for d in self.comb_delays]
        self.allpass_buffers = [np.zeros(d) for d in self.allpass_delays]

        self.comb_indices = [0] * len(self.comb_delays)
        self.allpass_indices = [0] * len(self.allpass_delays)

    def process(self, audio: np.ndarray) -> np.ndarray:
        """
        Apply reverb to audio.

        Args:
            audio: Input audio (mono or stereo)

        Returns:
            Processed audio
        """
        if len(audio.shape) > 1:
            # Stereo
            left = self._process_mono(audio[0])
            right = self._process_mono(audio[1])
            return np.stack([left, right])
        else:
            # Mono
            return self._process_mono(audio)

    def _process_mono(self, audio: np.ndarray) -> np.ndarray:
        """Process mono audio through reverb."""
        output = np.zeros_like(audio)

        # Process through comb filters (parallel)
        comb_sum = np.zeros_like(audio)
        for i in range(len(self.comb_delays)):
            comb_out = self._comb_filter(audio, i)
            comb_sum += comb_out

        comb_sum /= len(self.comb_delays)

        # Process through allpass filters (series)
        allpass_out = comb_sum
        for i in range(len(self.allpass_delays)):
            allpass_out = self._allpass_filter(allpass_out, i)

        # Mix wet and dry
        output = self.dry_level * audio + self.wet_level * allpass_out

        return output

    def _comb_filter(self, audio: np.ndarray, index: int) -> np.ndarray:
        """Apply comb filter."""
        delay = self.comb_delays[index]
        buffer = self.comb_buffers[index]
        buf_idx = self.comb_indices[index]

        output = np.zeros_like(audio)
        feedback = 0.84 * self.room_size
        damp = self.damping

        for i in range(len(audio)):
            delayed = buffer[buf_idx]

            # Damped feedback
            filtered = delayed * (1 - damp) + buffer[(buf_idx - 1) % delay] * damp
            output[i] = delayed
            buffer[buf_idx] = audio[i] + filtered * feedback

            buf_idx = (buf_idx + 1) % delay

        self.comb_indices[index] = buf_idx
        return output

    def _allpass_filter(self, audio: np.ndarray, index: int) -> np.ndarray:
        """Apply allpass filter."""
        delay = self.allpass_delays[index]
        buffer = self.allpass_buffers[index]
        buf_idx = self.allpass_indices[index]

        output = np.zeros_like(audio)
        feedback = 0.5

        for i in range(len(audio)):
            delayed = buffer[buf_idx]
            output[i] = -audio[i] + delayed
            buffer[buf_idx] = audio[i] + delayed * feedback

            buf_idx = (buf_idx + 1) % delay

        self.allpass_indices[index] = buf_idx
        return output


class Delay:
    """
    Delay/Echo effect with feedback.
    """

    def __init__(self, sample_rate: int = 44100):
        """
        Initialize delay.

        Args:
            sample_rate: Sample rate in Hz
        """
        self.sample_rate = sample_rate
        self.delay_time = 0.5     # seconds
        self.feedback = 0.3       # 0-1
        self.mix = 0.5            # 0-1

        # Initialize delay buffer
        max_delay = int(2.0 * sample_rate)  # 2 second max
        self.buffer = np.zeros(max_delay)
        self.write_pos = 0

    def process(self, audio: np.ndarray) -> np.ndarray:
        """Apply delay to audio."""
        delay_samples = int(self.delay_time * self.sample_rate)
        output = np.zeros_like(audio)

        for i in range(len(audio)):
            # Read delayed sample
            read_pos = (self.write_pos - delay_samples) % len(self.buffer)
            delayed = self.buffer[read_pos]

            # Write to buffer with feedback
            self.buffer[self.write_pos] = audio[i] + delayed * self.feedback

            # Mix dry and wet
            output[i] = (1 - self.mix) * audio[i] + self.mix * delayed

            self.write_pos = (self.write_pos + 1) % len(self.buffer)

        return output


class ParametricEQ:
    """
    5-band parametric EQ.
    """

    def __init__(self, sample_rate: int = 44100):
        """
        Initialize EQ.

        Args:
            sample_rate: Sample rate in Hz
        """
        self.sample_rate = sample_rate

        # Band parameters: (frequency, gain_db, Q)
        self.bands = [
            {'freq': 80, 'gain': 0.0, 'q': 1.0},     # Low
            {'freq': 250, 'gain': 0.0, 'q': 1.0},    # Low-mid
            {'freq': 1000, 'gain': 0.0, 'q': 1.0},   # Mid
            {'freq': 4000, 'gain': 0.0, 'q': 1.0},   # High-mid
            {'freq': 12000, 'gain': 0.0, 'q': 1.0},  # High
        ]

    def process(self, audio: np.ndarray) -> np.ndarray:
        """Apply EQ to audio."""
        output = audio.copy()

        for band in self.bands:
            if abs(band['gain']) > 0.1:  # Only process if gain is significant
                output = self._apply_band(output, band)

        return output

    def _apply_band(self, audio: np.ndarray, band: Dict) -> np.ndarray:
        """Apply single EQ band."""
        freq = band['freq']
        gain_db = band['gain']
        q = band['q']

        # Convert gain to linear
        A = 10 ** (gain_db / 40)

        # Calculate filter coefficients (peaking filter)
        w0 = 2 * np.pi * freq / self.sample_rate
        alpha = np.sin(w0) / (2 * q)

        b0 = 1 + alpha * A
        b1 = -2 * np.cos(w0)
        b2 = 1 - alpha * A
        a0 = 1 + alpha / A
        a1 = -2 * np.cos(w0)
        a2 = 1 - alpha / A

        # Apply filter
        b = np.array([b0, b1, b2]) / a0
        a = np.array([1, a1 / a0, a2 / a0])

        return signal.lfilter(b, a, audio)


class Compressor:
    """
    Dynamic range compressor.
    """

    def __init__(self, sample_rate: int = 44100):
        """
        Initialize compressor.

        Args:
            sample_rate: Sample rate in Hz
        """
        self.sample_rate = sample_rate
        self.threshold = -20.0    # dB
        self.ratio = 4.0          # ratio (e.g., 4:1)
        self.attack = 0.005       # seconds
        self.release = 0.1        # seconds
        self.knee = 6.0           # dB (soft knee)
        self.makeup_gain = 0.0    # dB

        self.envelope = 0.0

    def process(self, audio: np.ndarray) -> np.ndarray:
        """Apply compression to audio."""
        output = np.zeros_like(audio)

        # Convert parameters to samples
        attack_coeff = np.exp(-1.0 / (self.attack * self.sample_rate))
        release_coeff = np.exp(-1.0 / (self.release * self.sample_rate))

        for i in range(len(audio)):
            # Convert to dB
            input_level = max(abs(audio[i]), 1e-10)
            input_db = 20 * np.log10(input_level)

            # Calculate gain reduction
            gain_reduction = self._calculate_gain_reduction(input_db)

            # Smooth with attack/release
            target_envelope = 10 ** (gain_reduction / 20)
            if target_envelope < self.envelope:
                # Attack
                self.envelope = attack_coeff * self.envelope + (1 - attack_coeff) * target_envelope
            else:
                # Release
                self.envelope = release_coeff * self.envelope + (1 - release_coeff) * target_envelope

            # Apply gain reduction and makeup gain
            makeup_linear = 10 ** (self.makeup_gain / 20)
            output[i] = audio[i] * self.envelope * makeup_linear

        return output

    def _calculate_gain_reduction(self, input_db: float) -> float:
        """Calculate gain reduction in dB."""
        if input_db < (self.threshold - self.knee / 2):
            # Below threshold
            return 0.0
        elif input_db > (self.threshold + self.knee / 2):
            # Above threshold
            excess = input_db - self.threshold
            return -(excess * (self.ratio - 1) / self.ratio)
        else:
            # In knee
            excess = input_db - self.threshold + self.knee / 2
            return -(excess ** 2 * (self.ratio - 1)) / (2 * self.knee * self.ratio)


class Limiter:
    """
    Peak limiter (hard/soft).
    """

    def __init__(self, sample_rate: int = 44100):
        """
        Initialize limiter.

        Args:
            sample_rate: Sample rate in Hz
        """
        self.sample_rate = sample_rate
        self.threshold = -0.1     # dB
        self.ceiling = 0.0        # dB (output ceiling)
        self.release = 0.01       # seconds
        self.lookahead = 0.001    # seconds

        # Lookahead buffer
        lookahead_samples = int(self.lookahead * sample_rate)
        self.buffer = np.zeros(lookahead_samples)
        self.write_pos = 0

        self.gain_reduction = 1.0

    def process(self, audio: np.ndarray) -> np.ndarray:
        """Apply limiting to audio."""
        output = np.zeros_like(audio)

        threshold_linear = 10 ** (self.threshold / 20)
        ceiling_linear = 10 ** (self.ceiling / 20)
        release_coeff = np.exp(-1.0 / (self.release * self.sample_rate))

        for i in range(len(audio)):
            # Write to lookahead buffer
            self.buffer[self.write_pos] = audio[i]

            # Find peak in lookahead window
            peak = np.max(np.abs(self.buffer))

            # Calculate required gain reduction
            if peak > threshold_linear:
                target_gain = threshold_linear / peak
            else:
                target_gain = 1.0

            # Smooth gain reduction
            if target_gain < self.gain_reduction:
                # Instant attack
                self.gain_reduction = target_gain
            else:
                # Release
                self.gain_reduction = release_coeff * self.gain_reduction + \
                                    (1 - release_coeff) * target_gain

            # Apply gain reduction
            read_pos = (self.write_pos - len(self.buffer) + 1) % len(self.buffer)
            output[i] = self.buffer[read_pos] * self.gain_reduction

            # Apply ceiling
            output[i] = np.clip(output[i], -ceiling_linear, ceiling_linear)

            self.write_pos = (self.write_pos + 1) % len(self.buffer)

        return output


class EffectChain:
    """
    Chain of audio effects applied in series.
    """

    def __init__(self, sample_rate: int = 44100):
        """
        Initialize effect chain.

        Args:
            sample_rate: Sample rate in Hz
        """
        self.sample_rate = sample_rate
        self.effects = []
        self.bypass = False

    def add_effect(self, effect):
        """Add effect to chain."""
        self.effects.append(effect)

    def remove_effect(self, index: int):
        """Remove effect at index."""
        if 0 <= index < len(self.effects):
            del self.effects[index]

    def process(self, audio: np.ndarray) -> np.ndarray:
        """Process audio through effect chain."""
        if self.bypass or len(self.effects) == 0:
            return audio

        output = audio.copy()

        for effect in self.effects:
            output = effect.process(output)

        return output

    def clear(self):
        """Remove all effects."""
        self.effects.clear()


# Convenience function
def apply_effects(
    audio: np.ndarray,
    sample_rate: int,
    effects_config: Dict
) -> np.ndarray:
    """
    Apply effects from configuration.

    Args:
        audio: Input audio
        sample_rate: Sample rate
        effects_config: Dictionary of effect configurations

    Returns:
        Processed audio
    """
    chain = EffectChain(sample_rate)

    if 'reverb' in effects_config:
        reverb = Reverb(sample_rate)
        reverb.room_size = effects_config['reverb'].get('room_size', 0.5)
        reverb.wet_level = effects_config['reverb'].get('wet', 0.3)
        chain.add_effect(reverb)

    if 'delay' in effects_config:
        delay = Delay(sample_rate)
        delay.delay_time = effects_config['delay'].get('time', 0.5)
        delay.feedback = effects_config['delay'].get('feedback', 0.3)
        chain.add_effect(delay)

    if 'eq' in effects_config:
        eq = ParametricEQ(sample_rate)
        if 'bands' in effects_config['eq']:
            eq.bands = effects_config['eq']['bands']
        chain.add_effect(eq)

    if 'compressor' in effects_config:
        comp = Compressor(sample_rate)
        comp.threshold = effects_config['compressor'].get('threshold', -20.0)
        comp.ratio = effects_config['compressor'].get('ratio', 4.0)
        chain.add_effect(comp)

    if 'limiter' in effects_config:
        limiter = Limiter(sample_rate)
        limiter.threshold = effects_config['limiter'].get('threshold', -0.1)
        chain.add_effect(limiter)

    return chain.process(audio)


if __name__ == "__main__":
    # Example usage
    import soundfile as sf

    # Load audio
    audio, sr = sf.read('input.wav')

    # Apply effects
    effects = {
        'reverb': {'room_size': 0.7, 'wet': 0.3},
        'compressor': {'threshold': -15.0, 'ratio': 3.0},
        'limiter': {'threshold': -0.5}
    }

    processed = apply_effects(audio, sr, effects)

    # Save
    sf.write('output.wav', processed, sr)
    print("Effects applied and saved to output.wav")

