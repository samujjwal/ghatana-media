import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createFixtureState, mediaExperienceScenarioIds, projectExperience } from "../dist/index.js";
import { evaluateRetryEligibilityDefinition } from "../dist/retry-eligibility-definition.js";

const require = createRequire(resolve(process.cwd(), "../../../ghatana-tools/package.json"));
const { parse } = require("yaml");
const source = parse(await readFile(new URL("../../../.product-experience/pdp-3-product-experience/scenario-fixture-registry.yaml", import.meta.url), "utf8"));
const sourceById = new Map(source.fixtures.map((fixture) => [fixture.id, fixture]));
const actionSet = (scenarioId) => new Set(projectExperience(createFixtureState(scenarioId)).safeActionIds);
const mustAllow = (actions, actionRef, scenarioId) => assert.ok(actions.has(actionRef), `${scenarioId} must allow ${actionRef}`);
const mustDeny = (actions, actionRef, scenarioId) => assert.ok(!actions.has(actionRef), `${scenarioId} must not allow ${actionRef}`);

test("all 31 PDP-3 synthetic scenarios exercise their exact safe-action and non-happy-path boundaries", () => {
  assert.equal(source.fixtures.length, 31);
  assert.equal(mediaExperienceScenarioIds.length, 31);
  assert.deepEqual([...mediaExperienceScenarioIds].sort(), source.fixtures.map(({ id }) => id).sort());

  for (const { id, expected } of source.fixtures) {
    const actions = actionSet(id);
    const state = createFixtureState(id);
    assert.equal(state.scenarioId, id);
    assert.match(expected, /.+/u);

    if (state.workflow === "first-use") {
      if (id === "media.scenario.first-use-empty") mustAllow(actions, "media.action.create-project", id);
      else mustDeny(actions, "media.action.create-project", id);
      if (state.firstUse.creationStatus === "OUTCOME_UNKNOWN") mustAllow(actions, "media.action.inspect-project-creation", id);
      else mustDeny(actions, "media.action.inspect-project-creation", id);
      if (!state.firstUse.identityResolved || state.firstUse.workspaceAccess !== "ALLOWED") mustDeny(actions, "media.action.create-project", id);
    }

    if (state.workflow === "artifact-intake") {
      if (state.artifactIntake.status === "OUTCOME_UNKNOWN") {
        mustAllow(actions, "media.action.inspect-artifact", id);
        mustDeny(actions, "media.action.resume-artifact-upload", id);
      }
      if (state.artifactIntake.status === "INTERRUPTED" && state.artifactIntake.uploadResumeAuthority === "ALLOWED" && state.artifactIntake.sourceMetadataMatches && state.artifactIntake.workspaceMatches) {
        mustAllow(actions, "media.action.resume-artifact-upload", id);
      }
      if (["REJECTED", "QUARANTINED", "ACCESS_REVOKED"].includes(state.artifactIntake.status)) {
        mustDeny(actions, "media.action.resume-artifact-upload", id);
      }
    }

    if (state.workflow === "artifact-verification") {
      mustAllow(actions, "media.action.view-job-status", id);
      if (state.artifactVerification.status === "OUTCOME_UNKNOWN") mustAllow(actions, "media.action.check-job-outcome", id);
      else mustDeny(actions, "media.action.check-job-outcome", id);
      mustDeny(actions, "media.action.request-transcription", id);
    }

    if (state.workflow === "transcription") {
      if (state.consentState === "REVOKED" || state.access.processSource !== "ALLOWED") {
        mustDeny(actions, "media.action.request-transcription", id);
        mustDeny(actions, "media.action.save-caption-version", id);
      }
      if (state.job.finality === "UNKNOWN") {
        mustAllow(actions, "media.action.check-job-outcome", id);
        mustDeny(actions, "media.action.request-transcription", id);
        mustDeny(actions, "media.action.retry-job", id);
        mustDeny(actions, "media.action.request-cancellation", id);
      }
      if (state.captionDraft.hasConflict) {
        mustAllow(actions, "media.action.resolve-caption-conflict", id);
        mustDeny(actions, "media.action.save-caption-version", id);
      }
      if (state.captionDraft.timingDisposition !== "ALIGNED") mustDeny(actions, "media.action.save-caption-version", id);
      if (id === "media.scenario.source-available") {
        mustAllow(actions, "media.action.choose-source", id);
        mustDeny(actions, "media.action.request-transcription", id);
      }
      if (id === "media.scenario.source-quarantined") {
        mustAllow(actions, "media.action.inspect-source", id);
        mustDeny(actions, "media.action.request-transcription", id);
      }
      if (id === "media.scenario.job-running") {
        mustAllow(actions, "media.action.request-cancellation", id);
        assert.equal(state.job.finality, "PENDING", "cancellation request remains distinct from confirmed cancellation");
      }
      if (id === "media.scenario.job-retry-ineligible") mustDeny(actions, "media.action.retry-job", id);
      if (id === "media.scenario.job-retry-eligible") {
        const result = evaluateRetryEligibilityDefinition(state.retryEligibility, {
          tenantId: "fixture-tenant-001", principalId: "fixture-principal-creator-001",
          jobId: "fixture-job-retryable-001", jobVersion: 12,
          retryBudgetRef: "fixture:policy:retry-budget:v4", now: "2026-10-09T12:01:00.000Z", maxAgeMs: 120_000,
        });
        assert.equal(result.decision, "ELIGIBLE_FOR_EXPLICIT_REQUEST");
        mustDeny(actions, "media.action.retry-job", id);
        assert.equal(result.effect, "NONE", "eligibility is not an automatic retry or runtime result");
        assert.equal(result.runtimeAdmission, "NOT_ADMITTED");
      }
    }
  }
});

test("unknown effects stay non-replayable across project, upload, verification, and processing scenarios", () => {
  for (const id of [
    "media.scenario.project-create-outcome-unknown",
    "media.scenario.upload-outcome-unknown",
    "media.scenario.artifact-verification-outcome-unknown",
    "media.scenario.job-outcome-unknown",
  ]) {
    const fixture = sourceById.get(id);
    const actions = actionSet(id);
    assert.ok(fixture.initialConditions && fixture.expected);
    mustDeny(actions, "media.action.retry-job", id);
    mustDeny(actions, "media.action.create-project", id);
    mustDeny(actions, "media.action.resume-artifact-upload", id);
    if (id === "media.scenario.job-outcome-unknown") mustAllow(actions, "media.action.check-job-outcome", id);
    if (id === "media.scenario.artifact-verification-outcome-unknown") mustAllow(actions, "media.action.check-job-outcome", id);
  }
});
