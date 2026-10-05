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
        try {
            privacyMaintenance = MediaPrivacyMaintenanceRuntime.compose(environment);
            consentAdministration = MediaConsentAdministrationRuntime.compose(environment);
            MediaPrivacyMaintenanceRuntime finalPrivacyMaintenance = privacyMaintenance;
            MediaConsentAdministrationRuntime finalConsentAdministration = consentAdministration;
            Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                RuntimeException failure = null;
                if (finalConsentAdministration != null) {
                    try { finalConsentAdministration.close(); }
                    catch (RuntimeException cleanupFailure) { failure = cleanupFailure; }
                }
                if (finalPrivacyMaintenance != null) {
                    try { finalPrivacyMaintenance.close(); }
                    catch (RuntimeException cleanupFailure) {
                        if (failure == null) failure = cleanupFailure;
                        else failure.addSuppressed(cleanupFailure);
                    }
                }
                try { runtime.close(); }
                catch (RuntimeException cleanupFailure) {
                    if (failure == null) failure = cleanupFailure;
                    else failure.addSuppressed(cleanupFailure);
                }
                if (failure != null) log.error("Media Runtime shutdown failed", failure);
            }, "media-runtime-shutdown"));

            MediaHttpHandler handler = new MediaHttpHandler(
                    runtime,
                    consentAdministration == null ? null : consentAdministration.administration());
            log.info(
                    "Starting Media Runtime HTTP service port={} profile={} providers={} privacyMaintenance={} consentAdministration={}",
                    config.httpPort(), config.profile(), runtime.providerIds(),
                    privacyMaintenance == null ? "not-configured" : privacyMaintenance.maintenanceId(),
                    consentAdministration == null ? "not-configured" : consentAdministration.administrationId());
            ServiceLauncherSupport.startHttpService(
                    "Media", config.httpPort(), new MediaSecurityFilter(handler, config.profile()));
        } catch (RuntimeException failure) {
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
}
