package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptObservation;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptQuery;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Read-only reconciliation contract of the DEV ffmpeg transcode provider over the exact on-disk spool protocol.
 * The files here are the ones the provider itself writes; the end-to-end run with a real FFmpeg and a SIGKILLed
 * launcher is {@code MediaDevJobRestartRecoveryIT}.
 */
class MediaDevFfmpegTranscodeProviderTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String FINGERPRINT = "a".repeat(64);
    @TempDir Path spool;

    private MediaDevFfmpegTranscodeProvider provider() {
        return new MediaDevFfmpegTranscodeProvider(Path.of("/bin/true"), Path.of("/bin/true"), spool, null);
    }

    private static String sha(String value) { return sha(value.getBytes(StandardCharsets.UTF_8)); }

    private static String sha(byte[] value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value)); }
        catch (Exception impossible) { throw new IllegalStateException(impossible); }
    }

    private static ProviderAttemptQuery query(String jobId, String fingerprint) {
        String operation = "local-ffmpeg-transcode:" + jobId + ":1";
        return new ProviderAttemptQuery("tenant-a", jobId, "request-" + jobId, 1, 1, fingerprint,
                MediaDevFfmpegTranscodeProvider.PROVIDER_ID, operation, sha(operation + ":" + FINGERPRINT));
    }

    private Path dir(ProviderAttemptQuery query) {
        return spool.resolve(sha(query.providerOperationId()).substring(0, 40));
    }

    private ProviderAttemptObservation observe(ProviderAttemptQuery query) throws Exception {
        return provider().reconcileAttempt(query).get();
    }

    private static String liveOwner() { return MediaDevRequestLedger.localOwner(); }

    private static String deadLocalOwner() throws Exception {
        Process finished = new ProcessBuilder("/bin/true").start();
        finished.waitFor();
        String[] mine = MediaDevRequestLedger.localOwner().split("/");
        return "launcher/" + mine[1] + "/" + finished.pid() + "/0/deadbeef";
    }

    private void writeBegin(ProviderAttemptQuery query, String owner) throws Exception {
        Files.createDirectories(dir(query));
        Files.write(dir(query).resolve("begin.json"), JSON.writeValueAsBytes(Map.of("owner", owner)));
    }

    private void writeCommit(ProviderAttemptQuery query, byte[] output, String tenant) throws Exception {
        Files.createDirectories(dir(query));
        Files.write(dir(query).resolve("out.bin"), output);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("outputSha256", sha(output));
        result.put("outputBytes", output.length);
        Map<String, Object> receipt = new LinkedHashMap<>();
        receipt.put("tenantId", tenant);
        receipt.put("jobId", query.jobId());
        receipt.put("requestFingerprint", query.requestFingerprint());
        receipt.put("operationId", query.providerOperationId());
        receipt.put("receiptId", query.providerReceiptId());
        receipt.put("result", result);
        Files.write(dir(query).resolve("receipt.json"), JSON.writeValueAsBytes(receipt));
    }

    @Test
    void anOperationThatNeverStartedIsProvenNoEffectAndNothingIsInvented() throws Exception {
        ProviderAttemptObservation observed = observe(query("job-never", FINGERPRINT));
        assertThat(observed.finality()).isEqualTo(AttemptFinality.NO_EFFECT_PROVEN);
        assertThat(observed.result()).isEmpty();
    }

    @Test
    void aVerifiedReceiptIsSucceededWithTheOutputDigestRecomputedFromTheFile() throws Exception {
        ProviderAttemptQuery query = query("job-done", FINGERPRINT);
        writeBegin(query, deadLocalOwner());
        writeCommit(query, "fLaC-bytes".getBytes(StandardCharsets.UTF_8), "tenant-a");
        ProviderAttemptObservation observed = observe(query);
        assertThat(observed.finality()).isEqualTo(AttemptFinality.SUCCEEDED);
        assertThat(observed.result()).containsEntry("outputSha256", sha("fLaC-bytes"));
        assertThat(observed.provenanceDigest()).matches("[0-9a-f]{64}");
        // Reading back is repeatable and changes nothing.
        assertThat(observe(query)).usingRecursiveComparison().ignoringFields("observedAt").isEqualTo(observed);
        assertThat(dir(query).resolve("out.bin")).exists();
    }

    @Test
    void aTamperedOutputAForeignTenantOrAWrongFingerprintIsUnknownNotSucceeded() throws Exception {
        ProviderAttemptQuery tampered = query("job-tampered", FINGERPRINT);
        writeCommit(tampered, "original".getBytes(StandardCharsets.UTF_8), "tenant-a");
        Files.write(dir(tampered).resolve("out.bin"), "changed".getBytes(StandardCharsets.UTF_8));
        assertThat(observe(tampered).finality()).isEqualTo(AttemptFinality.UNKNOWN);

        ProviderAttemptQuery foreign = query("job-foreign", FINGERPRINT);
        writeCommit(foreign, "bytes".getBytes(StandardCharsets.UTF_8), "tenant-b");
        assertThat(observe(foreign).finality()).isEqualTo(AttemptFinality.UNKNOWN);

        ProviderAttemptQuery other = query("job-fingerprint", "b".repeat(64));
        assertThat(observe(other).finality()).isEqualTo(AttemptFinality.UNKNOWN);
    }

    @Test
    void anUncommittedRunWhoseOwnerIsGoneIsNoEffectAndItsPartialIsDiscarded() throws Exception {
        ProviderAttemptQuery query = query("job-dead", FINGERPRINT);
        writeBegin(query, deadLocalOwner());
        Files.writeString(dir(query).resolve("out.part"), "partial");
        ProviderAttemptObservation observed = observe(query);
        assertThat(observed.finality()).isEqualTo(AttemptFinality.NO_EFFECT_PROVEN);
        assertThat(dir(query)).doesNotExist();
    }

    @Test
    void anUncommittedRunWhoseOwnerMayStillBeAliveOrIsOnAnotherHostStaysUnknown() throws Exception {
        ProviderAttemptQuery live = query("job-live", FINGERPRINT);
        writeBegin(live, liveOwner());
        Files.writeString(dir(live).resolve("out.part"), "partial");
        assertThat(observe(live).finality()).isEqualTo(AttemptFinality.UNKNOWN);
        assertThat(dir(live).resolve("out.part")).exists();

        ProviderAttemptQuery remote = query("job-remote", FINGERPRINT);
        writeBegin(remote, "launcher/another-host/4242/1/cafebabe");
        assertThat(observe(remote).finality()).isEqualTo(AttemptFinality.UNKNOWN);
        assertThat(dir(remote).resolve("begin.json")).exists();
    }

    @Test
    void aQueryForAnotherProviderOrAForgedOperationIdentityIsUnknown() throws Exception {
        ProviderAttemptQuery base = query("job-forged", FINGERPRINT);
        ProviderAttemptQuery otherProvider = new ProviderAttemptQuery(base.tenantId(), base.jobId(), base.requestId(), 1, 1,
                FINGERPRINT, "other-provider", base.providerOperationId(), base.providerReceiptId());
        assertThat(observe(otherProvider).finality()).isEqualTo(AttemptFinality.UNKNOWN);
        ProviderAttemptQuery forged = new ProviderAttemptQuery(base.tenantId(), base.jobId(), base.requestId(), 1, 1,
                FINGERPRINT, base.providerId(), "local-ffmpeg-transcode:someone-else:1", base.providerReceiptId());
        assertThat(observe(forged).finality()).isEqualTo(AttemptFinality.UNKNOWN);
    }

    @Test
    void transcodeParametersAreClosedAndBounded() {
        assertThat(MediaDevFfmpegTranscodeProvider.params(Map.of()))
                .isEqualTo(new MediaDevFfmpegTranscodeProvider.Params("flac", 16_000, 1));
        assertThat(MediaDevFfmpegTranscodeProvider.params(Map.of("container", "wav", "sampleRateHz", 48_000, "channels", 2))
                .contentType()).isEqualTo("audio/wav");
        for (Map<String, Object> bad : java.util.List.<Map<String, Object>>of(
                Map.of("container", "mp3"), Map.of("sampleRateHz", 7_999), Map.of("sampleRateHz", 48_001),
                Map.of("channels", 3), Map.of("channels", 1.5), Map.of("extra", "x"), Map.of("sampleRateHz", "8000"))) {
            assertThatThrownBy(() -> MediaDevFfmpegTranscodeProvider.params(bad)).isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test
    void theProviderIsOnlyComposedWhenSpoolAndAbsoluteFfmpegPathsAreConfigured() {
        assertThat(MediaDevFfmpegTranscodeProvider.from(Map.of())).isEmpty();
        assertThat(MediaDevFfmpegTranscodeProvider.from(Map.of(
                MediaDevFfmpegTranscodeProvider.SPOOL_ENV, spool.toString()))).isEmpty();
        assertThat(MediaDevFfmpegTranscodeProvider.from(Map.of(
                MediaDevFfmpegTranscodeProvider.SPOOL_ENV, spool.toString(),
                MediaDevProjectRenderRuntime.FFMPEG_ENV, "/bin/true",
                MediaDevProjectRenderRuntime.FFPROBE_ENV, "/bin/true"))).isPresent();
        assertThatThrownBy(() -> MediaDevFfmpegTranscodeProvider.from(Map.of(
                MediaDevFfmpegTranscodeProvider.SPOOL_ENV, "relative/spool",
                MediaDevProjectRenderRuntime.FFMPEG_ENV, "/bin/true",
                MediaDevProjectRenderRuntime.FFPROBE_ENV, "/bin/true"))).isInstanceOf(IllegalArgumentException.class);
    }
}
