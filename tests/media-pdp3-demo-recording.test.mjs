import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = "docs/implementation/evidence/media-pdp3-demo/j03-explorer-simulated-2026-10-21-r2";
const manifestRef = `${evidenceDir}/recording-manifest.json`;
const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestRef), "utf8"));
const standard = parse(fs.readFileSync(path.join(root, ".product-experience/pdp-3-product-experience/demo-recording-standard.yaml"), "utf8"));
const profile = JSON.parse(fs.readFileSync(path.join(root, "docs/implementation/MEDIA-EARLY-BUSINESS-DEMO-RECORDING.v1.json"), "utf8"));
const digestFile = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function parseVtt(vtt) {
  return vtt.trim().split(/\n\s*\n/u).filter((block) => block && block !== "WEBVTT").map((block) => {
    const [id, timing, ...text] = block.split("\n");
    const [start, end] = timing.split(" --> ");
    const toSeconds = (value) => {
      const [hours, minutes, seconds] = value.split(":");
      return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
    };
    return { id, start: toSeconds(start), end: toSeconds(end), text: text.join("\n") };
  });
}

test("PDP-3 v1 binds one source-owned J-03 Explorer scenario to a truthful narrated recording", () => {
  assert.equal(standard.standardId, "media.pdp3.demo-recording.v1");
  assert.equal(standard.status, "MEDIA_OWNER_ADOPTED_VERSIONED_DEMO_SCOPE; CROSS_REPOSITORY_KERNEL_TOOLS_LIFECYCLE_ADMISSION_PENDING");
  assert.equal(standard.scope.edition, "media-pdp3-demo-v1");
  assert.equal(standard.scope.scenarioId, "media.demo.j03.corrected-captions.v1");
  assert.deepEqual(standard.scope.orderedSceneIds, ["s01", "s02", "s03", "s04", "s05", "s06", "s07"]);
  assert.deepEqual(standard.scope.journeyIds, ["J-03", "J-01", "J-02", "J-20"]);
  assert.equal(standard.scope.deferredScenarioCoverage.disposition, "DEFERRED_TO_LATER_VERSION; NOT_NOT_APPLICABLE");
  assert.equal(standard.acceptance.criterionId, "P3-11");

  assert.equal(profile.dualStageRecording.scenarioIdentity.demoScenarioId, standard.scope.scenarioId);
  assert.equal(profile.dualStageRecording.scenarioIdentity.scenarioRevision, standard.scope.edition);
  assert.equal(profile.dualStageRecording.passes[0].state, "RECORDED_SIMULATED_CONTENT_REVIEWED; FILM_APPROVAL_NOT_CLAIMED");
  assert.equal(profile.recordingEvidence.build.status, "NOT_RECORDED");
  assert.equal(profile.recordingEvidence.semanticEquivalence.status, "NOT_VERIFIED");
  assert.equal(standard.captures.build.status, "NOT_RECORDED");
  assert.equal(standard.captures.semanticEquivalence.status, "NOT_VERIFIED");
  assert.equal(standard.authority.lifecycleGtoolAdmission, "PENDING");
});

test("Explorer evidence has seven ordered source-linked beats, narration captions, and persistent simulation disclosure", () => {
  const expectedScenes = standard.scope.orderedSceneIds;
  assert.equal(manifest.evidenceId, "media.demo.j03.corrected-captions.v1.explorer.2026-10-21.r2");
  assert.equal(manifest.truthLabel, "EXPLORER_SIMULATED");
  assert.equal(manifest.evidenceDisposition, "CAPTURED_SOURCE_REVALIDATED_CONTENT_TRUTH_REVIEWED_PROPOSAL_EVIDENCE_ONLY");
  assert.equal(manifest.scenario.id, standard.scope.scenarioId);
  assert.equal(manifest.scenario.journeyId, "J-03");
  assert.deepEqual(manifest.scenario.sceneIds, expectedScenes);
  assert.equal(manifest.capture.persistentDisclosure, "Visible throughout via capture-only post-production banner: EVIDENCE-ONLY OVERLAY | SIMULATED FIXTURE | NO LIVE PRODUCT OPERATIONS. The banner is evidence packaging, not product UI.");
  assert.match(manifest.reviewerDisposition, /MEDIA_APP_OWNER_SOURCE_AND_CONTENT_TRUTH_REVIEW_PASS/u);
  assert.match(manifest.reviewerDisposition, /VOICE_RIGHTS_NOT_REVIEWED/u);
  assert.equal(manifest.sourceRevalidation.approvalDisposition, "NOT_APPROVED_FOR_EXTERNAL_PUBLICATION");

  const video = path.join(root, evidenceDir, path.basename(standard.captures.explorer.videoRef));
  assert.ok(fs.statSync(video).size > 1_000_000, "the captured MOV must be present and non-empty");
  assert.equal(fs.readFileSync(video).subarray(4, 12).toString("ascii"), "ftypqt  ", "the output must be a QuickTime MOV file");
  assert.equal(digestFile(video), manifest.files[path.basename(video)]);
  assert.equal(manifest.capture.audioMetadata.containerTrack, "AAC");
  assert.equal(manifest.capture.audioMetadata.channels, 2);
  assert.equal(manifest.capture.audioMetadata.sampleRateHz, 48000);

  const vttPath = path.join(root, evidenceDir, "narration-captions.vtt");
  const cues = parseVtt(fs.readFileSync(vttPath, "utf8"));
  const timeline = JSON.parse(fs.readFileSync(path.join(root, evidenceDir, "capture-timeline.json"), "utf8"));
  assert.deepEqual(cues.map(({ id }) => id), expectedScenes);
  assert.deepEqual(manifest.sceneCoverage.map(({ sceneId }) => sceneId), expectedScenes);
  assert.deepEqual(timeline.events.filter(({ startedAtSeconds }) => Number.isFinite(startedAtSeconds)).map(({ sceneId }) => sceneId), expectedScenes);
  assert.equal(cues.length, 7);
  assert.ok(cues.every((cue, index) => cue.end > cue.start && (index === 0 || cue.start >= cues[index - 1].end)));
  assert.ok(cues.at(-1).end <= manifest.durationVerification.avFoundationVideoSeconds);
  assert.equal(manifest.durationVerification.lastVttCueEndSeconds, cues.at(-1).end);
  assert.equal(manifest.durationVerification.vttCueCount, 7);
  assert.equal(manifest.durationVerification.allCuesWithinVideo, true);
  assert.deepEqual(cues.map(({ text }) => text), profile.storyboard.scenes.map(({ narration }) => narration.explorerDraft));

  const audioDir = path.join(root, evidenceDir);
  for (const sceneId of expectedScenes) {
    const audio = path.join(audioDir, `narration-${sceneId}.aiff`);
    assert.ok(fs.statSync(audio).size > 10_000, `${sceneId} has a non-empty narrated source clip`);
    assert.equal(digestFile(audio), manifest.files[path.basename(audio)]);
  }
});

test("PDP-3 recording source revalidation preserves capture pins and records the only non-material source delta", () => {
  const captured = manifest.sourceBaseline.sourcePins;
  const current = manifest.sourceRevalidation.currentSourcePins;
  assert.equal(manifest.sourceRevalidation.disposition, "CURRENT_FOR_SELECTED_J03_DEMO; NON_MATERIAL_PDP0_EXTENSION_SCOPE_CHANGE_REVIEWED");
  assert.equal(manifest.sourceRevalidation.reviewRef, ".product-experience/decision-log.md#PXD-224");
  assert.equal(manifest.sourceRevalidation.changedCapturePins.length, 1);
  assert.equal(manifest.sourceRevalidation.changedCapturePins[0].path, ".product-experience/pdp-0-product-truth/capabilities.yaml");
  assert.equal(manifest.sourceRevalidation.unchangedCapturePinCount, 10);
  assert.deepEqual(current.map(({ path: sourcePath }) => sourcePath).sort(), captured.map(({ path: sourcePath }) => sourcePath).sort());

  for (const pin of current) {
    const sourceFile = path.join(root, pin.path);
    assert.equal(digestFile(sourceFile), pin.currentSha256, `${pin.path} current source SHA-256`);
    const capturePin = captured.find(({ path: sourcePath }) => sourcePath === pin.path);
    assert.equal(capturePin.sha256, pin.captureSha256, `${pin.path} immutable capture pin`);
  }
  assert.match(manifest.sourceRevalidation.changedCapturePins[0].sourceImpact, /seven future capability extensions/u);
  assert.match(manifest.sourceRevalidation.changedCapturePins[0].sourceImpact, /J-03 transcription, caption, journey, and selected fixture meanings .* unchanged/u);
});

test("PDP-3 evidence checksums cover the video, captions, narration, manifest and selected profile", () => {
  const checksumPath = path.join(root, evidenceDir, "SHA256SUMS.txt");
  const entries = fs.readFileSync(checksumPath, "utf8").trim().split("\n").map((line) => {
    const match = line.match(/^([a-f0-9]{64})\s{2}(.+)$/u);
    assert.ok(match, `valid checksum row: ${line}`);
    return { expected: match[1], ref: match[2] };
  });
  assert.equal(entries.length, 12);
  assert.ok(entries.some(({ ref }) => ref === "../../../MEDIA-EARLY-BUSINESS-DEMO-RECORDING.v1.json"));
  for (const entry of entries) {
    const file = path.resolve(root, evidenceDir, entry.ref);
    assert.equal(digestFile(file), entry.expected, `${entry.ref} checksum`);
  }
});
