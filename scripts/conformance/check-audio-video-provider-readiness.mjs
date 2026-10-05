#!/usr/bin/env node
/**
 * @fileoverview Audio-Video provider readiness guard.
 *
 * @doc.type script
 * @doc.purpose Verify Audio-Video remains a provider capability with real routes, tests, gates, and runtime probes
 * @doc.layer infrastructure
 * @doc.pattern BoundaryCheck
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

const CAPABILITIES = [
  {
    id: "STT",
    module: "modules/speech/stt-service",
    proto: "modules/speech/stt-service/src/main/proto/stt_service.proto",
    dockerfile: "modules/speech/stt-service/Dockerfile",
    tests: [
      "modules/speech/stt-service/src/test/java/com/ghatana/stt/functional/SttFunctionalCompletenessTest.java",
      "modules/speech/stt-service/src/test/java/com/ghatana/stt/grpc/SttGrpcServiceInProcessIntegrationTest.java",
    ],
    gates: ["media-privacy", "content-safety", "artifact-retention", "stt-model-validation"],
    probe: "AUDIO_VIDEO_STT",
  },
  {
    id: "TTS",
    module: "modules/speech/tts-service",
    proto: "modules/speech/tts-service/src/main/proto/tts_service.proto",
    dockerfile: "modules/speech/tts-service/Dockerfile",
    tests: [
      "modules/speech/tts-service/src/test/java/com/ghatana/tts/functional/TtsFunctionalCompletenessTest.java",
      "modules/speech/tts-service/src/test/java/com/ghatana/tts/grpc/TtsGrpcServiceInProcessIntegrationTest.java",
    ],
    gates: ["media-privacy", "content-safety", "artifact-retention", "tts-model-validation"],
    probe: "AUDIO_VIDEO_TTS",
  },
  {
    id: "Vision",
    module: "modules/vision/vision-service",
    proto: "modules/vision/vision-service/src/main/proto/vision_service.proto",
    dockerfile: "modules/vision/vision-service/Dockerfile",
    tests: [
      "modules/vision/vision-service/src/test/java/com/ghatana/vision/functional/VisionFunctionalCompletenessTest.java",
      "modules/vision/vision-service/src/test/java/com/ghatana/audio/video/vision/grpc/VisionGrpcServiceInProcessIntegrationTest.java",
    ],
    gates: ["media-privacy", "content-safety", "artifact-retention", "vision-model-validation"],
    probe: "AUDIO_VIDEO_VISION",
  },
  {
    id: "Multimodal",
    module: "modules/intelligence/multimodal-service",
    proto: "modules/intelligence/multimodal-service/src/main/proto/multimodal_service.proto",
    dockerfile: "modules/intelligence/multimodal-service/Dockerfile",
    tests: [
      "modules/intelligence/multimodal-service/src/test/java/com/ghatana/multimodal/functional/MultimodalFunctionalCompletenessTest.java",
      "modules/intelligence/multimodal-service/src/test/java/com/ghatana/audio/video/multimodal/grpc/MultimodalGrpcServiceInProcessIntegrationTest.java",
    ],
    gates: ["media-privacy", "content-safety", "artifact-retention", "multimodal-model-validation"],
    probe: "AUDIO_VIDEO_MULTIMODAL",
  },
];

const REQUIRED_GATE_TERMS = [
  "MediaRuntimeContracts.MediaConsentAuthority",
  "PostgresqlMediaConsentAuthority",
  "PostgresqlMediaPrivacyMaintenance",
  "MediaSemanticRedactionRuntime",
];

const REQUIRED_AUTHORITY_PATHS = [
  "modules/infrastructure/security/src/test/java/com/ghatana/audio/video/infrastructure/security/MediaProcessingSecurityValidatorTest.java",
  "launcher/src/test/java/com/ghatana/media/launcher/MediaConsentRevocationTest.java",
  "launcher/src/test/java/com/ghatana/media/launcher/MediaSemanticRedactionRuntimeTest.java",
];

function read(root, path) {
  return readFileSync(join(root, path), "utf8");
}

function assertExists(errors, root, path, label) {
  if (!existsSync(join(root, path))) {
    errors.push(`${label} does not exist: ${path}`);
  }
}

function containsFieldValue(value, field, expected) {
  if (Array.isArray(value)) {
    return value.some((entry) => containsFieldValue(entry, field, expected));
  }
  if (value == null || typeof value !== "object") return false;
  if (value[field] === expected) return true;
  return Object.values(value).some((entry) => containsFieldValue(entry, field, expected));
}

export function findAudioVideoProviderReadinessViolations({ root = ROOT } = {}) {
  const errors = [];
  const capabilityMapPath = "docs/capability-map.md";
  const privacyPolicyPath = "docs/MEDIA_PRIVACY_AND_RETENTION_POLICY.md";
  const dataCloudRoutesPath = "services/data-cloud/delivery/ui/src/routes.tsx";
  const routeManifestPath = "services/data-cloud/config/route-manifest.json";
  const dependencyProbeRegistryPath =
    "services/data-cloud/delivery/launcher/src/main/java/com/ghatana/datacloud/launcher/http/runtime/DependencyProbeRegistry.java";
  const surfaceDefinitionsPath =
    "services/data-cloud/delivery/launcher/src/main/java/com/ghatana/datacloud/launcher/http/runtime/SurfaceDefinitions.java";
  const runtimeTruthTestPath =
    "services/data-cloud/delivery/launcher/src/test/java/com/ghatana/datacloud/launcher/http/RuntimeTruthServiceTest.java";

  try {
    for (const path of [
      capabilityMapPath,
      privacyPolicyPath,
      dataCloudRoutesPath,
      routeManifestPath,
      dependencyProbeRegistryPath,
      surfaceDefinitionsPath,
      runtimeTruthTestPath,
    ]) {
      assertExists(errors, root, path, "Required readiness input");
    }
    for (const path of REQUIRED_AUTHORITY_PATHS) {
      assertExists(errors, root, path, "Required Media privacy authority test");
    }
    if (errors.length > 0) {
      return errors;
    }

    const capabilityMap = read(root, capabilityMapPath);
    const privacyPolicy = read(root, privacyPolicyPath);
    const dataCloudRoutes = read(root, dataCloudRoutesPath);
    const routeManifest = JSON.parse(read(root, routeManifestPath));
    const dependencyProbeRegistry = read(root, dependencyProbeRegistryPath);
    const surfaceDefinitions = read(root, surfaceDefinitionsPath);
    const runtimeTruthTest = read(root, runtimeTruthTestPath);

    for (const capability of CAPABILITIES) {
      assertExists(errors, root, capability.module, `${capability.id} module`);
      assertExists(errors, root, capability.proto, `${capability.id} proto`);
      assertExists(errors, root, capability.dockerfile, `${capability.id} runtime Dockerfile`);
      for (const testPath of capability.tests) {
        assertExists(errors, root, testPath, `${capability.id} provider test`);
      }
      for (const gate of capability.gates) {
        if (!capabilityMap.includes(gate)) {
          errors.push(`${capability.id} capability map missing gate ${gate}`);
        }
      }
      if (!dependencyProbeRegistry.includes(capability.probe)) {
        errors.push(`DependencyProbeRegistry missing ${capability.probe}`);
      }
      if (!surfaceDefinitions.includes(capability.probe)) {
        errors.push(`SurfaceDefinitions does not integrate probe ${capability.probe}`);
      }
    }

    for (const term of REQUIRED_GATE_TERMS) {
      if (!privacyPolicy.includes(term) && !capabilityMap.includes(term)) {
        errors.push(`Audio-Video privacy/model gate evidence missing term: ${term}`);
      }
    }

    if (!capabilityMap.includes("Audio-Video is a capability provider")) {
      errors.push("capability-map.md must state Audio-Video is a capability provider");
    }
    if (!capabilityMap.includes("Data Cloud owns the user-facing Media") || !capabilityMap.includes("Artifacts surface")) {
      errors.push("capability-map.md must state Data Cloud owns Media Artifacts UX");
    }
    if (!capabilityMap.includes("Broader Data Cloud production-readiness and external provider completeness remain separate")) {
      errors.push("capability-map.md must keep Data Cloud production-readiness separate from provider completeness");
    }

    if (dataCloudRoutes.includes("media.audioVideo") || dataCloudRoutes.includes("audio-video")) {
      errors.push("Data Cloud routes must not present Audio-Video provider capability as a first-class UX route");
    }
    if (!dataCloudRoutes.includes("media.artifacts")) {
      errors.push("Data Cloud routes must present Media Artifacts through media.artifacts");
    }
    if (!containsFieldValue(routeManifest, "surfaceId", "media.artifacts")) {
      errors.push("route-manifest.json must include media.artifacts routes");
    }
    const serializedManifest = JSON.stringify(routeManifest);
    if (serializedManifest.includes('"surfaceId":"audioVideo.')
        || containsFieldValue(routeManifest, "surfaceId", "media.audioVideo")) {
      errors.push("route-manifest.json must not expose audio-video provider surfaces as Data Cloud UX");
    }
    if (!runtimeTruthTest.includes("Media provider down") || !runtimeTruthTest.includes("AUDIO_VIDEO_STT")) {
      errors.push("RuntimeTruthServiceTest must cover provider probe degradation");
    }

    return errors;
  } catch (error) {
    errors.push(`Audio-Video readiness input could not be parsed: ${error.message}`);
    return errors;
  }
}

function main() {
  const errors = findAudioVideoProviderReadinessViolations();
  if (errors.length > 0) {
    console.error(`FAIL: Audio-Video provider readiness check found ${errors.length} violation(s):`);
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }
  console.log("PASS: Audio-Video provider readiness check passed");
}

if (process.argv[1]?.endsWith("check-audio-video-provider-readiness.mjs")) {
  main();
}
