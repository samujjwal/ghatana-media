/**
 * Stem mixer hook backed by Web Audio when available.
 *
 * State remains serializable, while registered media elements are connected to
 * gain and stereo-panner nodes. Consumers may render controls independently and
 * register/unregister their audio elements as tracks mount.
 *
 * @doc.type hook
 * @doc.purpose Stem mixer state and audio graph
 * @doc.layer product
 * @doc.pattern AudioGraphHook
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  MixerState,
  StemMixSettings,
  StemSet,
  StemType,
} from "../types";

export interface UseStemMixerOptions {
  readonly stems?: StemSet;
  readonly masterVolume?: number;
}

interface StemAudioNodes {
  readonly element: HTMLMediaElement;
  readonly source: MediaElementAudioSourceNode;
  readonly gain: GainNode;
  readonly panner?: StereoPannerNode;
}

export interface UseStemMixerResult {
  readonly state: MixerState;
  readonly setVolume: (stemType: StemType, volume: number) => void;
  readonly setPan: (stemType: StemType, pan: number) => void;
  readonly toggleMute: (stemType: StemType) => void;
  readonly toggleSolo: (stemType: StemType) => void;
  readonly setMasterVolume: (volume: number) => void;
  readonly reset: () => void;
  readonly getEffectiveVolumes: () => Record<StemType, number>;
  /** Register a media element and receive an unregister callback. */
  readonly registerStemElement: (
    stemType: StemType,
    element: HTMLMediaElement,
  ) => () => void;
  /** Resume a suspended browser AudioContext after user interaction. */
  readonly resumeAudioContext: () => Promise<void>;
  readonly audioGraphAvailable: boolean;
}

const STEM_TYPES: readonly StemType[] = [
  "vocals",
  "drums",
  "bass",
  "other",
];

const defaultStemSettings: StemMixSettings = {
  volume: 1,
  pan: 0,
  muted: false,
  solo: false,
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function settingsFromStems(stems?: StemSet): Record<StemType, StemMixSettings> {
  return {
    vocals: stems
      ? {
          volume: clamp(stems.vocals.volume, 0, 2),
          pan: clamp(stems.vocals.pan, -1, 1),
          muted: stems.vocals.muted,
          solo: stems.vocals.solo,
        }
      : { ...defaultStemSettings },
    drums: stems
      ? {
          volume: clamp(stems.drums.volume, 0, 2),
          pan: clamp(stems.drums.pan, -1, 1),
          muted: stems.drums.muted,
          solo: stems.drums.solo,
        }
      : { ...defaultStemSettings },
    bass: stems
      ? {
          volume: clamp(stems.bass.volume, 0, 2),
          pan: clamp(stems.bass.pan, -1, 1),
          muted: stems.bass.muted,
          solo: stems.bass.solo,
        }
      : { ...defaultStemSettings },
    other: stems
      ? {
          volume: clamp(stems.other.volume, 0, 2),
          pan: clamp(stems.other.pan, -1, 1),
          muted: stems.other.muted,
          solo: stems.other.solo,
        }
      : { ...defaultStemSettings },
  };
}

function createInitialState(
  stems: StemSet | undefined,
  masterVolume: number,
): MixerState {
  return {
    masterVolume: clamp(masterVolume, 0, 2),
    stems: settingsFromStems(stems),
    effects: [],
  };
}

export function useStemMixer(
  options: UseStemMixerOptions = {},
): UseStemMixerResult {
  const { stems, masterVolume = 1 } = options;
  const [state, setState] = useState<MixerState>(() =>
    createInitialState(stems, masterVolume),
  );
  const audioContextRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const nodesRef = useRef(new Map<StemType, StemAudioNodes>());
  const registeredElementsRef = useRef(new WeakSet<HTMLMediaElement>());
  const [audioGraphAvailable] = useState(
    () => typeof window !== "undefined" && "AudioContext" in window,
  );

  const ensureAudioGraph = useCallback((): {
    readonly context: AudioContext;
    readonly masterGain: GainNode;
  } | null => {
    if (!audioGraphAvailable) return null;
    if (!audioContextRef.current) {
      const context = new AudioContext();
      const masterGainNode = context.createGain();
      masterGainNode.connect(context.destination);
      audioContextRef.current = context;
      masterGainRef.current = masterGainNode;
    }
    const context = audioContextRef.current;
    const masterGainNode = masterGainRef.current;
    return context && masterGainNode
      ? { context, masterGain: masterGainNode }
      : null;
  }, [audioGraphAvailable]);

  const effectiveVolumes = useMemo((): Record<StemType, number> => {
    const hasSolo = STEM_TYPES.some((type) => state.stems[type]?.solo);
    return Object.fromEntries(
      STEM_TYPES.map((type) => {
        const settings = state.stems[type] ?? defaultStemSettings;
        const audible = !settings.muted && (!hasSolo || settings.solo);
        return [
          type,
          audible
            ? clamp(settings.volume, 0, 2) * clamp(state.masterVolume, 0, 2)
            : 0,
        ];
      }),
    ) as Record<StemType, number>;
  }, [state]);

  useEffect(() => {
    const masterGain = masterGainRef.current;
    if (masterGain) {
      masterGain.gain.setTargetAtTime(
        clamp(state.masterVolume, 0, 2),
        masterGain.context.currentTime,
        0.01,
      );
    }

    for (const type of STEM_TYPES) {
      const nodes = nodesRef.current.get(type);
      const settings = state.stems[type] ?? defaultStemSettings;
      if (!nodes) continue;
      const hasSolo = STEM_TYPES.some((candidate) => state.stems[candidate]?.solo);
      const audible = !settings.muted && (!hasSolo || settings.solo);
      nodes.gain.gain.setTargetAtTime(
        audible ? clamp(settings.volume, 0, 2) : 0,
        nodes.gain.context.currentTime,
        0.01,
      );
      nodes.element.muted = false;
      nodes.element.volume = 1;
      if (nodes.panner) {
        nodes.panner.pan.setTargetAtTime(
          clamp(settings.pan, -1, 1),
          nodes.panner.context.currentTime,
          0.01,
        );
      }
    }
  }, [state]);

  useEffect(() => {
    if (!stems) return;
    setState((current) => ({
      ...current,
      stems: settingsFromStems(stems),
    }));
  }, [stems]);

  const setVolume = useCallback((stemType: StemType, volume: number): void => {
    setState((previous) => ({
      ...previous,
      stems: {
        ...previous.stems,
        [stemType]: {
          ...(previous.stems[stemType] ?? defaultStemSettings),
          volume: clamp(volume, 0, 2),
        },
      },
    }));
  }, []);

  const setPan = useCallback((stemType: StemType, pan: number): void => {
    setState((previous) => ({
      ...previous,
      stems: {
        ...previous.stems,
        [stemType]: {
          ...(previous.stems[stemType] ?? defaultStemSettings),
          pan: clamp(pan, -1, 1),
        },
      },
    }));
  }, []);

  const toggleMute = useCallback((stemType: StemType): void => {
    setState((previous) => {
      const current = previous.stems[stemType] ?? defaultStemSettings;
      return {
        ...previous,
        stems: {
          ...previous.stems,
          [stemType]: { ...current, muted: !current.muted },
        },
      };
    });
  }, []);

  const toggleSolo = useCallback((stemType: StemType): void => {
    setState((previous) => {
      const current = previous.stems[stemType] ?? defaultStemSettings;
      return {
        ...previous,
        stems: {
          ...previous.stems,
          [stemType]: { ...current, solo: !current.solo },
        },
      };
    });
  }, []);

  const setMasterVolume = useCallback((volume: number): void => {
    setState((previous) => ({
      ...previous,
      masterVolume: clamp(volume, 0, 2),
    }));
  }, []);

  const reset = useCallback((): void => {
    setState(createInitialState(stems, masterVolume));
  }, [masterVolume, stems]);

  const getEffectiveVolumes = useCallback(
    (): Record<StemType, number> => ({ ...effectiveVolumes }),
    [effectiveVolumes],
  );

  const registerStemElement = useCallback(
    (stemType: StemType, element: HTMLMediaElement): (() => void) => {
      const graph = ensureAudioGraph();
      if (!graph) {
        return () => undefined;
      }
      if (registeredElementsRef.current.has(element)) {
        throw new Error("This media element is already connected to an audio graph.");
      }

      const source = graph.context.createMediaElementSource(element);
      const gain = graph.context.createGain();
      const panner =
        typeof graph.context.createStereoPanner === "function"
          ? graph.context.createStereoPanner()
          : undefined;
      source.connect(gain);
      if (panner) {
        gain.connect(panner);
        panner.connect(graph.masterGain);
      } else {
        gain.connect(graph.masterGain);
      }
      const nodes: StemAudioNodes = {
        element,
        source,
        gain,
        ...(panner ? { panner } : {}),
      };
      nodesRef.current.set(stemType, nodes);
      registeredElementsRef.current.add(element);

      const settings = state.stems[stemType] ?? defaultStemSettings;
      gain.gain.value = settings.muted ? 0 : clamp(settings.volume, 0, 2);
      if (panner) panner.pan.value = clamp(settings.pan, -1, 1);

      return () => {
        const current = nodesRef.current.get(stemType);
        if (current !== nodes) return;
        current.source.disconnect();
        current.gain.disconnect();
        current.panner?.disconnect();
        nodesRef.current.delete(stemType);
      };
    },
    [ensureAudioGraph, state.stems],
  );

  const resumeAudioContext = useCallback(async (): Promise<void> => {
    const graph = ensureAudioGraph();
    if (graph?.context.state === "suspended") {
      await graph.context.resume();
    }
  }, [ensureAudioGraph]);

  useEffect(() => {
    return () => {
      for (const nodes of nodesRef.current.values()) {
        nodes.source.disconnect();
        nodes.gain.disconnect();
        nodes.panner?.disconnect();
      }
      nodesRef.current.clear();
      masterGainRef.current?.disconnect();
      void audioContextRef.current?.close();
      masterGainRef.current = null;
      audioContextRef.current = null;
    };
  }, []);

  return {
    state,
    setVolume,
    setPan,
    toggleMute,
    toggleSolo,
    setMasterVolume,
    reset,
    getEffectiveVolumes,
    registerStemElement,
    resumeAudioContext,
    audioGraphAvailable,
  };
}
