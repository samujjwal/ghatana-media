package com.ghatana.media.launcher;

import com.ghatana.launcher.ServiceLauncherSupport;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Map;

/**
 * Standalone Media Runtime service launcher.
 *
 * @doc.type class
 * @doc.purpose Provide Media Launcher behavior
 * @doc.layer product
 * @doc.pattern Bootstrap
 */
public final class MediaLauncher {
    private static final Logger log = LoggerFactory.getLogger(MediaLauncher.class);

    private MediaLauncher() { }

    public static void main(String[] args) {
        Map<String, String> environment = System.getenv();
        MediaRuntimeConfig config = MediaRuntimeConfig.fromEnvironment(environment);
        if (!config.runtimeEnabled()) {
            log.info("Media Runtime is disabled; no stores, providers, consent administration, privacy maintenance, or transport will start");
            return;
        }

        MediaRuntime runtime = MediaRuntime.compose(environment);
        MediaPrivacyMaintenanceRuntime privacyMaintenance = null;
        MediaConsentAdministrationRuntime consentAdministration = null;
        MediaCaptionRuntime captions = null;
        MediaDevProjectTimelineRuntime devProjectTimeline = null;
        MediaDevReviewRuntime devReview = null;
        MediaDevDeliveryRuntime devDelivery = null;
        MediaDevRightsRuntime devRights = null;
        MediaDevRequestLedger devLedger = null;
        MediaDevErasureRuntime devErasure = null;
        try {
            privacyMaintenance = MediaPrivacyMaintenanceRuntime.compose(environment);
            consentAdministration = MediaConsentAdministrationRuntime.compose(environment);
            captions = MediaCaptionRuntime.compose(environment);
            devProjectTimeline = MediaDevProjectTimelineRuntime.compose(environment);
            devReview = MediaDevReviewRuntime.compose(environment, runtime, devProjectTimeline);
            devRights = MediaDevRightsRuntime.compose(environment, runtime);
            devDelivery = MediaDevDeliveryRuntime.compose(environment, runtime,
                    devRights == null ? null : devRights.resolver());
            // One durable request ledger for every DEV_ONLY model lane (speech, captions, vision tracking/ROI, grounded).
            boolean devModelLanes = devProjectTimeline != null
                    || !environment.getOrDefault(MediaLocalVisionComposition.MODELS_ROOT_ENV, "").isBlank()
                    || !environment.getOrDefault(MediaDevProjectRenderRuntime.FFMPEG_ENV, "").isBlank();
            devLedger = devModelLanes ? MediaDevRequestLedger.compose(environment) : null;
            MediaDevRequestLedger finalDevLedger = devLedger;
            devErasure = MediaDevErasureRuntime.compose(environment, devLedger, devDelivery, null);
            MediaDevErasureRuntime finalDevErasure = devErasure;
            MediaPrivacyMaintenanceRuntime finalPrivacyMaintenance = privacyMaintenance;
            MediaConsentAdministrationRuntime finalConsentAdministration = consentAdministration;
            MediaCaptionRuntime finalCaptions = captions;
            MediaDevProjectTimelineRuntime finalDevProjectTimeline = devProjectTimeline;
            MediaDevReviewRuntime finalDevReview = devReview;
            MediaDevDeliveryRuntime finalDevDelivery = devDelivery;
            MediaDevRightsRuntime finalDevRights = devRights;
            Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                RuntimeException failure = null;
                if (finalDevErasure != null) {
                    try { finalDevErasure.close(); }
                    catch (RuntimeException cleanupFailure) { failure = appendShutdownFailure(failure, cleanupFailure); }
                }
                if (finalDevLedger != null) {
                    try { finalDevLedger.close(); }
                    catch (RuntimeException cleanupFailure) { failure = appendShutdownFailure(failure, cleanupFailure); }
                }
                if (finalDevDelivery != null) {
                    try { finalDevDelivery.close(); }
                    catch (RuntimeException cleanupFailure) { failure = appendShutdownFailure(failure, cleanupFailure); }
                }
                if (finalDevRights != null) {
                    try { finalDevRights.close(); }
                    catch (RuntimeException cleanupFailure) { failure = appendShutdownFailure(failure, cleanupFailure); }
                }
                if (finalDevReview != null) {
                    try { finalDevReview.close(); }
                    catch (RuntimeException cleanupFailure) { failure = appendShutdownFailure(failure, cleanupFailure); }
                }
                if (finalDevProjectTimeline != null) {
                    try { finalDevProjectTimeline.close(); }
                    catch (RuntimeException cleanupFailure) { failure = appendShutdownFailure(failure, cleanupFailure); }
                }
                if (finalCaptions != null) {
                    try { finalCaptions.close(); }
                    catch (RuntimeException cleanupFailure) {
                        failure = appendShutdownFailure(failure, cleanupFailure);
                    }
                }
                if (finalConsentAdministration != null) {
                    try { finalConsentAdministration.close(); }
                    catch (RuntimeException cleanupFailure) {
                        failure = appendShutdownFailure(failure, cleanupFailure);
                    }
                }
                if (finalPrivacyMaintenance != null) {
                    try { finalPrivacyMaintenance.close(); }
                    catch (RuntimeException cleanupFailure) {
                        failure = appendShutdownFailure(failure, cleanupFailure);
                    }
                }
                try { runtime.close(); }
                catch (RuntimeException cleanupFailure) {
                    failure = appendShutdownFailure(failure, cleanupFailure);
                }
                if (failure != null) log.error("Media Runtime shutdown failed", failure);
            }, "media-runtime-shutdown"));

            log.info("Media identity: OIDC {}",
                    com.ghatana.media.launcher.oidc.OidcConfig.fromEnvironment(environment)
                            .map(oidc -> "enabled issuer=" + oidc.issuer() + " audience=" + oidc.audience())
                            .orElse("not configured (DEV_ONLY/legacy mechanisms only)"));
            MediaCaptionRuntime captionRuntime = captions;
            log.info(
                    "Starting Media Runtime HTTP service port={} profile={} providers={} privacyMaintenance={} consentAdministration={} captionRuntime={} devProjectTimeline={}",
                    config.httpPort(), config.profile(), runtime.providerIds(),
                    privacyMaintenance == null ? "not-configured" : privacyMaintenance.maintenanceId(),
                    consentAdministration == null ? "not-configured" : consentAdministration.administrationId(),
                    captions == null ? "not-configured" : "ready",
                    devProjectTimeline == null ? "disabled" : "DEV_ONLY-ready");
            ServiceLauncherSupport.startHttpService(
                    "Media", config.httpPort(), new MediaSecurityFilter(
                            new MediaHttpHandler(runtime,
                                    consentAdministration == null ? null : consentAdministration.administration(),
                                    captions, finalDevProjectTimeline, finalDevReview,
                                    finalDevProjectTimeline == null ? null : new MediaDevCreativeOutputRuntime(runtime)).withDevDelivery(finalDevDelivery).withDevRights(finalDevRights)
                                    .withDevErasure(finalDevErasure, "true".equalsIgnoreCase(
                                            environment.getOrDefault("MEDIA_DEV_ERASURE_REQUIRE_OIDC", "false")))
                                    .withDevSpeech(finalDevProjectTimeline == null ? null
                                            : MediaDevSpeechRuntime.compose(runtime, System.getenv(),
                                                    finalDevRights == null ? null : finalDevRights.resolver(),
                                                    finalDevLedger))
                                    .withDevGrounded(MediaDevGroundedComposition.compose(runtime, environment,
                                            System.getenv(), finalDevRights == null ? null : finalDevRights.resolver(),
                                            finalDevLedger))
                                    .withDevAudio(finalDevProjectTimeline == null ? null
                                            : MediaDevAudioRestorationRuntime.compose(runtime, environment,
                                                    finalDevRights == null ? null : finalDevRights.resolver(),
                                                    finalDevLedger))
                                    .withDevCaptions(finalDevProjectTimeline == null ? null
                                            : MediaDevCaptionRuntime.compose(runtime,
                                                    finalDevRights == null ? null : finalDevRights.resolver(),
                                                    finalDevReview, finalDevLedger),
                                            "true".equalsIgnoreCase(environment.getOrDefault(
                                                    MediaDevCaptionRuntime.REVIEW_REQUIRED_ENV, "false")))
                                    .withDevVideo(finalDevLedger == null ? null
                                            : MediaDevVideoRuntime.compose(runtime, environment,
                                                    finalDevRights == null ? null : finalDevRights.resolver(),
                                                    finalDevLedger))
                                    .withDevVision(MediaLocalVisionComposition.engineFrom(environment)
                                            .map(engine -> {
                                                MediaDevVisionRuntime devVision = new MediaDevVisionRuntime(runtime, engine,
                                                        MediaDevFfmpegFrameExtractor.from(environment),
                                                        finalDevRights == null ? null : finalDevRights.resolver());
                                                return devVision.withTracking(
                                                        MediaDevVisionTrackingRuntime.compose(runtime, devVision, environment,
                                                                finalDevLedger));
                                            }).orElse(null))
                                    .withDevProviderCatalog(environment),
                            config.profile()));
        } catch (RuntimeException failure) {
            if (devErasure != null) {
                try { devErasure.close(); }
                catch (RuntimeException cleanupFailure) { failure.addSuppressed(cleanupFailure); }
            }
            if (devLedger != null) {
                try { devLedger.close(); }
                catch (RuntimeException cleanupFailure) { failure.addSuppressed(cleanupFailure); }
            }
            if (devDelivery != null) {
                try { devDelivery.close(); }
                catch (RuntimeException cleanupFailure) { failure.addSuppressed(cleanupFailure); }
            }
            if (devRights != null) {
                try { devRights.close(); }
                catch (RuntimeException cleanupFailure) { failure.addSuppressed(cleanupFailure); }
            }
            if (devReview != null) {
                try { devReview.close(); }
                catch (RuntimeException cleanupFailure) { failure.addSuppressed(cleanupFailure); }
            }
            if (devProjectTimeline != null) {
                try { devProjectTimeline.close(); }
                catch (RuntimeException cleanupFailure) { failure.addSuppressed(cleanupFailure); }
            }
            if (captions != null) {
                try { captions.close(); }
                catch (RuntimeException cleanupFailure) { failure.addSuppressed(cleanupFailure); }
            }
            if (consentAdministration != null) {
                try { consentAdministration.close(); }
                catch (RuntimeException cleanupFailure) { failure.addSuppressed(cleanupFailure); }
            }
            if (privacyMaintenance != null) {
                try { privacyMaintenance.close(); }
                catch (RuntimeException cleanupFailure) { failure.addSuppressed(cleanupFailure); }
            }
            try { runtime.close(); }
            catch (RuntimeException cleanupFailure) { failure.addSuppressed(cleanupFailure); }
            throw failure;
        }
    }

    static RuntimeException appendShutdownFailure(RuntimeException primary, RuntimeException cleanupFailure) {
        if (primary == null) return cleanupFailure;
        if (primary == cleanupFailure) return primary;
        primary.addSuppressed(cleanupFailure);
        return primary;
    }
}
