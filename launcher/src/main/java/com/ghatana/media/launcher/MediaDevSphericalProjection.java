package com.ghatana.media.launcher;

/**
 * Equirectangular sphere/pixel mapping of the DEV_ONLY 360 lane. Conventions (the ones FFmpeg's {@code v360} filter and
 * Spherical Video V2 use): yaw 0 is the horizontal centre of the frame and increases to the right (+180 and -180 meet at
 * the seam), pitch 0 is the vertical centre and increases upward (+90 is the top row). The frame spans 360 x 180 degrees.
 */
final class MediaDevSphericalProjection {
    private MediaDevSphericalProjection() { }

    /** A source pixel (continuous position and the integer pixel that contains it). */
    record Pixel(double xExact, double yExact, int x, int y) { }

    static Pixel toPixel(double yawDegrees, double pitchDegrees, int width, int height) {
        if (width <= 0 || height <= 0) throw new IllegalArgumentException("frame size must be positive");
        if (!Double.isFinite(yawDegrees) || yawDegrees < -180.0 || yawDegrees > 180.0) {
            throw new IllegalArgumentException("yaw must be within [-180, 180] degrees");
        }
        if (!Double.isFinite(pitchDegrees) || pitchDegrees < -90.0 || pitchDegrees > 90.0) {
            throw new IllegalArgumentException("pitch must be within [-90, 90] degrees");
        }
        double xExact = (yawDegrees / 360.0 + 0.5) * width;
        double yExact = (0.5 - pitchDegrees / 180.0) * height;
        int x = Math.min(width - 1, Math.max(0, (int) Math.floor(xExact)));
        int y = Math.min(height - 1, Math.max(0, (int) Math.floor(yExact)));
        return new Pixel(xExact, yExact, x, y);
    }

    /** Direction at the centre of pixel (x, y): {yaw, pitch} in degrees. */
    static double[] toDirection(int x, int y, int width, int height) {
        return new double[] {((x + 0.5) / width - 0.5) * 360.0, (0.5 - (y + 0.5) / height) * 180.0};
    }
}
