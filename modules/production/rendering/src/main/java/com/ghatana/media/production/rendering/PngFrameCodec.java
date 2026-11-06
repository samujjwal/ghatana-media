package com.ghatana.media.production.rendering;

import static com.ghatana.media.production.rendering.TemporalVideoRestoration.*;

import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Objects;
import java.util.zip.CRC32;
import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.MemoryCacheImageInputStream;

/** Strict bounded PNG still-frame codec for RGB8 sequences. It does not establish source-artifact provenance. */
public final class PngFrameCodec {
    public static final int DEFAULT_MAX_ENCODED_BYTES = 16 * 1024 * 1024;
    public static final int DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
    public static final long DEFAULT_MAX_PIXELS = 4_194_304L;

    private static final byte[] PNG_SIGNATURE = {
            (byte) 137, 80, 78, 71, 13, 10, 26, 10
    };

    private PngFrameCodec() { }

    /** Decodes a bounded still-frame sequence without claiming which artifact produced those bytes. */
    public static DecodedPngFrameSequence decodeSequence(TimeBase timeBase, List<PngFrame> frames) {
        return decodeSequence(timeBase, frames, Limits.defaults());
    }

    /**
     * Decodes only after the complete encoded and pixel budgets are checked. A trusted host source adapter must
     * independently establish artifact/version provenance before wrapping these frames in DecodedFrameSequence.
     */
    public static DecodedPngFrameSequence decodeSequence(TimeBase timeBase, List<PngFrame> frames, Limits limits) {
        Objects.requireNonNull(timeBase, "timeBase");
        Objects.requireNonNull(limits, "limits");
        Objects.requireNonNull(frames, "frames");
        List<PngFrame> copiedFrames = copyBoundedFrames(frames);
        FrameMetadata first = copiedFrames.getFirst().metadata();
        long totalPixels = 0, totalEncodedBytes = 0;
        long previousPts = -1;
        for (int index = 0; index < copiedFrames.size(); index++) {
            PngFrame frame = copiedFrames.get(index);
            FrameMetadata metadata = frame.metadata();
            checkDimensions(metadata.width(), metadata.height(), limits);
            if (metadata.frameIndex() != index || metadata.presentationTicks() <= previousPts) {
                throw invalid("frame metadata indexes must be contiguous and PTS values strictly increasing");
            }
            if (metadata.width() != first.width() || metadata.height() != first.height()
                    || !metadata.roi().equals(first.roi())) {
                throw invalid("frame metadata dimensions and ROI must remain identical within a sequence");
            }
            if (frame.png.length == 0 || frame.png.length > limits.maxEncodedBytes()) {
                throw invalid("PNG input is empty or exceeds its encoded byte bound");
            }
            previousPts = metadata.presentationTicks();
            totalPixels = Math.addExact(totalPixels, (long) metadata.width() * metadata.height());
            totalEncodedBytes = Math.addExact(totalEncodedBytes, frame.png.length);
            if (totalEncodedBytes > limits.maxTotalEncodedBytes()) {
                throw invalid("PNG frame sequence exceeds its aggregate encoded byte bound");
            }
        }
        if (totalPixels > TemporalVideoRestoration.MAX_TOTAL_PIXELS
                || totalPixels * 3 > TemporalVideoRestoration.MAX_TOTAL_RGB_BYTES) {
            throw invalid("PNG frame source exceeds the aggregate pixel or RGB byte budget");
        }
        List<Frame> decoded = new ArrayList<>(copiedFrames.size());
        for (PngFrame input : copiedFrames) decoded.add(decode(input.png, input.metadata(), limits));
        return new DecodedPngFrameSequence(timeBase, decoded);
    }

    private static List<PngFrame> copyBoundedFrames(List<PngFrame> frames) {
        List<PngFrame> copy = new ArrayList<>(TemporalVideoRestoration.MAX_FRAMES);
        Iterator<PngFrame> iterator = frames.iterator();
        while (copy.size() < TemporalVideoRestoration.MAX_FRAMES && iterator.hasNext()) {
            copy.add(Objects.requireNonNull(iterator.next(), "frames[]"));
        }
        if (iterator.hasNext()) throw invalid("PNG frame source must contain between 3 and 64 frames");
        if (copy.size() < 3) throw invalid("PNG frame source must contain between 3 and 64 frames");
        return List.copyOf(copy);
    }

    /** Encodes the candidate's actual RGB8 payload as a single PNG image. */
    public static byte[] encode(CandidateFrame candidate) {
        return encode(candidate, Limits.defaults());
    }

    public static byte[] encode(CandidateFrame candidate, Limits limits) {
        Objects.requireNonNull(candidate, "candidate");
        Objects.requireNonNull(limits, "limits");
        checkDimensions(candidate.width(), candidate.height(), limits);
        byte[] rgb = candidate.rgb();
        long expected = (long) candidate.width() * candidate.height() * 3;
        if (rgb.length != expected) throw invalid("candidate RGB8 payload length does not match its dimensions");

        BufferedImage image = new BufferedImage(candidate.width(), candidate.height(), BufferedImage.TYPE_INT_RGB);
        int[] row = new int[candidate.width()];
        for (int y = 0; y < candidate.height(); y++) {
            int offset = y * candidate.width() * 3;
            for (int x = 0; x < candidate.width(); x++) {
                int rgbOffset = offset + x * 3;
                row[x] = (Byte.toUnsignedInt(rgb[rgbOffset]) << 16)
                        | (Byte.toUnsignedInt(rgb[rgbOffset + 1]) << 8)
                        | Byte.toUnsignedInt(rgb[rgbOffset + 2]);
            }
            image.setRGB(0, y, candidate.width(), 1, row, 0, candidate.width());
        }

        BoundedOutputStream output = new BoundedOutputStream(limits.maxOutputBytes());
        try {
            if (!ImageIO.write(image, "PNG", output)) throw invalid("no PNG writer is available");
            return output.toByteArray();
        } catch (IOException ex) {
            throw new IllegalArgumentException("PNG candidate encoding failed or exceeded its output bound", ex);
        }
    }

    /**
     * Encodes an ordered collection of still-frame candidates. The result carries the caller-supplied frame clock
     * and ROI beside each PNG; it is not a video container and does not establish artifact provenance.
     */
    public static EncodedPngFrameSequence encodeSequence(TimeBase timeBase, List<CandidateFrame> frames) {
        return encodeSequence(timeBase, frames, Limits.defaults());
    }

    /** Encodes a bounded ordered still-frame collection with per-frame and aggregate output limits. */
    public static EncodedPngFrameSequence encodeSequence(
            TimeBase timeBase, List<CandidateFrame> frames, Limits limits) {
        Objects.requireNonNull(timeBase, "timeBase");
        Objects.requireNonNull(frames, "frames");
        Objects.requireNonNull(limits, "limits");
        List<CandidateFrame> candidates = copyBoundedCandidates(frames);
        CandidateFrame first = candidates.getFirst();
        long totalPixels = 0;
        long previousPts = -1;
        for (int index = 0; index < candidates.size(); index++) {
            CandidateFrame candidate = candidates.get(index);
            checkDimensions(candidate.width(), candidate.height(), limits);
            if (candidate.frameIndex() != index || candidate.presentationTicks() <= previousPts) {
                throw invalid("candidate frame indexes must be contiguous and PTS values strictly increasing");
            }
            if (candidate.width() != first.width() || candidate.height() != first.height()
                    || !candidate.roi().equals(first.roi())) {
                throw invalid("candidate frame dimensions and ROI must remain identical within a sequence");
            }
            previousPts = candidate.presentationTicks();
            totalPixels = Math.addExact(totalPixels, (long) candidate.width() * candidate.height());
        }
        if (totalPixels > TemporalVideoRestoration.MAX_TOTAL_PIXELS
                || totalPixels * 3 > TemporalVideoRestoration.MAX_TOTAL_RGB_BYTES) {
            throw invalid("PNG candidate sequence exceeds the aggregate pixel or RGB byte budget");
        }

        List<PngFrame> encoded = new ArrayList<>(candidates.size());
        long totalEncodedBytes = 0;
        for (CandidateFrame candidate : candidates) {
            long remainingBytes = limits.maxTotalEncodedBytes() - totalEncodedBytes;
            if (remainingBytes < 1) throw invalid("PNG candidate sequence exceeds its aggregate encoded byte bound");
            int frameOutputLimit = (int) Math.min(limits.maxOutputBytes(), remainingBytes);
            Limits frameLimits = new Limits(limits.maxEncodedBytes(), frameOutputLimit, limits.maxDimension(),
                    limits.maxPixels(), limits.maxTotalEncodedBytes());
            byte[] png = encode(candidate, frameLimits);
            totalEncodedBytes = Math.addExact(totalEncodedBytes, png.length);
            if (totalEncodedBytes > limits.maxTotalEncodedBytes()) {
                throw invalid("PNG candidate sequence exceeds its aggregate encoded byte bound");
            }
            FrameMetadata metadata = new FrameMetadata(candidate.frameIndex(), candidate.presentationTicks(),
                    candidate.width(), candidate.height(), candidate.roi());
            encoded.add(new PngFrame(png, metadata));
        }
        return new EncodedPngFrameSequence(timeBase, encoded);
    }

    private static List<CandidateFrame> copyBoundedCandidates(List<CandidateFrame> frames) {
        List<CandidateFrame> copy = new ArrayList<>(TemporalVideoRestoration.MAX_FRAMES);
        Iterator<CandidateFrame> iterator = frames.iterator();
        while (copy.size() < TemporalVideoRestoration.MAX_FRAMES && iterator.hasNext()) {
            copy.add(Objects.requireNonNull(iterator.next(), "candidate frames[]"));
        }
        if (iterator.hasNext()) throw invalid("PNG candidate sequence must contain between 3 and 64 frames");
        if (copy.size() < 3) throw invalid("PNG candidate sequence must contain between 3 and 64 frames");
        return List.copyOf(copy);
    }

    public static Frame decode(byte[] encodedPng, FrameMetadata metadata) {
        return decode(encodedPng, metadata, Limits.defaults());
    }

    public static Frame decode(byte[] encodedPng, FrameMetadata metadata, Limits limits) {
        Objects.requireNonNull(encodedPng, "encodedPng");
        Objects.requireNonNull(metadata, "metadata");
        Objects.requireNonNull(limits, "limits");
        if (encodedPng.length == 0 || encodedPng.length > limits.maxEncodedBytes()) {
            throw invalid("PNG input is empty or exceeds its encoded byte bound");
        }
        byte[] input = encodedPng.clone();
        PngHeader header = validatePng(input, limits);
        if (header.width() != metadata.width() || header.height() != metadata.height()) {
            throw invalid("PNG dimensions do not match caller-supplied frame metadata");
        }

        BufferedImage image = readImage(input, header.width(), header.height());
        byte[] rgb = new byte[Math.multiplyExact(Math.multiplyExact(header.width(), header.height()), 3)];
        int[] row = new int[header.width()];
        for (int y = 0; y < header.height(); y++) {
            image.getRGB(0, y, header.width(), 1, row, 0, header.width());
            int offset = y * header.width() * 3;
            for (int x = 0; x < header.width(); x++) {
                int pixel = row[x];
                rgb[offset++] = (byte) (pixel >>> 16);
                rgb[offset++] = (byte) (pixel >>> 8);
                rgb[offset++] = (byte) pixel;
            }
        }
        return new Frame(metadata.frameIndex(), metadata.presentationTicks(), metadata.width(), metadata.height(),
                metadata.roi(), rgb);
    }

    private static BufferedImage readImage(byte[] input, int width, int height) {
        try (MemoryCacheImageInputStream imageInput = new MemoryCacheImageInputStream(new ByteArrayInputStream(input))) {
            var readers = ImageIO.getImageReaders(imageInput);
            if (!readers.hasNext()) throw invalid("PNG input has no supported image reader");
            ImageReader reader = readers.next();
            try {
                reader.setInput(imageInput, true, true);
                if (!"png".equalsIgnoreCase(reader.getFormatName())
                        || reader.getWidth(0) != width || reader.getHeight(0) != height) {
                    throw invalid("PNG reader dimensions or format differ from the validated header");
                }
                BufferedImage image = reader.read(0);
                if (image == null || image.getWidth() != width || image.getHeight() != height) {
                    throw invalid("PNG reader returned no frame or mismatched dimensions");
                }
                return image;
            } finally {
                reader.dispose();
            }
        } catch (IOException ex) {
            throw new IllegalArgumentException("malformed PNG frame", ex);
        }
    }

    /** Accepts only non-interlaced 8-bit truecolor PNG without ancillary or animation chunks. */
    private static PngHeader validatePng(byte[] input, Limits limits) {
        if (input.length < PNG_SIGNATURE.length || !matches(input, 0, PNG_SIGNATURE)) {
            throw invalid("input is not a PNG image");
        }
        int cursor = PNG_SIGNATURE.length;
        boolean ihdr = false;
        boolean idat = false;
        boolean idatEnded = false;
        boolean iend = false;
        int width = 0;
        int height = 0;
        while (cursor < input.length) {
            if (input.length - cursor < 12) throw invalid("PNG contains a truncated chunk");
            long length = uint32(input, cursor);
            if (length > Integer.MAX_VALUE || length > input.length - (long) cursor - 12) {
                throw invalid("PNG chunk length exceeds the bounded input");
            }
            int chunkLength = (int) length;
            int typeOffset = cursor + 4;
            int dataOffset = cursor + 8;
            int crcOffset = dataOffset + chunkLength;
            String type = new String(input, typeOffset, 4, java.nio.charset.StandardCharsets.US_ASCII);
            CRC32 crc = new CRC32();
            crc.update(input, typeOffset, 4 + chunkLength);
            if (crc.getValue() != uint32(input, crcOffset)) throw invalid("PNG chunk CRC mismatch");

            if (!ihdr) {
                if (!"IHDR".equals(type) || chunkLength != 13) throw invalid("PNG must begin with one valid IHDR chunk");
                width = positiveInt(input, dataOffset);
                height = positiveInt(input, dataOffset + 4);
                checkDimensions(width, height, limits);
                int bitDepth = Byte.toUnsignedInt(input[dataOffset + 8]);
                int colorType = Byte.toUnsignedInt(input[dataOffset + 9]);
                int compression = Byte.toUnsignedInt(input[dataOffset + 10]);
                int filter = Byte.toUnsignedInt(input[dataOffset + 11]);
                int interlace = Byte.toUnsignedInt(input[dataOffset + 12]);
                if (bitDepth != 8 || colorType != 2 || compression != 0 || filter != 0 || interlace != 0) {
                    throw invalid("only non-interlaced 8-bit RGB PNG frames are supported");
                }
                ihdr = true;
            } else if ("IDAT".equals(type)) {
                if (idatEnded || iend) throw invalid("PNG IDAT chunks must be contiguous and precede IEND");
                idat = true;
            } else if ("IEND".equals(type)) {
                if (!idat || chunkLength != 0) throw invalid("PNG IEND is missing image data or malformed");
                iend = true;
                cursor = crcOffset + 4;
                if (cursor != input.length) throw invalid("PNG contains trailing bytes after IEND");
                break;
            } else {
                if (idat) idatEnded = true;
                throw invalid("unsupported PNG chunk: " + type);
            }
            cursor = crcOffset + 4;
        }
        if (!ihdr || !idat || !iend) throw invalid("PNG is incomplete");
        return new PngHeader(width, height);
    }

    private static void checkDimensions(int width, int height, Limits limits) {
        if (width < 1 || height < 1 || width > limits.maxDimension() || height > limits.maxDimension()
                || width > TemporalVideoRestoration.MAX_FRAME_DIMENSION
                || height > TemporalVideoRestoration.MAX_FRAME_DIMENSION
                || (long) width * height > limits.maxPixels()
                || (long) width * height * 3 > TemporalVideoRestoration.MAX_TOTAL_RGB_BYTES) {
            throw invalid("PNG dimensions exceed the configured pixel or frame bounds");
        }
    }

    private static int positiveInt(byte[] input, int offset) {
        long value = uint32(input, offset);
        if (value < 1 || value > Integer.MAX_VALUE) throw invalid("PNG dimensions are invalid");
        return (int) value;
    }

    private static long uint32(byte[] input, int offset) {
        return ((long) Byte.toUnsignedInt(input[offset]) << 24)
                | ((long) Byte.toUnsignedInt(input[offset + 1]) << 16)
                | ((long) Byte.toUnsignedInt(input[offset + 2]) << 8)
                | Byte.toUnsignedInt(input[offset + 3]);
    }

    private static boolean matches(byte[] input, int offset, byte[] expected) {
        for (int i = 0; i < expected.length; i++) if (input[offset + i] != expected[i]) return false;
        return true;
    }

    private static IllegalArgumentException invalid(String message) { return new IllegalArgumentException(message); }

    public record Limits(int maxEncodedBytes, int maxOutputBytes, int maxDimension, long maxPixels,
            long maxTotalEncodedBytes) {
        public Limits {
            if (maxEncodedBytes < 1 || maxOutputBytes < 1 || maxDimension < 1
                    || maxEncodedBytes > DEFAULT_MAX_ENCODED_BYTES || maxOutputBytes > DEFAULT_MAX_OUTPUT_BYTES
                    || maxDimension > TemporalVideoRestoration.MAX_FRAME_DIMENSION || maxPixels < 1
                    || maxPixels > TemporalVideoRestoration.MAX_TOTAL_PIXELS || maxTotalEncodedBytes < 1
                    || maxTotalEncodedBytes > TemporalVideoRestoration.MAX_TOTAL_RGB_BYTES) {
                throw invalid("PNG codec limits must be positive and within the rendering frame bounds");
            }
        }
        public static Limits defaults() {
            return new Limits(DEFAULT_MAX_ENCODED_BYTES, DEFAULT_MAX_OUTPUT_BYTES,
                    TemporalVideoRestoration.MAX_FRAME_DIMENSION, DEFAULT_MAX_PIXELS,
                    TemporalVideoRestoration.MAX_TOTAL_RGB_BYTES);
        }
    }

    public record FrameMetadata(int frameIndex, long presentationTicks, int width, int height, Roi roi) {
        public FrameMetadata {
            if (frameIndex < 0 || frameIndex >= TemporalVideoRestoration.MAX_FRAMES || presentationTicks < 0) {
                throw invalid("frame index or presentation timestamp is outside the frame bounds");
            }
            Objects.requireNonNull(roi, "roi");
            if (width < 1 || width > TemporalVideoRestoration.MAX_FRAME_DIMENSION || height < 1
                    || height > TemporalVideoRestoration.MAX_FRAME_DIMENSION) {
                throw invalid("frame metadata dimensions exceed the RGB8 bounds");
            }
            if ((long) roi.x() + roi.width() > width || (long) roi.y() + roi.height() > height) {
                throw invalid("caller-supplied ROI is outside the frame dimensions");
            }
        }
    }

    /** Decoded pixels and their declared source clock, without an artifact identity or provenance claim. */
    public record DecodedPngFrameSequence(TimeBase timeBase, List<Frame> frames) {
        public DecodedPngFrameSequence {
            Objects.requireNonNull(timeBase, "timeBase");
            frames = List.copyOf(Objects.requireNonNull(frames, "frames"));
            if (frames.size() < 3 || frames.size() > TemporalVideoRestoration.MAX_FRAMES) {
                throw invalid("decoded PNG sequence must contain between 3 and 64 frames");
            }
            Frame first = Objects.requireNonNull(frames.getFirst(), "frames[]");
            long pixels = 0, previousPts = -1;
            for (int index = 0; index < frames.size(); index++) {
                Frame frame = Objects.requireNonNull(frames.get(index), "frames[]");
                if (frame.frameIndex() != index || frame.presentationTicks() <= previousPts) {
                    throw invalid("decoded PNG frame indexes and PTS must be contiguous and increasing");
                }
                if (frame.width() != first.width() || frame.height() != first.height()
                        || !frame.roi().equals(first.roi())) {
                    throw invalid("decoded PNG frame dimensions and ROI must remain identical");
                }
                previousPts = frame.presentationTicks();
                pixels = Math.addExact(pixels, (long) frame.width() * frame.height());
            }
            if (pixels > TemporalVideoRestoration.MAX_TOTAL_PIXELS
                    || pixels * 3 > TemporalVideoRestoration.MAX_TOTAL_RGB_BYTES) {
                throw invalid("decoded PNG sequence exceeds the aggregate pixel or RGB byte budget");
            }
        }
    }

    /** Ordered still PNGs plus their declared clock; this is not a video container or provenance claim. */
    public record EncodedPngFrameSequence(TimeBase timeBase, List<PngFrame> frames) {
        public EncodedPngFrameSequence {
            Objects.requireNonNull(timeBase, "timeBase");
            frames = copyBoundedFrames(Objects.requireNonNull(frames, "frames"));
            FrameMetadata first = frames.getFirst().metadata();
            long totalEncodedBytes = 0;
            long previousPts = -1;
            for (int index = 0; index < frames.size(); index++) {
                PngFrame frame = frames.get(index);
                FrameMetadata metadata = frame.metadata();
                if (metadata.frameIndex() != index || metadata.presentationTicks() <= previousPts) {
                    throw invalid("encoded PNG frame indexes must be contiguous and PTS values strictly increasing");
                }
                if (metadata.width() != first.width() || metadata.height() != first.height()
                        || !metadata.roi().equals(first.roi())) {
                    throw invalid("encoded PNG frame dimensions and ROI must remain identical");
                }
                previousPts = metadata.presentationTicks();
                totalEncodedBytes = Math.addExact(totalEncodedBytes, frame.png.length);
                if (totalEncodedBytes > TemporalVideoRestoration.MAX_TOTAL_RGB_BYTES) {
                    throw invalid("encoded PNG sequence exceeds the aggregate encoded byte bound");
                }
            }
        }
    }

    public record PngFrame(byte[] png, FrameMetadata metadata) {
        public PngFrame {
            Objects.requireNonNull(png, "png");
            if (png.length == 0 || png.length > DEFAULT_MAX_ENCODED_BYTES) {
                throw invalid("PNG input is empty or exceeds its encoded byte bound");
            }
            png = png.clone();
            Objects.requireNonNull(metadata, "metadata");
        }
        @Override public byte[] png() { return png.clone(); }
    }

    private record PngHeader(int width, int height) {}

    private static final class BoundedOutputStream extends OutputStream {
        private final int limit;
        private final ByteArrayOutputStream delegate;
        private BoundedOutputStream(int limit) { this.limit = limit; this.delegate = new ByteArrayOutputStream(Math.min(limit, 8_192)); }
        @Override public void write(int value) throws IOException {
            ensureRoom(1);
            delegate.write(value);
        }
        @Override public void write(byte[] bytes, int offset, int length) throws IOException {
            Objects.checkFromIndexSize(offset, length, bytes.length);
            ensureRoom(length);
            delegate.write(bytes, offset, length);
        }
        private void ensureRoom(int amount) throws IOException {
            if (amount > limit - delegate.size()) throw new IOException("PNG output exceeds configured byte bound");
        }
        byte[] toByteArray() { return delegate.toByteArray(); }
    }
}
