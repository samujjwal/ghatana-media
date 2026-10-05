/**
 * AI Voice Production Studio - Project Context
 * 
 * @doc.type component
 * @doc.purpose Project state management context
 * @doc.layer product
 * @doc.pattern Context
 */

import React, { createContext, useContext, useReducer, useCallback, type ReactNode } from 'react';
import type {
  Project,
  AudioFile,
  StemSet,
  Phrase,
  VoiceModel,
  PlaybackState,
  MixerState,
  RuntimeModeState,
} from '../types';

interface ProjectState {
  project: Project | null;
  playback: PlaybackState;
  mixer: MixerState;
  runtimeMode: RuntimeModeState;
  isLoading: boolean;
  error: string | null;
}

type ProjectAction =
  | { type: 'SET_PROJECT'; payload: Project }
  | { type: 'UPDATE_PROJECT'; payload: Partial<Project> }
  | { type: 'SET_AUDIO_FILE'; payload: AudioFile }
  | { type: 'SET_STEMS'; payload: StemSet }
  | { type: 'SET_PHRASES'; payload: Phrase[] }
  | { type: 'UPDATE_PHRASE'; payload: { id: string; updates: Partial<Phrase> } }
  | { type: 'SET_VOICE_MODEL'; payload: VoiceModel }
  | { type: 'SET_PLAYBACK'; payload: Partial<PlaybackState> }
  | { type: 'SET_MIXER'; payload: Partial<MixerState> }
  | { type: 'SET_RUNTIME_MODE'; payload: RuntimeModeState }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_ERROR'; payload: string | null }
  | { type: 'RESET' };

const initialPlayback: PlaybackState = {
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  isLooping: false,
};

const initialMixer: MixerState = {
  masterVolume: 1.0,
  stems: {},
  effects: [],
};

const initialState: ProjectState = {
  project: null,
  playback: initialPlayback,
  mixer: initialMixer,
  runtimeMode: {
    mode: 'degraded',
    reason: 'Runtime prerequisites have not been verified for this session.',
    exportAllowed: false,
  },
  isLoading: false,
  error: null,
};

function projectReducer(state: ProjectState, action: ProjectAction): ProjectState {
  switch (action.type) {
    case 'SET_PROJECT':
      return { ...state, project: action.payload, error: null };
    case 'UPDATE_PROJECT':
      return state.project
        ? { ...state, project: { ...state.project, ...action.payload } }
        : state;
    case 'SET_AUDIO_FILE':
      return state.project
        ? { ...state, project: { ...state.project, audioFile: action.payload } }
        : state;
    case 'SET_STEMS':
      return state.project
        ? { ...state, project: { ...state.project, stems: action.payload } }
        : state;
    case 'SET_PHRASES':
      return state.project
        ? { ...state, project: { ...state.project, phrases: action.payload } }
        : state;
    case 'UPDATE_PHRASE':
      if (!state.project?.phrases) return state;
      return {
        ...state,
        project: {
          ...state.project,
          phrases: state.project.phrases.map((p) =>
            p.id === action.payload.id ? { ...p, ...action.payload.updates } : p
          ),
        },
      };
    case 'SET_VOICE_MODEL':
      return state.project
        ? { ...state, project: { ...state.project, voiceModel: action.payload } }
        : state;
    case 'SET_PLAYBACK':
      return { ...state, playback: { ...state.playback, ...action.payload } };
    case 'SET_MIXER':
      return { ...state, mixer: { ...state.mixer, ...action.payload } };
    case 'SET_RUNTIME_MODE':
      return { ...state, runtimeMode: action.payload };
    case 'SET_LOADING':
      return { ...state, isLoading: action.payload };
    case 'SET_ERROR':
      return { ...state, error: action.payload, isLoading: false };
    case 'RESET':
      return initialState;
    default:
      return state;
  }
}

interface ProjectContextValue {
  state: ProjectState;
  createProject: (name: string) => void;
  loadProject: (project: Project) => void;
  setAudioFile: (file: AudioFile) => void;
  setStems: (stems: StemSet) => void;
  setPhrases: (phrases: Phrase[]) => void;
  updatePhrase: (id: string, updates: Partial<Phrase>) => void;
  setVoiceModel: (model: VoiceModel) => void;
  setPlayback: (playback: Partial<PlaybackState>) => void;
  setMixer: (mixer: Partial<MixerState>) => void;
  setRuntimeMode: (runtimeMode: RuntimeModeState) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(projectReducer, initialState);

  const createProject = useCallback((name: string) => {
    const project: Project = {
      id: crypto.randomUUID(),
      name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    dispatch({ type: 'SET_PROJECT', payload: project });
  }, []);

  const loadProject = useCallback((project: Project) => {
    dispatch({ type: 'SET_PROJECT', payload: project });
  }, []);

  const setAudioFile = useCallback((file: AudioFile) => {
    dispatch({ type: 'SET_AUDIO_FILE', payload: file });
  }, []);

  const setStems = useCallback((stems: StemSet) => {
    dispatch({ type: 'SET_STEMS', payload: stems });
  }, []);

  const setPhrases = useCallback((phrases: Phrase[]) => {
    dispatch({ type: 'SET_PHRASES', payload: phrases });
  }, []);

  const updatePhrase = useCallback((id: string, updates: Partial<Phrase>) => {
    dispatch({ type: 'UPDATE_PHRASE', payload: { id, updates } });
  }, []);

  const setVoiceModel = useCallback((model: VoiceModel) => {
    dispatch({ type: 'SET_VOICE_MODEL', payload: model });
  }, []);

  const setPlayback = useCallback((playback: Partial<PlaybackState>) => {
    dispatch({ type: 'SET_PLAYBACK', payload: playback });
  }, []);

  const setMixer = useCallback((mixer: Partial<MixerState>) => {
    dispatch({ type: 'SET_MIXER', payload: mixer });
  }, []);

  const setRuntimeMode = useCallback((runtimeMode: RuntimeModeState) => {
    dispatch({ type: 'SET_RUNTIME_MODE', payload: runtimeMode });
  }, []);

  const setError = useCallback((error: string | null) => {
    dispatch({ type: 'SET_ERROR', payload: error });
  }, []);

  const reset = useCallback(() => {
    dispatch({ type: 'RESET' });
  }, []);

  return (
    <ProjectContext.Provider
      value={{
        state,
        createProject,
        loadProject,
        setAudioFile,
        setStems,
        setPhrases,
        updatePhrase,
        setVoiceModel,
        setPlayback,
        setMixer,
        setRuntimeMode,
        setError,
        reset,
      }}
    >
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject() {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error('useProject must be used within a ProjectProvider');
  }
  return context;
}
