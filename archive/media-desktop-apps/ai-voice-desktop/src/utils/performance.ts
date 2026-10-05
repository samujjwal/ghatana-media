/**
 * Performance Utilities
 *
 * Reusable performance optimization utilities for AI Voice Desktop App.
 * Following "reuse first" principle - these can be used across all components.
 *
 * @doc.type utility
 * @doc.purpose Performance optimization
 * @doc.layer product
 * @doc.pattern PerformanceUtility
 */

import React, { useCallback, useMemo, useRef, useEffect } from 'react';
import { createLogger } from './logger';

const logger = createLogger('Performance');

// ============================================================================
// Debounce Utility (Reusable)
// ============================================================================

/**
 * Creates a debounced function that delays invoking func until after wait milliseconds
 * have elapsed since the last time the debounced function was invoked.
 *
 * Reusable across all input handlers, search, filters, etc.
 */
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number = 300
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  return function executedFunction(...args: Parameters<T>) {
    const later = () => {
      timeout = null;
      func(...args);
    };

    if (timeout) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(later, wait);
  };
}

/**
 * React hook for debounced values
 * Reusable in any component that needs debounced state
 */
export function useDebounce<T>(value: T, delay: number = 300): T {
  const [debouncedValue, setDebouncedValue] = React.useState<T>(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
}

// ============================================================================
// Throttle Utility (Reusable)
// ============================================================================

/**
 * Creates a throttled function that only invokes func at most once per every wait milliseconds.
 * Reusable for scroll handlers, resize handlers, etc.
 */
export function throttle<T extends (...args: any[]) => any>(
  func: T,
  wait: number = 100
): (...args: Parameters<T>) => void {
  let inThrottle: boolean = false;

  return function executedFunction(...args: Parameters<T>) {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => {
        inThrottle = false;
      }, wait);
    }
  };
}

// ============================================================================
// Cache Utilities (Reusable)
// ============================================================================

interface CacheOptions {
  ttl?: number; // Time to live in milliseconds
  storage?: 'session' | 'local' | 'memory';
}

/**
 * Simple cache utility with TTL support
 * Reusable for any data caching needs
 */
export class Cache<T> {
  private cache = new Map<string, { data: T; expires: number }>();
  private storage: Storage | null = null;

  constructor(private options: CacheOptions = {}) {
    if (options.storage === 'session') {
      this.storage = sessionStorage;
    } else if (options.storage === 'local') {
      this.storage = localStorage;
    }
  }

  set(key: string, data: T): void {
    const expires = this.options.ttl
      ? Date.now() + this.options.ttl
      : Infinity;

    if (this.storage) {
      this.storage.setItem(key, JSON.stringify({ data, expires }));
    } else {
      this.cache.set(key, { data, expires });
    }
  }

  get(key: string): T | null {
    let item: { data: T; expires: number } | null = null;

    if (this.storage) {
      const stored = this.storage.getItem(key);
      if (stored) {
        item = JSON.parse(stored);
      }
    } else {
      item = this.cache.get(key) || null;
    }

    if (!item) return null;

    if (item.expires < Date.now()) {
      this.delete(key);
      return null;
    }

    return item.data;
  }

  delete(key: string): void {
    if (this.storage) {
      this.storage.removeItem(key);
    } else {
      this.cache.delete(key);
    }
  }

  clear(): void {
    if (this.storage) {
      this.storage.clear();
    } else {
      this.cache.clear();
    }
  }
}

/**
 * React hook for cached data fetching
 * Reusable in any component that fetches data
 */
export function useCache<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: CacheOptions = {}
) {
  const [data, setData] = React.useState<T | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<Error | null>(null);
  const cacheRef = useRef(new Cache<T>(options));

  useEffect(() => {
    const cache = cacheRef.current;
    const cached = cache.get(key);

    if (cached) {
      setData(cached);
      setLoading(false);
      return;
    }

    setLoading(true);
    fetcher()
      .then(result => {
        cache.set(key, result);
        setData(result);
        setError(null);
      })
      .catch(err => {
        setError(err);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [key]);

  return { data, loading, error };
}

// ============================================================================
// Memoization Utilities (Reusable)
// ============================================================================

/**
 * Memoized callback hook wrapper with dependencies checking
 * Reusable replacement for useCallback with better type inference
 */
export function useMemoizedCallback<T extends (...args: any[]) => any>(
  callback: T,
  deps: React.DependencyList
): T {
  return useCallback(callback, deps);
}

/**
 * Memoized value hook wrapper
 * Reusable replacement for useMemo with better type inference
 */
export function useMemoizedValue<T>(
  factory: () => T,
  deps: React.DependencyList
): T {
  return useMemo(factory, deps);
}

// ============================================================================
// Lazy Image Component (Reusable)
// ============================================================================

interface LazyImageProps {
  src: string;
  alt: string;
  className?: string;
  placeholder?: string;
}

/**
 * Lazy loading image component with placeholder support
 * Reusable across all image displays
 */
export const LazyImage: React.FC<LazyImageProps> = React.memo(({
  src,
  alt,
  className,
  placeholder = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"%3E%3Crect fill="%23ddd" width="100" height="100"/%3E%3C/svg%3E'
}) => {
  const [imageSrc, setImageSrc] = React.useState(placeholder);
  const [isLoading, setIsLoading] = React.useState(true);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    let observer: IntersectionObserver | null = null;

    if (imgRef.current) {
      observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              setImageSrc(src);
              setIsLoading(false);
              observer?.disconnect();
            }
          });
        },
        { threshold: 0.01 }
      );

      observer.observe(imgRef.current);
    }

    return () => {
      observer?.disconnect();
    };
  }, [src]);

  return React.createElement('img', {
    ref: imgRef,
    src: imageSrc,
    alt,
    className,
    loading: 'lazy',
    decoding: 'async',
    style: { opacity: isLoading ? 0.5 : 1, transition: 'opacity 0.3s' },
  });
});

LazyImage.displayName = 'LazyImage';

// ============================================================================
// Performance Monitoring (Reusable)
// ============================================================================

/**
 * Performance marker for measuring operations
 * Reusable for timing any operation
 */
export class PerformanceMarker {
  private startTime: number = 0;

  constructor(private name: string) {}

  start(): void {
    this.startTime = performance.now();
    performance.mark(`${this.name}-start`);
  }

  end(): number {
    const endTime = performance.now();
    performance.mark(`${this.name}-end`);
    performance.measure(this.name, `${this.name}-start`, `${this.name}-end`);

    const duration = endTime - this.startTime;

    if (process.env.NODE_ENV === 'development') {
      logger.debug('Marker', { name: this.name, durationMs: Number(duration.toFixed(2)) });
    }

    return duration;
  }
}

/**
 * React hook for measuring component render time
 * Reusable in any component for performance monitoring
 */
export function useRenderTime(componentName: string) {
  const renderCount = useRef(0);

  useEffect(() => {
    renderCount.current += 1;

    if (process.env.NODE_ENV === 'development') {
      logger.debug('Render', { componentName, renderCount: renderCount.current });
    }
  });
}

// ============================================================================
// Virtual Scrolling Utilities (Reusable)
// ============================================================================

interface VirtualListProps<T> {
  items: T[];
  itemHeight: number;
  containerHeight: number;
  renderItem: (item: T, index: number) => React.ReactNode;
  overscan?: number;
}

/**
 * Virtual scrolling list component for large lists
 * Reusable for any list with many items
 */
export function VirtualList<T>({
  items,
  itemHeight,
  containerHeight,
  renderItem,
  overscan = 3,
}: VirtualListProps<T>) {
  const [scrollTop, setScrollTop] = React.useState(0);

  const totalHeight = items.length * itemHeight;
  const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const endIndex = Math.min(
    items.length,
    Math.ceil((scrollTop + containerHeight) / itemHeight) + overscan
  );

  const visibleItems = items.slice(startIndex, endIndex);

  const handleScroll = useMemoizedCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  return React.createElement(
    'div',
    {
      style: { height: containerHeight, overflow: 'auto' },
      onScroll: handleScroll,
    },
    React.createElement(
      'div',
      { style: { height: totalHeight, position: 'relative' } },
      ...visibleItems.map((item, idx) => {
        const actualIndex = startIndex + idx;
        return React.createElement(
          'div',
          {
            key: actualIndex,
            style: {
              position: 'absolute',
              top: actualIndex * itemHeight,
              height: itemHeight,
              width: '100%',
            },
          },
          renderItem(item, actualIndex)
        );
      })
    )
  );
}

// ============================================================================
// Export all utilities
// ============================================================================

export {
  useCallback,
  useMemo,
  memo,
} from 'react';

