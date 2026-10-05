package com.ghatana.media.vision.api;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.ghatana.media.common.ImageData;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Content-hash-keyed in-memory cache for Vision inference results.
 *
 * <p>Caches {@link VisionEngine.DetectionResult} and image captions by a
 * SHA-256 content-hash of the input image bytes + {@link VisionEngine.DetectionOptions} key.
 * This allows the same frame to skip re-inference when re-submitted (e.g. on replay or
 * identical thumbnails). The cache is bounded by an LRU eviction policy.
 *
 * <p>Call {@link #warmup(byte[][])} to pre-populate the cache with representative
 * frames before streaming begins, reducing cold-start latency on first frames.
 *
 * @doc.type class
 * @doc.purpose Content-addressed in-memory vision inference result cache (AV-P2-01)
 * @doc.layer product
 * @doc.pattern Cache
 */
public class VisionInferenceCache {

    private static final Logger LOG = LoggerFactory.getLogger(VisionInferenceCache.class);

    private static final int DEFAULT_MAX_SIZE = 512;

    private final int maxSize;
    private final Map<String, DetectionResult> detectionCache;
    private final Map<String, String> captionCache;
    private final AtomicLong hits = new AtomicLong();
    private final AtomicLong misses = new AtomicLong();
    private final VisionEngine delegate;

    public VisionInferenceCache(VisionEngine delegate) {
        this(delegate, DEFAULT_MAX_SIZE);
    }

    public VisionInferenceCache(VisionEngine delegate, int maxSize) {
        this.delegate = delegate;
        this.maxSize = maxSize;
        this.detectionCache = buildLruMap(maxSize);
        this.captionCache = buildLruMap(maxSize);
    }

    /**
     * Detect objects in the given image, returning a cached result if available.
     *
     * @param image   image data
     * @param options detection options
     * @return detection result (from cache or freshly inferred)
     */
    public DetectionResult detectWithCache(
            ImageData image,
            DetectionOptions options) {

        String key = contentKey(image.data(), options);
        DetectionResult cached = detectionCache.get(key);
        if (cached != null) {
            hits.incrementAndGet();
            LOG.debug("Vision cache HIT: key={}", key);
            return cached;
        }

        misses.incrementAndGet();
        LOG.debug("Vision cache MISS: key={}", key);
        DetectionResult result = delegate.detect(image, options);

        if (detectionCache.size() < maxSize) {
            detectionCache.put(key, result);
        }

        return result;
    }

    /**
     * Caption image with cache.
     *
     * @param image image data
     * @return caption string
     */
    public String captionWithCache(ImageData image) {
        String key = contentKey(image.data(), null);
        String cached = captionCache.get(key);
        if (cached != null) {
            hits.incrementAndGet();
            return cached;
        }

        misses.incrementAndGet();
        String caption = delegate.caption(image);
        if (captionCache.size() < maxSize) {
            captionCache.put(key, caption);
        }
        return caption;
    }

    /**
     * Pre-warm the cache by running inference on representative frames.
     *
     * @param frames representative image byte arrays
     */
    public void warmup(byte[][] frames) {
        LOG.info("Warming up vision inference cache with {} frames", frames.length);
        DetectionOptions defaultOptions = DetectionOptions.defaults();
        for (byte[] frameBytes : frames) {
            try {
                ImageData img = ImageData.builder()
                        .data(frameBytes)
                        .width(1).height(1)
                        .format(com.ghatana.media.common.ImageFormat.JPEG)
                        .colorSpace(com.ghatana.media.common.ColorSpace.RGB)
                        .build();
                detectWithCache(img, defaultOptions);
            } catch (Exception e) {
                LOG.warn("Warmup frame failed: {}", e.getMessage());
            }
        }
        LOG.info("Vision cache warmup complete: hits={} misses={}", hits.get(), misses.get());
    }

    /** Returns the fraction of requests served from cache (0.0–1.0). */
    public double getHitRate() {
        long h = hits.get();
        long m = misses.get();
        long total = h + m;
        return total == 0 ? 0.0 : (double) h / total;
    }

    /** Reset hit and miss counters. */
    public void resetStats() {
        hits.set(0);
        misses.set(0);
    }

    /** Evict all cached entries. */
    public void invalidateAll() {
        detectionCache.clear();
        captionCache.clear();
    }

    // ── helpers ────────────────────────────────────────────────────────────

    private static String contentKey(byte[] pixels, DetectionOptions options) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update(pixels);
            if (options != null) {
                // Use fields significant to inference output as the cache discriminator
                digest.update(Double.toString(options.confidenceThreshold()).getBytes());
                digest.update(Integer.toString(options.maxDetections()).getBytes());
                digest.update(Integer.toString(options.inputSize()).getBytes());
            }
            return HexFormat.of().formatHex(digest.digest());
        } catch (NoSuchAlgorithmException e) {
            // SHA-256 is always available in Java 21
            throw new IllegalStateException("SHA-256 not available", e);
        }
    }

    @SuppressWarnings("unchecked")
    private static <K, V> Map<K, V> buildLruMap(int maxSize) {
        return java.util.Collections.synchronizedMap(
                new java.util.LinkedHashMap<K, V>(maxSize, 0.75f, true) {
                    @Override
                    protected boolean removeEldestEntry(java.util.Map.Entry<K, V> eldest) {
                        return size() > maxSize;
                    }
                });
    }
}














