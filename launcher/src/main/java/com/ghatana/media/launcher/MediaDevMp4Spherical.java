package com.ghatana.media.launcher;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Writes Google's Spherical Video V2 metadata ({@code st3d} stereo mode and {@code sv3d} equirectangular projection) into
 * the first video sample entry of an MP4 file. FFmpeg can mux this side data but its command line cannot set it, so the
 * boxes are inserted into the container that FFmpeg wrote; nothing in the media samples changes.
 *
 * <p>Only what the caller declares is written: stereo mode (mono) and the pose (initial view) given by the declaration;
 * the equirectangular projection bounds are 0 (the full 360 x 180 degree sphere). Nothing is inferred. The sizes of every
 * ancestor box are updated and, when {@code moov} precedes sample data, every {@code stco}/{@code co64} chunk offset at or
 * beyond the insertion point is shifted, so the file stays a valid MP4 (fragmented files are refused).</p>
 */
final class MediaDevMp4Spherical {
    private MediaDevMp4Spherical() { }

    /** The declared initial view (pose) in degrees. */
    record Pose(double yawDegrees, double pitchDegrees, double rollDegrees) {
        Pose {
            if (!Double.isFinite(yawDegrees) || yawDegrees < -180.0 || yawDegrees >= 180.0
                    || !Double.isFinite(pitchDegrees) || pitchDegrees < -90.0 || pitchDegrees > 90.0
                    || !Double.isFinite(rollDegrees) || rollDegrees < -180.0 || rollDegrees >= 180.0) {
                throw new IllegalArgumentException("pose is outside yaw [-180,180), pitch [-90,90], roll [-180,180)");
            }
        }

        static Pose identity() { return new Pose(0, 0, 0); }

        /** 16.16 fixed point exactly as stored in {@code prhd}. */
        int yawFixed() { return fixed(yawDegrees); }
        int pitchFixed() { return fixed(pitchDegrees); }
        int rollFixed() { return fixed(rollDegrees); }

        private static int fixed(double degrees) { return (int) Math.round(degrees * 65536.0); }
    }

    /** The container cannot take the metadata (not an MP4, fragmented, no video sample entry, already has spatial boxes). */
    static final class Mp4SphericalException extends IllegalArgumentException {
        Mp4SphericalException(String message) { super(message); }
    }

    private record Box(int start, int header, long size, String type) {
        int end() { return (int) (start + size); }
        int payload() { return start + header; }
    }

    static final String METADATA_SOURCE = "ghatana-media-dev-spatial-export";

    static byte[] st3d() {
        ByteBuffer box = ByteBuffer.allocate(13).order(ByteOrder.BIG_ENDIAN);
        box.putInt(13).put("st3d".getBytes(StandardCharsets.US_ASCII)).putInt(0).put((byte) 0); // mono
        return box.array();
    }

    static byte[] sv3d(Pose pose) {
        byte[] source = (METADATA_SOURCE + "\0").getBytes(StandardCharsets.UTF_8);
        int svhdSize = 8 + 4 + source.length;
        int prhdSize = 8 + 4 + 12;
        int equiSize = 8 + 4 + 16;
        int projSize = 8 + prhdSize + equiSize;
        int sv3dSize = 8 + svhdSize + projSize;
        ByteBuffer box = ByteBuffer.allocate(sv3dSize).order(ByteOrder.BIG_ENDIAN);
        box.putInt(sv3dSize).put("sv3d".getBytes(StandardCharsets.US_ASCII));
        box.putInt(svhdSize).put("svhd".getBytes(StandardCharsets.US_ASCII)).putInt(0).put(source);
        box.putInt(projSize).put("proj".getBytes(StandardCharsets.US_ASCII));
        box.putInt(prhdSize).put("prhd".getBytes(StandardCharsets.US_ASCII)).putInt(0)
                .putInt(pose.yawFixed()).putInt(pose.pitchFixed()).putInt(pose.rollFixed());
        box.putInt(equiSize).put("equi".getBytes(StandardCharsets.US_ASCII)).putInt(0).putInt(0).putInt(0).putInt(0).putInt(0);
        return box.array();
    }

    /** The two boxes appended to the sample entry. */
    static byte[] spatialBoxes(Pose pose) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.writeBytes(st3d());
        out.writeBytes(sv3d(pose));
        return out.toByteArray();
    }

    static byte[] insert(byte[] file, Pose pose) {
        byte[] copy = file.clone();
        ByteBuffer buffer = ByteBuffer.wrap(copy).order(ByteOrder.BIG_ENDIAN);
        List<Box> top = children(buffer, 0, copy.length);
        Box moov = find(top, "moov");
        if (moov == null) throw new Mp4SphericalException("the file has no moov box");
        if (find(children(buffer, moov.payload(), moov.end()), "mvex") != null) {
            throw new Mp4SphericalException("fragmented MP4 is not supported");
        }
        List<Box> path = videoEntryPath(buffer, copy, moov);
        Box entry = path.get(path.size() - 1);
        if (entry.size() < 8 + 78) throw new Mp4SphericalException("the video sample entry is malformed");
        for (Box child : children(buffer, entry.payload() + 78, entry.end())) {
            if (child.type().equals("st3d") || child.type().equals("sv3d")) {
                throw new Mp4SphericalException("the video track already carries spatial metadata");
            }
        }
        byte[] boxes = spatialBoxes(pose);
        int insertionPoint = entry.end();
        int delta = boxes.length;
        // 1. chunk offsets that point at or beyond the insertion point shift by the inserted length
        for (Box trak : children(buffer, moov.payload(), moov.end())) {
            if (!trak.type().equals("trak")) continue;
            Box mdia = find(children(buffer, trak.payload(), trak.end()), "mdia");
            if (mdia == null) continue;
            Box minf = find(children(buffer, mdia.payload(), mdia.end()), "minf");
            if (minf == null) continue;
            Box stbl = find(children(buffer, minf.payload(), minf.end()), "stbl");
            if (stbl == null) continue;
            for (Box table : children(buffer, stbl.payload(), stbl.end())) {
                boolean wide = table.type().equals("co64");
                if (!wide && !table.type().equals("stco")) continue;
                int count = buffer.getInt(table.payload() + 4);
                int base = table.payload() + 8;
                for (int i = 0; i < count; i++) {
                    int at = base + i * (wide ? 8 : 4);
                    if (wide) {
                        long offset = buffer.getLong(at);
                        if (offset >= insertionPoint) buffer.putLong(at, offset + delta);
                    } else {
                        long offset = buffer.getInt(at) & 0xFFFFFFFFL;
                        if (offset >= insertionPoint) {
                            if (offset + delta > 0xFFFFFFFFL) throw new Mp4SphericalException("chunk offset overflow");
                            buffer.putInt(at, (int) (offset + delta));
                        }
                    }
                }
            }
        }
        // 2. every ancestor grows
        for (Box ancestor : path) {
            if (ancestor.header() != 8) throw new Mp4SphericalException("64-bit box sizes are not supported on the track path");
            long grown = ancestor.size() + delta;
            if (grown > Integer.MAX_VALUE) throw new Mp4SphericalException("box size overflow");
            buffer.putInt(ancestor.start(), (int) grown);
        }
        // 3. splice
        byte[] out = new byte[copy.length + delta];
        System.arraycopy(copy, 0, out, 0, insertionPoint);
        System.arraycopy(boxes, 0, out, insertionPoint, delta);
        System.arraycopy(copy, insertionPoint, out, insertionPoint + delta, copy.length - insertionPoint);
        return out;
    }

    private static List<Box> videoEntryPath(ByteBuffer buffer, byte[] copy, Box moov) {
        List<Box> path = null;
        for (Box trak : children(buffer, moov.payload(), moov.end())) {
            if (!trak.type().equals("trak")) continue;
            Box mdia = find(children(buffer, trak.payload(), trak.end()), "mdia");
            if (mdia == null) continue;
            List<Box> mdiaChildren = children(buffer, mdia.payload(), mdia.end());
            Box hdlr = find(mdiaChildren, "hdlr");
            Box minf = find(mdiaChildren, "minf");
            if (hdlr == null || minf == null || hdlr.size() < 20
                    || !new String(copy, hdlr.payload() + 8, 4, StandardCharsets.US_ASCII).equals("vide")) continue;
            Box stbl = find(children(buffer, minf.payload(), minf.end()), "stbl");
            if (stbl == null) continue;
            Box stsd = find(children(buffer, stbl.payload(), stbl.end()), "stsd");
            if (stsd == null) continue;
            // stsd: version/flags (4) + entry_count (4), then the entries
            List<Box> entries = children(buffer, stsd.payload() + 8, stsd.end());
            if (entries.isEmpty()) continue;
            path = List.of(moov, trak, mdia, minf, stbl, stsd, entries.get(0));
            break;
        }
        if (path == null) throw new Mp4SphericalException("the file has no video sample entry");
        return path;
    }

    /** What the file itself says about the first video sample entry (read from the boxes, not from a tool). */
    record ReadBack(boolean hasSt3d, int stereoMode, boolean hasSv3d, boolean equirectangular, int yawFixed,
                    int pitchFixed, int rollFixed, long boundsSum) {
        double yawDegrees() { return yawFixed / 65536.0; }
        double pitchDegrees() { return pitchFixed / 65536.0; }
        double rollDegrees() { return rollFixed / 65536.0; }
    }

    static ReadBack readBack(byte[] file) {
        ByteBuffer buffer = ByteBuffer.wrap(file).order(ByteOrder.BIG_ENDIAN);
        Box moov = find(children(buffer, 0, file.length), "moov");
        if (moov == null) throw new Mp4SphericalException("the file has no moov box");
        Box entry = videoEntryPath(buffer, file, moov).get(6);
        boolean st3d = false;
        int stereo = -1;
        boolean sv3d = false;
        boolean equi = false;
        int yaw = 0, pitch = 0, roll = 0;
        long bounds = 0;
        if (entry.size() >= 8 + 78) {
            for (Box child : children(buffer, entry.payload() + 78, entry.end())) {
                if (child.type().equals("st3d")) {
                    st3d = true;
                    stereo = file[child.payload() + 4] & 0xFF;
                } else if (child.type().equals("sv3d")) {
                    sv3d = true;
                    for (Box inner : children(buffer, child.payload(), child.end())) {
                        if (!inner.type().equals("proj")) continue;
                        for (Box projChild : children(buffer, inner.payload(), inner.end())) {
                            if (projChild.type().equals("prhd")) {
                                yaw = buffer.getInt(projChild.payload() + 4);
                                pitch = buffer.getInt(projChild.payload() + 8);
                                roll = buffer.getInt(projChild.payload() + 12);
                            } else if (projChild.type().equals("equi")) {
                                equi = true;
                                for (int i = 0; i < 4; i++) bounds += buffer.getInt(projChild.payload() + 4 + 4 * i) & 0xFFFFFFFFL;
                            }
                        }
                    }
                }
            }
        }
        return new ReadBack(st3d, stereo, sv3d, equi, yaw, pitch, roll, bounds);
    }

    private static Box find(List<Box> boxes, String type) {
        for (Box box : boxes) if (box.type().equals(type)) return box;
        return null;
    }

    private static List<Box> children(ByteBuffer buffer, int from, int to) {
        List<Box> boxes = new ArrayList<>();
        int at = from;
        while (at + 8 <= to) {
            long size = buffer.getInt(at) & 0xFFFFFFFFL;
            String type = new String(buffer.array(), at + 4, 4, StandardCharsets.ISO_8859_1);
            int header = 8;
            if (size == 1) {
                if (at + 16 > to) throw new Mp4SphericalException("truncated 64-bit box header");
                size = buffer.getLong(at + 8);
                header = 16;
            } else if (size == 0) {
                size = to - at;
            }
            if (size < header || at + size > to) throw new Mp4SphericalException("box '" + type + "' overruns its parent");
            boxes.add(new Box(at, header, size, type));
            at += (int) size;
        }
        return boxes;
    }
}
