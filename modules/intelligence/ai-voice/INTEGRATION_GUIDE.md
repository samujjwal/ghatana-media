# AI Voice Developer Integration Guide

**Version:** 1.0.0
**Last Updated:** Implementation Complete
**Status:** Experimental / Internal Preview

---

## 📋 Overview

This guide provides complete instructions for integrating AI Voice features (D3-D6) into your application.

---

## 🚀 Quick Start

### Prerequisites

**Python Environment:**
```bash
# Python 3.11+
python --version  # Should be 3.11+

# Install dependencies
pip install torch torchaudio librosa soundfile numpy scipy
pip install demucs  # For stem separation
# Optional: pip install crepe dtaidistance  # For pitch extraction and DTW
```

**Rust Environment:**
```bash
# Rust 1.70+
rustc --version

# Build Rust bridge
cd products/shared-services/ai-voice/apps/desktop/src-tauri
cargo build --release
```

**Node.js Environment:**
```bash
# Node.js 18+
node --version

# Install dependencies
cd products/shared-services/ai-voice/apps/desktop
pnpm install
```

---

## D3: Stem Separation Integration

### Python API

```python
from stem_separator_enhanced import separate_stems_enhanced, SeparationProgress

def progress_callback(progress: SeparationProgress):
    print(f"[{progress.progress:.1f}%] {progress.stage}: {progress.message}")
    print(f"Time: {progress.time_elapsed:.1f}s elapsed, {progress.time_remaining:.1f}s remaining")
    print(f"Completed: {', '.join(progress.stems_completed)}")

# Separate stems
result = separate_stems_enhanced(
    input_path="input_audio.wav",
    output_dir="output_stems",
    model_name="htdemucs",  # or "htdemucs_ft", "htdemucs_6s"
    progress_callback=progress_callback
)

if result['success']:
    print(f"Separation complete in {result['total_time']:.2f}s")
    
    # Access stems
    vocals = result['stems']['vocals']
    print(f"Vocals: {vocals['path']}")
    print(f"Duration: {vocals['duration']:.2f}s")
    print(f"Quality - RMS: {vocals['quality']['rms']:.4f}")
else:
    print(f"Error: {result['error']}")
```

### Rust Bridge

```rust
use crate::python::separate_stems;

// Call from Rust
let result = separate_stems("input.wav", "output_dir")?;

println!("Vocals: {}", result.vocals.path);
println!("Drums: {}", result.drums.path);
println!("Bass: {}", result.bass.path);
println!("Other: {}", result.other.path);
```

### React Component

```tsx
import { StemSeparator } from '@/components/audio/StemSeparator';
import { MultiStemWaveform } from '@/components/audio/MultiStemWaveform';

function MyApp() {
  const [stems, setStems] = useState(null);

  return (
    <div>
      <StemSeparator onComplete={setStems} />
      
      {stems && (
        <MultiStemWaveform stems={stems} />
      )}
    </div>
  );
}
```

### Tauri Command

```rust
#[tauri::command]
pub async fn ai_voice_separate_stems(
    audio_path: String,
    state: State<'_, AppState>,
) -> Result<StemsOutput, AppError> {
    let output_dir = state.temp_path(&format!("stems_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&output_dir)?;
    
    python::separate_stems(&audio_path, output_dir.to_str().unwrap_or(""))
}
```

---

## D4: Voice Training Integration

### Python API

```python
from voice_training_pipeline import train_voice_model, DatasetValidator

# Validate dataset
validator = DatasetValidator(config)
is_valid, message, stats = validator.validate("path/to/dataset")

if is_valid:
    print(f"Dataset valid: {stats.total_samples} samples, {stats.total_duration:.1f}s")
    
    # Train model
    result = train_voice_model({
        'model_name': 'rvc-v2',
        'dataset_path': 'path/to/dataset',
        'output_dir': 'path/to/output',
        'epochs': 100,
        'batch_size': 16,
        'learning_rate': 0.0001
    })
    
    if result['success']:
        print(f"Training complete!")
        print(f"Checkpoints: {len(result['checkpoints'])}")
    else:
        print(f"Error: {result['error']}")
```

### React Component

```tsx
import { VoiceTraining } from '@/components/training/VoiceTraining';

function TrainingPage() {
  return (
    <div>
      <VoiceTraining />
    </div>
  );
}
```

### Configuration

```typescript
interface TrainingConfig {
  model_name: string;      // 'rvc-v2', 'vits', 'so-vits-svc'
  dataset_path: string;    // Path to training data
  output_dir: string;      // Where to save checkpoints
  batch_size: number;      // Default: 16
  epochs: number;          // Default: 100
  learning_rate: number;   // Default: 0.0001
  save_every: number;      // Save checkpoint every N epochs
}
```

---

## D5: Voice Conversion Integration

### Python API

```python
from voice_conversion_engine import convert_voice, ConversionConfig

# Configure conversion
config = {
    'source_audio': 'input.wav',
    'target_voice': 'voice_model_id',
    'output_path': 'output.wav',
    'pitch_shift': 0.0,        # Semitones
    'formant_shift': 1.0,      # Multiplier
    'preserve_timing': True,
    'enhance_quality': True
}

# Convert
result = convert_voice(config)

if result['success']:
    print(f"Conversion complete in {result['total_time']:.2f}s")
    print(f"RTF: {result['rtf']:.3f}")
    print(f"Quality score: {result['quality_score']:.2f}")
else:
    print(f"Error: {result['error']}")
```

### Pitch Extraction

```python
from voice_conversion_engine import PitchExtractor

extractor = PitchExtractor(sample_rate=22050)

# Extract F0 using CREPE (most accurate)
f0 = extractor.extract_f0(audio, method='crepe')

# Or use alternatives
f0_pyin = extractor.extract_f0(audio, method='pyin')
f0_harvest = extractor.extract_f0(audio, method='harvest')

# Shift pitch
f0_shifted = extractor.shift_pitch(f0, semitones=2.0)  # Up 2 semitones
```

### Quality Enhancement

```python
from voice_conversion_engine import QualityEnhancer

enhancer = QualityEnhancer()

# Apply full enhancement pipeline
enhanced_audio = enhancer.enhance(audio, sample_rate=22050)

# Or apply individual steps
audio = enhancer._noise_gate(audio, threshold=0.01)
audio = enhancer._normalize(audio, target_level=0.9)
audio = enhancer._compress(audio, threshold=0.5, ratio=4.0)
audio = enhancer._deess(audio, sample_rate)
```

---

## D6: Multi-Track Integration

### React Component

```tsx
import { MultiTrackTimeline } from '@/components/mixer/MultiTrackTimeline';

function StudioPage() {
  return (
    <div className="h-screen">
      <MultiTrackTimeline />
    </div>
  );
}
```

### Track Management

```typescript
interface AudioTrack {
  id: string;
  name: string;
  audioPath: string;
  volume: number;      // 0-1
  pan: number;         // -1 to 1
  muted: boolean;
  solo: boolean;
  color: string;
  startTime: number;   // seconds
  duration: number;    // seconds
}

// Add track
const newTrack: AudioTrack = {
  id: uuid(),
  name: 'Track 1',
  audioPath: '/path/to/audio.wav',
  volume: 1.0,
  pan: 0,
  muted: false,
  solo: false,
  color: '#a855f7',
  startTime: 0,
  duration: 0
};
```

### Playback Control

```typescript
// Play/pause
const togglePlay = () => {
  setState(prev => ({ ...prev, playing: !prev.playing }));
};

// Stop
const stop = () => {
  setState(prev => ({ ...prev, playing: false, currentTime: 0 }));
};

// Seek
const seek = (time: number) => {
  setState(prev => ({ ...prev, currentTime: time }));
};
```

---

## 🧪 Testing

### Unit Tests

```python
import pytest
from stem_separator_enhanced import EnhancedStemSeparator

def test_stem_separation():
    separator = EnhancedStemSeparator()
    result = separator.separate('test.wav', 'output')
    assert result.success
    assert result.vocals is not None
```

### Integration Tests

```python
def test_end_to_end_workflow():
    # 1. Separate stems
    sep_result = separate_stems_enhanced('input.wav', 'stems')
    assert sep_result['success']
    
    # 2. Train model (mock)
    # 3. Convert voice (mock)
    # 4. Mix in timeline
```

### React Component Tests

```typescript
import { render, screen } from '@testing-library/react';
import { StemSeparator } from '@/components/audio/StemSeparator';

test('renders stem separator', () => {
  render(<StemSeparator />);
  expect(screen.getByText(/stem separation/i)).toBeInTheDocument();
});
```

---

## 🔧 Configuration

### Environment Variables

```bash
# Python
PYTHONPATH=/path/to/ai-voice/apps/desktop/src-tauri/python

# Rust
RUST_LOG=info

# Models (optional)
DEMUCS_MODEL_PATH=/path/to/models/demucs
VOICE_MODEL_PATH=/path/to/models/voices
```

### Model Configuration

```python
# Stem Separation Models
MODELS = {
    'htdemucs': 'default',           # 4-stem separation
    'htdemucs_ft': 'fine_tuned',     # Better quality
    'htdemucs_6s': '6_stems',        # Vocals, drums, bass, other, piano, guitar
}

# Training Models
TRAINING_MODELS = {
    'rvc-v2': 'RVC v2 (Recommended)',
    'vits': 'VITS',
    'so-vits-svc': 'SO-VITS-SVC'
}
```

---

## 🚀 Performance Optimization

### GPU Acceleration

```python
# Use GPU if available
separator = EnhancedStemSeparator(device='cuda')  # or 'mps' for Apple Silicon

# Check device
print(f"Using device: {separator.device}")
```

### Batch Processing

```python
# Process multiple files
files = ['audio1.wav', 'audio2.wav', 'audio3.wav']

for file in files:
    result = separate_stems_enhanced(file, f'output_{file}')
    if result['success']:
        print(f"Processed {file}")
```

### Memory Management

```python
# For large files, consider processing in chunks
# The current implementation loads full files
# For streaming support, see Phase 4 roadmap
```

---

## 🐛 Troubleshooting

### Common Issues

**1. ImportError: No module named 'demucs'**
```bash
pip install demucs
```

**2. CUDA out of memory**
```python
# Reduce batch size or use CPU
separator = EnhancedStemSeparator(device='cpu')
```

**3. Slow processing**
```bash
# Install with CUDA support
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu118
```

**4. TypeScript errors in React**
```bash
# Ensure types are installed
pnpm install -D @types/react @types/node
```

---

## 📚 API Reference

### Python Modules

- `stem_separator_enhanced.py` - Stem separation
- `voice_training_pipeline.py` - Voice training
- `voice_conversion_engine.py` - Voice conversion

### React Components

- `StemSeparator.tsx` - Stem separation UI
- `MultiStemWaveform.tsx` - Waveform visualization
- `VoiceTraining.tsx` - Training wizard
- `MultiTrackTimeline.tsx` - Timeline editor

### Rust Modules

- `python.rs` - Python bridge
- `commands.rs` - Tauri commands

---

## 🔗 Additional Resources

- [Full API Documentation](./API_DOCUMENTATION.md)
- [Deployment Guide](./DEPLOYMENT_GUIDE.md)
- [Architecture Overview](./AI_VOICE_IMPLEMENTATION_PLAN.md)
- [Testing Guide](./TESTING_GUIDE.md)

---

## 💬 Support

For issues or questions:
1. Check [Troubleshooting](#-troubleshooting)
2. Review [API Reference](#-api-reference)
3. See example code in this guide
4. Contact the development team

---

**Last Updated:** Implementation Complete
**Version:** 1.0.0
**Status:** Experimental / Internal Preview

