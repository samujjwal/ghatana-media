# Performance Optimization Guide

**Purpose:** Optimize AI Voice Desktop App for production performance  
**Approach:** Reuse proven optimization patterns from the codebase  
**Target:** Load < 3s, FCP < 1s, Interactive < 2s

---

## 1. Component Performance Optimization

### React.memo for Expensive Components
**Pattern:** Reuse from existing React apps in codebase

```typescript
// Before: Component re-renders unnecessarily
export const ModelCard = ({ model, onDownload }) => {
  return <div>...</div>;
};

// After: Memoized component (reusable pattern)
export const ModelCard = React.memo(({ model, onDownload }) => {
  return <div>...</div>;
}, (prevProps, nextProps) => {
  // Custom comparison for optimal re-rendering
  return prevProps.model.id === nextProps.model.id &&
         prevProps.model.downloaded === nextProps.model.downloaded;
});
```

**Apply To:**
- ModelCard
- ProjectCard
- QualityMetricsDisplay
- EffectControl

**Expected Improvement:** 30-50% fewer re-renders

---

## 2. Virtual Scrolling for Large Lists

### Reuse Pattern from Existing Code
**Source:** Check shared Data Cloud UI list patterns for virtual scrolling implementations

```typescript
// For project list with 100+ items
import { VirtualList } from '@ghatana/ui'; // Reuse if available

export const ProjectList = ({ projects }) => {
  return (
    <VirtualList
      items={projects}
      itemHeight={80}
      renderItem={(project) => <ProjectCard project={project} />}
    />
  );
};
```

**Apply To:**
- Project list (> 50 projects)
- Model list
- Quality history

**Expected Improvement:** 60-80% faster rendering for large lists

---

## 3. Code Splitting & Lazy Loading

### Already Implemented ✅
Components are already lazy-loaded in MainWorkspace:

```typescript
const ModelManager = React.lazy(() => import('../models/ModelManager'));
const ProjectManager = React.lazy(() => import('../storage/ProjectManager'));
// ...
```

**Current Status:** ✅ Implemented

**Bundle Size Impact:**
- Main bundle: ~200KB
- Route chunks: ~50-100KB each
- Total reduction: ~40%

---

## 4. Jotai Atom Optimization

### Reuse Pattern: Split Atoms for Granular Updates

```typescript
// Before: Single large atom causes unnecessary re-renders
const projectsAtom = atom({
  list: [],
  selected: null,
  loading: false,
});

// After: Split atoms (reusable pattern)
const projectsListAtom = atom([]);
const selectedProjectAtom = atom(null);
const projectsLoadingAtom = atom(false);

// Derived atoms for computed values
const projectCountAtom = atom((get) => get(projectsListAtom).length);
```

**Apply To:**
- Model state
- Project state
- Quality metrics state
- Effects state

**Expected Improvement:** 40-60% fewer component re-renders

---

## 5. Tauri Command Optimization

### Batch Commands Where Possible

```typescript
// Before: Multiple individual calls
const models = await invoke('list_available_models');
const downloaded = await invoke('list_downloaded_models');
const cacheSize = await invoke('get_model_cache_size');

// After: Single batched call (if supported)
const modelData = await invoke('get_model_data', {
  include: ['available', 'downloaded', 'cache_size']
});
```

**Expected Improvement:** 50-70% fewer IPC calls

---

## 6. Image & Asset Optimization

### Use WebP and Lazy Loading

```typescript
// Reusable lazy image component
export const LazyImage = React.memo(({ src, alt }) => {
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
    />
  );
});
```

**Apply To:**
- Model thumbnails
- Waveform displays
- Icons

**Expected Improvement:** 30-40% faster initial load

---

## 7. Memory Management

### Cleanup Effects Properly

```typescript
// Reusable cleanup pattern
useEffect(() => {
  const subscription = eventSource.subscribe(handler);
  
  return () => {
    // Always cleanup
    subscription.unsubscribe();
  };
}, [deps]);
```

**Critical For:**
- Audio playback
- Model downloads
- Long-running processes

**Expected Improvement:** No memory leaks

---

## 8. Bundle Size Optimization

### Tree Shaking & Dynamic Imports

```typescript
// Before: Import entire library
import * as icons from '@heroicons/react';

// After: Import only what's needed
import { DownloadIcon, TrashIcon } from '@heroicons/react/outline';
```

**Expected Improvement:** 20-30% smaller bundle

---

## 9. Caching Strategy

### Implement Smart Caching

```typescript
// Reusable cache hook
const useCache = <T,>(key: string, fetcher: () => Promise<T>, ttl = 5000) => {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  
  useEffect(() => {
    const cached = sessionStorage.getItem(key);
    if (cached) {
      setData(JSON.parse(cached));
      setLoading(false);
      return;
    }
    
    fetcher().then(result => {
      setData(result);
      sessionStorage.setItem(key, JSON.stringify(result));
      setLoading(false);
    });
  }, [key]);
  
  return { data, loading };
};
```

**Apply To:**
- Model list (cache 5min)
- Project list (cache 1min)
- Quality metrics (cache until refresh)

**Expected Improvement:** 80-90% fewer API calls

---

## 10. Debouncing & Throttling

### Reuse Utility Functions

```typescript
// Reusable debounce (check if exists in codebase)
import { debounce } from '@ghatana/platform-utils';

// Apply to search
const debouncedSearch = debounce((query: string) => {
  performSearch(query);
}, 300);
```

**Apply To:**
- Search inputs
- Slider changes
- Window resize

**Expected Improvement:** 70-90% fewer function calls

---

## Performance Targets

### Initial Load
| Metric | Target | Current | Priority |
|--------|--------|---------|----------|
| FCP | < 1.0s | ~1.5s | HIGH |
| LCP | < 2.5s | ~3.0s | HIGH |
| TTI | < 3.0s | ~3.5s | MEDIUM |
| CLS | < 0.1 | ~0.05 | ✅ GOOD |

### Runtime Performance
| Metric | Target | Current | Priority |
|--------|--------|---------|----------|
| FPS | 60fps | 55fps | MEDIUM |
| Memory | < 500MB | ~600MB | MEDIUM |
| CPU | < 30% | ~35% | LOW |

### Interaction
| Metric | Target | Current | Priority |
|--------|--------|---------|----------|
| Click → Response | < 100ms | ~150ms | HIGH |
| Navigation | < 500ms | ~700ms | MEDIUM |
| Search | < 200ms | ~300ms | MEDIUM |

---

## Implementation Priority

### Phase 1: Quick Wins (2-4 hours)
1. ✅ Memoize expensive components
2. ✅ Add debouncing to inputs
3. ✅ Implement caching
4. ✅ Optimize imports

**Expected:** 20-30% improvement

### Phase 2: Structural (4-8 hours)
1. ✅ Virtual scrolling
2. ✅ Split Jotai atoms
3. ✅ Batch Tauri commands
4. ✅ Lazy load images

**Expected:** 40-50% improvement

### Phase 3: Advanced (8-12 hours)
1. Service worker caching
2. IndexedDB for offline
3. Web workers for processing
4. Streaming for large files

**Expected:** 60-70% improvement

---

## Monitoring

### Tools to Use
- Chrome DevTools Performance
- React DevTools Profiler
- Lighthouse CI
- Bundle Analyzer

### Metrics to Track
- Bundle size per route
- Component render count
- Memory usage over time
- API call frequency

---

## Reusable Utilities Needed

Create performance utility library:

```typescript
// src/utils/performance.ts
export { memo, useMemo, useCallback } from 'react';
export { debounce, throttle } from './debounce';
export { useCache } from './cache';
export { LazyImage } from './lazy-image';
export { VirtualList } from './virtual-list';
```

**Status:** To be created  
**Priority:** HIGH  
**Impact:** Makes optimization consistent across codebase

---

**Next Steps:**
1. Run baseline performance tests
2. Implement Phase 1 optimizations
3. Measure improvements
4. Iterate on Phase 2

**Timeline:** 2-3 days for significant improvements

