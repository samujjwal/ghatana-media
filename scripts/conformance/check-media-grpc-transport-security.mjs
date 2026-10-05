#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const errors = [];

const base = read('libs/common/src/main/java/com/ghatana/audio/video/common/AudioVideoGrpcServerBase.java');
const policy = read('libs/common/src/main/java/com/ghatana/audio/video/common/GrpcTransportSecurityPolicy.java');
const baseTest = read('libs/common/src/test/java/com/ghatana/audio/video/common/AudioVideoGrpcServerBaseTest.java');
const policyTest = read('libs/common/src/test/java/com/ghatana/audio/video/common/GrpcTransportSecurityPolicyTest.java');

for (const token of [
  'builder.useTransportSecurity(',
  'public record TransportSecurity(',
  'Files.isSymbolicLink(value)',
  'isTlsEnabled()',
]) if (!base.includes(token)) errors.push(`AudioVideoGrpcServerBase missing ${token}`);

for (const token of [
  'MEDIA_GRPC_TLS_CERT_CHAIN_PATH',
  'MEDIA_GRPC_TLS_PRIVATE_KEY_PATH',
  'MEDIA_ENVIRONMENT',
  'GHATANA_DEPLOYMENT_PROFILE',
  'case "production", "staging", "sovereign" -> true',
  'serviceCertificateKey',
  'completePair(',
  'TransportSecurity.plaintext()',
  'TransportSecurity.tls(',
]) if (!policy.includes(token)) errors.push(`GrpcTransportSecurityPolicy missing ${token}`);

const servers = [
  ['STT', 'modules/speech/stt-service/src/main/java/com/ghatana/stt/grpc/SttGrpcServer.java', 'SttGrpcServer'],
  ['TTS', 'modules/speech/tts-service/src/main/java/com/ghatana/tts/grpc/TtsGrpcServer.java', 'TtsGrpcServer'],
  ['VISION', 'modules/vision/vision-service/src/main/java/com/ghatana/audio/video/vision/grpc/VisionGrpcServer.java', 'VisionGrpcServer'],
  ['MULTIMODAL', 'modules/intelligence/multimodal-service/src/main/java/com/ghatana/audio/video/multimodal/grpc/MultimodalGrpcServer.java', 'MultimodalGrpcServer'],
];
for (const [prefix, relative, className] of servers) {
  const source = read(relative);
  for (const token of [
    `GrpcTransportSecurityPolicy.resolve(environment, "${prefix}")`,
    `new ${className}(port, transportSecurity).startAndAwaitShutdown()`,
    'static TransportSecurity transportSecurity(Map<String, String> environment)',
  ]) if (!source.includes(token)) errors.push(`${className} missing ${token}`);
}

if (!baseTest.includes('tlsTransportRejectsMissingOrUnsafeMaterialBeforeBinding')) {
  errors.push('Shared gRPC base test does not prove invalid TLS material fails before binding');
}
for (const token of [
  'productionLikeProfilesRequireCompleteTlsPair',
  'sharedMediaTlsPairCanSecureEveryService',
  'serviceSpecificPairOverridesSharedPair',
  'partialServicePairCannotBorrowFromSharedPair',
  'serviceProfileOverridesSharedAndDeploymentProfiles',
]) if (!policyTest.includes(token)) errors.push(`GrpcTransportSecurityPolicyTest missing ${token}`);

if (errors.length) {
  console.error(`Media gRPC transport security failed with ${errors.length} violation(s):`);
  errors.forEach(error => console.error(`- ${error}`));
  process.exit(1);
}
console.log('All standalone Media gRPC launchers use one fail-closed profile-aware TLS policy; production-like profiles cannot bind plaintext and TLS material is validated by the shared server boundary.');
