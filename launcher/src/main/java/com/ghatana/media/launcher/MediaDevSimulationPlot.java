package com.ghatana.media.launcher;

import com.ghatana.media.production.simulation.scenario.Scenario;
import com.ghatana.media.production.simulation.scenario.ScenarioSolver.Sample;

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageTypeSpecifier;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.metadata.IIOMetadata;
import javax.imageio.metadata.IIOMetadataNode;
import javax.imageio.stream.MemoryCacheImageOutputStream;
import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Renders the solved trace to a PNG without any text (host fonts would make the bytes machine-dependent). Two panels share
 * one 800x400 image: the trajectory (projectile: y over x; one-dimensional models: x over t) and the total energy over t.
 * The exact pixel rectangle and data range of each panel are returned so an independent reader can map any analytic
 * point to a pixel and check the drawn curve: {@code px = x0 + (v - min) / (max - min) * (x1 - x0)}, and for y
 * {@code py = y1 - (v - min) / (max - min) * (y1 - y0)}.
 */
final class MediaDevSimulationPlot {
    static final int WIDTH = 800;
    static final int HEIGHT = 400;
    static final int[] LEFT = {40, 20, 380, 380};
    static final int[] RIGHT = {440, 20, 780, 380};
    static final int TRAJECTORY_RGB = 0xC80000;
    static final int ENERGY_RGB = 0x007800;
    static final int MARKER_RGB = 0x0000C8;
    static final int BACKGROUND_RGB = 0xFFFFFF;

    static {
        System.setProperty("java.awt.headless", "true");
    }

    /** Data range and pixel rectangle of one panel. */
    record Panel(String id, int[] rect, double xMin, double xMax, double yMin, double yMax, String xAxis, String yAxis) {
        double px(double x) { return rect[0] + (x - xMin) / (xMax - xMin) * (rect[2] - rect[0]); }
        double py(double y) { return rect[3] - (y - yMin) / (yMax - yMin) * (rect[3] - rect[1]); }

        Map<String, Object> view() {
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("id", id);
            view.put("pixelRect", Map.of("x0", rect[0], "y0", rect[1], "x1", rect[2], "y1", rect[3]));
            view.put("xAxis", xAxis);
            view.put("yAxis", yAxis);
            view.put("xMin", xMin);
            view.put("xMax", xMax);
            view.put("yMin", yMin);
            view.put("yMax", yMax);
            return view;
        }
    }

    private final Panel trajectory;
    private final Panel energy;
    private final List<Sample> samples;
    private final boolean planar;

    MediaDevSimulationPlot(Scenario scenario, List<Sample> samples) {
        this.samples = samples;
        this.planar = scenario.model() instanceof Scenario.Projectile;
        double xMin = Double.POSITIVE_INFINITY, xMax = Double.NEGATIVE_INFINITY, yMin = xMin, yMax = xMax;
        double eMin = xMin, eMax = xMax, tMax = 0;
        for (Sample s : samples) {
            double a = planar ? s.x() : s.t();
            double b = planar ? s.y() : s.x();
            xMin = Math.min(xMin, a); xMax = Math.max(xMax, a);
            yMin = Math.min(yMin, b); yMax = Math.max(yMax, b);
            eMin = Math.min(eMin, s.energy()); eMax = Math.max(eMax, s.energy());
            tMax = Math.max(tMax, s.t());
        }
        this.trajectory = new Panel("trajectory", LEFT, pad(xMin, xMax, 0)[0], pad(xMin, xMax, 0)[1], pad(yMin, yMax, 0)[0],
                pad(yMin, yMax, 0)[1], planar ? "positionXMeters" : "timeSeconds", planar ? "positionYMeters" : "positionXMeters");
        this.energy = new Panel("energy", RIGHT, 0.0, tMax > 0 ? tMax : 1.0, pad(eMin, eMax, 1)[0], pad(eMin, eMax, 1)[1],
                "timeSeconds", "totalEnergyJoules");
    }

    private static double[] pad(double min, double max, int minimumRelative) {
        double span = max - min;
        double scale = Math.max(Math.abs(min), Math.abs(max));
        if (!(span > scale * 1e-9) || span == 0) {
            double half = scale > 0 ? scale * 0.1 : 1.0;
            return new double[] {min - half, max + half};
        }
        return new double[] {min - 0.05 * span, max + 0.05 * span};
    }

    List<Map<String, Object>> panels() { return List.of(trajectory.view(), energy.view()); }

    BufferedImage render(double untilTime, boolean marker) {
        BufferedImage image = new BufferedImage(WIDTH, HEIGHT, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = image.createGraphics();
        try {
            g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_OFF);
            g.setColor(new Color(BACKGROUND_RGB));
            g.fillRect(0, 0, WIDTH, HEIGHT);
            for (Panel panel : List.of(trajectory, energy)) {
                g.setColor(new Color(0xD0D0D0));
                g.setStroke(new BasicStroke(1f));
                for (int i = 0; i <= 4; i++) {
                    int gx = panel.rect[0] + (panel.rect[2] - panel.rect[0]) * i / 4;
                    int gy = panel.rect[1] + (panel.rect[3] - panel.rect[1]) * i / 4;
                    g.drawLine(gx, panel.rect[1], gx, panel.rect[3]);
                    g.drawLine(panel.rect[0], gy, panel.rect[2], gy);
                }
                g.setColor(new Color(0x404040));
                g.drawRect(panel.rect[0], panel.rect[1], panel.rect[2] - panel.rect[0], panel.rect[3] - panel.rect[1]);
            }
            g.setStroke(new BasicStroke(2f));
            curve(g, trajectory, TRAJECTORY_RGB, untilTime, false);
            curve(g, energy, ENERGY_RGB, untilTime, true);
            if (marker) {
                double[] at = interpolate(untilTime);
                g.setColor(new Color(MARKER_RGB));
                int mx = (int) Math.round(trajectory.px(planar ? at[1] : at[0]));
                int my = (int) Math.round(trajectory.py(planar ? at[2] : at[1]));
                g.fillOval(mx - 5, my - 5, 10, 10);
                int ex = (int) Math.round(energy.px(at[0]));
                int ey = (int) Math.round(energy.py(at[3]));
                g.fillOval(ex - 5, ey - 5, 10, 10);
            }
        } finally {
            g.dispose();
        }
        return image;
    }

    private void curve(Graphics2D g, Panel panel, int rgb, double until, boolean isEnergy) {
        g.setColor(new Color(rgb));
        double[] prev = null;
        for (Sample s : samples) {
            if (s.t() > until) {
                double[] cut = interpolate(until);
                double[] point = isEnergy ? new double[] {cut[0], cut[3]} : planar ? new double[] {cut[1], cut[2]} : new double[] {cut[0], cut[1]};
                if (prev != null) segment(g, panel, prev, point);
                return;
            }
            double[] point = isEnergy ? new double[] {s.t(), s.energy()} : planar ? new double[] {s.x(), s.y()} : new double[] {s.t(), s.x()};
            if (prev != null) segment(g, panel, prev, point);
            prev = point;
        }
    }

    private static void segment(Graphics2D g, Panel panel, double[] a, double[] b) {
        g.drawLine((int) Math.round(panel.px(a[0])), (int) Math.round(panel.py(a[1])),
                (int) Math.round(panel.px(b[0])), (int) Math.round(panel.py(b[1])));
    }

    /** Linear interpolation of {t, x, y, energy} between the two samples that bracket {@code t}. */
    private double[] interpolate(double t) {
        Sample before = samples.get(0);
        for (Sample s : samples) {
            if (s.t() >= t) {
                if (s.t() == before.t()) return new double[] {s.t(), s.x(), s.y(), s.energy()};
                double f = (t - before.t()) / (s.t() - before.t());
                return new double[] {t, before.x() + f * (s.x() - before.x()), before.y() + f * (s.y() - before.y()),
                        before.energy() + f * (s.energy() - before.energy())};
            }
            before = s;
        }
        return new double[] {before.t(), before.x(), before.y(), before.energy()};
    }

    /** PNG bytes with a tEXt comment (the request id), so two requests never share bytes. */
    static byte[] png(BufferedImage image, String comment) {
        try {
            ImageWriter writer = ImageIO.getImageWritersByFormatName("png").next();
            try {
                ImageWriteParam param = writer.getDefaultWriteParam();
                IIOMetadata metadata = writer.getDefaultImageMetadata(ImageTypeSpecifier.createFromRenderedImage(image), param);
                IIOMetadataNode text = new IIOMetadataNode("tEXt");
                IIOMetadataNode entry = new IIOMetadataNode("tEXtEntry");
                entry.setAttribute("keyword", "Comment");
                entry.setAttribute("value", comment);
                text.appendChild(entry);
                IIOMetadataNode root = new IIOMetadataNode("javax_imageio_png_1.0");
                root.appendChild(text);
                metadata.mergeTree("javax_imageio_png_1.0", root);
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                try (MemoryCacheImageOutputStream stream = new MemoryCacheImageOutputStream(out)) {
                    writer.setOutput(stream);
                    writer.write(null, new IIOImage(image, null, metadata), param);
                }
                return out.toByteArray();
            } finally {
                writer.dispose();
            }
        } catch (IOException failure) {
            throw new IllegalStateException("the plot could not be encoded", failure);
        }
    }
}
