# AI Voice Production Studio

**Version:** 1.0.0  
**Status:** Experimental / Internal Preview  
**Last Updated:** 2026-04-17

Interactive voice replacement and music production studio with stem separation, voice training, voice conversion, and multi-track production capabilities.

This module is not release-ready as a production product surface. Runtime behavior still depends on optional Python and model dependencies, and unsupported fallback paths are blocked instead of being presented as successful production output.

## Product Boundary

AI Voice currently belongs to the `audio-video` product workspace as an experimental creator-facing application, not as a shared platform capability that other products should treat as a stable contract. Shared media primitives can still graduate into platform modules later, but the current desktop app, Python ML stack, and workflow claims remain product-scoped and preview-only.

## Runtime Modes

| Runtime mode | Meaning | Export policy |
| --- | --- | --- |
| `production` | Real user audio plus verified local model prerequisites for the current workstation session | Enabled |
| `degraded` | Missing models, failed runtime checks, or unresolved local dependency state | Blocked |
| `demo` | Example audio or guided preview session intended to demonstrate flows only | Blocked |

---

## 🎯 Features

### D3: Stem Separation
- **Professional audio separation** into vocals, drums, bass, and other instruments
- **Real-time progress tracking** with time estimates and stage indicators
- **Quality metrics** per stem (RMS, peak, spectral centroid)
- **Drag & drop interface** with instant upload
- **WaveSurfer.js visualization** with multi-stem playback
- **Individual controls** per stem (play, pause, volume, mute)
- **Current mode:** real stems only when Python separation dependencies are installed; otherwise the operation fails explicitly
- **Verification:** Python integration tests exist, but production-readiness claims are not evidence-backed end-to-end

### D4: Voice Training
- **Complete training pipeline** with dataset validation
- **Preprocessing** (silence removal, normalization, resampling)
- **Training loop** with checkpoint management
- **Early stopping** logic with patience counter
- **4-step wizard UI** (upload → config → training → complete)
- **Real-time dashboard** with metrics and progress
- **Architecture ready** for VITS, RVC, and custom models
- **Checkpoint versioning** with metadata tracking

### D5: Voice Conversion
- **Advanced pitch extraction** (4 methods: CREPE, pYIN, HARVEST, fallback)
- **Pitch shifting** with semitone control
- **DTW timing alignment** for natural speech patterns
- **Quality enhancement pipeline:**
  - Noise gate (threshold-based)
  - EQ normalization (peak-based)
  - Dynamic compression (ratio-based)
  - De-essing (sibilance reduction)
- **Flexible configuration** (pitch, formant, timing, quality)
- **Performance note:** Local measurements vary by hardware and dependency availability; this repository does not currently treat them as validation evidence.

### D6: Multi-Track Production

---

## Capability Matrix

| Capability | Current classification | Notes |
| --- | --- | --- |
| Stem separation | Real ML-backed when dependencies are installed | Demucs-backed separation runs only when Python and model dependencies are present; unsupported dependencies fail explicitly |
| Voice training | Degraded / partial | UI and pipeline scaffolding exist, but end-to-end model-quality claims are not validation evidence |
| Voice conversion | Degraded / partial | Conversion flow exists, but quality and latency claims remain environment-dependent |
| Multi-track editing | Functional local editor | Useful for local editing, but not evidence of production production readiness |
| Export / publish workflows | Not releaseable | Treat as preview workflows until end-to-end validation and persistence evidence are in place |
- **Professional DAW-like timeline** editor
- **Canvas-based rendering** with waveform visualization
- **Complete track controls:**
  - Volume (0-100%)
  - Pan (-100% to +100%)
  - Mute/Solo buttons
  - Track naming and coloring
- **Real-time playback** at 60fps with animation loop
- **Zoom/pan navigation** (20-1000 px/s)
- **Project state management** with add/remove/rename

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│             AI Voice Production Studio                  │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │ Stem Sep (D3)│  │Training (D4) │  │Conversion(D5)│ │
│  │   450 lines  │  │   600 lines  │  │   500 lines  │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘ │
│         │                  │                  │         │
│  ┌──────▼──────────────────▼──────────────────▼──────┐ │
│  │         Multi-Track Engine (D6)                    │ │
│  │              400 lines                             │ │
│  └─────────────────────────────────────────────────────┘│
│                                                          │
│  ┌─────────────────────────────────────────────────────┐│
│  │   Python (ML) ↔ Rust (Bridge) ↔ React (UI)       ││
│  │    1,850 lines    80 lines       1,680 lines      ││
│  └─────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

### Technology Stack

- **Frontend:** React 18 + TypeScript + Tailwind CSS + Jotai
- **Desktop:** Tauri (Rust 1.70+)
- **ML/Audio:** Python 3.11 (PyTorch, librosa, Demucs, CREPE)
- **Bridge:** PyO3 for Rust ↔ Python interop
- **Visualization:** WaveSurfer.js, Canvas API
- **State:** Jotai (atomic state management)
- **Testing:** Vitest, Playwright, pytest, cargo test

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** 18+ and pnpm
- **Rust** 1.70+
- **Python** 3.11+
- **Optional:** NVIDIA GPU with CUDA 11.8+

### Installation

```bash
# Clone repository
git clone <repo-url>
cd ghatana/products/shared-services/ai-voice

# Install Node dependencies
cd apps/desktop
pnpm install

# Install Python dependencies
cd src-tauri/python
pip install torch torchaudio librosa soundfile scipy numpy
pip install demucs  # Optional: for production models

# Build Rust components
cd ..
cargo build --release
```

### Development

```bash
# Run in development mode
pnpm tauri dev

# Run web only
pnpm dev

# Run tests
pnpm test              # UI unit tests
pnpm test:e2e          # Playwright desktop/browser smoke tests
pnpm test:integration  # Python stem-separation integration tests
cargo test             # Rust tests
```

### Production Build

```bash
# Build Tauri desktop app
pnpm tauri build

# Outputs to: src-tauri/target/release/bundle/
```

---

## 📚 Documentation

### Backend Patterns

The Rust backend now follows explicit audio-module ownership instead of ad hoc helpers:

- `speech-audio-rust` owns decode, metadata, waveform extraction, slicing, mixing, and resampling.
- `src-tauri/src/device.rs` owns device selection for recording and playback.
- `src-tauri/src/buffer.rs` owns shared buffering semantics.
- `src-tauri/src/session.rs`, `sync.rs`, `stream.rs`, and `effects.rs` own local editing/session workflows.
- `src-tauri/src/error.rs` owns error categorization and retryability metadata.

Example command flow:

```rust
let metadata = audio::load_audio_metadata(&path)?;
let session = crate::session::new_audio_session(
  path.clone(),
  Some(project_id),
  AudioSessionMode::Edit,
  metadata.duration,
);
let sync = crate::sync::assess_sync(metadata.duration, video_duration, 0, 0, 40);
let stream = crate::stream::build_stream_plan(&path, 250)?;
```

For the full audit closure matrix and the repo-standard remediation rationale, see `../../../../../docs/audits/AUDIO_VIDEO_AUDIT_CLOSURE_2026-03-27.md`.

### User Guides
- **[Integration Guide](./INTEGRATION_GUIDE.md)** - Complete API examples and usage
- **[Deployment Guide](./DEPLOYMENT_GUIDE.md)** - Production deployment instructions
- **[Implementation Plan](./AI_VOICE_IMPLEMENTATION_PLAN.md)** - Full feature specification

### Technical Documentation
- **Python Modules:**
  - `stem_separator_enhanced.py` - Enhanced stem separation (450 lines)
  - `voice_training_pipeline.py` - Complete training system (600 lines)
  - `voice_conversion_engine.py` - Voice conversion engine (500 lines)
  
- **React Components:**
  - `StemSeparator.tsx` - Stem separation UI (480 lines)
  - `MultiStemWaveform.tsx` - Waveform visualization (300 lines)
  - `VoiceTraining.tsx` - Training wizard (500 lines)
  - `MultiTrackTimeline.tsx` - Timeline editor (400 lines)

### Review Documents
- **[Implementation Audit](../../AI_VOICE_IMPLEMENTATION_AUDIT.md)** - Detailed technical audit
- **[Task-by-Task Review](../../TASK_BY_TASK_REVIEW.md)** - Individual task completion
- **[Executive Summary](../../EXECUTIVE_REVIEW_SUMMARY.md)** - High-level overview
- **[Audit Action Items](../../AUDIT_SUMMARY_ACTION_ITEMS.md)** - Next steps

---

## 🧪 Testing

### Test Suite

```bash
# Python integration tests (15 tests)
cd apps/desktop/tests
pytest test_stem_separation_integration.py -v

# Rust unit tests
cd apps/desktop/src-tauri
cargo test

# React component tests (when added)
cd apps/desktop
pnpm test
```

### Test Coverage

- **Stem Separation:** 15 integration tests ✅
- **Voice Training:** Framework tested ✅
- **Voice Conversion:** Core engine tested ✅
- **Multi-Track:** UI components tested ✅

Treat this as reproducible test entrypoint coverage, not as proof of production readiness.

---

## 📊 Performance

### Performance Notes

The repository contains implementation notes and local measurements, but it does not currently include a reproducible benchmark suite in CI for this module. Treat historical latency or throughput numbers in older documents as illustrative developer measurements, not release criteria.

### Hardware Recommendations

**Minimum:**
- CPU: 4 cores (Intel i5 / AMD Ryzen 5)
- RAM: 8GB
- GPU: None (CPU fallback works)
- Storage: 2GB for models

**Recommended:**
- CPU: 8+ cores (Intel i7 / AMD Ryzen 7)
- RAM: 16GB+
- GPU: NVIDIA RTX 3060+ (8GB VRAM) or Apple Silicon M1+
- Storage: 10GB for models and workspace

---

## 🔧 Configuration

### Environment Variables

```bash
# Python
export PYTHONPATH=/path/to/python/modules
export PYTHON_ENV=production

# Models
export DEMUCS_MODEL=htdemucs          # or htdemucs_ft, htdemucs_6s
export MODEL_CACHE_DIR=/path/to/models

# Performance
export USE_GPU=true                    # Enable GPU acceleration
export GPU_DEVICE=0                    # GPU device ID
export BATCH_SIZE=16                   # Training batch size

# Storage
export AI_VOICE_DATA_DIR=/path/to/data
export AI_VOICE_MODELS_DIR=/path/to/models
```

### Model Options

**Stem Separation:**
- `htdemucs` - Default (4-stem: vocals, drums, bass, other)
- `htdemucs_ft` - Fine-tuned (better quality)
- `htdemucs_6s` - 6-stem (adds piano, guitar)

**Voice Training:**
- `rvc-v2` - RVC v2 (Recommended)
- `vits` - VITS
- `so-vits-svc` - SO-VITS-SVC

---

## 🎓 Usage Examples

### Stem Separation

```python
from stem_separator_enhanced import separate_stems_enhanced

result = separate_stems_enhanced(
    input_path="song.wav",
    output_dir="stems_output",
    model_name="htdemucs"
)

print(f"Vocals: {result['stems']['vocals']['path']}")
print(f"Quality: {result['stems']['vocals']['quality']['rms']:.4f}")
```

### Voice Training

```python
from voice_training_pipeline import train_voice_model

result = train_voice_model({
    'model_name': 'rvc-v2',
    'dataset_path': 'training_data/',
    'output_dir': 'model_output/',
    'epochs': 100
})

print(f"Training complete: {result['success']}")
```

### Voice Conversion

```python
from voice_conversion_engine import convert_voice

result = convert_voice({
    'source_audio': 'input.wav',
    'target_voice': 'my_voice_model',
    'output_path': 'output.wav',
    'pitch_shift': 2.0,  # Up 2 semitones
    'enhance_quality': True
})

print(f"RTF: {result['rtf']:.3f}")
```

---

## 🐛 Troubleshooting

### Common Issues

**1. ImportError: No module named 'torch'**
```bash
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu118
```

**2. CUDA out of memory**
```python
# Use CPU instead
separator = EnhancedStemSeparator(device='cpu')
```

**3. Slow processing**
```bash
# Check GPU availability
python -c "import torch; print(f'CUDA: {torch.cuda.is_available()}')"

# Enable GPU in config
export USE_GPU=true
```

**4. Module not found errors**
```bash
# Set PYTHONPATH
export PYTHONPATH=/path/to/ai-voice/apps/desktop/src-tauri/python
```

---

## 📈 Roadmap

### Current status
- Experimental / internal preview
- Reproducible test entrypoints exist from the desktop package
- Core capabilities remain dependency-sensitive and should be treated as preview workflows unless validated in the target environment

### Phase 4: Optional Enhancements (5-7 weeks)

**Priority 1: Real ML Models (2-3 weeks)**
- Production Demucs model integration
- VITS/RVC training implementation
- Voice conversion model hookup

**Priority 2: Backend Persistence (1 week)**
- Project save/load implementation
- Export mixdown backend
- Cloud storage integration

**Priority 3: Quality Metrics (1 week)**
- Real MOS estimation
- WER calculation
- Speaker similarity measurement

**Priority 4: Effects Library (1-2 weeks)**
- Reverb, delay, EQ
- Compressor, limiter
- Plugin architecture

---

## 🤝 Contributing

1. Review [Implementation Plan](./AI_VOICE_IMPLEMENTATION_PLAN.md)
2. Check [Integration Guide](./INTEGRATION_GUIDE.md)
3. Follow code style (Prettier, ESLint, rustfmt, black)
4. Write tests for new features
5. Submit pull request

---

## 📜 License

MIT

---

## 🙏 Acknowledgments

- **Demucs** by Facebook Research - Stem separation
- **WaveSurfer.js** - Waveform visualization
- **Tauri** - Desktop framework
- **PyTorch** - ML framework
- **React** - UI framework

---

## 📞 Support

- **Documentation:** See guides above
- **Issues:** GitHub Issues
- **Discussions:** GitHub Discussions

---

## Project Status

> **Formal governance entry**: `docs/AI_GOVERNANCE_CONTRACTS.md` — Appendix A: AI Capability Release Status Registry.
> Status terms follow [docs/process/RUNTIME_TRUTHFULNESS_POLICY.md](../../../../../docs/process/RUNTIME_TRUTHFULNESS_POLICY.md).

| Capability | Phase | Release Status | Notes |
|---|---|---|---|
| Stem separation (Demucs) | D3 | `verified locally` | Reproducible pytest suite; Demucs dependency must be installed |
| Voice training (RVC/VITS) | D4 | **`experimental`** | Pipeline scaffolding exists; ML quality not validation evidence; NOT for user-facing production use |
| Voice conversion | D5 | **`experimental`** | Conversion flow exists; quality/latency environment-dependent; NOT for user-facing production use |
| Multi-track editing | D6 | `verified locally` | Functional local editor; not deployment-validated |
| Export/publish workflows | — | `experimental` | Preview workflow; no persistent backend |

**D4 and D5 are formally classified as `experimental`** per the governance decision recorded in `AI_GOVERNANCE_CONTRACTS.md` (2026-04-28). Promotion requires the criteria in that document to be met.

---

**Last Updated:** 2026-04-28  
**Version:** 1.0.0  
**Status:** D3/D6 — verified locally · D4/D5 — experimental (non-GA)

---

**Built with ❤️ by the Ghatana Team**

