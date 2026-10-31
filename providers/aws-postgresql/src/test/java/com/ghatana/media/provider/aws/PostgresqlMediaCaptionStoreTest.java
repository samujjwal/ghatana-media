package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaCaptionContracts;
import com.ghatana.media.runtime.MediaCaptionContracts.CaptionSegment;
import com.ghatana.media.runtime.MediaCaptionContracts.LanguageDisposition;
import com.ghatana.media.runtime.MediaCaptionContracts.ParentClockLookup;
import com.ghatana.media.runtime.MediaCaptionContracts.ParentVersionKind;
import com.ghatana.media.runtime.MediaCaptionContracts.Registered;
import com.ghatana.media.runtime.MediaCaptionContracts.RegistrationAuthority;
import com.ghatana.media.runtime.MediaCaptionContracts.RegistrationError;
import com.ghatana.media.runtime.MediaCaptionContracts.RegistrationRequest;
import com.ghatana.media.runtime.MediaCaptionContracts.RegistrationResult;
import com.ghatana.media.runtime.MediaCaptionContracts.Rejected;
import com.ghatana.media.runtime.MediaCaptionContracts.SegmentOrigin;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@Testcontainers(disabledWithoutDocker = true)
class PostgresqlMediaCaptionStoreTest {

    @Container static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices("s3");

    private static final RegistrationAuthority ADMITTED =
            check -> RegistrationAuthority.Decision.ADMITTED;
    private static final ParentClockLookup PARENT = (kind, parentId, sourceId, sourceVersion) ->
            Optional.of(new ParentClockLookup.ParentFacts("clock.v1", 90_000, 9_000_000));

    @Test
    void registersImmutableVersionAndReplaysSameRequestIdentically() throws Exception {
        try (Fixture f = openFixture()) {
            RegistrationRequest request = request("req-1");
            RegistrationResult first = f.store().register("tenant-1", "principal-1", request, ADMITTED, PARENT);
            assertThat(first).isInstanceOf(Registered.class);
            Registered registered = (Registered) first;
            assertThat(registered.requestId()).isEqualTo("req-1");
            assertThat(registered.requestFingerprint()).hasSize(64);
            assertThat(registered.captionVersionId()).startsWith("capv-");
            assertThat(registered.registrationReceiptId()).startsWith("capreg-");

            RegistrationResult replay = f.store().register("tenant-1", "principal-1", request, ADMITTED, PARENT);
            assertThat(replay).isEqualTo(first); // same key+fingerprint: original receipt, no second version
            assertThat(f.store().versions("tenant-1", "principal-1", "artifact-1", "src-v1"))
                    .extracting(Registered::captionVersionId).containsExactly(registered.captionVersionId());
        }
    }

    @Test
    void sameRequestKeyWithDifferentFingerprintIsConflictNotDuplicateVersion() throws Exception {
        try (Fixture f = openFixture()) {
            assertThat(f.store().register("tenant-1", "principal-1", request("req-1"), ADMITTED, PARENT))
                    .isInstanceOf(Registered.class);
            RegistrationRequest changed = new RegistrationRequest("req-1", "artifact-1", "src-v1",
                    ParentVersionKind.TRANSCRIPT_VERSION, "transcript-v1", "clock.v1", 90_000, 9_000_000,
                    LanguageDisposition.DECLARED_BY_USER, Optional.of("en"),
                    List.of(CaptionSegment.of("seg-1", "different", 10, 900, SegmentOrigin.USER_EDITED)),
                    Optional.empty());
            RegistrationResult conflict = f.store().register("tenant-1", "principal-1", changed, ADMITTED, PARENT);
            assertThat(conflict).isInstanceOf(Rejected.class);
            assertThat(((Rejected) conflict).error()).isEqualTo(RegistrationError.IDEMPOTENCY_CONFLICT);
            assertThat(f.store().versions("tenant-1", "principal-1", "artifact-1", "src-v1")).hasSize(1);
        }
    }

    @Test
    void authorityDenialAndMissingOrMismatchedParentClockFailClosedWithoutWrites() throws Exception {
        try (Fixture f = openFixture()) {
            java.util.function.Function<String, RegistrationRequest> deny = requestId -> new RegistrationRequest(
                    requestId, "artifact-1", "src-deny", ParentVersionKind.TRANSCRIPT_VERSION, "transcript-v1",
                    "clock.v1", 90_000, 9_000_000, LanguageDisposition.DECLARED_BY_USER, Optional.of("en"),
                    segments(), Optional.empty());
            Rejected denied = (Rejected) f.store().register("tenant-1", "principal-1", deny.apply("req-d1"),
                    check -> RegistrationAuthority.Decision.DENIED, PARENT);
            assertThat(denied.error()).isEqualTo(RegistrationError.VERSION_REGISTRATION_NOT_ALLOWED);

            Rejected noParent = (Rejected) f.store().register("tenant-1", "principal-1", deny.apply("req-d2"),
                    ADMITTED, (kind, parentId, s, v) -> Optional.empty());
            assertThat(noParent.error()).isEqualTo(RegistrationError.SOURCE_NOT_READY);

            Rejected clock = (Rejected) f.store().register("tenant-1", "principal-1", deny.apply("req-d3"), ADMITTED,
                    (kind, parentId, s, v) -> Optional.of(new ParentClockLookup.ParentFacts("clock.other", 90_000, 9_000_000)));
            assertThat(clock.error()).isEqualTo(RegistrationError.CAPTION_ALIGNMENT_REQUIRED);

            assertThat(f.store().versions("tenant-1", "principal-1", "artifact-1", "src-deny")).isEmpty();
        }
    }

    @Test
    void versionsAreScopedToExactTenantPrincipalAndSourceVersion() throws Exception {
        try (Fixture f = openFixture()) {
            f.store().register("tenant-1", "principal-1", request("req-1"), ADMITTED, PARENT);
            f.store().register("tenant-1", "principal-2", request("req-1"), ADMITTED, PARENT);
            RegistrationRequest otherSource = new RegistrationRequest("req-9", "artifact-1", "src-v2",
                    ParentVersionKind.TRANSCRIPT_VERSION, "transcript-v1", "clock.v1", 90_000, 9_000_000,
                    LanguageDisposition.DECLARED_BY_USER, Optional.of("en"), segments(), Optional.empty());
            f.store().register("tenant-1", "principal-1", otherSource, ADMITTED, PARENT);
            assertThat(f.store().versions("tenant-1", "principal-1", "artifact-1", "src-v1")).hasSize(1);
            assertThat(f.store().versions("tenant-1", "principal-2", "artifact-1", "src-v1")).hasSize(1);
            assertThat(f.store().versions("tenant-1", "principal-1", "artifact-1", "src-v2")).hasSize(1);
            assertThat(f.store().versions("tenant-2", "principal-1", "artifact-1", "src-v1")).isEmpty();
        }
    }

    @Test
    void snapshotReadbackReturnsImmutableSegmentsAndParentClockFacts() throws Exception {
        try (Fixture f = openFixture()) {
            RegistrationResult first = f.store().register("tenant-1", "principal-1", request("req-1"), ADMITTED, PARENT);
            String versionId = ((Registered) first).captionVersionId();

            var snapshot = f.store().version("tenant-1", "principal-1", versionId);
            assertThat(snapshot).isPresent();
            assertThat(snapshot.get().captionSegments()).isEqualTo(segments());
            assertThat(snapshot.get().ticksPerSecond()).isEqualTo(90_000);
            assertThat(snapshot.get().sourceClockId()).isEqualTo("clock.v1");
            assertThat(f.store().version("tenant-2", "principal-1", versionId)).isEmpty();
            assertThat(f.store().version("tenant-1", "principal-2", versionId)).isEmpty();

            var clock = f.store().parentClock("tenant-1", "principal-1", versionId, "artifact-1", "src-v1");
            assertThat(clock).isPresent();
            assertThat(clock.get().ticksPerSecond()).isEqualTo(90_000);
            assertThat(clock.get().sourceDurationTicks()).isEqualTo(9_000_000);
            assertThat(f.store().parentClock("tenant-1", "principal-1", versionId, "artifact-1", "src-v2")).isEmpty();
        }
    }

    @Test
    void fingerprintIsDeterministicAndPresenceSensitive() {
        RegistrationRequest base = request("req-1");
        String a = MediaCaptionContracts.fingerprint("t", "p", base);
        assertThat(a).isEqualTo(MediaCaptionContracts.fingerprint("t", "p", base));
        RegistrationRequest noTag = new RegistrationRequest("req-1", "artifact-1", "src-v1",
                ParentVersionKind.TRANSCRIPT_VERSION, "transcript-v1", "clock.v1", 90_000, 9_000_000,
                LanguageDisposition.DECLARED_BY_USER, Optional.empty(), segments(), Optional.empty());
        assertThat(MediaCaptionContracts.fingerprint("t", "p", noTag)).isNotEqualTo(a);
        assertThatThrownBy(() -> MediaCaptionContracts.fingerprint("t", "p",
                new RegistrationRequest("req-1", "artifact-1", "src-v1", ParentVersionKind.TRANSCRIPT_VERSION,
                        "transcript-v1", "clock.v1", 90_000, 9_000_000, LanguageDisposition.DECLARED_BY_USER,
                        Optional.of("en"), List.of(CaptionSegment.of("s", "lone \ud800 surrogate", 1, 2, SegmentOrigin.RECOGNIZED)),
                        Optional.empty())))
                .isInstanceOf(MediaCaptionContracts.CaptionRegistrationException.class);
        assertThat(MediaCaptionContracts.parseSegmentsJson(MediaCaptionContracts.segmentsJson(segments())))
                .isEqualTo(segments());
    }

    @Test
    void fingerprintMatchesSharedTypeScriptGoldenVector() {
        // test-fixtures/caption-registration-parity.v1.json — same digest computed by caption-version.ts
        List<CaptionSegment> segs = List.of(
                CaptionSegment.of("seg-1", "Hello, \"world\"\nline2", 10, 900, SegmentOrigin.USER_EDITED),
                new CaptionSegment("seg-2", "unicode-अक्षर-😀", 900, 1800, SegmentOrigin.RECOGNIZED, Optional.of("spk-1")));
        RegistrationRequest golden = new RegistrationRequest("req-parity-1", "artifact-1", "src-v1",
                ParentVersionKind.TRANSCRIPT_VERSION, "transcript-v1", "clock.v1", 90_000, 9_000_000,
                LanguageDisposition.DECLARED_BY_USER, Optional.of("en"), segs, Optional.of("j03 demo"));
        assertThat(MediaCaptionContracts.fingerprint("tenant-1", "principal-1", golden))
                .isEqualTo("96c98af1bc04d7cff056e159cd77e387b0961b3b7a068882cbd0bd93b5307e18");
    }

    private static List<CaptionSegment> segments() {
        return List.of(
                CaptionSegment.of("seg-1", "hello world", 10, 900, SegmentOrigin.USER_EDITED),
                new CaptionSegment("seg-2", "second", 900, 1800, SegmentOrigin.RECOGNIZED, Optional.of("spk-1")));
    }

    private static RegistrationRequest request(String requestId) {
        return new RegistrationRequest(requestId, "artifact-1", "src-v1",
                ParentVersionKind.TRANSCRIPT_VERSION, "transcript-v1", "clock.v1", 90_000, 9_000_000,
                LanguageDisposition.DECLARED_BY_USER, Optional.of("en"), segments(), Optional.empty());
    }

    private static Fixture openFixture() throws Exception {
        String bucket = "media-caption-" + UUID.randomUUID().toString().replace("-", "");
        try (S3Client client = S3Client.builder().endpointOverride(LOCALSTACK.getEndpoint())
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build()).build()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment(bucket));
        try {
            PostgresqlMediaCaptionStore store = new PostgresqlMediaCaptionStore();
            MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
            return new Fixture(installed, store, state);
        } catch (RuntimeException failure) {
            installed.close();
            throw failure;
        }
    }

    private record Fixture(AutoCloseable installed, PostgresqlMediaCaptionStore store,
                           MediaAwsPostgresqlRuntimeState state) implements AutoCloseable {
        @Override public void close() throws Exception {
            try {
                state.release();
            } finally {
                try {
                    store.close();
                } finally {
                    installed.close();
                }
            }
        }
    }

    private static Map<String, String> environment(String bucket) {
        Map<String, String> env = new HashMap<>();
        env.put("MEDIA_RUNTIME_ENVIRONMENT", "integration");
        env.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        env.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        env.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_TRANSCRIPT_DB_PASSWORD");
        env.put("MEDIA_TRANSCRIPT_DB_PASSWORD", POSTGRES.getPassword());
        env.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        env.put("MEDIA_S3_BUCKET", bucket);
        env.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        env.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpoint().toString());
        env.put("MEDIA_S3_PATH_STYLE", "true");
        env.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_ACCESS");
        env.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_SECRET");
        env.put("MEDIA_ACCESS", LOCALSTACK.getAccessKey());
        env.put("MEDIA_SECRET", LOCALSTACK.getSecretKey());
        return env;
    }
}
