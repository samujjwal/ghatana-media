package com.ghatana.audio.video.vision.image;

/** Converts sRGB ARGB pixels to OpenCV BGR, compositing alpha over neutral gray (114). */
public final class SrgbToBgr {
    private static final double BACKGROUND = 114.0;

    private SrgbToBgr() { }

    public static double[] convert(int argb) {
        double alpha = ((argb >>> 24) & 0xFF) / 255.0;
        int red = (argb >>> 16) & 0xFF;
        int green = (argb >>> 8) & 0xFF;
        int blue = argb & 0xFF;
        return new double[] {
                blend(blue, alpha), blend(green, alpha), blend(red, alpha)
        };
    }

    private static double blend(int value, double alpha) {
        return value * alpha + BACKGROUND * (1.0 - alpha);
    }
}
