import { useEffect, useRef, useState } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

export type MemoryPressureLevel = 'normal' | 'moderate' | 'critical';

export interface MemoryInfo {
  /** Estimated heap usage in bytes (0 if unavailable). */
  usedJSHeapSize: number;
  /** Maximum available JS heap in bytes (0 if unavailable). */
  jsHeapSizeLimit: number;
  /** Utilisation ratio in [0, 1] (0 if unavailable). */
  utilisation: number;
  /** Derived pressure level. */
  level: MemoryPressureLevel;
}

export interface UseMemoryPressureOptions {
  /** How often to poll memory usage (ms). Default: 5 000. */
  pollIntervalMs?: number;
  /**
   * Called whenever the pressure level transitions.
   * Use this to evict audio caches or reduce buffer sizes.
   */
  onPressureChange?: (level: MemoryPressureLevel, info: MemoryInfo) => void;
  /**
   * Called when level becomes 'critical'.
   * Suitable for immediate cache eviction.
   */
  onCritical?: (info: MemoryInfo) => void;
}

export interface UseMemoryPressureResult {
  memoryInfo: MemoryInfo;
  /** Whether the browser exposes `performance.memory` at all. */
  isSupported: boolean;
}

// ─── Thresholds ───────────────────────────────────────────────────────────────

const MODERATE_THRESHOLD = 0.70; // 70 % utilisation → moderate pressure
const CRITICAL_THRESHOLD = 0.90; // 90 % utilisation → critical pressure

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * React hook that monitors browser memory pressure and fires callbacks when
 * pressure levels change.
 *
 * Designed for the audio-video UI to automatically evict audio caches before
 * the browser tab runs out of heap.
 *
 * The browser `performance.memory` API is non-standard (Chrome/Edge only). On
 * unsupported browsers the hook reports level='normal' and isSupported=false so
 * callers can gracefully skip eviction logic.
 *
 * @example
 * ```tsx
 * const { memoryInfo } = useMemoryPressure({
 *   onCritical: () => audioCache.evictAll(),
 * });
 * if (memoryInfo.level === 'critical') return <LowMemoryBanner />;
 * ```
 */
export function useMemoryPressure(
  options: UseMemoryPressureOptions = {},
): UseMemoryPressureResult {
  const {
    pollIntervalMs = 5_000,
    onPressureChange,
    onCritical,
  } = options;

  const isSupported = typeof performance !== 'undefined' &&
    'memory' in performance;

  const [memoryInfo, setMemoryInfo] = useState<MemoryInfo>(() =>
    readMemoryInfo(),
  );

  // Keep stable refs so the interval closure never becomes stale
  const onPressureChangeRef = useRef(onPressureChange);
  const onCriticalRef       = useRef(onCritical);
  const prevLevelRef        = useRef<MemoryPressureLevel>(memoryInfo.level);

  useEffect(() => { onPressureChangeRef.current = onPressureChange; }, [onPressureChange]);
  useEffect(() => { onCriticalRef.current = onCritical; },           [onCritical]);

  useEffect(() => {
    if (!isSupported) return;

    const tick = () => {
      const info = readMemoryInfo();
      setMemoryInfo(info);

      if (info.level !== prevLevelRef.current) {
        prevLevelRef.current = info.level;
        onPressureChangeRef.current?.(info.level, info);
        if (info.level === 'critical') {
          onCriticalRef.current?.(info);
        }
      }
    };

    const id = setInterval(tick, pollIntervalMs);
    tick(); // immediate first read
    return () => clearInterval(id);
  }, [isSupported, pollIntervalMs]);

  return { memoryInfo, isSupported };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readMemoryInfo(): MemoryInfo {
  // `performance.memory` is available in Chromium browsers (non-standard).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mem = (performance as any)?.memory as {
    usedJSHeapSize: number;
    jsHeapSizeLimit: number;
  } | undefined;

  if (!mem || mem.jsHeapSizeLimit === 0) {
    return { usedJSHeapSize: 0, jsHeapSizeLimit: 0, utilisation: 0, level: 'normal' };
  }

  const utilisation = mem.usedJSHeapSize / mem.jsHeapSizeLimit;
  return {
    usedJSHeapSize: mem.usedJSHeapSize,
    jsHeapSizeLimit: mem.jsHeapSizeLimit,
    utilisation,
    level: utilisationToLevel(utilisation),
  };
}

function utilisationToLevel(utilisation: number): MemoryPressureLevel {
  if (utilisation >= CRITICAL_THRESHOLD)  return 'critical';
  if (utilisation >= MODERATE_THRESHOLD)  return 'moderate';
  return 'normal';
}
