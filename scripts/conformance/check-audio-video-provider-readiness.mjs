#!/usr/bin/env node
/**
 * Media-owned PROVIDER SOURCE PREFLIGHT only.
 *
 * Legacy CLI filename and exported function remain for existing conformance
 * consumers. This no longer interrogates Data Cloud internal source files from
 * a standalone Media checkout, nor claims runtime, provider or release readiness.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CAPABILITIES = [
  {
    id: 'STT',
    module: 'modules/speech/stt-service',
    proto: 'modules/speech/stt-service/src/main/proto/stt_service.proto',
    dockerfile: 'docker/Dockerfile.stt-service',
    distribution: 'stt-service',
    port: 50051,
    portKey: 'STT_GRPC_PORT',
    tests: [
      'modules/speech/stt-service/src/test/java/com/ghatana/stt/functional/SttFunctionalCompletenessTest.java',
      'modules/speech/stt-service/src/test/java/com/ghatana/stt/grpc/SttGrpcServiceInProcessIntegrationTest.java'
    ],
    gates: ['media-privacy', 'content-safety', 'artifact-retention', 'stt-model-validation']
  },
  {
    id: 'TTS',
    module: 'modules/speech/tts-service',
    proto: 'modules/speech/tts-service/src/main/proto/tts_service.proto',
    dockerfile: 'docker/Dockerfile.tts-service',
    distribution: 'tts-service',
    port: 50052,
    portKey: 'TTS_GRPC_PORT',
    tests: [
      'modules/speech/tts-service/src/test/java/com/ghatana/tts/functional/TtsFunctionalCompletenessTest.java',
      'modules/speech/tts-service/src/test/java/com/ghatana/tts/grpc/TtsGrpcServiceInProcessIntegrationTest.java'
    ],
    gates: ['media-privacy', 'content-safety', 'artifact-retention', 'tts-model-validation']
  },
  {
    id: 'Vision',
    module: 'modules/vision/vision-service',
    proto: 'modules/vision/vision-service/src/main/proto/vision_service.proto',
    dockerfile: 'docker/Dockerfile.vision-service',
    distribution: 'vision-service',
    port: 50054,
    portKey: 'VISION_GRPC_PORT',
    tests: [
      'modules/vision/vision-service/src/test/java/com/ghatana/vision/functional/VisionFunctionalCompletenessTest.java',
      'modules/vision/vision-service/src/test/java/com/ghatana/audio/video/vision/grpc/VisionGrpcServiceInProcessIntegrationTest.java'
    ],
    gates: ['media-privacy', 'content-safety', 'artifact-retention', 'vision-model-validation']
  },
  {
    id: 'Multimodal',
    module: 'modules/intelligence/multimodal-service',
    proto: 'modules/intelligence/multimodal-service/src/main/proto/multimodal_service.proto',
    dockerfile: 'docker/Dockerfile.multimodal-service',
    distribution: 'multimodal-service',
    port: 50055,
    portKey: 'MULTIMODAL_GRPC_PORT',
    tests: [
      'modules/intelligence/multimodal-service/src/test/java/com/ghatana/multimodal/functional/MultimodalFunctionalCompletenessTest.java',
      'modules/intelligence/multimodal-service/src/test/java/com/ghatana/audio/video/multimodal/grpc/MultimodalGrpcServiceInProcessIntegrationTest.java'
    ],
    gates: ['media-privacy', 'content-safety', 'artifact-retention', 'multimodal-model-validation']
  }
];

const REQUIRED_AUTHORITY_PATHS = [
  'modules/infrastructure/security/src/test/java/com/ghatana/audio/video/infrastructure/security/MediaProcessingSecurityValidatorTest.java',
  'launcher/src/test/java/com/ghatana/media/launcher/MediaConsentRevocationTest.java',
  'launcher/src/test/java/com/ghatana/media/launcher/MediaSemanticRedactionRuntimeTest.java'
];
const REQUIRED_TERMS = [
  'MediaRuntimeContracts.MediaConsentAuthority',
  'PostgresqlMediaConsentAuthority',
  'PostgresqlMediaPrivacyMaintenance',
  'MediaSemanticRedactionRuntime'
];

export function findMediaProviderSourceViolations({ root = process.cwd() } = {}) {
  const errors = [];
  const exists = (p) => existsSync(join(root, p));
  const requireFile = (p) => {
    if (!exists(p)) errors.push('Media source input missing: ' + p);
    return exists(p);
  };
  const capabilityMap = requireFile('docs/capability-map.md')
    ? readFileSync(join(root, 'docs/capability-map.md'), 'utf8') : '';
  const privacyPolicy = requireFile('docs/MEDIA_PRIVACY_AND_RETENTION_POLICY.md')
    ? readFileSync(join(root, 'docs/MEDIA_PRIVACY_AND_RETENTION_POLICY.md'), 'utf8') : '';
  for (const p of REQUIRED_AUTHORITY_PATHS) requireFile(p);
  const ignore = requireFile('.dockerignore')
    ? readFileSync(join(root, '.dockerignore'), 'utf8') : '';
  if (ignore && (!ignore.includes('**/*') || !ignore.includes('!modules/'))) {
    errors.push('Docker context must exclude repository by default and include only distributions');
  }
  for (const cap of CAPABILITIES) {
    for (const p of [cap.module, cap.proto, ...cap.tests]) requireFile(p);
    if (requireFile(cap.dockerfile)) {
      const recipe = readFileSync(join(root, cap.dockerfile), 'utf8');
      const distribution = cap.module + '/build/install/' + cap.distribution + '/';
      if (!recipe.includes(distribution) || !recipe.includes('ENTRYPOINT ["/app/bin/' + cap.distribution + '"]')) {
        errors.push(cap.id + ': candidate must consume exact Gradle application distribution');
      }
      if (!recipe.includes('ENV ' + cap.portKey + '=' + cap.port) ||
          !recipe.includes('EXPOSE ' + cap.port)) {
        errors.push(cap.id + ': container port does not match Media service contract');
      }
      if (/COPY\s+(?:buildSrc|products\/audio-video|\.\s+\.)|shadowJar|-x\s+(?:test|checkstyleMain|compileJava)/u.test(recipe)) {
        errors.push(cap.id + ': obsolete build context or skipped qualification in container');
      }
      if (!/^USER\s+(?:\d+:\d+|media)\s*$/mu.test(recipe)) {
        errors.push(cap.id + ': runtime image must use an unprivileged identity');
      }
    }
    for (const gate of cap.gates) if (!capabilityMap.includes(gate)) {
      errors.push(cap.id + ': source capability map missing gate ' + gate);
    }
  }
  for (const term of REQUIRED_TERMS) if (!privacyPolicy.includes(term) && !capabilityMap.includes(term)) {
    errors.push('Media privacy source contract missing ' + term);
  }
  return errors;
}
// Compatibility export for the previous checker entrypoint. Same source-only
// semantics; its name must not be read as actual provider admission.
export const findAudioVideoProviderReadinessViolations = findMediaProviderSourceViolations;

if (process.argv[1]?.endsWith('check-audio-video-provider-readiness.mjs')) {
  const violations = findMediaProviderSourceViolations();
  if (violations.length) {
    console.error('FAIL: Media provider source preflight:', violations.join('\n  - '));
    process.exitCode = 1;
  } else {
    console.log('PASS: Media provider SOURCE preflight. Provider execution, licensing and release NOT_QUALIFIED.');
  }
}
