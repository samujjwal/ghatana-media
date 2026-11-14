package com.ghatana.media.launcher;

import com.ghatana.media.launcher.MediaDevProjectRenderRuntime.RenderExecutionFailedException;
import com.ghatana.media.launcher.MediaDevProjectRenderRuntime.RenderNotSupportedException;
import com.ghatana.media.production.audio.PcmStemMixer;
import com.ghatana.media.production.rendering.MultitrackRenderPlanner.Time;
import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * DEV_ONLY exact placement and mix of several AUDIO WAV clips into one timeline-length 16-bit stereo WAV using
 * {@link PcmStemMixer}. Every clip becomes one stem of exactly the timeline frame count (silence outside the
 * clip). Nothing is resampled, up/down-mixed, retimed, trimmed or padded implicitly: inputs that do not fit the
 * mixer's contract are typed {@link RenderNotSupportedException}s.
 *
 * <p>Gains are unity and pan is centre because the project timeline has no per-clip gain or pan. Overlapping
 * clips are summed by the mixer, which then applies its own bounded peak-ceiling guard; the applied master gain
 * (1.0 when no limiting was needed) is reported. The rights decision handed to the mixer is the same DEV_ONLY
 * owner-scope visibility decision used elsewhere in the dev runtime, not a production rights grant.
 */
final class MediaDevProjectAudioMix {
    static final float CEILING = 0.98f;
    static final String RIGHTS_AUTHORITY = "DEV_ONLY_OWNER_SCOPE_VISIBILITY";

    record Input(String clipId, String artifactId, String versionId, String sha256, byte[] wav,
                 Time sourceStart, Time storyStart, Time duration) { }

    record Result(byte[] wav, String wavSha256, String pcmSha256, int sampleRate, int frameCount,
                  float appliedMasterGain, Map<String, Object> lineage) { }

    private record Wav(int rate, int channels, byte[] pcm) { }

    private MediaDevProjectAudioMix() { }

    static Result mix(List<Input> inputs, Time timelineDuration) {
        if (inputs.size() > PcmStemMixer.MAX_STEMS) {
            throw new RenderNotSupportedException("RENDER_LIMIT_EXCEEDED",
                    "more than " + PcmStemMixer.MAX_STEMS + " audio clips cannot be mixed");
        }
        List<Wav> parsed = new ArrayList<>();
        int rate = -1;
        for (Input in : inputs) {
            Wav wav = parse(in.wav());
            if (wav.channels() != PcmStemMixer.CHANNELS) {
                throw new RenderNotSupportedException("RENDER_UNSUPPORTED_AUDIO_LAYOUT",
                        "mixing several audio clips requires 16-bit stereo WAV sources (clip " + in.clipId()
                                + " has " + wav.channels() + " channel(s)); no channel conversion is applied");
            }
            if (rate < 0) rate = wav.rate();
            else if (rate != wav.rate()) {
                throw new RenderNotSupportedException("RENDER_UNSUPPORTED_AUDIO_FORMAT",
                        "all mixed audio clips must share one sample rate; no resampling is applied");
            }
            parsed.add(wav);
        }
        int frames = wholeFrames(timelineDuration, rate, "timeline duration");
        if (frames > PcmStemMixer.MAX_FRAMES) {
            throw new RenderNotSupportedException("RENDER_LIMIT_EXCEEDED",
                    "mixed audio exceeds " + PcmStemMixer.MAX_FRAMES + " frames");
        }
        if ((long) frames * 4 * inputs.size() > PcmStemMixer.MAX_AGGREGATE_INPUT_BYTES) {
            throw new RenderNotSupportedException("RENDER_LIMIT_EXCEEDED", "mixed audio exceeds the aggregate byte budget");
        }
        Instant now = Instant.now();
        Clock clock = Clock.fixed(now, ZoneOffset.UTC);
        List<PcmStemMixer.Stem> stems = new ArrayList<>();
        List<Map<String, Object>> clipLineage = new ArrayList<>();
        for (int i = 0; i < inputs.size(); i++) {
            Input in = inputs.get(i);
            Wav wav = parsed.get(i);
            int srcOffset = wholeFrames(in.sourceStart(), rate, "audio source start");
            int length = wholeFrames(in.duration(), rate, "audio clip duration");
            int offset = wholeFrames(in.storyStart(), rate, "audio story start");
            if ((long) srcOffset + length > wav.pcm().length / 4) {
                throw new RenderNotSupportedException("RENDER_UNSUPPORTED_AUDIO_LAYOUT",
                        "audio source is shorter than the selected interval");
            }
            if ((long) offset + length > frames) {
                throw new RenderNotSupportedException("RENDER_UNSUPPORTED_AUDIO_LAYOUT",
                        "audio clip extends past the timeline");
            }
            byte[] pcm = new byte[frames * 4];
            System.arraycopy(wav.pcm(), srcOffset * 4, pcm, offset * 4, length * 4);
            String ref = in.artifactId() + "@" + in.versionId();
            stems.add(new PcmStemMixer.Stem(ref, rate, 2, 16, pcm, 1.0f, 0.0f,
                    new PcmStemMixer.AssetProvenance(ref, new PcmStemMixer.RightsEvidence(ref,
                            "dev-only-owner-scope:" + ref, PcmStemMixer.RightsPurpose.PCM_STEM_MIX,
                            PcmStemMixer.RightsDisposition.CLEARED, now.minus(Duration.ofSeconds(1)),
                            now.plus(Duration.ofHours(1))))));
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("clipId", in.clipId());
            entry.put("artifactId", in.artifactId());
            entry.put("artifactVersionId", in.versionId());
            entry.put("sourceSha256", in.sha256());
            entry.put("sourceInSeconds", in.sourceStart().toString());
            entry.put("storyOffsetSeconds", in.storyStart().toString());
            entry.put("durationSeconds", in.duration().toString());
            entry.put("storyOffsetFrames", offset);
            entry.put("durationFrames", length);
            entry.put("gain", 1.0);
            entry.put("pan", 0.0);
            clipLineage.add(entry);
        }
        PcmStemMixer.MixResult mixed;
        try {
            mixed = new PcmStemMixer().mix(stems, new PcmStemMixer.MixSpec(rate, frames, CEILING), clock);
        } catch (PcmStemMixer.MixException failure) {
            switch (failure.code()) {
                case FORMAT_MISMATCH -> throw new RenderNotSupportedException("RENDER_UNSUPPORTED_AUDIO_FORMAT",
                        "audio clips do not fit the mixer format contract");
                case RESOURCE_LIMIT -> throw new RenderNotSupportedException("RENDER_LIMIT_EXCEEDED",
                        "audio mix exceeds the mixer budget");
                case INVALID_INPUT -> throw new RenderNotSupportedException("RENDER_UNSUPPORTED_AUDIO_FORMAT",
                        "audio mix parameters are outside the mixer's bounded range");
                default -> throw new RenderExecutionFailedException("AUDIO_MIX_" + failure.code().name());
            }
        }
        Map<String, Object> lineage = new LinkedHashMap<>();
        lineage.put("engine", "production.audio.PcmStemMixer");
        lineage.put("sampleRate", rate);
        lineage.put("channels", 2);
        lineage.put("frameCount", frames);
        lineage.put("timelineDurationSeconds", timelineDuration.toString());
        lineage.put("truePeakCeiling", (double) CEILING);
        lineage.put("appliedMasterGain", (double) mixed.appliedMasterGain());
        lineage.put("mixedWavSha256", mixed.wavSha256());
        lineage.put("mixedPcmSha256", mixed.pcmSha256());
        Map<String, Object> rights = new LinkedHashMap<>();
        rights.put("authority", RIGHTS_AUTHORITY);
        rights.put("outcome", "ELIGIBLE");
        rights.put("basis", "each source version was read as an existing artifact of the requesting principal");
        rights.put("productionGrant", false);
        lineage.put("rightsDecision", rights);
        lineage.put("clips", clipLineage);
        return new Result(mixed.wav(), mixed.wavSha256(), mixed.pcmSha256(), rate, frames,
                mixed.appliedMasterGain(), lineage);
    }

    private static int wholeFrames(Time seconds, int rate, String what) {
        BigInteger scaled = BigInteger.valueOf(seconds.numerator()).multiply(BigInteger.valueOf(rate));
        BigInteger[] qr = scaled.divideAndRemainder(BigInteger.valueOf(seconds.denominator()));
        if (qr[1].signum() != 0 || qr[0].signum() < 0 || qr[0].bitLength() > 31) {
            throw new RenderNotSupportedException("RENDER_UNSUPPORTED_AUDIO_FORMAT",
                    what + " is not a whole number of samples at " + rate + " Hz; no rounding is applied");
        }
        return qr[0].intValue();
    }

    private static Wav parse(byte[] data) {
        ByteBuffer b = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN);
        if (data.length < 44 || b.getInt(0) != 0x46464952 || b.getInt(8) != 0x45564157) {
            throw notPcm();
        }
        int pos = 12;
        int rate = -1, channels = -1;
        while (pos + 8 <= data.length) {
            int id = b.getInt(pos);
            long size = b.getInt(pos + 4) & 0xFFFFFFFFL;
            int body = pos + 8;
            if (id == 0x20746d66) {
                if (size < 16 || body + 16 > data.length) throw notPcm();
                int tag = b.getShort(body) & 0xFFFF;
                channels = b.getShort(body + 2) & 0xFFFF;
                rate = b.getInt(body + 4);
                int bits = b.getShort(body + 14) & 0xFFFF;
                if (tag != 1 || bits != 16 || channels < 1 || rate < 8_000 || rate > 192_000) throw notPcm();
            } else if (id == 0x61746164) {
                if (rate < 0 || body + size > data.length) throw notPcm();
                long frameBytes = 2L * channels;
                int usable = (int) (size - size % frameBytes);
                byte[] pcm = new byte[usable];
                System.arraycopy(data, body, pcm, 0, usable);
                return new Wav(rate, channels, pcm);
            }
            long next = body + size + (size & 1);
            if (next > data.length) break;
            pos = (int) next;
        }
        throw notPcm();
    }

    private static RenderNotSupportedException notPcm() {
        return new RenderNotSupportedException("RENDER_UNSUPPORTED_AUDIO_FORMAT",
                "audio sources must be 16-bit PCM WAV between 8 kHz and 192 kHz");
    }
}
