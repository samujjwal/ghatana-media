package com.ghatana.audio.video.vision.tracking;

/**
 * A caller-supplied region of interest in SOURCE pixel coordinates. Validation is two-staged so the cheap structural
 * refusals happen before the source bytes are even opened, and the raster-dependent one happens before any model
 * call:
 * <ol>
 *   <li>{@link #of}: integer coordinates only, no negative origin, positive size, no arithmetic overflow
 *       (ROI_MALFORMED / ROI_NEGATIVE / ROI_ZERO_SIZE).</li>
 *   <li>{@link #requireWithin}: the whole region lies inside the decoded frame (ROI_OUT_OF_FRAME).</li>
 * </ol>
 *
 * @doc.type record
 * @doc.purpose Validated integer source-pixel region of interest
 * @doc.layer product
 * @doc.pattern Value Object
 */
public record RegionOfInterest(int x, int y, int width, int height) {

    /** Typed ROI refusal; {@link #code()} is stable and surfaced to callers. */
    public static final class RoiRefusedException extends IllegalArgumentException {
        private final String code;
        public RoiRefusedException(String code, String message) { super(message); this.code = code; }
        public String code() { return code; }
    }

    /** Structural validation of raw JSON numbers (so a fractional or non-numeric value is refused, never rounded). */
    public static RegionOfInterest of(Object x, Object y, Object width, Object height) {
        long[] v = {integer(x, "x"), integer(y, "y"), integer(width, "width"), integer(height, "height")};
        if (v[0] < 0 || v[1] < 0) throw new RoiRefusedException("ROI_NEGATIVE", "roi x and y must not be negative");
        if (v[2] < 1 || v[3] < 1) throw new RoiRefusedException("ROI_ZERO_SIZE", "roi width and height must be positive");
        if (v[0] + v[2] > Integer.MAX_VALUE || v[1] + v[3] > Integer.MAX_VALUE) {
            throw new RoiRefusedException("ROI_MALFORMED", "roi extent overflows");
        }
        return new RegionOfInterest((int) v[0], (int) v[1], (int) v[2], (int) v[3]);
    }

    private static long integer(Object value, String field) {
        if (value instanceof Integer || value instanceof Long || value instanceof Short || value instanceof Byte) {
            return ((Number) value).longValue();
        }
        throw new RoiRefusedException("ROI_MALFORMED", "roi." + field + " must be an integer");
    }

    /** Refuses a region that is not entirely inside the {@code frameWidth x frameHeight} raster. */
    public void requireWithin(int frameWidth, int frameHeight) {
        if ((long) x + width > frameWidth || (long) y + height > frameHeight) {
            throw new RoiRefusedException("ROI_OUT_OF_FRAME", "roi is not inside the " + frameWidth + "x"
                    + frameHeight + " frame");
        }
    }
}
