import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const auditPath = ".product-experience/pdp-2-design-interface-system/gui/reuse-audit.yaml";
const audit = readYaml(auditPath);
const crosswalk = audit.componentFamilyCrosswalk;
const byId = new Map(crosswalk.map((record) => [record.componentRef, record]));

const verifiedExports = new Map([
  ["media.component.task-flow", {
    package: "@audio-video/ui",
    packagePath: "libs/audio-video-ui/package.json",
    source: "libs/audio-video-ui/src/components/MediaTaskFlow.tsx",
    barrel: "libs/audio-video-ui/src/components/index.ts",
    exportName: "MediaTaskFlow",
    consumers: [
      "libs/audio-video-ui/src/screens/MediaTaskScreen.tsx",
      "modules/intelligence/ai-voice/libs/ai-voice-ui-react/src/components/VoiceProductionWorkflow.tsx",
    ],
  }],
  ["media.component.voice-production-workflow", {
    package: "@ghatana/ai-voice-ui-react",
    packagePath: "modules/intelligence/ai-voice/libs/ai-voice-ui-react/package.json",
    source: "modules/intelligence/ai-voice/libs/ai-voice-ui-react/src/components/VoiceProductionWorkflow.tsx",
    barrel: "modules/intelligence/ai-voice/libs/ai-voice-ui-react/src/components/index.ts",
    exportName: "VoiceProductionWorkflow",
    consumers: [],
  }],
  ["media.component.progress-indicator", {
    package: "@audio-video/ui",
    packagePath: "libs/audio-video-ui/package.json",
    source: "libs/audio-video-ui/src/components/MediaProgress.tsx",
    barrel: "libs/audio-video-ui/src/components/index.ts",
    exportName: "MediaProgress",
    consumers: [
      "libs/audio-video-ui/src/components/MediaTaskFlow.tsx",
      "modules/intelligence/ai-voice/libs/ai-voice-ui-react/src/components/TrainingProgress.tsx",
    ],
  }],
]);

function assertSourceExportBinding(record, specification) {
  assert.ok(record.bindingStatus.startsWith("exact-source-and-public-export-identity-observed"));
  const [packageName, exportName] = record.publicExport.split("/components#");
  assert.equal(packageName, specification.package);
  assert.equal(exportName, specification.exportName);
  assert.deepEqual(record.implementationEvidence, [specification.source]);
  assert.ok(existsSync(resolve(root, specification.source)));
  assert.ok(existsSync(resolve(root, specification.barrel)));
  const barrel = readFileSync(resolve(root, specification.barrel), "utf8");
  assert.match(barrel, new RegExp(`\\b${specification.exportName}\\b`, "u"), "barrel must export the exact component name");
  const manifest = JSON.parse(readFileSync(resolve(root, specification.packagePath), "utf8"));
  assert.equal(manifest.name, specification.package);
  assert.equal(manifest.version, record.boundPackageVersion);
  assert.equal(record.packageVersionEvidence, `${specification.packagePath}#version`);
  assert.equal(record.versionEvidenceKind, "source-package-manifest-snapshot; not immutable artifact or release identity");
  assert.equal(record.bindingPort, "exact named component export and its typed source contract");
  assert.ok(manifest.exports?.["./components"]?.types && manifest.exports?.["./components"]?.import,
    "public package boundary must expose type and runtime entrypoints");
  for (const consumer of specification.consumers) {
    assert.ok(existsSync(resolve(root, consumer)), `missing consumer ${consumer}`);
    assert.ok(readFileSync(resolve(root, consumer), "utf8").includes(specification.exportName),
      `${consumer} must use the shared exact family export`);
  }
  assert.match(record.reviewState, /owner-accessibility|owner review|visual/u,
    "source/export identity does not claim independent accessibility, visual, or owner acceptance");
}

function assertExplicitContractOnly(record) {
  assert.equal(record.bindingStatus, "contract-only-no-verified-exact-public-family-export");
  assert.equal(record.publicExport, "none established");
  assert.equal(record.contractOnlyDisposition.status, "EXPLICIT_CONTRACT_ONLY");
  assert.equal(record.contractOnlyDisposition.noEquivalenceInferred, true);
  assert.ok(record.contractOnlyDisposition.rationale.length >= 40,
    `${record.componentRef} needs its own concrete contract-only rationale`);
  assert.equal(verifiedExports.has(record.componentRef), false);
}

test("all 31 Media component families have an exact export or an explicit contract-only disposition", () => {
  assert.equal(crosswalk.length, 31);
  assert.equal(new Set(crosswalk.map(({ componentRef }) => componentRef)).size, 31);
  assert.equal(audit.publicExportInventory.implementationDispositionCounts.sourceAndPublicExportIdentityObserved, 3);
  assert.equal(audit.publicExportInventory.implementationDispositionCounts.explicitContractOnlyWithFamilySpecificRationale, 28);
  assert.match(audit.publicExportInventory.completionMeaning, /not package-resolution evidence/u);

  for (const [id, specification] of verifiedExports) assertSourceExportBinding(byId.get(id), specification);
  for (const record of crosswalk) {
    if (!verifiedExports.has(record.componentRef)) assertExplicitContractOnly(record);
  }
});

test("screen candidates, partial Shared reuse, and similar component exports never become family equivalence", () => {
  for (const id of [
    "media.component.project-browser",
    "media.component.project-context-summary",
    "media.component.source-picker",
    "media.component.activity-recovery-feed",
  ]) {
    const record = byId.get(id);
    assert.ok(record.implementationEvidence.some((path) => path.includes("/screens/")));
    assertExplicitContractOnly(record);
    assert.match(record.contractOnlyDisposition.rationale, /full-screen|whole-screen/u);
  }
  const browser = byId.get("media.component.project-browser");
  assert.deepEqual(browser.sharedReuse.components, ["EmptyState"]);
  assert.equal(browser.publicExport, "none established");
  assert.match(browser.contractOnlyDisposition.rationale, /partial composition reuse/u);

  const sourcePicker = byId.get("media.component.source-picker");
  assert.deepEqual(sourcePicker.sharedReuse.components, ["FileUpload"]);
  assert.equal(sourcePicker.publicExport, "none established");
  assert.match(sourcePicker.contractOnlyDisposition.rationale, /partial source-picker reuse only/u);

  for (const [id, candidate, requiredMismatch] of [
    ["media.component.waveform-spectrogram", "@ghatana/ai-voice-ui-react/components#Waveform", /spectrogram mode.*analysis kind and units/u],
    ["media.component.timeline-keyframe-editor", "@ghatana/ai-voice-ui-react/components#PhraseTimeline", /voice-phrase timeline.*animation keyframes/u],
    ["media.component.audio-mixer", "@ghatana/ai-voice-ui-react/components#StemTrack", /per-stem control.*channel\/bus lists/u],
  ]) {
    const record = byId.get(id);
    assert.equal(record.candidatePublicExportObservation, candidate);
    assertExplicitContractOnly(record);
    assert.match(record.contractOnlyDisposition.rationale, requiredMismatch);
  }

  const falsePublicBinding = structuredClone(browser);
  falsePublicBinding.bindingStatus = "exact-source-and-public-export-identity-observed";
  falsePublicBinding.publicExport = "@audio-video/ui/components#FirstUseProjectScreen";
  assert.throws(() => assertExplicitContractOnly(falsePublicBinding));
  const falseUnknownExport = structuredClone(byId.get("media.component.waveform-spectrogram"));
  falseUnknownExport.bindingStatus = "exact-source-and-public-export-identity-observed";
  falseUnknownExport.publicExport = "@audio-video/ui/components#InventedWaveformSpectrogram";
  assert.throws(() => assertExplicitContractOnly(falseUnknownExport));
});
