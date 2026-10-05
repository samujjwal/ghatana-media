# Phase 4b: UI Implementation Guide

> **Prerequisites**: Backend implementation complete (Phases 1-3, 4a)  
> **Status**: Ready to implement  
> **Estimated Time**: 1-2 days

## 🎯 Overview

This guide outlines the implementation of React UI components for voice cloning and TTS synthesis. The backend is complete; we now need to build the user interface.

## 📋 Components to Implement

### 1. Voice Cloning Wizard (`VoiceCloningWizard.tsx`)

**Location**: `products/shared-services/speech/libs/speech-ui-react/src/voice-cloning/`

**Purpose**: Multi-step wizard for cloning a user's voice

**Steps**:
1. **Upload Audio Samples** (3-10 files, WAV/MP3)
2. **Voice Configuration** (name, epochs, learning rate)
3. **Training Progress** (real-time progress bar)
4. **Quality Review** (similarity score, test synthesis)
5. **Save & Complete** (add to voice library)

**Example Structure**:
```tsx
import { useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';

interface VoiceCloningWizardProps {
  onComplete: (voiceId: string) => void;
  onCancel: () => void;
}

export function VoiceCloningWizard({ onComplete, onCancel }: VoiceCloningWizardProps) {
  const [step, setStep] = useState(1);
  const [audioFiles, setAudioFiles] = useState<string[]>([]);
  const [voiceName, setVoiceName] = useState('');
  const [isTraining, setIsTraining] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);

  const handleStartTraining = async () => {
    setIsTraining(true);
    try {
      const result = await invoke('ai_voice_clone_voice', {
        voiceName,
        audioPaths: audioFiles,
        epochs: 100,
        learningRate: 0.0001
      });
      setResult(result);
      setStep(4);
    } finally {
      setIsTraining(false);
    }
  };

  return (
    <div className="voice-cloning-wizard">
      {/* Step 1: Upload Files */}
      {/* Step 2: Configure */}
      {/* Step 3: Training Progress */}
      {/* Step 4: Review & Complete */}
    </div>
  );
}
```

### 2. Cloned Voice TTS Panel (`ClonedVoiceTTSPanel.tsx`)

**Location**: Same directory as wizard

**Purpose**: Synthesize text using cloned voices

**Features**:
- Voice selection dropdown
- Text input (multi-line)
- Prosody controls (speed, pitch sliders)
- Generate button
- Audio player for preview
- Download synthesized audio

**Example Structure**:
```tsx
import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/tauri';

interface ClonedVoiceTTSPanelProps {
  availableVoices: ClonedVoiceInfo[];
  onRefreshVoices: () => void;
}

export function ClonedVoiceTTSPanel({ availableVoices, onRefreshVoices }: ClonedVoiceTTSPanelProps) {
  const [selectedVoice, setSelectedVoice] = useState('');
  const [text, setText] = useState('');
  const [speed, setSpeed] = useState(1.0);
  const [pitch, setPitch] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const handleSynthesize = useCallback(async () => {
    if (!selectedVoice || !text.trim()) return;

    setIsGenerating(true);
    try {
      const outputPath = `/tmp/synthesis_${Date.now()}.wav`;
      await invoke('ai_voice_synthesize_with_voice', {
        text,
        voiceId: selectedVoice,
        speed,
        pitch,
        outputPath
      });
      setAudioUrl(outputPath);
    } finally {
      setIsGenerating(false);
    }
  }, [selectedVoice, text, speed, pitch]);

  return (
    <div className="cloned-voice-tts-panel">
      {/* Voice selector */}
      {/* Text input */}
      {/* Prosody controls */}
      {/* Generate button */}
      {/* Audio player */}
    </div>
  );
}
```

### 3. Voice Library Manager (`VoiceLibraryManager.tsx`)

**Location**: Same directory

**Purpose**: Manage cloned voices (view, test, delete)

**Features**:
- List of cloned voices
- Voice details (name, similarity score, created date)
- Test synthesis button
- Delete confirmation
- Refresh button

**Example Structure**:
```tsx
import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/tauri';

export function VoiceLibraryManager() {
  const [voices, setVoices] = useState<ClonedVoiceInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const loadVoices = async () => {
    setLoading(true);
    try {
      const result = await invoke('ai_voice_list_cloned_voices');
      setVoices(result);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadVoices();
  }, []);

  const handleDelete = async (voiceId: string) => {
    if (!confirm('Delete this voice?')) return;
    await invoke('ai_voice_delete_cloned_voice', { voiceId });
    loadVoices();
  };

  return (
    <div className="voice-library-manager">
      {voices.map(voice => (
        <div key={voice.voiceId} className="voice-item">
          <h3>{voice.voiceName}</h3>
          <p>Similarity: {(voice.similarityScore * 100).toFixed(1)}%</p>
          <button onClick={() => handleDelete(voice.voiceId)}>Delete</button>
        </div>
      ))}
    </div>
  );
}
```

## 🎨 UI/UX Guidelines

### Design Principles

1. **Progressive Disclosure**: Show only relevant options at each step
2. **Clear Feedback**: Always show progress and status
3. **Error Handling**: Display user-friendly error messages
4. **Accessibility**: Follow ARIA guidelines

### Styling

Use existing Tailwind CSS classes from the project:
- Primary buttons: `bg-purple-600 hover:bg-purple-700`
- Secondary buttons: `bg-gray-600 hover:bg-gray-700`
- Success: `bg-green-600`
- Error: `bg-red-600`
- Cards: `bg-gray-800 rounded-lg p-4`

### Audio Requirements

**For Training**:
- Minimum 3 samples, maximum 10
- Each 3-10 seconds long
- Clear speech, minimal background noise
- WAV or MP3 format

**Quality Indicators**:
- Green (>0.85): Excellent similarity
- Yellow (0.70-0.85): Good similarity
- Red (<0.70): Poor similarity

## 📦 TypeScript Types

Create `types/voice-cloning.ts`:

```typescript
export interface ClonedVoiceInfo {
  voiceId: string;
  voiceName: string;
  similarityScore: number;
  embeddingDim: number;
  modelPath: string;
  createdAt: number;
}

export interface VoiceCloningResult {
  success: boolean;
  voiceId: string;
  modelPath: string;
  embeddingPath: string;
  similarityScore: number;
  trainingTimeSeconds: number;
  message: string;
  error?: string;
}

export interface SynthesisResult {
  outputPath: string;
  durationSeconds: number;
  sampleRate: number;
  textProcessed: string;
}

export interface SynthesisOptions {
  speed?: number;
  pitch?: number;
  energy?: number;
}
```

## 🧪 Testing UI Components

### Component Tests

```typescript
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { VoiceCloningWizard } from './VoiceCloningWizard';

describe('VoiceCloningWizard', () => {
  it('should render upload step initially', () => {
    render(<VoiceCloningWizard onComplete={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.getByText(/upload audio samples/i)).toBeInTheDocument();
  });

  it('should validate minimum audio samples', () => {
    // Test that user needs at least 3 samples
  });

  it('should show progress during training', async () => {
    // Test progress bar visibility and updates
  });

  it('should call onComplete with voice ID', async () => {
    const onComplete = jest.fn();
    render(<VoiceCloningWizard onComplete={onComplete} onCancel={jest.fn()} />);
    // ... trigger completion
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith('voice_id'));
  });
});
```

### Integration Tests

Test the full flow:
1. Upload files → configure → train → complete
2. List voices → select → synthesize → play
3. Delete voice → confirm deletion

## 🔌 Integration Points

### With Existing Components

1. **Audio File Picker**: Reuse from existing audio upload components
2. **Progress Bar**: Reuse from existing operation progress displays
3. **Audio Player**: Reuse from existing audio playback components

### State Management

Use Jotai atoms for global state:

```typescript
// atoms/voiceCloning.ts
import { atom } from 'jotai';

export const clonedVoicesAtom = atom<ClonedVoiceInfo[]>([]);
export const selectedVoiceAtom = atom<string | null>(null);
export const isCloningAtom = atom<boolean>(false);
```

## 📝 User Flow

### Voice Cloning Flow

```
1. Click "Clone Your Voice" button
   ↓
2. Open VoiceCloningWizard modal
   ↓
3. Upload 3-10 audio samples (drag & drop or file picker)
   ↓
4. Enter voice name and adjust settings
   ↓
5. Click "Start Training"
   ↓
6. Show progress (preprocessing → training → validation)
   ↓
7. Show results (similarity score, test synthesis)
   ↓
8. Save to voice library
```

### TTS Synthesis Flow

```
1. Open ClonedVoiceTTSPanel
   ↓
2. Select voice from dropdown
   ↓
3. Enter text to synthesize
   ↓
4. Adjust speed/pitch if needed
   ↓
5. Click "Generate Speech"
   ↓
6. Show progress spinner
   ↓
7. Play generated audio
   ↓
8. Download if desired
```

## 🚀 Implementation Checklist

### Step 1: Setup (30 min)
- [ ] Create `voice-cloning/` directory
- [ ] Create TypeScript types file
- [ ] Set up basic component structure

### Step 2: VoiceCloningWizard (3-4 hours)
- [ ] Step 1: File upload with validation
- [ ] Step 2: Configuration form
- [ ] Step 3: Progress tracking
- [ ] Step 4: Results display
- [ ] Modal wrapper with animations

### Step 3: ClonedVoiceTTSPanel (2-3 hours)
- [ ] Voice selector dropdown
- [ ] Text input area
- [ ] Prosody control sliders
- [ ] Generate button with loading state
- [ ] Audio player integration

### Step 4: VoiceLibraryManager (1-2 hours)
- [ ] Voice list display
- [ ] Delete confirmation
- [ ] Test synthesis button
- [ ] Empty state

### Step 5: Integration (2-3 hours)
- [ ] Add to main navigation
- [ ] Wire up state management
- [ ] Error handling
- [ ] Loading states

### Step 6: Testing (2-3 hours)
- [ ] Component unit tests
- [ ] Integration tests
- [ ] Manual E2E testing

### Step 7: Polish (1-2 hours)
- [ ] Animations and transitions
- [ ] Responsive design
- [ ] Accessibility review
- [ ] Documentation

**Total Estimated Time: 12-18 hours (1.5-2 days)**

## 📚 Resources

- **Tauri API**: https://tauri.app/v1/api/js/
- **React Testing Library**: https://testing-library.com/react
- **Tailwind CSS**: https://tailwindcss.com/docs
- **Jotai**: https://jotai.org/docs/introduction

## 🎯 Success Criteria

- [ ] User can clone their voice in < 5 clicks
- [ ] Training progress is clearly visible
- [ ] Synthesis completes in < 5 seconds
- [ ] All components are responsive
- [ ] Error messages are user-friendly
- [ ] Accessibility score > 95
- [ ] All tests passing

## 📞 Next Steps

1. Review this guide
2. Set up development environment
3. Create branch: `feature/voice-cloning-ui`
4. Implement components in order (wizard → panel → manager)
5. Test each component before moving on
6. Create PR when complete

---

**Note**: Backend is fully implemented and tested. Focus on creating an intuitive UI that leverages the existing API.

