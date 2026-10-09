import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildLocalViewObservationStateProjection } from "../scripts/lib/pdp3-view-observation-state-projection.mjs";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const parse = require("yaml").parse;
const root = resolve(new URL("..", import.meta.url).pathname);
const publicExperienceSpecification = await import(pathToFileURL(resolve(root, "../ghatana-tools/libs/product-development/experience-specification/src/index.ts")).href);
const read = (path) => parse(readFileSync(path, "utf8"));
const predicates = read(".product-experience/pdp-3-product-experience/view-observation-predicates.yaml");
const inputContracts = read(".product-experience/pdp-3-product-experience/view-observation-input-contracts.yaml");
const dispositions = read(".product-experience/pdp-3-product-experience/view-state-binding-dispositions.yaml");
const screenRegistry = read(".product-experience/pdp-3-product-experience/screen-registry.yaml");
const views = [...screenRegistry.screens, ...screenRegistry.laneViews];

test("all local observation predicates project to distinct view-state refs, separate from PDP1 states", () => {
  const projection = buildLocalViewObservationStateProjection({
    predicates: predicates.predicates,
    factSchemas: inputContracts.factSchemas,
    views,
    viewDispositions: dispositions.views,
  });
  assert.equal(views.length, 47);
  assert.equal(projection.states.length, 364);
  assert.equal(projection.refsByView.size, 47);
  assert.equal([...projection.refsByView.values()].flat().length, 364);
  for (const state of projection.states) {
    assert.match(state.id, /^media\.view-observation\./u);
    assert.equal(state.isTerminal, false);
    assert.ok(state.invariants.some((item) => item.startsWith("factSchemaRef:")));
    assert.ok(state.invariants.includes("display-only; runtimeAdmission=NOT_ADMITTED"));
    assert.doesNotMatch(state.id, /^(media-job|media-project|media-upload-and-artifact)\//u);
  }
});

test("projection refuses cross-view predicates, duplicate IDs, and unresolved schemas", () => {
  const input = { predicates: predicates.predicates, factSchemas: inputContracts.factSchemas, views, viewDispositions: dispositions.views };
  const wrongView = structuredClone(input);
  wrongView.predicates[0].factScope.viewRef = "media.view.foreign";
  assert.throws(() => buildLocalViewObservationStateProjection(wrongView), /Invalid local view-state predicate binding/u);
  const duplicateId = structuredClone(input);
  duplicateId.predicates[1].id = duplicateId.predicates[0].id;
  assert.throws(() => buildLocalViewObservationStateProjection(duplicateId), /Invalid local view-state predicate binding/u);
  const unresolvedSchema = structuredClone(input);
  unresolvedSchema.predicates[0].factSchemaRef = ".product-experience/pdp-3-product-experience/view-observation-input-contracts.yaml#factSchemas/@id=media.view-observation-schema.missing.v1";
  assert.throws(() => buildLocalViewObservationStateProjection(unresolvedSchema), /Invalid local view-state predicate binding/u);
  const foreignSource = structuredClone(input);
  foreignSource.predicates[0].factSchemaRef = "other.yaml#factSchemas/@id=" + foreignSource.predicates[0].factSchemaRef.split("@id=")[1];
  assert.throws(() => buildLocalViewObservationStateProjection(foreignSource), /Invalid local view-state predicate binding/u);
  const foreignDisposition = structuredClone(input);
  foreignDisposition.viewDispositions[0].viewRef = "media.view.foreign";
  assert.throws(() => buildLocalViewObservationStateProjection(foreignDisposition), /View-state source disposition/u);
  const replacedDisposition = structuredClone(input);
  replacedDisposition.viewDispositions[0].viewRef = replacedDisposition.views[1].id;
  assert.throws(() => buildLocalViewObservationStateProjection(replacedDisposition), /View-state source disposition/u);
  const missingDisposition = structuredClone(input);
  missingDisposition.viewDispositions.pop();
  assert.throws(() => buildLocalViewObservationStateProjection(missingDisposition), /View-state source disposition|Invalid local view-state predicate binding/u);
  const weakenedSchema = structuredClone(input);
  weakenedSchema.factSchemas[0].closedSchema.additionalProperties = true;
  assert.throws(() => buildLocalViewObservationStateProjection(weakenedSchema), /closed schema definitions/u);
  const missingSchemaFields = structuredClone(input);
  missingSchemaFields.factSchemas[0].closedSchema.required = [];
  assert.throws(() => buildLocalViewObservationStateProjection(missingSchemaFields), /closed schema definitions/u);
});

test("local observation state refs validate in the public Tools schema without becoming PDP1 states", () => {
  const local = buildLocalViewObservationStateProjection({
    predicates: predicates.predicates,
    factSchemas: inputContracts.factSchemas,
    views,
    viewDispositions: dispositions.views,
  });
  const model = {
    id: "media.experience-definition.local-state-test",
    subjectId: "media",
    schemaVersion: publicExperienceSpecification.EXPERIENCE_SPECIFICATION_SCHEMA_VERSION,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    contextDimensions: [], renderTargets: [], componentContracts: [], journeys: [], interactions: [], transitions: [], actions: [], effects: [], finality: [], recovery: [], scenarios: [], fixtures: [], search: [], inspections: [],
    views: [{ id: views[0].id, name: views[0].label, intent: views[0].purpose, componentRefs: [], journeyRefs: [], stateRefs: local.refsByView.get(views[0].id) }],
    states: local.states,
  };
  assert.doesNotThrow(() => publicExperienceSpecification.validateExperienceDefinition(model, { resolveReference: () => true }));
  assert.ok(model.states.every((state) => state.id.startsWith("media.view-observation.")));
  assert.ok(model.states.every((state) => !state.id.startsWith("media-upload-and-artifact.") && !state.id.startsWith("media-job.")));
  const forgedCanonicalAlias = structuredClone(model);
  forgedCanonicalAlias.views[0].stateRefs[0] = "media-upload-and-artifact.AVAILABLE";
  assert.throws(() => publicExperienceSpecification.validateExperienceDefinition(forgedCanonicalAlias, { resolveReference: () => true }));
});
