import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMediaProductDefinitionResidualReport,
  renderMediaProductDefinitionResidualJson,
  renderMediaProductDefinitionResidualMarkdown,
  validateProjectionSourceReferences,
} from "../scripts/lib/media-product-definition-residuals.mjs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("residual report validates exact projection dispositions and pinned sources", () => {
  const report = buildMediaProductDefinitionResidualReport();

  assert.deepEqual(report.diagnostics, []);
  assert.deepEqual(report.projections.map(({ phase }) => phase), ["PDP-0", "PDP-2", "PDP-3"]);
  assert.deepEqual(report.projections.map(({ unresolvedFieldCount }) => unresolvedFieldCount), [4, 0, 10]);
  assert.deepEqual(report.projections.map(({ unresolvedFields }) => unresolvedFields.map(({ field }) => field)), [
    ["domainRules", "requirements", "successMeasures", "userIntents"],
    [],
    ["actions", "componentContracts", "effects", "finality", "fixtures", "journeys", "recovery", "scenarios", "transitions", "views"],
  ]);
  assert.deepEqual(report.projections[0].intentionalOmissions.map(({ field, status }) => ({ field, status })), [
    { field: "createdAt", status: "OPTIONAL_AUTHORED_METADATA_OMITTED_INTENTIONALLY" },
    { field: "updatedAt", status: "OPTIONAL_AUTHORED_METADATA_OMITTED_INTENTIONALLY" },
  ]);
  for (const projection of report.projections) {
    assert.equal(projection.unresolvedFieldCount, projection.unresolvedFields.length);
    assert.ok(projection.mappedFieldCount >= projection.unresolvedFieldCount);
    assert.ok(projection.unresolvedFields.every((field) => field.id && field.status && field.reasons.length));
  }
  assert.equal(report.capabilityCoverage.leafCount, 462, "capability denominator must not shrink without an explicit source-scope revision");
  assert.equal(report.capabilityCoverage.unresolvedCount, 383);
  assert.equal(new Set(report.capabilityCoverage.unresolvedLeafIds).size, report.capabilityCoverage.unresolvedCount);
  assert.equal(report.capabilityCoverage.applicability.total, 462);
  assert.equal(report.capabilityCoverage.applicability.classified, 79);
  assert.equal(report.capabilityCoverage.applicability.unresolved, 383);
  assert.equal(report.capabilityCoverage.acceptedCoverageCount, 0);
  assert.equal(report.capabilityCoverage.unresolvedLeaves.length, 383);
  assert.ok(report.capabilityCoverage.unresolvedLeaves.every((leaf) => leaf.id && leaf.sourceRef && leaf.rationale));
  assert.equal(Object.values(report.capabilityCoverage.dispositionCounts).reduce((sum, count) => sum + count, 0), report.capabilityCoverage.leafCount);
  assert.equal(report.migrationSemantics.uniqueContentUnits, 1340);
  assert.equal(report.migrationSemantics.unresolvedCount, 349);
  assert.equal(report.migrationSemantics.mixedRequiresDecompositionCount, 123);
  assert.equal(report.migrationSemantics.sourceChangeLedger.changedClusterCount, 15);
  assert.equal(report.migrationSemantics.sourceChangeLedger.historicalSha256,
    report.migrationSemantics.sourcePins.find(({ path }) => path === "docs/migration/expert-reviewed-master-plan.md").sha256);
  assert.equal(report.migrationSemantics.sourceChangeLedger.observedCurrentSha256, report.migrationSemantics.sourceChangeLedger.actualCurrentSha256);
  assert.notEqual(report.migrationSemantics.sourceChangeLedger.historicalSha256, report.migrationSemantics.sourceChangeLedger.actualCurrentSha256);
  assert.equal(report.migrationSemantics.sourceChangeLedger.unmappedClusterIds.length, 2);
  assert.deepEqual(report.migrationSemantics.sourceChangeLedger.unmappedClusterIds, ["MSC-01", "MSC-09"]);
  assert.equal(report.migrationSemantics.sourceChangeLedger.clusters.length, 15);
  assert.ok(report.migrationSemantics.sourceChangeLedger.clusters.every((cluster) => cluster.currentLineSpans.length && cluster.changedClaims));
  assert.ok(report.migrationSemantics.unresolvedItemIds.every((id) => /^MPSEM-\d+$/u.test(id)));
  assert.ok(report.migrationSemantics.mixedItemIds.every((id) => /^MPSEM-\d+$/u.test(id)));
  assert.equal(Object.values(report.migrationSemantics.classificationCounts).reduce((sum, count) => sum + count, 0), 1340);
  assert.equal(report.migrationSemantics.total, 1340);
  assert.equal(report.migrationSemantics.applicable, 406);
  assert.equal(report.migrationSemantics.unresolvedItems.length, 349);
  assert.ok(report.migrationSemantics.unresolvedItems.every((item) => item.id && item.sourceLocations.length && item.classificationBasis));
  assert.equal(report.operationParity.surfaceCount, 8);
  assert.equal(report.operationParity.totalObservedIdentities, 279);
  assert.equal(report.operationParity.unresolvedIdentityCount, 175);
  assert.ok(report.operationParity.surfaces.every((surface) => surface.observedIdentities.length === surface.denominator));
  assert.ok(report.operationParity.surfaces.every((surface) => surface.unresolvedIdentities.length === (surface.counts.unresolved ?? 0)));
  assert.equal(report.designConformance.gateCount, 7);
  assert.equal(report.designConformance.resolvedOwnerGateCount, 4);
  assert.equal(report.designConformance.openGateCount, 3);
  assert.deepEqual(report.designConformance.gates
    .filter((gate) => gate.status !== "RESOLVED_OWNER")
    .map(({ id, status }) => ({ id, status })), [
    { id: "shared-artifact-binding", status: "EXTERNAL_PENDING" },
    { id: "conformance-and-specialist-review", status: "INDEPENDENT_PENDING" },
    { id: "concrete-component-bindings", status: "SOURCE_INCOMPLETE" },
  ]);
  assert.equal(report.lifecycle.obligationCount, 318);
  assert.equal(report.lifecycle.totalProofRoutes, 318);
  assert.equal(report.lifecycle.obligationsMissingCaseIds.length, 256);
  assert.equal(report.lifecycle.receiptEvaluation.status, "NOT_EVALUATED");
  assert.equal(report.lifecycle.receiptEvaluation.authoritativeReceiptCount, null);
  assert.equal(report.lifecycle.currentnessEvaluation.status, "NOT_EVALUATED");
  assert.equal(report.productExperience.screenViewCount, 47);
  assert.equal(report.productExperience.journeyCount, 30);
  assert.equal(report.productExperience.stepCount, 130);
  assert.equal(report.productExperience.stepsWithScreenContracts, 122);
  assert.equal(report.productExperience.stepsWithActionBindings, 18);
  assert.equal(report.productExperience.journeyTrace.journeyCount, 30);
  assert.equal(report.productExperience.journeyTrace.orderedStepCount, 130);
  assert.equal(report.productExperience.journeyTrace.steps.length, 130);
  assert.equal(report.productExperience.journeyTrace.screenContractBindings.unresolvedSteps.length, 8);
  assert.equal(report.productExperience.journeyTrace.actionBindings.linkedSteps.length, 18);
  assert.equal(report.productExperience.journeyTrace.actionBindings.unresolvedSteps.length, 112);
  assert.ok(report.productExperience.journeyTrace.steps.every((step) => step.journeyRef && step.sourceRef && step.stepKey));
  assert.ok(report.productExperience.journeyTrace.actionBindings.linkedSteps
    .every((step) => step.actionRef && step.actionBindingState === "SOURCE_LINKED_PROPOSAL"));
  assert.match(renderMediaProductDefinitionResidualMarkdown(report), /authoritative receipt\/currentness evaluation is NOT_EVALUATED/u);
  assert.ok(report.capabilityCoverage.sourcePins
    .every((pin) => pin.state === "CURRENT"));
  assert.deepEqual(report.migrationSemantics.sourcePins
    .filter((pin) => pin.state !== "CURRENT")
    .map(({ path, state }) => ({ path, state })), [
    { path: "docs/migration/expert-reviewed-master-plan.md", state: "STALE" },
    { path: ".product-experience/pdp-0-product-truth/actors-responsibilities.yaml", state: "STALE" },
    { path: ".product-experience/pdp-0-product-truth/constitution.yaml", state: "STALE" },
    { path: ".product-experience/pdp-0-product-truth/goals-jtbd.yaml", state: "STALE" },
  ]);
  assert.notEqual(report.migrationSemantics.declaredSourceLineCount, report.migrationSemantics.currentSourceLineCount);
});

test("residual report output is deterministic and clearly diagnostic", () => {
  const first = buildMediaProductDefinitionResidualReport();
  const second = buildMediaProductDefinitionResidualReport();

  assert.equal(renderMediaProductDefinitionResidualJson(first), renderMediaProductDefinitionResidualJson(second));
  assert.match(renderMediaProductDefinitionResidualMarkdown(first), /diagnostic-only/u);
  assert.match(renderMediaProductDefinitionResidualMarkdown(first), /Projection mappings/u);
});

test("projection source validation rejects unregistered and stale local sources", () => {
  const root = resolve(new URL("..", import.meta.url).pathname);
  const path = ".product-experience/pdp-2-design-interface-system/generated/experience-language.candidate.json";
  const source = { phase: "PDP-2", name: "experience-language", path };
  const candidate = JSON.parse(readFileSync(resolve(root, path), "utf8"));
  assert.deepEqual(validateProjectionSourceReferences(root, source, candidate), []);

  const unregistered = structuredClone(candidate);
  unregistered.candidateFieldSources.subjectId.sourceRef = ".product-experience/missing-authority.yaml";
  assert.ok(validateProjectionSourceReferences(root, source, unregistered)
    .some((diagnostic) => /subjectId sourceRef is not present in sourceAuthorities/u.test(diagnostic)));

  const stale = structuredClone(candidate);
  stale.sourceAuthorities.find(({ sourceRef }) => sourceRef === stale.candidateFieldSources.subjectId.sourceRef).sha256 = "0".repeat(64);
  assert.ok(validateProjectionSourceReferences(root, source, stale)
    .some((diagnostic) => /subjectId source authority is stale/u.test(diagnostic)));
});
