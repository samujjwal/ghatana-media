import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");

test("PDP-2 reuse audit counts match the executable UI inventory", () => {
  const audit = parse(readFileSync(resolve(root, ".product-experience/pdp-2-design-interface-system/gui/reuse-audit.yaml"), "utf8"));
  const inventory = JSON.parse(readFileSync(resolve(root, ".product-experience/pdp-2-design-interface-system/executable-ui-inventory.json"), "utf8"));
  const observedCounts = Object.fromEntries(Object.entries(
    inventory.entries.reduce((counts, entry) => {
      counts[entry.disposition] = (counts[entry.disposition] ?? 0) + 1;
      return counts;
    }, {}),
  ).sort(([left], [right]) => left.localeCompare(right)));
  const auditedCounts = Object.fromEntries(Object.entries(audit.sourceInventory.dispositionCounts)
    .filter(([, count]) => count !== 0)
    .sort(([left], [right]) => left.localeCompare(right)));

  assert.equal(audit.sourceInventory.entryCount, inventory.entries.length);
  assert.deepEqual(auditedCounts, observedCounts);
});

test("PDP-2 reuse audit records exact cross-product reuse and semantic exclusions", () => {
  const audit = parse(readFileSync(resolve(root, ".product-experience/pdp-2-design-interface-system/gui/reuse-audit.yaml"), "utf8"));
  const sharedCandidates = new Map(audit.additionalSharedCandidates.map((candidate) => [candidate.candidate, candidate]));
  const ecosystemCandidates = new Map(audit.ecosystemComponentCandidates.map((candidate) => [candidate.candidate, candidate]));
  const productShell = ecosystemCandidates.get("@ghatana/product-shell#ProductShell/DashboardLayout/PageHeader/PageContent");

  assert.deepEqual(audit.crossProductReuse.componentReuse.consumers, [
    "libs/audio-video-ui/src/components/MediaTaskFlow.tsx",
    "modules/intelligence/ai-voice/libs/ai-voice-ui-react/src/components/TrainingProgress.tsx",
  ]);
  assert.equal(audit.crossProductReuse.codeReuse.consumer, "modules/intelligence/ai-voice/libs/ai-voice-ui-react/src/components/VoiceProductionWorkflow.tsx");
  assert.equal(sharedCandidates.get("@ghatana/design-system/molecules#Stepper")?.disposition, "not-adopted");
  assert.equal(sharedCandidates.get("@ghatana/design-system/molecules/FormStepper#FormStepper")?.disposition, "not-adopted");
  assert.equal(sharedCandidates.get("@ghatana/design-system/atoms#DataUseNotice")?.disposition, "not-adopted");
  assert.match(sharedCandidates.get("@ghatana/design-system/atoms#DataUseNotice")?.rationale, /processing location or a retention period/u);
  assert.equal(ecosystemCandidates.get("@gharbatai/ui-mui#EmptyStateCard")?.disposition, "not-adopted");
  assert.equal(productShell?.disposition, "not-adopted-current-media-workflow-body");
  assert.match(productShell?.rationale, /host-level application chrome/u);
  assert.match(productShell?.rationale, /another h1/u);
  assert.match(productShell?.rationale, /duplicate main landmarks/u);
  assert.match(productShell?.rationale, /style-src-attr 'none'/u);
  assert.match(productShell?.rationale, /not a dependency of @audio-video\/ui/u);
  assert.match(productShell?.followUp, /future host-integration candidate/u);
});

test("PDP-2 family crosswalk binds only source-exact public component exports and consumers", () => {
  const auditText = readFileSync(resolve(root, ".product-experience/pdp-2-design-interface-system/gui/reuse-audit.yaml"), "utf8");
  const audit = parse(auditText);
  const contracts = parse(readFileSync(resolve(root, ".product-experience/pdp-2-design-interface-system/component-contracts.yaml"), "utf8"));
  const crosswalk = new Map(audit.componentFamilyCrosswalk.map((entry) => [entry.componentRef, entry]));
  const publicBarrel = readFileSync(resolve(root, "libs/audio-video-ui/src/index.tsx"), "utf8");
  const exact = audit.publicExportInventory;
  const expectedBindings = [
    {
      family: "media.component.progress-indicator",
      source: "libs/audio-video-ui/src/components/MediaProgress.tsx",
      exportName: "MediaProgress",
      packagePath: "libs/audio-video-ui",
      packageName: "@audio-video/ui",
      consumers: [
        "libs/audio-video-ui/src/components/MediaTaskFlow.tsx",
        "modules/intelligence/ai-voice/libs/ai-voice-ui-react/src/components/TrainingProgress.tsx",
      ],
    },
    {
      family: "media.component.task-flow",
      source: "libs/audio-video-ui/src/components/MediaTaskFlow.tsx",
      exportName: "MediaTaskFlow",
      packagePath: "libs/audio-video-ui",
      packageName: "@audio-video/ui",
      consumers: [
        "libs/audio-video-ui/src/screens/MediaTaskScreen.tsx",
        "modules/intelligence/ai-voice/libs/ai-voice-ui-react/src/components/VoiceProductionWorkflow.tsx",
      ],
    },
    {
      family: "media.component.voice-production-workflow",
      source: "modules/intelligence/ai-voice/libs/ai-voice-ui-react/src/components/VoiceProductionWorkflow.tsx",
      exportName: "VoiceProductionWorkflow",
      packagePath: "modules/intelligence/ai-voice/libs/ai-voice-ui-react",
      packageName: "@ghatana/ai-voice-ui-react",
      consumers: [],
      testConsumer: "modules/intelligence/ai-voice/libs/ai-voice-ui-react/src/components/VoiceProductionWorkflow.test.tsx",
    },
  ];

  assert.equal(contracts.components.length, 31);
  assert.equal(crosswalk.size, contracts.components.length, "every PDP-2 family has one explicit crosswalk row");
  assert.equal(exact.contractFamilyCount, contracts.components.length);
  assert.equal(exact.exactSourceAndPublicExportIdentityCount, expectedBindings.length);
  assert.equal(exact.unboundFamilyCount, contracts.components.length - expectedBindings.length);
  assert.deepEqual(exact.exactBindings, expectedBindings.map(({ family }) => family));
  assert.deepEqual(exact.unboundFamilies, contracts.components.map(({ id }) => id).filter((id) => !exact.exactBindings.includes(id)));

  for (const binding of expectedBindings) {
    const contract = contracts.components.find(({ id }) => id === binding.family);
    const row = crosswalk.get(binding.family);
    assert.equal(contract.sourceRef, binding.source, `${binding.family}: contract source identity`);
    assert.ok(row.implementationEvidence.includes(binding.source), `${binding.family}: implementation source identity`);
    assert.equal(row.bindingStatus, "exact-source-and-public-export-identity-observed; owner-accessibility-and-package-acceptance-pending");
    assert.equal(row.publicExport, `${binding.packageName}/components#${binding.exportName}`);
    assert.ok(row.publicExportEvidence.includes(`${binding.packagePath}/package.json#./components`));
    const manifest = JSON.parse(readFileSync(resolve(root, `${binding.packagePath}/package.json`), "utf8"));
    const barrel = readFileSync(resolve(root, `${binding.packagePath}/src/components/index.ts`), "utf8");
    assert.equal(manifest.exports["./components"].import, "./dist/components/index.js");
    assert.match(barrel, new RegExp(`export \\{ ${binding.exportName} \\} from \\"\\./${binding.exportName}\\"`));
    if (binding.packageName === "@audio-video/ui") {
      assert.match(publicBarrel, /export \* from "\.\/components"/u);
    } else {
      const aiVoiceRootBarrel = readFileSync(resolve(root, `${binding.packagePath}/src/index.ts`), "utf8");
      assert.match(aiVoiceRootBarrel, new RegExp(`\\b${binding.exportName}\\b[\\s\\S]*?from \\"\\.\\/components\\"`));
    }
    assert.deepEqual(row.actualConsumers, binding.consumers);
    if (binding.testConsumer) {
      assert.ok(row.testConsumer === binding.testConsumer);
      assert.match(readFileSync(resolve(root, binding.testConsumer), "utf8"), new RegExp(`import \\{ ${binding.exportName} \\}`));
    }
  }

  const mediaTaskScreen = readFileSync(resolve(root, expectedBindings[1].consumers[0]), "utf8");
  const voiceWorkflow = readFileSync(resolve(root, expectedBindings[1].consumers[1]), "utf8");
  const mediaFlow = readFileSync(resolve(root, expectedBindings[0].consumers[0]), "utf8");
  const trainingProgress = readFileSync(resolve(root, expectedBindings[0].consumers[1]), "utf8");
  assert.match(mediaTaskScreen, /MediaTaskFlow/u);
  assert.match(voiceWorkflow, /MediaTaskFlow/u);
  assert.match(mediaFlow, /MediaProgress/u);
  assert.match(trainingProgress, /import \{ MediaProgress \} from "@audio-video\/ui"/u);

  for (const id of exact.unboundFamilies) {
    const row = crosswalk.get(id);
    assert.ok(row, `${id}: explicit unbound family row`);
    assert.notEqual(row.bindingStatus, "exact-source-and-public-export-identity-observed; owner-accessibility-and-package-acceptance-pending");
  }
  assert.equal(audit.sharedStylesheetBindingReview.observedMismatch.exactNameMatches, 0);
  assert.equal(crosswalk.get("media.component.task-flow").sharedReuse.progress, "excluded-from-Shared-reuse");
  assert.equal(crosswalk.get("media.component.progress-indicator").sharedReuse.status, "excluded-from-Shared-reuse");
  assert.match(audit.publicExportInventory.sharedConsumerObservation, /Shared EmptyState is source\/test-verified supporting markup/u);

  const acceptance = readFileSync(resolve(root, ".product-experience/acceptance.yaml"), "utf8");
  assert.match(acceptance, /approves 41 exact top-level template\/layout links and withholds six mismatches/u);
  assert.match(acceptance, /full 47-screen denominator is preserved/u);
});

test("PDP-2 reuse audit covers the broader Ghatana workspace and dependency boundaries", () => {
  const audit = parse(readFileSync(resolve(root, ".product-experience/pdp-2-design-interface-system/gui/reuse-audit.yaml"), "utf8"));
  const review = audit.ecosystemReuseReview;
  const packages = new Map(review.packageReviews.map((entry) => [entry.package, entry]));

  assert.equal(review.status, "local-source-review; no additional implementation binding admitted");
  assert.ok(review.scope.includedSiblingWorkspaces.includes("../ghatana-shared/platform/typescript/*"));
  assert.ok(review.scope.includedSiblingWorkspaces.includes("../ghatana-tools/libs/product-development/*"));
  assert.ok(review.scope.inspectedMediaSurfaces.includes("libs/audio-video-ui/src/screens/TranscriptCaptionScreen.tsx"));
  assert.ok(review.scope.inspectedMediaSurfaces.includes("apps/media-experience-explorer/src/product-review.tsx"));
  assert.ok(review.scope.filesystemAccessibleButOutsideMediaWorkspace.some((entry) => entry.repository === "../ghatana-kernel"));
  assert.ok(review.scope.filesystemAccessibleButOutsideMediaWorkspace.some((entry) => entry.repository === "../gharbatai"));

  assert.equal(packages.get("@ghatana/design-system")?.disposition, "exact-empty-state-and-file-picker-reuse; other-observed-controls-excluded");
  assert.match(packages.get("@ghatana/design-system")?.surfaceMapping["artifact-and-project-collections"], /sort\/filter\/page semantics/u);
  assert.equal(packages.get("@ghatana/product-shell")?.disposition, "future-host-integration-candidate; not-current-workflow-body");
  assert.equal(packages.get("@ghatana/ui-styles")?.disposition, "candidate-not-consumed; unresolved-token-contract");
  assert.equal(packages.get("@ghatana/accessibility")?.disposition, "verification-tooling-not-renderer");
  assert.match(review.scope.filesystemAccessibleButOutsideMediaWorkspace.find((entry) => entry.repository === "../ghatana-kernel")?.finding, /not reusable Media UI/u);
  assert.equal(packages.get("@gharbatai/ui-react and @gharbatai/ui-web")?.workspacePackage, false);
  assert.equal(packages.get("@gharbatai/forms-react-hook-form and @gharbatai/table-tanstack")?.workspacePackage, false);
  assert.match(review.verificationBoundary.acceptanceBoundary, /No new component/u);
});
