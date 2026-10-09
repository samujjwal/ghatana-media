import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const read = (path) => parse(readFileSync(resolve(process.cwd(), path), "utf8"));
const matrix = read(".product-experience/interface-parity/operation-parity.yaml").ownerDefinedSourceTruthMatrix.currentUiActionIdentityResolution;
const actions = read(".product-experience/pdp-3-product-experience/action-registry.yaml");
const operations = read(".product-experience/pdp-1-domain-data/operations.yaml");

function indexOwnerOperations(document) {
  const rows = [
    ...(document.operations ?? []),
    ...(document.individualOperationContracts?.records ?? []),
    ...(document.ownerDefinedOperationContracts?.records ?? []),
    ...(document.capabilityOperationContracts?.records ?? []),
  ];
  const byId = new Map();
  const duplicates = new Set();
  for (const row of rows) {
    if (!row?.id) continue;
    if (byId.has(row.id)) duplicates.add(row.id);
    else byId.set(row.id, row);
  }
  return { byId, duplicates };
}

function validateActionPopulation(document, ownerOperations, definition = matrix) {
  const errors = [];
  const rows = [...(document.actions ?? []), ...(document.ownerDefinedActions ?? [])];
  if (rows.length !== definition.currentIdentityCount) errors.push("current action population count differs");
  const ids = rows.map(({ id }) => id);
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) errors.push("action identities must be present and unique");

  const counts = { operationIntent: 0, localOrSessionOnly: 0, sharedIdentityBoundary: 0 };
  for (const row of rows) {
    const typed = row.actionDefinitionSemantics?.typedDefinition;
    if (!typed || definition.exactSemanticFields && [
      "semanticRole", "effectKind", "reversibilityDisposition", "confirmationDisposition",
      "actorRefs", "applicabilityGuards", "effect", "finality", "failureRecovery",
      "domainOperationDisposition", "exactOperationRefs", "runtimeAdmission",
    ].some((field) => typed[field] === undefined)) {
      errors.push(`${row.id}: exact typed action semantics are incomplete`);
      continue;
    }
    const disposition = typed.domainOperationDisposition;
    if (definition.exactDispositionClasses.operationIntent.includes(disposition)) {
      counts.operationIntent += 1;
      if (!Array.isArray(typed.exactOperationRefs) || !typed.exactOperationRefs.length) errors.push(`${row.id}: operation intent has no exact operation refs`);
      for (const operationId of typed.exactOperationRefs ?? []) {
        if (!ownerOperations.byId.has(operationId) || ownerOperations.duplicates.has(operationId)) {
          errors.push(`${row.id}: operation ref ${operationId} does not resolve uniquely`);
        }
      }
    } else if (definition.exactDispositionClasses.localOrSessionOnly.includes(disposition)) {
      counts.localOrSessionOnly += 1;
      if (!Array.isArray(typed.exactOperationRefs) || typed.exactOperationRefs.length) errors.push(`${row.id}: local/session action must not bind a Media operation`);
      if (!/local|draft|selection|playback/iu.test(`${typed.effectKind} ${typed.effect} ${typed.finality}`)
        || !/local|draft/iu.test(typed.finality ?? "")) {
        errors.push(`${row.id}: local/session effect and finality need explicit bounded semantics`);
      }
    } else if (definition.exactDispositionClasses.sharedIdentityBoundary.includes(disposition)) {
      counts.sharedIdentityBoundary += 1;
      if (!Array.isArray(typed.exactOperationRefs) || typed.exactOperationRefs.length) errors.push(`${row.id}: external identity handoff must not bind a Media operation`);
      if (!/identity|workspace|upstream/iu.test(`${typed.effect} ${typed.finality} ${typed.failureRecovery}`)) errors.push(`${row.id}: external identity boundary lacks exact role semantics`);
    } else {
      errors.push(`${row.id}: unknown or missing operation disposition ${disposition}`);
    }
    if (!Array.isArray(typed.actorRefs) || !typed.actorRefs.length) errors.push(`${row.id}: actor scope is absent`);
    if (!Array.isArray(typed.applicabilityGuards) || !typed.applicabilityGuards.length) errors.push(`${row.id}: applicability guards are absent`);
    if (typeof typed.failureRecovery !== "string" || !typed.failureRecovery.trim()) errors.push(`${row.id}: failure/recovery semantics are absent`);
    if (typed.runtimeAdmission !== "NOT_ADMITTED") errors.push(`${row.id}: owner action definition cannot imply runtime admission`);
  }
  if (JSON.stringify(counts) !== JSON.stringify(definition.dispositionCounts)) errors.push("action disposition population differs from the exact source partition");
  return errors;
}

test("all current UI actions have exact owner operation or non-operation semantics", () => {
  const ownerOperations = indexOwnerOperations(operations);
  assert.deepEqual([...ownerOperations.duplicates], [], "operation identities must resolve to a unique canonical source row");
  assert.equal(actions.actions.length + actions.ownerDefinedActions.length, 147);
  assert.deepEqual(validateActionPopulation(actions, ownerOperations), []);
  assert.equal(matrix.excludedClaims.includes("transport-equivalence"), true);
  assert.equal(matrix.excludedClaims.includes("runtime-reachability"), true);
});

test("action identity checks reject missing, foreign, and falsely domain-bound meanings", () => {
  const ownerOperations = indexOwnerOperations(operations);
  const missingRef = structuredClone(actions);
  const command = missingRef.actions.find((row) => row.actionDefinitionSemantics.typedDefinition.exactOperationRefs.length);
  command.actionDefinitionSemantics.typedDefinition.exactOperationRefs = ["media.operation.not-registered"];
  assert.ok(validateActionPopulation(missingRef, ownerOperations).some((error) => error.includes("does not resolve uniquely")));

  const falseDomainBinding = structuredClone(actions);
  const local = falseDomainBinding.actions.find((row) => row.actionDefinitionSemantics.typedDefinition.domainOperationDisposition === "NO_DOMAIN_OPERATION_LOCAL_SELECTION_OR_SESSION_DRAFT");
  local.actionDefinitionSemantics.typedDefinition.exactOperationRefs = ["media.operation-slice.begin-upload"];
  assert.ok(validateActionPopulation(falseDomainBinding, ownerOperations).some((error) => error.includes("local/session action must not bind")));

  const missingFinality = structuredClone(actions);
  delete missingFinality.actions[0].actionDefinitionSemantics.typedDefinition.finality;
  assert.ok(validateActionPopulation(missingFinality, ownerOperations).some((error) => error.includes("typed action semantics are incomplete")));

  const missingPopulationMember = structuredClone(actions);
  missingPopulationMember.ownerDefinedActions.pop();
  assert.ok(validateActionPopulation(missingPopulationMember, ownerOperations).some((error) => error.includes("population count differs")));
});
