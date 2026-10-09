import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { validatePdpUiLocalActionSemantics } from "../scripts/lib/pdp-ui-action-semantic-validation.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const yaml = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const readYaml = (path) => yaml.parse(readFileSync(resolve(root, path), "utf8"));
const parityPath = ".product-experience/interface-parity/operation-parity.yaml";
const actionPath = ".product-experience/pdp-3-product-experience/action-registry.yaml";
const base = {
  parity: readYaml(parityPath),
  actionRegistry: readYaml(actionPath),
};
const validate = (value) => validatePdpUiLocalActionSemantics(value);

test("all 49 local and draft action meanings preserve exact source effects and finality", () => {
  assert.deepEqual(validate(base), []);
  const local = base.parity.typedUiActionSemantics.filter(({ actionDefinitionSemantics }) =>
    actionDefinitionSemantics.typedDefinition.semanticRole === "LOCAL_SELECTION_OR_SESSION_DRAFT");
  assert.equal(local.length, 49);
  assert.equal(base.parity.typedUiActionDispositions.entries.filter(({ type }) => type === "CLIENT_ONLY").length, 48);
  assert.equal(base.parity.typedUiActionDispositions.entries.find(({ identity }) =>
    identity === "media.action.switch-measurement-presentation").type, "NAVIGATION_OR_PRESENTATION");
  assert.ok(local.every(({ actionDefinitionSemantics }) => actionDefinitionSemantics.typedDefinition.runtimeAdmission === "NOT_ADMITTED"));
});

test("local action meaning fails closed when an effect, finality, authority boundary, or identity changes", () => {
  const effect = structuredClone(base);
  effect.actionRegistry.actions.find(({ id }) => id === "media.action.select-artifact-source").effect = "upload-the-source-bytes";
  assert.ok(validate(effect).some((error) => error.includes("effect, finality, and reversibility")));

  const finality = structuredClone(base);
  finality.actionRegistry.actions.find(({ id }) => id === "media.action.seek-source").finality = "provider-accepted";
  assert.ok(validate(finality).some((error) => error.includes("local effect, finality")));

  const forgedOperation = structuredClone(base);
  const row = forgedOperation.parity.typedUiActionSemantics.find(({ identity }) => identity === "media.action.select-artifact-source");
  row.actionDefinitionSemantics.typedDefinition.exactOperationRefs = ["media.operation-slice.begin-upload"];
  row.actionDefinitionSemantics.typedDefinition.operationRef = "media.operation-slice.begin-upload";
  assert.ok(validate(forgedOperation).some((error) => error.includes("local selection/draft cannot imply a domain operation")));
});

test("local allowlist cannot silently widen to a presentation action or hide an ordinary local action", () => {
  const widened = structuredClone(base);
  widened.parity.typedUiActionDispositions.entries.find(({ identity }) =>
    identity === "media.action.switch-measurement-presentation").type = "CLIENT_ONLY";
  assert.ok(validate(widened).some((error) => error.includes("expected 48 CLIENT_ONLY")));

  const narrowed = structuredClone(base);
  narrowed.parity.typedUiActionDispositions.entries.find(({ identity }) =>
    identity === "media.action.seek-source").type = "NAVIGATION_OR_PRESENTATION";
  assert.ok(validate(narrowed).some((error) => error.includes("allowlist must preserve")));
});
