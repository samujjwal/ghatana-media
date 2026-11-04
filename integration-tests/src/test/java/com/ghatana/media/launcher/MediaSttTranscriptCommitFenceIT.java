package com.ghatana.media.launcher;

import com.ghatana.governance.PolicyDecisionOutcome;
import com.ghatana.governance.PolicyDecisionRecord;
import com.ghatana.governance.PolicyEngine;
import com.ghatana.governance.PolicyEvaluationContext;
import com.ghatana.governance.PolicyReasonCode;
import com.ghatana.media.provider.aws.PostgresqlMediaConsentAuthority;
import com.ghatana.media.provider.aws.PostgresqlMediaJobStore;
import com.ghatana.media.provider.aws.PostgresqlMediaSourceAuthorizationAuthority;
import com.ghatana.media.provider.aws.PostgresqlMediaSourceRightsAdministration;
import com.ghatana.media.provider.aws.PostgresqlMediaStreamSessionStore;
import com.ghatana.media.provider.aws.PostgresqlMediaTranscriptStore;
import com.ghatana.media.provider.aws.TestAwsStateInstall;
import com.ghatana.media.runtime.MediaRuntimeContracts.BiometricSensitivity;
import com.ghatana.media.runtime.MediaRuntimeContracts.AutomationRisk;
import com.ghatana.media.runtime.MediaRuntimeContracts.DataClassification;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderSubmission;
import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.CancellationOutcome;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts;
import com.ghatana.media.runtime.MediaSourceRightsAdministration;
import com.ghatana.media.runtime.MediaSpeechToTextAdmission;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * PostgreSQL-backed STT transcript-commit fencing that needs no real model. A fixture provider
 * returns a typed SUCCEEDED submission carrying the canonical transcript response, while the
 * Shared policy verdict is re-read before the atomic terminal/transcript transaction. The suite
 * also forces a late outbox failure and verifies the job, attempt, transcript, and both outbox
 * effects roll back together; replay and restart remain duplicate-safe.
 */
@Tag("integration")
@Testcontainers(disabledWithoutDocker = true)
class MediaSttTranscriptCommitFenceIT {
    @Container static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    private static com.sun.net.httpserver.HttpsServer s3Stub;
    private static Path keystore;
    private static String stubUrl;
    private static Map<String, String> previousTls = new java.util.HashMap<>();

    @org.junit.jupiter.api.BeforeAll
    static void startS3Stub() throws Exception {
        keystore = Files.createTempFile("media-fence-s3-", ".p12");
        Files.delete(keystore);
        new ProcessBuilder("keytool", "-genkeypair", "-alias", "s3stub",
                "-keyalg", "RSA", "-keysize", "2048", "-validity", "1",
                "-keystore", keystore.toString(), "-storetype", "PKCS12",
                "-storepass", "changeit", "-keypass", "changeit",
                "-dname", "CN=localhost", "-ext", "SAN=dns:localhost,ip:127.0.0.1")
                .inheritIO().start().waitFor();
        javax.net.ssl.KeyManagerFactory keyManagers = javax.net.ssl.KeyManagerFactory
                .getInstance(javax.net.ssl.KeyManagerFactory.getDefaultAlgorithm());
        var store = java.security.KeyStore.getInstance(keystore.toFile(), "changeit".toCharArray());
        keyManagers.init(store, "changeit".toCharArray());
        javax.net.ssl.SSLContext tls = javax.net.ssl.SSLContext.getInstance("TLS");
        tls.init(keyManagers.getKeyManagers(), null, null);
        for (String prop : new String[]{
                "javax.net.ssl.trustStore", "javax.net.ssl.trustStorePassword",
                "javax.net.ssl.trustStoreType"}) {
            previousTls.put(prop, System.getProperty(prop));
        }
        System.setProperty("javax.net.ssl.trustStore", keystore.toString());
        System.setProperty("javax.net.ssl.trustStorePassword", "changeit");
        System.setProperty("javax.net.ssl.trustStoreType", "PKCS12");
        s3Stub = com.sun.net.httpserver.HttpsServer.create(
                new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        s3Stub.setHttpsConfigurator(new com.sun.net.httpserver.HttpsConfigurator(tls));
        s3Stub.createContext("/", exchange -> {
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
        });
        s3Stub.start();
        stubUrl = "https://127.0.0.1:" + s3Stub.getAddress().getPort();
    }

    @org.junit.jupiter.api.AfterAll
    static void stopS3Stub() throws Exception {
        if (s3Stub != null) s3Stub.stop(0);
        previousTls.forEach((key, value) -> {
            if (value == null) System.clearProperty(key);
            else System.setProperty(key, value);
        });
        if (keystore != null) Files.deleteIfExists(keystore);
    }

    @Test
    void admittedAttemptAppendsTranscriptRevisionThroughTheFence() throws Exception {
        AtomicBoolean providerRan = new AtomicBoolean();
        Path root = Files.createTempDirectory("media-fence-allow-");
        AutoCloseable installed = TestAwsStateInstall.install(environment());
        try (var artifactStore = new LocalMediaRuntimeSupport.FileArtifactStore(root);
             var jobStore = new PostgresqlMediaJobStore();
             var streamStore = new PostgresqlMediaStreamSessionStore();
             var consentAuthority = new PostgresqlMediaConsentAuthority();
             var authority = new PostgresqlMediaSourceAuthorizationAuthority(
                     new FlippingPolicy(new AtomicBoolean()));
             var transcriptStore = new PostgresqlMediaTranscriptStore();
             var administration = new PostgresqlMediaSourceRightsAdministration();
             var runtime = runtime(root, artifactStore, jobStore, streamStore, consentAuthority,
                     authority, transcriptStore, List.of(fenceProvider(providerRan)))) {
            MediaArtifact artifact = upload(runtime, "allow");
            seedArtifactRow(artifact);
            administration.register(register(artifact), authenticated("tenant-a", "principal-a"));

            var accepted = runtime.submit(jobRequest(artifact, "allow"),
                    authenticated("tenant-a", "principal-a"));
            var terminal = await(runtime, accepted.jobId());
            assertThat(terminal.status()).as("final job: %s", terminal)
                    .isEqualTo(JobStatus.COMPLETED);
            assertThat(providerRan).isTrue();

            var revisions = transcriptStore.revisions(
                    "tenant-a", "principal-a", "transcript:" + accepted.jobId());
            assertThat(revisions).hasSize(1);
            var revision = revisions.getFirst();
            assertThat(revision.admissionStatus()).isEqualTo("ADMITTED");
            assertThat(revision.draft().text()).isEqualTo("fence transcript");
            assertThat(transcriptStore.readAttemptBinding(
                    "tenant-a", "principal-a", "transcript:" + accepted.jobId(), 1)
                    .providerOperationId()).isEqualTo("op-fence-1");

            // A lost append acknowledgement can be retried from the same exact attempt. The
            // attempt-bound transcript store returns the committed revision without duplicating
            // either its immutable version or its outbox event.
            var attempt = jobStore.findProcessingAttempt("tenant-a", accepted.jobId(), 1).orElseThrow();
            transcriptStore.appendFromSuccessfulAttempt(revision.draft(), 0, attempt.attemptNumber(),
                    attempt.fencingToken(), attempt.requestFingerprint(), "tv-fence-1");
            assertThat(transcriptStore.revisions(
                    "tenant-a", "principal-a", "transcript:" + accepted.jobId())).hasSize(1);
            assertThat(transcriptOutboxCount("tenant-a", accepted.jobId())).isEqualTo(1);
        } finally {
            installed.close();
        }
    }

    @Test
    void completedFixtureAttemptAndTranscriptReadBackAfterRuntimeRestartWithFreshAuthorityReplay() throws Exception {
        AtomicBoolean providerRan = new AtomicBoolean();
        AtomicInteger providerCalls = new AtomicInteger();
        Path root = Files.createTempDirectory("media-fence-success-restart-");
        AutoCloseable installed = TestAwsStateInstall.install(environment());
        String jobId;
        ProcessingJobRequest request;
        MediaArtifact sourceArtifact;
        try {
            try (var artifactStore = new LocalMediaRuntimeSupport.FileArtifactStore(root);
                 var jobStore = new PostgresqlMediaJobStore();
                 var streamStore = new PostgresqlMediaStreamSessionStore();
                 var consentAuthority = new PostgresqlMediaConsentAuthority();
                 var authority = new PostgresqlMediaSourceAuthorizationAuthority(
                         new FlippingPolicy(new AtomicBoolean()));
                 var transcriptStore = new PostgresqlMediaTranscriptStore();
                 var administration = new PostgresqlMediaSourceRightsAdministration();
                 var runtime = runtime(root, artifactStore, jobStore, streamStore, consentAuthority,
                        authority, transcriptStore,
                        List.of(fenceProviderWithCallCount(providerRan, providerCalls)))) {
                sourceArtifact = upload(runtime, "success-restart");
                seedArtifactRow(sourceArtifact);
                administration.register(register(sourceArtifact), authenticated("tenant-a", "principal-a"));
                request = jobRequest(sourceArtifact, "success-restart");

                var accepted = runtime.submit(request, authenticated("tenant-a", "principal-a"));
                jobId = accepted.jobId();
                assertThat(await(runtime, jobId).status()).isEqualTo(JobStatus.COMPLETED);
                var attempt = jobStore.findProcessingAttempt("tenant-a", jobId, 1).orElseThrow();
                assertThat(attempt.finality()).isEqualTo(AttemptFinality.SUCCEEDED);
                assertThat(attempt.requestId()).isEqualTo(request.requestId());
                assertThat(attempt.providerOperationId()).isEqualTo("op-fence-1");
                assertThat(attempt.providerReceiptId()).isEqualTo("receipt-fence-1");
                assertThat(providerRan).isTrue();
                assertThat(providerCalls).hasValue(1);
            }

            // Reconstruct every runtime store over the same PostgreSQL state. The completed
            // request must remain terminal, its receipt-bound transcript and both outbox
            // effects must remain present, and replaying the original request with freshly
            // evaluated ALLOW evidence must return the original job without redispatch.
            try (AutoCloseable reinstalled = TestAwsStateInstall.install(environment());
                 var artifactStore = new LocalMediaRuntimeSupport.FileArtifactStore(root);
                 var jobStore = new PostgresqlMediaJobStore();
                 var streamStore = new PostgresqlMediaStreamSessionStore();
                 var consentAuthority = new PostgresqlMediaConsentAuthority();
                 var authority = new PostgresqlMediaSourceAuthorizationAuthority(
                         new FlippingPolicy(new AtomicBoolean()));
                 var transcriptStore = new PostgresqlMediaTranscriptStore();
                 var runtime = runtime(root, artifactStore, jobStore, streamStore, consentAuthority,
                     authority, transcriptStore,
                     List.of(fenceProviderWithCallCount(providerRan, providerCalls)))) {
                // Verify the fixture bytes themselves after all stores have been recreated. The
                // metadata-only artifact lookup would not detect a corrupt or substituted file.
                byte[] expectedSourceBytes = "fence-audio-bytes-success-restart"
                        .getBytes(java.nio.charset.StandardCharsets.UTF_8);
                var sourceReadback = new java.io.ByteArrayOutputStream();
                var sourceReceipt = artifactStore.copyContent("tenant-a", "principal-a",
                        sourceArtifact.artifactId(), sourceArtifact.version(), sourceReadback,
                        sourceArtifact.sizeBytes()).orElseThrow();
                assertThat(sourceReadback.toByteArray()).containsExactly(expectedSourceBytes);
                assertThat(sourceReceipt.version()).isEqualTo(sourceArtifact.version());
                assertThat(sourceReceipt.sha256()).isEqualTo(sourceArtifact.sha256());
                assertThat(sourceReceipt.bytesCopied()).isEqualTo(expectedSourceBytes.length);

                assertThat(runtime.job("tenant-a", "principal-a", jobId).orElseThrow().status())
                        .isEqualTo(JobStatus.COMPLETED);
                var replay = runtime.submit(request, authenticated("tenant-a", "principal-a"));
                assertThat(replay.jobId()).isEqualTo(jobId);
                assertThat(replay.status()).isEqualTo(JobStatus.COMPLETED);
                assertThat(providerCalls).hasValue(1);

                var attempt = jobStore.findProcessingAttempt("tenant-a", jobId, 1).orElseThrow();
                assertThat(attempt.finality()).isEqualTo(AttemptFinality.SUCCEEDED);
                assertThat(attempt.providerOperationId()).isEqualTo("op-fence-1");
                assertThat(attempt.providerReceiptId()).isEqualTo("receipt-fence-1");
                var revisions = transcriptStore.revisions(
                        "tenant-a", "principal-a", "transcript:" + jobId);
                assertThat(revisions).hasSize(1);
                assertThat(revisions.getFirst().admissionStatus()).isEqualTo("ADMITTED");
                assertThat(revisions.getFirst().draft().text()).isEqualTo("fence transcript");
                assertThat(revisions.getFirst().revision()).isEqualTo(1);
                assertThat(revisions.getFirst().draft().sourceArtifactId()).isEqualTo(sourceArtifact.artifactId());
                assertThat(revisions.getFirst().draft().sourceVersion()).isEqualTo(sourceArtifact.version().value());
                assertThat(revisions.getFirst().draft().sourceSha256()).isEqualTo(sourceArtifact.sha256());
                var binding = transcriptStore.readAttemptBinding(
                        "tenant-a", "principal-a", "transcript:" + jobId, 1);
                assertThat(binding.providerOperationId()).isEqualTo("op-fence-1");
                assertThat(binding.providerReceiptId()).isEqualTo("receipt-fence-1");
                assertThat(transcriptOutboxCount("tenant-a", jobId)).isEqualTo(1);
                assertThat(completedJobOutboxCount("tenant-a", jobId)).isEqualTo(1);
            }
        } finally {
            installed.close();
        }
    }

    @Test
    void hardRuntimeProcessRestartReadsBackSyntheticTranscriptLineageWithoutReplay(
            @org.junit.jupiter.api.io.TempDir Path root) throws Exception {
        Path committed = root.resolve("transcript-committed.properties");
        Path seedLog = root.resolve("seed.log");
        Map<String, String> environment = environment();
        Process seed = startTranscriptWorker(environment, "seed", root, committed, seedLog);
        try {
            awaitChildMarker(seed, committed, seedLog);
            // The first runtime process has durably committed the fixture-provider result and transcript.
            // Kill its JVM before it can close stores or return an acknowledgement to this process.
            seed.destroyForcibly();
            assertThat(seed.waitFor(15, TimeUnit.SECONDS)).isTrue();
        } finally {
            if (seed.isAlive()) seed.destroyForcibly().waitFor(15, TimeUnit.SECONDS);
        }

        Properties identity = new Properties();
        try (var input = Files.newInputStream(committed)) {
            identity.load(input);
        }
        assertThat(identity.getProperty("providerCalls")).isEqualTo("1");
        Path recovered = root.resolve("transcript-recovered.properties");
        Path recoveryLog = root.resolve("recovery.log");
        Process recovery = startTranscriptWorker(environment, "recover", root, recovered, recoveryLog,
                identity.getProperty("tenantId"), identity.getProperty("principalId"),
                identity.getProperty("jobId"), identity.getProperty("artifactId"),
                identity.getProperty("artifactVersion"), identity.getProperty("artifactSha256"),
                identity.getProperty("transcriptId"), identity.getProperty("transcriptVersionRef"));
        try {
            awaitChildMarker(recovery, recovered, recoveryLog);
            assertThat(recovery.waitFor(15, TimeUnit.SECONDS)).isTrue();
            assertThat(recovery.exitValue()).isZero();
        } finally {
            if (recovery.isAlive()) recovery.destroyForcibly().waitFor(15, TimeUnit.SECONDS);
        }

        Properties readback = new Properties();
        try (var input = Files.newInputStream(recovered)) {
            readback.load(input);
        }
        assertThat(readback.getProperty("transcriptText")).isEqualTo("fence transcript");
        // This ADMITTED marker is confined to the disposable integration database and test fixture;
        // it is not evidence of a real provider, rights decision, or source authorization.
        assertThat(readback.getProperty("transcriptStatus")).isEqualTo("ADMITTED");
        assertThat(readback.getProperty("revision")).isEqualTo("1");
        assertThat(readback.getProperty("sourceArtifactId")).isEqualTo(identity.getProperty("artifactId"));
        assertThat(readback.getProperty("sourceVersion")).isEqualTo(identity.getProperty("artifactVersion"));
        assertThat(readback.getProperty("sourceSha256")).isEqualTo(identity.getProperty("artifactSha256"));
        assertThat(readback.getProperty("transcriptVersionRef")).isEqualTo(
                identity.getProperty("transcriptVersionRef"));
        assertThat(readback.getProperty("providerOperationId")).isEqualTo("op-fence-1");
        assertThat(readback.getProperty("providerReceiptId")).isEqualTo("receipt-fence-1");
        assertThat(readback.getProperty("providerCalls")).isEqualTo("0");
        assertThat(readback.getProperty("attemptTwoExists")).isEqualTo("false");
        assertThat(readback.getProperty("transcriptOutboxEvents")).isEqualTo("1");
        assertThat(readback.getProperty("completedJobOutboxEvents")).isEqualTo("1");
    }

    private static Process startTranscriptWorker(Map<String, String> environment, String mode, Path root,
            Path marker, Path log, String... identity) throws Exception {
        String classpath = System.getProperty("media.child.classpath", "");
        if (classpath.isBlank()) throw new IllegalStateException("Gradle did not provide media.child.classpath");
        Path javaBin = Path.of(System.getProperty("java.home"), "bin", "java");
        var command = new java.util.ArrayList<String>();
        command.add(javaBin.toString());
        command.add("-Djavax.net.ssl.trustStore=" + keystore.toAbsolutePath());
        command.add("-Djavax.net.ssl.trustStorePassword=changeit");
        command.add("-Djavax.net.ssl.trustStoreType=PKCS12");
        command.add("-cp");
        command.add(classpath);
        command.add(HardRestartWorker.class.getName());
        command.add(mode);
        command.add(root.toString());
        command.add(marker.toString());
        java.util.Collections.addAll(command, identity);
        ProcessBuilder builder = new ProcessBuilder(command);
        builder.environment().putAll(environment);
        builder.redirectErrorStream(true);
        builder.redirectOutput(log.toFile());
        return builder.start();
    }

    private static void awaitChildMarker(Process process, Path marker, Path log) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60);
        while (System.nanoTime() < deadline) {
            if (Files.exists(marker)) return;
            if (!process.isAlive()) {
                throw new AssertionError("runtime worker exited before its durable marker: "
                        + (Files.exists(log) ? Files.readString(log) : "<no child output>"));
            }
            Thread.sleep(25);
        }
        throw new AssertionError("timed out waiting for runtime worker marker: "
                + (Files.exists(log) ? Files.readString(log) : "<no child output>"));
    }

    /** Child process boundary: each mode installs independent runtime stores from the same env. */
    public static final class HardRestartWorker {
        private HardRestartWorker() { }

        public static void main(String[] args) throws Exception {
            if (args.length < 3) throw new IllegalArgumentException("mode, root, and marker are required");
            String mode = args[0];
            Path root = Path.of(args[1]);
            Path marker = Path.of(args[2]);
            if (mode.equals("seed")) seed(root, marker);
            else if (mode.equals("recover")) recover(root, marker, args);
            else throw new IllegalArgumentException("unsupported hard-restart mode: " + mode);
        }

        private static void seed(Path root, Path marker) throws Exception {
            AtomicBoolean providerRan = new AtomicBoolean();
            AtomicInteger providerCalls = new AtomicInteger();
            Map<String, String> env = System.getenv();
            AutoCloseable installed = TestAwsStateInstall.install(env);
            try (var artifactStore = new LocalMediaRuntimeSupport.FileArtifactStore(root);
                 var jobStore = new PostgresqlMediaJobStore();
                 var streamStore = new PostgresqlMediaStreamSessionStore();
                 var consentAuthority = new PostgresqlMediaConsentAuthority();
                 var authority = new PostgresqlMediaSourceAuthorizationAuthority(new FlippingPolicy(new AtomicBoolean()));
                 var transcriptStore = new PostgresqlMediaTranscriptStore();
                 var administration = new PostgresqlMediaSourceRightsAdministration();
                 var runtime = runtime(root, artifactStore, jobStore, streamStore, consentAuthority,
                         authority, transcriptStore, List.of(fenceProviderWithCallCount(providerRan, providerCalls)))) {
                MediaArtifact artifact = upload(runtime, "hard-restart");
                seedArtifactRow(artifact, env.get("MEDIA_POSTGRES_JDBC_URL"),
                        env.get("MEDIA_POSTGRES_USER"), env.get("MEDIA_FENCE_DB_PASSWORD"));
                administration.register(register(artifact), authenticated("tenant-a", "principal-a"));
                var accepted = runtime.submit(jobRequest(artifact, "hard-restart"),
                        authenticated("tenant-a", "principal-a"));
                var terminal = await(runtime, accepted.jobId());
                if (terminal.status() != JobStatus.COMPLETED || !providerRan.get() || providerCalls.get() != 1) {
                    throw new AssertionError("synthetic fixture STT did not commit exactly once");
                }
                var revision = transcriptStore.revisions(
                        "tenant-a", "principal-a", "transcript:" + accepted.jobId()).getFirst();
                if (!"ADMITTED".equals(revision.admissionStatus())) {
                    throw new AssertionError("test fixture did not persist through the admitted attempt path");
                }
                Properties identity = new Properties();
                identity.setProperty("tenantId", artifact.tenantId());
                identity.setProperty("principalId", artifact.principalId());
                identity.setProperty("jobId", accepted.jobId());
                identity.setProperty("artifactId", artifact.artifactId());
                identity.setProperty("artifactVersion", artifact.version().value());
                identity.setProperty("artifactSha256", artifact.sha256());
                identity.setProperty("transcriptId", revision.draft().transcriptId());
                identity.setProperty("transcriptVersionRef", "tv-fence-1");
                identity.setProperty("providerCalls", Integer.toString(providerCalls.get()));
                writePropertiesAtomically(marker, identity, "fixture committed");
                // Parent forcibly kills this runtime process after the durable marker is written.
                while (true) Thread.sleep(60_000);
            } finally {
                installed.close();
            }
        }

        private static void recover(Path root, Path marker, String[] args) throws Exception {
            if (args.length != 11) throw new IllegalArgumentException("recovery identity is incomplete");
            String tenant = args[3], principal = args[4], jobId = args[5], artifactId = args[6];
            String artifactVersion = args[7], sha256 = args[8], transcriptId = args[9], versionRef = args[10];
            AtomicBoolean providerRan = new AtomicBoolean();
            AtomicInteger providerCalls = new AtomicInteger();
            Map<String, String> env = System.getenv();
            AutoCloseable installed = TestAwsStateInstall.install(env);
            try (var artifactStore = new LocalMediaRuntimeSupport.FileArtifactStore(root);
                 var jobStore = new PostgresqlMediaJobStore();
                 var streamStore = new PostgresqlMediaStreamSessionStore();
                 var consentAuthority = new PostgresqlMediaConsentAuthority();
                 var authority = new PostgresqlMediaSourceAuthorizationAuthority(new FlippingPolicy(new AtomicBoolean()));
                 var transcriptStore = new PostgresqlMediaTranscriptStore();
                 var runtime = runtime(root, artifactStore, jobStore, streamStore, consentAuthority,
                         authority, transcriptStore, List.of(fenceProviderWithCallCount(providerRan, providerCalls)))) {
                var job = runtime.job(tenant, principal, jobId).orElseThrow();
                if (job.status() != JobStatus.COMPLETED) throw new AssertionError("completed state changed on restart");
                var revisions = transcriptStore.revisions(tenant, principal, transcriptId);
                if (revisions.size() != 1) throw new AssertionError("transcript revision did not read back exactly once");
                var revision = revisions.getFirst();
                if (!"ADMITTED".equals(revision.admissionStatus())
                        || !"fence transcript".equals(revision.draft().text())
                        || !artifactId.equals(revision.draft().sourceArtifactId())
                        || !artifactVersion.equals(revision.draft().sourceVersion())
                        || !sha256.equals(revision.draft().sourceSha256())) {
                    throw new AssertionError("transcript bytes or source lineage changed on restart");
                }
                var version = transcriptStore.revisionByVersionRef(tenant, principal, versionRef).orElseThrow();
                if (!version.equals(revision)) throw new AssertionError("exact version ref resolved another revision");
                var attempt = jobStore.findProcessingAttempt(tenant, jobId, 1).orElseThrow();
                var binding = transcriptStore.readAttemptBinding(tenant, principal, transcriptId, 1);
                if (!"op-fence-1".equals(binding.providerOperationId())
                        || !"receipt-fence-1".equals(binding.providerReceiptId())
                        || !versionRef.equals(binding.transcriptVersionRef())
                        || !artifactVersion.equals(binding.sourceArtifactVersionRef())
                        || !attempt.requestFingerprint().equals(binding.requestFingerprint())) {
                    throw new AssertionError("attempt lineage changed on restart");
                }
                boolean attemptTwoExists = jobStore.findProcessingAttempt(tenant, jobId, 2).isPresent();
                int transcriptOutboxEvents = transcriptOutboxCount(
                        tenant, jobId, env.get("MEDIA_POSTGRES_JDBC_URL"), env.get("MEDIA_POSTGRES_USER"),
                        env.get("MEDIA_FENCE_DB_PASSWORD"));
                int completedJobOutboxEvents = completedJobOutboxCount(
                        tenant, jobId, env.get("MEDIA_POSTGRES_JDBC_URL"), env.get("MEDIA_POSTGRES_USER"),
                        env.get("MEDIA_FENCE_DB_PASSWORD"));
                if (attempt.finality() != AttemptFinality.SUCCEEDED
                        || attemptTwoExists
                        || providerRan.get() || providerCalls.get() != 0
                        || transcriptOutboxEvents != 1 || completedJobOutboxEvents != 1) {
                    throw new AssertionError("provider attempt was replayed or lost after restart");
                }
                byte[] expected = "fence-audio-bytes-hard-restart".getBytes(java.nio.charset.StandardCharsets.UTF_8);
                var content = new java.io.ByteArrayOutputStream();
                var receipt = artifactStore.copyContent(tenant, principal, artifactId,
                        new com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion(artifactVersion),
                        content, expected.length).orElseThrow();
                if (!java.util.Arrays.equals(expected, content.toByteArray())
                        || !sha256.equals(receipt.sha256()) || receipt.bytesCopied() != expected.length) {
                    throw new AssertionError("source artifact bytes/hash/version changed on restart");
                }
                Properties result = new Properties();
                result.setProperty("transcriptText", revision.draft().text());
                result.setProperty("transcriptStatus", revision.admissionStatus());
                result.setProperty("revision", Integer.toString(revision.revision()));
                result.setProperty("sourceArtifactId", revision.draft().sourceArtifactId());
                result.setProperty("sourceVersion", revision.draft().sourceVersion());
                result.setProperty("sourceSha256", revision.draft().sourceSha256());
                result.setProperty("transcriptVersionRef", binding.transcriptVersionRef());
                result.setProperty("providerOperationId", binding.providerOperationId());
                result.setProperty("providerReceiptId", binding.providerReceiptId());
                result.setProperty("providerCalls", Integer.toString(providerCalls.get()));
                result.setProperty("attemptTwoExists", Boolean.toString(attemptTwoExists));
                result.setProperty("transcriptOutboxEvents", Integer.toString(transcriptOutboxEvents));
                result.setProperty("completedJobOutboxEvents", Integer.toString(completedJobOutboxEvents));
                writePropertiesAtomically(marker, result, "fixture recovered");
            } finally {
                installed.close();
            }
        }
    }

    private static void writePropertiesAtomically(Path marker, Properties properties, String comment)
            throws Exception {
        Path temporary = Files.createTempFile(marker.getParent(), marker.getFileName().toString(), ".tmp");
        try {
            try (var output = Files.newOutputStream(temporary)) {
                properties.store(output, comment);
            }
            Files.move(temporary, marker, java.nio.file.StandardCopyOption.ATOMIC_MOVE);
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    @Test
    void policyDenialAfterProviderSuccessDoesNotCommitCompletedJob() throws Exception {
        AtomicBoolean providerRan = new AtomicBoolean();
        Path root = Files.createTempDirectory("media-fence-deny-");
        AutoCloseable installed = TestAwsStateInstall.install(environment());
        try (var artifactStore = new LocalMediaRuntimeSupport.FileArtifactStore(root);
             var jobStore = new PostgresqlMediaJobStore();
             var streamStore = new PostgresqlMediaStreamSessionStore();
             var consentAuthority = new PostgresqlMediaConsentAuthority();
             var authority = new PostgresqlMediaSourceAuthorizationAuthority(
                     new FlippingPolicy(providerRan));
             var transcriptStore = new PostgresqlMediaTranscriptStore();
             var administration = new PostgresqlMediaSourceRightsAdministration();
             var runtime = runtime(root, artifactStore, jobStore, streamStore, consentAuthority,
                     authority, transcriptStore, List.of(fenceProvider(providerRan)))) {
            MediaArtifact artifact = upload(runtime, "deny");
            seedArtifactRow(artifact);
            administration.register(register(artifact), authenticated("tenant-a", "principal-a"));

            var accepted = runtime.submit(jobRequest(artifact, "deny"),
                    authenticated("tenant-a", "principal-a"));
            awaitProviderRan(providerRan);
            var terminal = awaitStatus(runtime, accepted.jobId(), JobStatus.OUTCOME_UNKNOWN);
            // Denial at the fresh authorization boundary fails before the atomic transaction;
            // a completed job cannot exist without its transcript.
            assertThat(terminal.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
            assertThat(providerRan).isTrue();
            assertThat(transcriptStore.revisions(
                    "tenant-a", "principal-a", "transcript:" + accepted.jobId())).isEmpty();
        } finally {
            installed.close();
        }
    }

    @Test
    void transcriptAndJobTerminalRollBackTogetherWhenLifecycleOutboxInsertFails() throws Exception {
        AtomicBoolean providerRan = new AtomicBoolean();
        AtomicInteger providerCalls = new AtomicInteger();
        CountDownLatch allowProviderReturn = new CountDownLatch(1);
        Path root = Files.createTempDirectory("media-fence-atomic-rollback-");
        try (AutoCloseable installed = TestAwsStateInstall.install(environment())) {
            ProcessingJobRequest request;
            String jobId;
            try (var artifactStore = new LocalMediaRuntimeSupport.FileArtifactStore(root);
                 var jobStore = new PostgresqlMediaJobStore();
                 var streamStore = new PostgresqlMediaStreamSessionStore();
                 var consentAuthority = new PostgresqlMediaConsentAuthority();
                 var authority = new PostgresqlMediaSourceAuthorizationAuthority(
                         new FlippingPolicy(new AtomicBoolean()));
                 var transcriptStore = new PostgresqlMediaTranscriptStore();
                 var administration = new PostgresqlMediaSourceRightsAdministration();
                 var runtime = runtime(root, artifactStore, jobStore, streamStore, consentAuthority,
                         authority, transcriptStore,
                         List.of(fenceProvider(providerRan, providerCalls, allowProviderReturn)))) {
                MediaArtifact artifact = upload(runtime, "atomic-rollback");
                seedArtifactRow(artifact);
                administration.register(register(artifact), authenticated("tenant-a", "principal-a"));
                request = jobRequest(artifact, "atomic-rollback");
                var accepted = runtime.submit(request,
                        authenticated("tenant-a", "principal-a"));
                jobId = accepted.jobId();
                awaitProviderRan(providerRan);

                // Force the last operation in the finalization transaction (job lifecycle outbox
                // insert) to violate its unique identity after transcript rows and its outbox row
                // have been inserted in the same transaction.
                insertJobLifecycleOutboxCollision(accepted);
                allowProviderReturn.countDown();
                var stored = awaitStatus(jobStore, "tenant-a", accepted.jobId(), JobStatus.OUTCOME_UNKNOWN);
                assertThat(stored.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
                var attempt = jobStore.findProcessingAttempt("tenant-a", accepted.jobId(), 1).orElseThrow();
                assertThat(attempt.finality()).isEqualTo(AttemptFinality.SUCCEEDED);
                assertThat(attempt.requestId()).isEqualTo(request.requestId());
                assertThat(attempt.providerOperationId()).isEqualTo("op-fence-1");
                assertThat(attempt.providerReceiptId()).isEqualTo("receipt-fence-1");
                assertThat(providerCalls).hasValue(1);
                assertThat(transcriptStore.revisions(
                        "tenant-a", "principal-a", "transcript:" + accepted.jobId())).isEmpty();
                assertThat(transcriptRevisionCount(accepted.jobId())).isZero();
                assertThat(transcriptOutboxCount("tenant-a", accepted.jobId())).isZero();
                assertThat(completedJobOutboxCount("tenant-a", accepted.jobId())).isEqualTo(1);
                assertThat(outboxEventCount("media:media.job.completed:" + accepted.jobId() + ":"
                        + (accepted.version() + 2))).isZero();
            } finally {
                allowProviderReturn.countDown();
            }

            // Reconstruct the runtime over the same durable state. The provider has a SUCCEEDED
            // receipt, but the lifecycle outbox collision left its job OUTCOME_UNKNOWN and the
            // transaction produced no transcript. Replaying the exact request must preserve that
            // result without dispatching the fixture provider again.
            try (AutoCloseable reinstalled = TestAwsStateInstall.install(environment());
                 var artifactStore = new LocalMediaRuntimeSupport.FileArtifactStore(root);
                 var jobStore = new PostgresqlMediaJobStore();
                 var streamStore = new PostgresqlMediaStreamSessionStore();
                 var consentAuthority = new PostgresqlMediaConsentAuthority();
                 var authority = new PostgresqlMediaSourceAuthorizationAuthority(
                         new FlippingPolicy(new AtomicBoolean()));
                 var transcriptStore = new PostgresqlMediaTranscriptStore();
                 var runtime = runtime(root, artifactStore, jobStore, streamStore, consentAuthority,
                         authority, transcriptStore,
                         List.of(fenceProviderWithCallCount(providerRan, providerCalls)))) {
                var recovered = runtime.job("tenant-a", "principal-a", jobId).orElseThrow();
                assertThat(recovered.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
                var attempt = jobStore.findProcessingAttempt("tenant-a", jobId, 1).orElseThrow();
                assertThat(attempt.finality()).isEqualTo(AttemptFinality.SUCCEEDED);
                assertThat(attempt.requestId()).isEqualTo(request.requestId());
                assertThat(attempt.providerOperationId()).isEqualTo("op-fence-1");
                assertThat(attempt.providerReceiptId()).isEqualTo("receipt-fence-1");
                assertThat(transcriptStore.revisions(
                        "tenant-a", "principal-a", "transcript:" + jobId)).isEmpty();

                var replay = runtime.submit(request, authenticated("tenant-a", "principal-a"));
                assertThat(replay.jobId()).isEqualTo(jobId);
                assertThat(replay.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
                assertThat(providerCalls).hasValue(1);
                assertThat(transcriptOutboxCount("tenant-a", jobId)).isZero();
            }
        }
    }

    @Test
    void abandonedAttemptReconcilesToUnknownOnRestartAndLeavesNoTranscript() throws Exception {
        AtomicBoolean providerRan = new AtomicBoolean();
        Path root = Files.createTempDirectory("media-fence-kill-");
        AutoCloseable installed = TestAwsStateInstall.install(environment());
        String jobId;
        try {
            try (var artifactStore = new LocalMediaRuntimeSupport.FileArtifactStore(root);
                 var jobStore = new PostgresqlMediaJobStore();
                 var streamStore = new PostgresqlMediaStreamSessionStore();
                 var consentAuthority = new PostgresqlMediaConsentAuthority();
                 var authority = new PostgresqlMediaSourceAuthorizationAuthority(
                         new FlippingPolicy(new AtomicBoolean()));
                 var transcriptStore = new PostgresqlMediaTranscriptStore();
                 var administration = new PostgresqlMediaSourceRightsAdministration();
                 var runtime = runtime(root, artifactStore, jobStore, streamStore,
                         consentAuthority, authority, transcriptStore,
                         List.of(blockingProvider(providerRan)))) {
                MediaArtifact artifact = upload(runtime, "kill");
                seedArtifactRow(artifact);
                administration.register(register(artifact),
                        authenticated("tenant-a", "principal-a"));
                var accepted = runtime.submit(jobRequest(artifact, "kill"),
                        authenticated("tenant-a", "principal-a"));
                jobId = accepted.jobId();
                for (int i = 0; i < 240 && !providerRan.get(); i++) {
                    Thread.sleep(250);
                }
                assertThat(providerRan).as("attempt dispatched before close").isTrue();
                // Leaving the try closes the runtime while the attempt is still in flight:
                // no terminal write happens. Expiring the lease models the crashed worker's
                // claim timing out, which is what a fresh runtime recovers from.
                expireLease(jobId);
            }

            // A fresh installation and runtime over the same durable state reconciles the
            // abandoned RUNNING row to OUTCOME_UNKNOWN and never produces a transcript.
            try (AutoCloseable reinstalled = TestAwsStateInstall.install(environment());
                 var artifactStoreB = new LocalMediaRuntimeSupport.FileArtifactStore(root);
                 var jobStoreB = new PostgresqlMediaJobStore();
                 var streamStoreB = new PostgresqlMediaStreamSessionStore();
                 var consentAuthorityB = new PostgresqlMediaConsentAuthority();
                 var authorityB = new PostgresqlMediaSourceAuthorizationAuthority(
                         new FlippingPolicy(new AtomicBoolean()));
                 var transcriptStoreB = new PostgresqlMediaTranscriptStore();
                 var runtimeB = runtime(root, artifactStoreB, jobStoreB, streamStoreB,
                         consentAuthorityB, authorityB, transcriptStoreB, List.of())) {
                var reconciled = runtimeB.job("tenant-a", "principal-a", jobId).orElseThrow();
                assertThat(reconciled.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
                assertThat(transcriptStoreB.revisions(
                        "tenant-a", "principal-a", "transcript:" + jobId)).isEmpty();
            }
        } finally {
            installed.close();
        }
    }

    @Test
    void confirmedCancellationPersistsOutboxAndRemainsTerminalAfterRestart() throws Exception {
        AtomicBoolean providerRan = new AtomicBoolean();
        AtomicInteger providerCancelCalls = new AtomicInteger();
        Path root = Files.createTempDirectory("media-fence-cancel-");
        AutoCloseable installed = TestAwsStateInstall.install(environment());
        String jobId;
        try {
            try (var artifactStore = new LocalMediaRuntimeSupport.FileArtifactStore(root);
                 var jobStore = new PostgresqlMediaJobStore();
                 var streamStore = new PostgresqlMediaStreamSessionStore();
                 var consentAuthority = new PostgresqlMediaConsentAuthority();
                 var authority = new PostgresqlMediaSourceAuthorizationAuthority(
                         new FlippingPolicy(new AtomicBoolean()));
                 var transcriptStore = new PostgresqlMediaTranscriptStore();
                 var administration = new PostgresqlMediaSourceRightsAdministration();
                 var runtime = runtime(root, artifactStore, jobStore, streamStore,
                         consentAuthority, authority, transcriptStore,
                         List.of(blockingProvider(providerRan, CancellationOutcome.CONFIRMED,
                                 providerCancelCalls)))) {
                MediaArtifact artifact = upload(runtime, "cancel");
                seedArtifactRow(artifact);
                administration.register(register(artifact), authenticated("tenant-a", "principal-a"));

                var accepted = runtime.submit(jobRequest(artifact, "cancel"),
                        authenticated("tenant-a", "principal-a"));
                jobId = accepted.jobId();
                for (int i = 0; i < 240 && !providerRan.get(); i++) {
                    Thread.sleep(250);
                }
                assertThat(providerRan).as("provider attempt dispatched before cancel").isTrue();

                var cancelled = runtime.cancel("tenant-a", "principal-a", jobId);
                assertThat(cancelled.status()).isEqualTo(JobStatus.CANCELLED);
                assertThat(providerCancelCalls).hasValue(1);
                assertThat(transcriptStore.revisions(
                        "tenant-a", "principal-a", "transcript:" + jobId)).isEmpty();
            }

            // The PostgreSQL row and outbox entry survive runtime/store close. Repeating
            // cancellation after restart is an idempotent terminal read and never calls a
            // provider again or creates a second cancellation event.
            try (AutoCloseable reinstalled = TestAwsStateInstall.install(environment());
                 var artifactStore = new LocalMediaRuntimeSupport.FileArtifactStore(root);
                 var jobStore = new PostgresqlMediaJobStore();
                 var streamStore = new PostgresqlMediaStreamSessionStore();
                 var consentAuthority = new PostgresqlMediaConsentAuthority();
                 var authority = new PostgresqlMediaSourceAuthorizationAuthority(
                         new FlippingPolicy(new AtomicBoolean()));
                 var transcriptStore = new PostgresqlMediaTranscriptStore();
                 var runtime = runtime(root, artifactStore, jobStore, streamStore,
                         consentAuthority, authority, transcriptStore, List.of())) {
                var persisted = runtime.job("tenant-a", "principal-a", jobId).orElseThrow();
                assertThat(persisted.status()).isEqualTo(JobStatus.CANCELLED);
                assertThat(runtime.cancel("tenant-a", "principal-a", jobId).status())
                        .isEqualTo(JobStatus.CANCELLED);
                assertThat(providerCancelCalls).hasValue(1);
            }
            // A cancellation must be represented in the durable lifecycle outbox along
            // with its terminal state so downstream consumers can recover after restart.
            assertThat(outboxEventCount("tenant-a", "principal-a", jobId,
                    "MEDIA_JOB_CANCELLED")).isEqualTo(1);
        } finally {
            installed.close();
        }
    }

    private static MediaRuntime runtime(
            Path root,
            LocalMediaRuntimeSupport.FileArtifactStore artifactStore,
            PostgresqlMediaJobStore jobStore,
            PostgresqlMediaStreamSessionStore streamStore,
            PostgresqlMediaConsentAuthority consentAuthority,
            PostgresqlMediaSourceAuthorizationAuthority authority,
            PostgresqlMediaTranscriptStore transcriptStore,
            List<MediaProcessingProvider> providers) throws Exception {
        return new MediaRuntime(
                new MediaRuntimeConfig(true, "test", 8093, 8 * 1024 * 1024,
                        4 * 1024 * 1024, 64L * 1024 * 1024, Duration.ofMinutes(4), 4,
                        "", "", false, false, root),
                artifactStore, jobStore, streamStore, consentAuthority,
                MediaSemanticRedactionRuntime.disabled(Duration.ofSeconds(2)),
                MediaLifecyclePublisher.disabled(), providers,
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()),
                List.of(), authority, transcriptStore, Clock.systemUTC());
    }

    private static MediaProcessingProvider fenceProvider(AtomicBoolean ran) {
        return fenceProvider(ran, null);
    }

    private static MediaProcessingProvider fenceProviderWithCallCount(
            AtomicBoolean ran, AtomicInteger calls) {
        return fenceProvider(ran, calls, null);
    }

    private static MediaProcessingProvider fenceProvider(AtomicBoolean ran, CountDownLatch allowReturn) {
        return fenceProvider(ran, null, allowReturn);
    }

    private static MediaProcessingProvider fenceProvider(
            AtomicBoolean ran, AtomicInteger calls, CountDownLatch allowReturn) {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return "stt-fence-fixture"; }
            @Override public String providerVersion() { return "v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.SPEECH_TO_TEXT); }
            @Override public java.util.Optional<MediaSpeechToTextAdmission.Profile> speechToTextProfile() {
                return java.util.Optional.of(new MediaSpeechToTextAdmission.Profile(
                        "stt-fence-fixture", "v1", "fence-profile", "v1",
                        "sha256:" + "a".repeat(64),
                        MediaSpeechToTextAdmission.ProfileQualification.QUALIFIED,
                        Set.of("en-US"), false,
                        MediaSpeechToTextAdmission.TimingDisposition.SOURCE_CLOCK_BOUND,
                        "fixture-qualification-evidence"));
            }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 0; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public String processingRegion() { return "local"; }
            @Override public ProviderDataRetention providerDataRetention() {
                return ProviderDataRetention.NONE;
            }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                return CompletableFuture.failedFuture(
                        new AssertionError("durable dispatch must use the typed attempt path"));
            }
            @Override public CompletableFuture<ProviderSubmission> processAttempt(
                    ProcessingContext context, ProviderAttemptContext attempt) {
                ran.set(true);
                if (calls != null) calls.incrementAndGet();
                if (allowReturn != null) {
                    return CompletableFuture.supplyAsync(() -> {
                        try { allowReturn.await(); }
                        catch (InterruptedException interrupted) {
                            Thread.currentThread().interrupt();
                            throw new IllegalStateException("fixture provider interrupted", interrupted);
                        }
                        return successfulFenceSubmission(context, attempt);
                    });
                }
                return CompletableFuture.completedFuture(successfulFenceSubmission(context, attempt));
            }
            private ProviderSubmission successfulFenceSubmission(
                    ProcessingContext context, ProviderAttemptContext attempt) {
                String fingerprint = attempt.requestFingerprint();
                return new ProviderSubmission(
                        AttemptFinality.SUCCEEDED, "op-fence-1", "receipt-fence-1",
                        Map.of("text", "fence transcript",
                                "semanticObservations", Map.of(
                                        "requestFingerprint", fingerprint,
                                        "glossaryApplication", Map.of(
                                                "disposition", "NOT_REQUESTED"),
                                        "transcriptResponse", Map.of(
                                                "sourceArtifactVersionRef",
                                                context.artifact().version().value(),
                                                "requestFingerprint", fingerprint,
                                                "transcriptVersionRef", "tv-fence-1",
                                                "glossaryDisposition", "NOT_REQUESTED",
                                                "transcriptText", "fence transcript"))),
                        "a".repeat(64), Instant.now());
            }
        };
    }

    private static void awaitProviderRan(AtomicBoolean providerRan) throws Exception {
        for (int i = 0; i < 200 && !providerRan.get(); i++) Thread.sleep(25);
        assertThat(providerRan).isTrue();
    }

    private static ProcessingJob awaitStatus(
            MediaRuntime runtime, String jobId, JobStatus expected) throws Exception {
        for (int i = 0; i < 200; i++) {
            ProcessingJob current = runtime.job("tenant-a", "principal-a", jobId).orElseThrow();
            if (current.status() == expected) return current;
            if (current.status() == JobStatus.COMPLETED || current.status() == JobStatus.FAILED
                    || current.status() == JobStatus.CANCELLED || current.status() == JobStatus.OUTCOME_UNKNOWN) {
                throw new AssertionError("job reached unexpected terminal state: " + current.status());
            }
            Thread.sleep(25);
        }
        throw new AssertionError("job did not reach expected status " + expected);
    }

    private static ProcessingJob awaitStatus(
            PostgresqlMediaJobStore store, String tenantId, String jobId, JobStatus expected) throws Exception {
        for (int i = 0; i < 200; i++) {
            ProcessingJob current = store.find(tenantId, jobId).orElseThrow();
            if (current.status() == expected) return current;
            if (current.status() == JobStatus.COMPLETED || current.status() == JobStatus.FAILED
                    || current.status() == JobStatus.CANCELLED || current.status() == JobStatus.OUTCOME_UNKNOWN) {
                throw new AssertionError("job reached unexpected terminal state: " + current.status());
            }
            Thread.sleep(25);
        }
        throw new AssertionError("job did not reach expected status " + expected);
    }

    private static void insertJobLifecycleOutboxCollision(ProcessingJob accepted) throws Exception {
        try (var connection = java.sql.DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement("""
                     INSERT INTO media_processing_lifecycle_outbox
                       (event_id,tenant_id,aggregate_type,aggregate_id,aggregate_version,event_type,
                        payload_json,classification,created_at,published_at,attempts,last_error)
                     VALUES (?,?,?,?,?,?,?,'CONFIDENTIAL',?,NULL,0,NULL)
                     """)) {
            statement.setString(1, "collision:" + accepted.jobId());
            statement.setString(2, accepted.tenantId());
            statement.setString(3, "job");
            statement.setString(4, accepted.jobId());
            statement.setLong(5, accepted.version() + 2);
            statement.setString(6, "media.job.completed");
            statement.setString(7, "{}");
            statement.setLong(8, System.currentTimeMillis());
            statement.executeUpdate();
        }
    }

    private static int transcriptOutboxCount(String tenantId, String jobId) throws Exception {
        return transcriptOutboxCount(
                tenantId, jobId, POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
    }

    private static int transcriptOutboxCount(
            String tenantId, String jobId, String jdbcUrl, String username, String password) throws Exception {
        try (var connection = java.sql.DriverManager.getConnection(
                jdbcUrl, username, password);
             var statement = connection.prepareStatement(
                     "SELECT COUNT(*) FROM media_processing_lifecycle_outbox WHERE tenant_id=? "
                             + "AND aggregate_type='transcript' AND aggregate_id=?")) {
            statement.setString(1, tenantId);
            statement.setString(2, "transcript:" + jobId);
            try (var result = statement.executeQuery()) {
                result.next();
                return result.getInt(1);
            }
        }
    }

    private static int transcriptRevisionCount(String jobId) throws Exception {
        try (var connection = java.sql.DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement(
                     "SELECT COUNT(*) FROM media_transcript_revisions WHERE job_id=?")) {
            statement.setString(1, jobId);
            try (var result = statement.executeQuery()) {
                result.next();
                return result.getInt(1);
            }
        }
    }

    private static int completedJobOutboxCount(String tenantId, String jobId) throws Exception {
        return completedJobOutboxCount(
                tenantId, jobId, POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
    }

    private static int completedJobOutboxCount(
            String tenantId, String jobId, String jdbcUrl, String username, String password) throws Exception {
        try (var connection = java.sql.DriverManager.getConnection(
                jdbcUrl, username, password);
             var statement = connection.prepareStatement("""
                     SELECT COUNT(*) FROM media_processing_lifecycle_outbox
                      WHERE tenant_id=? AND aggregate_type='job' AND aggregate_id=?
                        AND event_type='media.job.completed'
                     """)) {
            statement.setString(1, tenantId);
            statement.setString(2, jobId);
            try (var result = statement.executeQuery()) {
                result.next();
                return result.getInt(1);
            }
        }
    }

    private static int outboxEventCount(String eventId) throws Exception {
        try (var connection = java.sql.DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement(
                     "SELECT COUNT(*) FROM media_processing_lifecycle_outbox WHERE event_id=?")) {
            statement.setString(1, eventId);
            try (var result = statement.executeQuery()) {
                result.next();
                return result.getInt(1);
            }
        }
    }

    private static MediaProcessingProvider blockingProvider(AtomicBoolean ran) {
        return blockingProvider(ran, CancellationOutcome.UNSUPPORTED, new AtomicInteger());
    }

    private static MediaProcessingProvider blockingProvider(
            AtomicBoolean ran, CancellationOutcome cancellationOutcome, AtomicInteger cancelCalls) {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return "stt-fence-fixture"; }
            @Override public String providerVersion() { return "v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.SPEECH_TO_TEXT); }
            @Override public java.util.Optional<MediaSpeechToTextAdmission.Profile> speechToTextProfile() {
                return java.util.Optional.of(new MediaSpeechToTextAdmission.Profile(
                        "stt-fence-fixture", "v1", "fence-profile", "v1",
                        "sha256:" + "a".repeat(64),
                        MediaSpeechToTextAdmission.ProfileQualification.QUALIFIED,
                        Set.of("en-US"), false,
                        MediaSpeechToTextAdmission.TimingDisposition.SOURCE_CLOCK_BOUND,
                        "fixture-qualification-evidence"));
            }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 0; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public String processingRegion() { return "local"; }
            @Override public ProviderDataRetention providerDataRetention() {
                return ProviderDataRetention.NONE;
            }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                return new CompletableFuture<>();
            }
            @Override public CompletableFuture<ProviderSubmission> processAttempt(
                    ProcessingContext context, ProviderAttemptContext attempt) {
                ran.set(true);
                return new CompletableFuture<>();
            }
            @Override public CancellationOutcome cancel(
                    String tenantId, String principalId, String correlationId, String jobId) {
                cancelCalls.incrementAndGet();
                return cancellationOutcome;
            }
        };
    }

    private static int outboxEventCount(
            String tenantId, String principalId, String jobId, String eventType) throws Exception {
        try (var connection = java.sql.DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement(
                     "SELECT payload_json FROM media_lifecycle_outbox "
                             + "WHERE tenant_id=? AND subject_id=? AND event_type=?")) {
            statement.setString(1, tenantId);
            statement.setString(2, principalId);
            statement.setString(3, eventType);
            try (var result = statement.executeQuery()) {
                int matches = 0;
                var mapper = new tools.jackson.databind.ObjectMapper();
                while (result.next()) {
                    if (jobId.equals(mapper.readTree(result.getString(1)).path("jobId").asString())) {
                        matches++;
                    }
                }
                return matches;
            }
        }
    }

    private static MediaArtifact upload(MediaRuntime runtime, String tag) throws Exception {
        byte[] wav = ("fence-audio-bytes-" + tag)
                .getBytes(java.nio.charset.StandardCharsets.UTF_8);
        String wavSha = HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(wav));
        var upload = runtime.beginUpload(new UploadRequest(
                "tenant-a", "principal-a", "fence.wav", "audio/wav", wav.length, wavSha,
                "CONFIDENTIAL", Duration.ofMinutes(30), Map.of(
                        "sourceClockId", "fixture-clock",
                        "sourceClockMappingEvidenceRef", "fixture-clock-evidence",
                        "sourceClockTicksPerSecond", 1,
                        "sourceDurationTicks", wav.length / 2)), "fence-upload-" + tag);
        runtime.appendChunk("tenant-a", "principal-a", upload.uploadId(), 0, wav);
        return runtime.completeUpload("tenant-a", "principal-a", upload.uploadId());
    }

    private static MediaSourceRightsAdministration.RegisterRequest register(MediaArtifact artifact) {
        return new MediaSourceRightsAdministration.RegisterRequest(
                "tenant-a", "principal-a", artifact.artifactId(), artifact.version().value(),
                artifact.sha256(), "principal-a",
                MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                MediaSourceAuthorizationContracts.HumanConsentDisposition
                        .NOT_APPLICABLE_HUMAN_CONSENT,
                "", Set.of("speech_to_text"), Set.of("transcription"), Set.of("local"),
                Set.of(ProviderDataRetention.NONE), "fixture-clock-evidence",
                "provenance://fixture/fence", Instant.now().plusSeconds(3600), "corr-fence");
    }

    private static ProcessingJobRequest jobRequest(MediaArtifact artifact, String tag) {
        return new ProcessingJobRequest(
                "fence-stt-" + tag, "tenant-a", "principal-a", "correlation-fence-" + tag,
                artifact.artifactId(), artifact.version().value(), JobType.SPEECH_TO_TEXT,
                "stt-fence-fixture", Map.of(
                        "profileId", "fence-profile",
                        "profileVersion", "v1",
                        "profileConfigurationDigest", "sha256:" + "a".repeat(64),
                        "languageIntent", Map.of("mode", "EXPLICIT", "languageTag", "en-US")),
                new MediaGovernanceContext("", "transcription", DataClassification.CONFIDENTIAL,
                        "local", Set.of("local"), false, "short-lived-media", false, false, "",
                        BiometricSensitivity.NONE, AutomationRisk.ASSISTIVE));
    }

    private static MediaSourceAuthorizationContracts.AuthenticatedPrincipal authenticated(
            String tenantId, String principalId) {
        return new MediaSourceAuthorizationContracts.AuthenticatedPrincipal(
                tenantId, principalId, Instant.now());
    }

    private static ProcessingJob await(MediaRuntime runtime, String jobId) throws Exception {
        for (int i = 0; i < 240; i++) {
            var job = runtime.job("tenant-a", "principal-a", jobId);
            if (job.isPresent() && (job.get().status() == JobStatus.COMPLETED
                    || job.get().status() == JobStatus.FAILED)) {
                return job.get();
            }
            Thread.sleep(250);
        }
        throw new AssertionError("STT job did not reach a terminal state");
    }

    /** Models the crashed worker's lease timing out so a fresh runtime can recover the row. */
    private static void expireLease(String jobId) throws Exception {
        try (var connection = java.sql.DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement(
                     "UPDATE media_processing_jobs SET lease_expires_at=0 WHERE job_id=?")) {
            statement.setString(1, jobId);
            assertThat(statement.executeUpdate()).isEqualTo(1);
        }
    }

    /** Mirrors the artifact store's durable admission record for the fixture upload. */
    private static void seedArtifactRow(MediaArtifact artifact) throws Exception {
        seedArtifactRow(artifact, POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
    }

    private static void seedArtifactRow(
            MediaArtifact artifact, String jdbcUrl, String username, String password) throws Exception {
        try (var connection = java.sql.DriverManager.getConnection(
                jdbcUrl, username, password);
             var statement = connection.prepareStatement(
                     "INSERT INTO media_artifacts (tenant_id,artifact_id,principal_id,file_name,"
                             + "content_type,size_bytes,sha256,object_reference,classification,"
                             + "created_at,expires_at,metadata_json,scan_status,"
                             + "scan_policy_version,scanner_id,scanned_at) "
                             + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'CLEAN',?,?,?)")) {
            statement.setString(1, artifact.tenantId());
            statement.setString(2, artifact.artifactId());
            statement.setString(3, artifact.principalId());
            statement.setString(4, artifact.fileName());
            statement.setString(5, artifact.contentType());
            statement.setLong(6, artifact.sizeBytes());
            statement.setString(7, artifact.sha256());
            statement.setString(8, artifact.objectReference());
            statement.setString(9, artifact.classification());
            statement.setLong(10, artifact.createdAt().toEpochMilli());
            statement.setLong(11, artifact.expiresAt().toEpochMilli());
            statement.setString(12, "{\"sourceClockId\":\"fixture-clock\","
                    + "\"sourceClockMappingEvidenceRef\":\"fixture-clock-evidence\","
                    + "\"sourceClockTicksPerSecond\":1,"
                    + "\"sourceDurationTicks\":" + artifact.sizeBytes() / 2 + "}");
            statement.setString(13, "fixture-scan-policy/v1");
            statement.setString(14, "fixture-scanner/v1");
            statement.setLong(15, Instant.now().toEpochMilli());
            statement.executeUpdate();
        }
    }

    private static Map<String, String> environment() {
        Map<String, String> env = new java.util.HashMap<>();
        env.put("MEDIA_RUNTIME_ENABLED", "true");
        env.put("MEDIA_RUNTIME_ENVIRONMENT", "integration");
        env.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        env.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        env.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_FENCE_DB_PASSWORD");
        env.put("MEDIA_FENCE_DB_PASSWORD", POSTGRES.getPassword());
        env.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        env.put("MEDIA_POSTGRES_POOL_SIZE", "4");
        env.put("MEDIA_S3_BUCKET", "media-fence-stt");
        env.put("MEDIA_S3_REGION", "us-east-1");
        env.put("MEDIA_S3_ENDPOINT", stubUrl);
        env.put("MEDIA_S3_PATH_STYLE", "true");
        env.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_FENCE_ACCESS");
        env.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_FENCE_SECRET");
        env.put("MEDIA_FENCE_ACCESS", "fence-access");
        env.put("MEDIA_FENCE_SECRET", "fence-secret");
        return env;
    }

    /** Deterministic Shared policy: ALLOW until the provider executes, then DENY. */
    private static final class FlippingPolicy implements PolicyEngine {
        private final AtomicBoolean providerRan;

        FlippingPolicy(AtomicBoolean providerRan) {
            this.providerRan = providerRan;
        }

        @Override public CompletionStage<PolicyDecisionRecord> evaluate(
                com.ghatana.governance.PolicyEvaluationRequest request) {
            PolicyEvaluationContext context = new PolicyEvaluationContext(
                    request.principalId(), request.tenantId(), request.actionClass(),
                    request.targetType(), request.targetId(), request.toolId(),
                    request.criticality(), request.reversibility(), request.attributes(),
                    Instant.now(), request.correlationId(), request.verifiedContext());
            boolean deny = providerRan.get();
            return CompletableFuture.completedFuture(new PolicyDecisionRecord(
                    "policy-decision-fence", deny
                            ? PolicyDecisionOutcome.DENY : PolicyDecisionOutcome.ALLOW,
                    List.of("policy-v1:rule-media"), List.of("rule-media"),
                    List.of("fence policy evaluation"), context, Instant.now(), null,
                    "policy-v1", List.of(deny
                            ? PolicyReasonCode.POLICY_DENIED : PolicyReasonCode.POLICY_ALLOWED)));
        }

        @Override public CompletionStage<Boolean> policyExists(String policyId) {
            return CompletableFuture.completedFuture("policy-v1".equals(policyId));
        }

        @Override public CompletionStage<Boolean> policyExists(String policyId, String version) {
            return policyExists(policyId);
        }

        @Override public boolean isOpen() { return true; }

        @Override public void close() { }

        @Override public com.ghatana.governance.PolicyEngineLifecycle.State lifecycleState() {
            return com.ghatana.governance.PolicyEngineLifecycle.State.OPEN;
        }

        @Override public long inFlightEvaluations() { return 0; }

        @Override public com.ghatana.governance.PolicyEngineLifecycle.Result drain(Duration timeout) {
            return new com.ghatana.governance.PolicyEngineLifecycle.Result(
                    com.ghatana.governance.PolicyEngineLifecycle.State.DRAINED, 0);
        }

        @Override public com.ghatana.governance.PolicyEngineLifecycle.Result close(Duration timeout) {
            return new com.ghatana.governance.PolicyEngineLifecycle.Result(
                    com.ghatana.governance.PolicyEngineLifecycle.State.CLOSED, 0);
        }
    }
}
