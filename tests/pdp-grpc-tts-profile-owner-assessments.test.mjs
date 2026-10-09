import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const parity = parse(readFileSync(resolve(root, ".product-experience/interface-parity/operation-parity.yaml"), "utf8"));
const implementation = readFileSync(resolve(root, "modules/speech/tts-service/src/main/java/com/ghatana/tts/grpc/TtsGrpcService.java"), "utf8");
const identities = new Map([
  ["TTSService.CreateProfile", {
    id: "media.interface-implementation-assessment.grpc.tts-create-profile.v1",
    sourceMethod: "createProfile",
    sourceEvidence: ["UUID.randomUUID()", "positiveOrDefault(", ".createProfile(profileId, displayName, settings)"],
    requiredMeaning: ["random-UUID", "request-settings", "NOT_ESTABLISHED"],
    sourceRole: "LEGACY_PROVIDER_PROFILE_ADMIN",
  }],
  ["TTSService.GetProfile", {
    id: "media.interface-implementation-assessment.grpc.tts-get-profile.v1",
    sourceMethod: "getProfile",
    sourceEvidence: ["loadProfile(profileId)", "Status.NOT_FOUND", ".setTotalCharactersSynthesized"],
    requiredMeaning: ["unversioned-profile-id-lookup", "NOT_FOUND", "character-count"],
    sourceRole: "LEGACY_PROVIDER_PROFILE_ADMIN",
  }],
  ["TTSService.UpdateProfile", {
    id: "media.interface-implementation-assessment.grpc.tts-update-profile.v1",
    sourceMethod: "updateProfile",
    sourceEvidence: ["loadProfile(profileId)", "saveProfile(updated)", "getDefaultVoiceId().isBlank()"],
    requiredMeaning: ["without-CAS", "expected profile version", "NOT_ADMITTED"],
    sourceRole: "LEGACY_PROVIDER_PROFILE_ADMIN",
  }],
  ["TTSService.SubmitFeedback", {
    id: "media.interface-implementation-assessment.grpc.tts-submit-feedback.v1",
    sourceMethod: "submitFeedback",
    sourceEvidence: ["Status.UNIMPLEMENTED", "requires an explicit persistence and learning provider"],
    requiredMeaning: ["UNIMPLEMENTED", "does-not-persist-feedback", "NOT_ADMITTED"],
    sourceRole: "UNIMPLEMENTED_ENDPOINT",
  }],
]);

function validate(record, expected) {
  const assessment = record.mediaOwnerImplementationAssessment;
  assert.ok(assessment, `${record.identity} has an exact handler assessment`);
  assert.equal(assessment.id, expected.id);
  assert.equal(assessment.sourceImplementationRef,
    `modules/speech/tts-service/src/main/java/com/ghatana/tts/grpc/TtsGrpcService.java#${expected.sourceMethod}`);
  assert.equal(assessment.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(assessment.independentAcceptance, "OPEN");
  assert.match(assessment.canonicalEquivalence, /^NOT_ESTABLISHED/u);
  assert.ok(assessment.observedEffect.trim().length > 0);
  assert.ok(assessment.missingOwnerSemantics.length > 0);
  const text = JSON.stringify(assessment);
  for (const meaning of expected.requiredMeaning) assert.ok(text.includes(meaning), `${record.identity} retains ${meaning}`);
  for (const evidence of expected.sourceEvidence) assert.ok(implementation.includes(evidence), `${record.identity} handler contains ${evidence}`);
}

test("TTS profile RPC assessments trace exact handler effects without inventing canonical parity", () => {
  for (const [identity, expected] of identities) {
    const record = parity.typedGrpcMethodContracts.find((candidate) => candidate.identity === identity);
    assert.ok(record, `${identity} remains in the exact gRPC source inventory`);
    assert.equal(record.role, expected.sourceRole);
    assert.equal(record.bindingStatus, "SOURCE_BACKED_NON_OPERATION");
    validate(record, expected);
  }
});

test("TTS profile assessments reject handler drift, false admission, and canonical-equivalence promotion", () => {
  for (const [identity, expected] of identities) {
    const original = parity.typedGrpcMethodContracts.find((candidate) => candidate.identity === identity);
    const wrongMethod = structuredClone(original);
    wrongMethod.mediaOwnerImplementationAssessment.sourceImplementationRef = "some similarly named method";
    assert.throws(() => validate(wrongMethod, expected));
    const admitted = structuredClone(original);
    admitted.mediaOwnerImplementationAssessment.runtimeAdmission = "ADMITTED";
    assert.throws(() => validate(admitted, expected));
    const equivalent = structuredClone(original);
    equivalent.mediaOwnerImplementationAssessment.canonicalEquivalence = "ESTABLISHED";
    assert.throws(() => validate(equivalent, expected));
  }
});
