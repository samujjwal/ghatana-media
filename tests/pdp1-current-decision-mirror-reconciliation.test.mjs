import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");

const decisionPath = ".product-experience/pdp-1-domain-data/decisions.yaml";
const reconciliationPath = ".product-experience/pdp-1-domain-data/canonical-reconciliation.yaml";
const offlinePath = ".product-experience/pdp-1-domain-data/offline-sync.yaml";
const overviewPath = ".product-experience/pdp-1-domain-data/DOMAIN-MODEL.md";

function readYaml(path) {
  return parse(readFileSync(path, "utf8"));
}

function decisionById(document, id) {
  const matches = document.decisions.filter((decision) => decision.id === id);
  assert.equal(matches.length, 1, `${id} is unique in decisions.yaml`);
  return matches[0];
}

test("artifact-version decision mirrors the current owner-defined logical disposition and its residuals", () => {
  const decisions = readYaml(decisionPath);
  const reconciliation = readYaml(reconciliationPath);
  const decision = decisionById(decisions, "media.pdp1.decision.artifact-version-and-lineage");
  const adjudication = reconciliation.currentDefinitionAdjudication;
  const record = adjudication.records.find(({ id }) => id === "canonical-artifact-version-and-lineage");

  assert.ok(record, "current canonical artifact-version adjudication exists");
  assert.equal(record.classification, "MEDIA_LOGICAL_MEANING_RESOLVED; STORAGE_AND_RETENTION_ENFORCEMENT_DEFERRED");
  assert.match(record.disposition, /tenantId \+ artifactId \+ opaque versionId/u);
  assert.match(record.disposition, /explicit exact-version ancestry/u);
  assert.equal(decision.state, "OWNER_DEFINED_LOGICAL_MEANING; independent-acceptance-pending");
  assert.ok(decision.sourceRefs.includes(".product-experience/pdp-1-domain-data/canonical-reconciliation.yaml#currentDefinitionAdjudication/records/@id=canonical-artifact-version-and-lineage"));
  assert.ok(decision.sourceRefs.includes(".product-experience/pdp-1-domain-data/versioning.yaml#ownerDefinedRevisionSemantics/artifactVersion"));
  assert.match(decision.pending, /Durable-byte-immutability/u);
  assert.match(decision.pending, /retention-and-erasure-completeness/u);
  assert.match(decision.pending, /cross-product-consumer-compatibility/u);
  assert.match(decision.pending, /independent-P0-010\/PDP-1-acceptance/u);
  assert.match(decision.scopeStatus, /no-runtime-admission/u);
});

test("offline conflict decision mirrors owner-defined semantics while keeping runtime admission deferred", () => {
  const decisions = readYaml(decisionPath);
  const offline = readYaml(offlinePath);
  const decision = decisionById(decisions, "media.pdp1.decision.offline-conflicts");
  const semantics = offline.ownerDefinedOfflineSemantics;
  const reconnect = semantics.reconnectProtocol.join("\n");

  assert.equal(semantics.decisionId, "MEDIA-OWNER-2026-10-08-PDP1-10-OFFLINE-01");
  assert.match(reconnect, /compare every expected canonical source\/project revision and typed parent-version edge; stale values produce CONFLICT, as does changed ancestry/u);
  assert.match(reconnect, /never auto-merge or last-write-wins/u);
  assert.equal(decision.state, "OWNER_DEFINED_LOGICAL_MEANING; independent-acceptance-pending");
  assert.ok(decision.sourceRefs.includes(".product-experience/pdp-1-domain-data/offline-sync.yaml#ownerDefinedOfflineSemantics"));
  assert.match(decision.decision, /mismatch-or-changed-ancestry-is-CONFLICT/u);
  assert.match(decision.pending, /Runtime-conflict-detection/u);
  assert.match(decision.pending, /offline-capability-admission/u);
  assert.match(decision.pending, /device-security-review/u);
  assert.match(decision.pending, /independent-P0-010\/PDP-1-acceptance/u);
  assert.ok(offline.unboundRuntimeAndQualification.includes("device-security-and-reconnect-scenario-qualification"));
  assert.match(semantics.scopeStatus, /offline capability admission and device-security review pending/u);
});

test("PDP-1 overview distinguishes owner-defined meaning from independent acceptance and runtime evidence", () => {
  const overview = readFileSync(overviewPath, "utf8");

  assert.match(overview, /owner-defined logical dispositions are recorded alongside source proposals and observations/u);
  assert.match(overview, /Current owner-defined meanings include the scoped artifact-version identity/u);
  assert.match(overview, /offline revision-conflict behavior/u);
  assert.match(overview, /runtime enforcement, offline capability admission, or\nindependent phase acceptance/u);
  assert.match(overview, /Current owner-defined logical dispositions, including\nartifact-version identity\/lineage and offline revision-conflict behavior/u);
  assert.doesNotMatch(overview, /ArtifactVersion` remains a proposed domain distinction/u);
  assert.doesNotMatch(overview, /canonical registries remain proposals[\s\S]{0,180}offline conflict behavior/u);
});
