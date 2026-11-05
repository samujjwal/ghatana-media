package com.ghatana.media.production.animation;

import com.ghatana.media.production.AnimationSpecCompiler.AnimationSpec;
import com.ghatana.media.production.AnimationSpecCompiler.PositiveRational;
import com.ghatana.media.production.AnimationSpecCompiler.StoryTime;
import org.junit.jupiter.api.Test;

import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import org.w3c.dom.Node;
import org.w3c.dom.NamedNodeMap;
import java.io.ByteArrayInputStream;
import java.util.List;
import java.util.Iterator;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class AnimationRendererTest {
    private static AnimationSpec spec() {
        return spec("png");
    }

    private static AnimationSpec spec(String renderingFormat) {
        return new AnimationSpec("media.declarative.value.animation-spec.v1",
                "scene/a@v1", "animation/a@v1", "operators/vector@v1", "assets/a@v1",
                List.of("curve/position@v1"),
                new StoryTime("story", "clock", "stream", "origin@v1", "2",
                        new PositiveRational("1", "100")), "render/" + renderingFormat + "@v1");
    }

    private static AnimationRenderer.Scene scene() {
        return new AnimationRenderer.Scene(32, 24, 0xff101820, List.of(
                new AnimationRenderer.Shape("moving-box", AnimationRenderer.Primitive.RECTANGLE,
                        2, 2, 8, 6, 0, 0xffff0000,
                        List.of(
                                new AnimationRenderer.Keyframe(0, 0, 0, 1, 1, 0, 1,
                                        AnimationRenderer.Easing.EASE_IN),
                                new AnimationRenderer.Keyframe(2, 10, 0, 1, 1, 0, 1,
                                        AnimationRenderer.Easing.LINEAR))),
                new AnimationRenderer.Shape("dot", AnimationRenderer.Primitive.ELLIPSE,
                        20, 10, 5, 5, 0, 0xff00ff00, List.of()),
                new AnimationRenderer.Shape("guide", AnimationRenderer.Primitive.LINE,
                        1, 20, 10, 0, 1, 0xff0000ff, List.of())));
    }

    @Test
    void rendersDeterministicDecodablePngFramesWithGoldenPixelsCurvesAndExactClocks() throws Exception {
        var renderer = new AnimationRenderer();
        var profile = new AnimationRenderer.Profile(10, 1, 3);
        var first = renderer.render(spec(), scene(), profile);
        var repeated = renderer.render(spec(), scene(), profile);

        assertThat(first.plan().sceneGraphRef()).isEqualTo("scene/a@v1");
        assertThat(first.frames()).hasSize(3);
        for (int index = 0; index < first.frames().size(); index++) {
            var frame = first.frames().get(index);
            assertThat(frame.png()).containsExactly(repeated.frames().get(index).png());
            var decoded = ImageIO.read(new ByteArrayInputStream(frame.png()));
            assertThat(decoded).isNotNull();
            assertThat(decoded.getWidth()).isEqualTo(32);
            assertThat(decoded.getHeight()).isEqualTo(24);
            assertThat(decoded.getRGB(0, 0)).isEqualTo(0xff101820);
            assertThat(decoded.getRGB(22, 12)).isEqualTo(0xff00ff00);
            assertThat(decoded.getRGB(5, 20)).isEqualTo(0xff0000ff);
        }

        assertThat(ImageIO.read(new ByteArrayInputStream(first.frames().get(0).png())).getRGB(3, 3))
                .isEqualTo(0xffff0000);
        assertThat(ImageIO.read(new ByteArrayInputStream(first.frames().get(1).png())).getRGB(8, 3))
                .isEqualTo(0xffff0000); // Ease-in midpoint shifts the rectangle 2.5 pixels.
        assertThat(first.frames().get(1).ptsNumerator()).isEqualTo("1");
        assertThat(first.frames().get(1).ptsDenominator()).isEqualTo("10");
        assertThat(first.frames().get(1).storyTicksNumerator()).isEqualTo("12");
        assertThat(first.frames().get(1).storyTicksDenominator()).isEqualTo("1");
        byte[] exposed = first.frames().get(0).png();
        exposed[0] = 0;
        assertThat(first.frames().get(0).png()[0]).isEqualTo((byte) 0x89);
    }

    @Test
    void samplesLinearAndEasedCurvesAtExactEndpointsAndInterior() {
        var keys = List.of(
                new AnimationRenderer.Keyframe(0, 0, 0, 1, 1, 0, 1, AnimationRenderer.Easing.EASE_IN),
                new AnimationRenderer.Keyframe(10, 100, 50, 3, 1, 90, 0.5, AnimationRenderer.Easing.LINEAR));
        assertThat(AnimationRenderer.sample(keys, 0).x()).isEqualTo(0);
        var midpoint = AnimationRenderer.sample(keys, 5);
        assertThat(midpoint.x()).isEqualTo(25);
        assertThat(midpoint.y()).isEqualTo(12.5);
        assertThat(midpoint.scaleX()).isEqualTo(1.5);
        assertThat(midpoint.rotationDegrees()).isEqualTo(22.5);
        assertThat(midpoint.opacity()).isEqualTo(0.875);
        assertThat(AnimationRenderer.sample(keys, 10).x()).isEqualTo(100);
    }

    @Test
    void rejectsMalformedCurvesDimensionsAndExcessiveRasterWorkBeforeRendering() {
        assertThatThrownBy(() -> new AnimationRenderer.Keyframe(0, Double.NaN, 0,
                1, 1, 0, 1, AnimationRenderer.Easing.LINEAR))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("finite");
        assertThatThrownBy(() -> new AnimationRenderer.Scene(2_049, 1, 0, List.of()))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("dimensions");
        assertThatThrownBy(() -> new AnimationRenderer.Profile(24, 1, AnimationRenderer.MAX_FRAMES + 1))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("frameCount");
        assertThatThrownBy(() -> new AnimationRenderer().render(spec(),
                new AnimationRenderer.Scene(2_048, 2_048, 0, List.of()),
                new AnimationRenderer.Profile(24, 1, 9)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("pixel budget");
    }

    @Test
    void rejectsDuplicateShapeIdsOutOfRangeKeysAndUnsortedKeys() {
        var box = new AnimationRenderer.Shape("same", AnimationRenderer.Primitive.RECTANGLE,
                0, 0, 1, 1, 0, 0xffffffff, List.of());
        assertThatThrownBy(() -> new AnimationRenderer.Scene(4, 4, 0, List.of(box, box)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("unique");
        var lateKey = new AnimationRenderer.Shape("late", AnimationRenderer.Primitive.RECTANGLE,
                0, 0, 1, 1, 0, 0xffffffff,
                List.of(new AnimationRenderer.Keyframe(2, 0, 0, 1, 1, 0, 1, AnimationRenderer.Easing.LINEAR)));
        assertThatThrownBy(() -> new AnimationRenderer().render(spec(),
                new AnimationRenderer.Scene(4, 4, 0, List.of(lateKey)), new AnimationRenderer.Profile(24, 1, 2)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("less than profile.frameCount");
        assertThatThrownBy(() -> new AnimationRenderer.Scene(4, 4, 0, List.of(
                new AnimationRenderer.Shape("unsorted", AnimationRenderer.Primitive.RECTANGLE,
                        0, 0, 1, 1, 0, 0xffffffff, List.of(
                                new AnimationRenderer.Keyframe(2, 0, 0, 1, 1, 0, 1, AnimationRenderer.Easing.LINEAR),
                                new AnimationRenderer.Keyframe(1, 0, 0, 1, 1, 0, 1, AnimationRenderer.Easing.LINEAR))))))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("strictly increasing");
    }

    @Test
    void rendersSeededProceduralParticlesDeterministicallyAndBoundsTotalDraws() throws Exception {
        var field = new AnimationRenderer.ParticleField("stars", 42L, 80,
                2, 2, 28, 20, 1.5, 0xffffffff);
        var particleScene = new AnimationRenderer.Scene(32, 24, 0xff000000, List.of(), List.of(field));
        var renderer = new AnimationRenderer();
        var profile = new AnimationRenderer.Profile(24, 1, 2);
        var first = renderer.render(spec(), particleScene, profile);
        var again = renderer.render(spec(), particleScene, profile);
        assertThat(first.frames().get(0).png()).containsExactly(again.frames().get(0).png());

        var decoded = ImageIO.read(new ByteArrayInputStream(first.frames().get(0).png()));
        long litPixels = 0;
        for (int y = 0; y < decoded.getHeight(); y++) {
            for (int x = 0; x < decoded.getWidth(); x++) {
                if (decoded.getRGB(x, y) != 0xff000000) {
                    litPixels++;
                }
            }
        }
        assertThat(litPixels).isPositive();

        var largeField = new AnimationRenderer.ParticleField("many-stars", 42L, 5_000,
                0, 0, 32, 24, 1, 0xffffffff);
        assertThatThrownBy(() -> renderer.render(spec(),
                new AnimationRenderer.Scene(32, 24, 0, List.of(), List.of(largeField)),
                new AnimationRenderer.Profile(24, 1, 240)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("procedural draw budget");
    }

    @Test
    void rejectsStoryClockOverflowInsteadOfWrappingFrameTimestamps() {
        var boundarySpec = new AnimationSpec("media.declarative.value.animation-spec.v1",
                "scene/a@v1", "animation/a@v1", "operators/vector@v1", "assets/a@v1",
                List.of(),
                new StoryTime("story", "clock", "stream", "origin@v1", Long.toString(Long.MAX_VALUE),
                        new PositiveRational("1", "1")), "render/png@v1");
        assertThatThrownBy(() -> new AnimationRenderer().render(boundarySpec,
                new AnimationRenderer.Scene(2, 2, 0, List.of()),
                new AnimationRenderer.Profile(1, 1, 2)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("signed-int64");
    }

    @Test
    void exportsDeterministicAnimatedGifWithExactCadenceAndDecoderGoldenFrames() throws Exception {
        var spec = spec("gif");
        var animatedScene = new AnimationRenderer.Scene(4, 2, 0xff000000, List.of(
                new AnimationRenderer.Shape("moving-pixel", AnimationRenderer.Primitive.RECTANGLE,
                        0, 0, 1, 1, 0, 0xffff0000,
                        List.of(
                                new AnimationRenderer.Keyframe(0, 0, 0, 1, 1, 0, 1, AnimationRenderer.Easing.LINEAR),
                                new AnimationRenderer.Keyframe(2, 2, 0, 1, 1, 0, 1, AnimationRenderer.Easing.LINEAR)))));
        var profile = new AnimationRenderer.Profile(10, 1, 3);
        var renderer = new AnimationRenderer();
        var first = renderer.renderAnimated(spec, animatedScene, profile, AnimationRenderer.AnimatedFormat.GIF);
        var repeated = renderer.renderAnimated(spec, animatedScene, profile, AnimationRenderer.AnimatedFormat.GIF);

        assertThat(first.status()).isEqualTo(AnimationRenderer.ExportStatus.ENCODED);
        var encoded = first.encoded().orElseThrow();
        assertThat(encoded.format()).isEqualTo("gif");
        assertThat(encoded.plan().renderingRef()).isEqualTo("render/gif@v1");
        assertThat(encoded.framesPerSecondNumerator()).isEqualTo(10);
        assertThat(encoded.framesPerSecondDenominator()).isEqualTo(1);
        assertThat(encoded.frameDelayCentiseconds()).isEqualTo(10);
        assertThat(encoded.frameCount()).isEqualTo(3);
        assertThat(encoded.frameTimes()).extracting(AnimationRenderer.FrameTime::ptsNumerator).containsExactly("0", "1", "1");
        assertThat(encoded.frameTimes()).extracting(AnimationRenderer.FrameTime::ptsDenominator).containsExactly("1", "10", "5");
        assertThat(encoded.frameTimes().get(1).storyTicksNumerator()).isEqualTo("12");
        assertThat(encoded.frameTimes().get(1).storyTicksDenominator()).isEqualTo("1");
        assertThat(encoded.bytes()).containsExactly(repeated.encoded().orElseThrow().bytes());
        assertThat(encoded.sha256()).hasSize(64);

        Iterator<ImageReader> readers = ImageIO.getImageReadersByFormatName("gif");
        assertThat(readers.hasNext()).isTrue();
        ImageReader reader = readers.next();
        try (ImageInputStream input = ImageIO.createImageInputStream(new ByteArrayInputStream(encoded.bytes()))) {
            reader.setInput(input, false, false);
            assertThat(reader.getNumImages(true)).isEqualTo(3);
            for (int index = 0; index < 3; index++) {
                var decoded = reader.read(index);
                assertThat(decoded.getWidth()).isEqualTo(4);
                assertThat(decoded.getHeight()).isEqualTo(2);
                assertThat(decoded.getRGB(index, 0)).isEqualTo(0xffff0000);
                assertThat(decoded.getRGB(3, 1)).isEqualTo(0xff000000);
                var metadata = reader.getImageMetadata(index);
                Node root = metadata.getAsTree("javax_imageio_gif_image_1.0");
                Node control = findNode(root, "GraphicControlExtension");
                NamedNodeMap attributes = control.getAttributes();
                assertThat(attributes.getNamedItem("delayTime").getNodeValue()).isEqualTo("10");
                decoded.flush();
            }
        } finally {
            reader.dispose();
        }
    }

    @Test
    void unsupportedCodecAndUnrepresentableGifFrameRateReturnTypedUnavailableOutcomes() {
        var scene = new AnimationRenderer.Scene(2, 2, 0xff000000, List.of());
        var renderer = new AnimationRenderer();
        var unsupported = renderer.renderAnimated(spec("webp"), scene, new AnimationRenderer.Profile(10, 1, 2),
                AnimationRenderer.AnimatedFormat.WEBP);
        assertThat(unsupported.status()).isEqualTo(AnimationRenderer.ExportStatus.UNSUPPORTED_CODEC);
        assertThat(unsupported.failure()).contains(AnimationRenderer.ExportFailure.CODEC_NOT_SUPPORTED);
        assertThat(unsupported.encoded()).isEmpty();

        var inexactRate = renderer.renderAnimated(spec("gif"), scene, new AnimationRenderer.Profile(24, 1, 2),
                AnimationRenderer.AnimatedFormat.GIF);
        assertThat(inexactRate.status()).isEqualTo(AnimationRenderer.ExportStatus.UNSUPPORTED_FRAME_RATE);
        assertThat(inexactRate.failure()).contains(AnimationRenderer.ExportFailure.FRAME_RATE_NOT_EXACTLY_REPRESENTABLE);
        assertThat(inexactRate.encoded()).isEmpty();
    }

    private static Node findNode(Node root, String name) {
        if (name.equals(root.getNodeName())) return root;
        for (Node child = root.getFirstChild(); child != null; child = child.getNextSibling()) {
            Node match = findNode(child, name);
            if (match != null) return match;
        }
        return null;
    }
}
