import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const contracts = parse(read(".product-experience/pdp-2-design-interface-system/component-contracts.yaml"));

function interfaceRequiredProps(source, interfaceName) {
  const escaped = interfaceName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = source.match(new RegExp(`export interface ${escaped} \\{([\\s\\S]*?)\\n\\}`, "u"));
  assert.ok(match, `missing exported interface ${interfaceName}`);
  return [...match[1].matchAll(/^\s*readonly\s+([A-Za-z_$][\w$]*)(\?)?\s*:/gmu)]
    .filter((field) => !field[2])
    .map((field) => field[1])
    .sort();
}

test("ExperienceSpecification required props map exact typed contracts and the three public source interfaces", () => {
  const expected = new Map([
    ["media.component.progress-indicator", {
      source: "libs/audio-video-ui/src/components/MediaProgress.tsx#MediaProgressProps",
      interfaceName: "MediaProgressProps",
      names: ["label"],
    }],
    ["media.component.task-flow", {
      source: "libs/audio-video-ui/src/components/MediaTaskFlow.tsx#MediaTaskFlowProps",
      interfaceName: "MediaTaskFlowProps",
      names: ["children"],
    }],
    ["media.component.voice-production-workflow", {
      source: "modules/intelligence/ai-voice/libs/ai-voice-ui-react/src/components/VoiceProductionWorkflow.tsx#VoiceProductionWorkflowProps",
      interfaceName: "VoiceProductionWorkflowProps",
      names: ["capabilities", "consent", "currentStep", "projectName"],
    }],
  ]);
  const byId = new Map(contracts.components.map((component) => [component.id, component]));

  assert.equal(expected.size, 3, "the source-bound public export subset remains separately verified");
  for (const [componentId, binding] of expected) {
    const component = byId.get(componentId);
    assert.ok(component, `${componentId} must remain in the component registry`);
    assert.equal(component.propsSourceRef, binding.source);
    assert.deepEqual(component.requiredProps, binding.names);
    const sourcePath = binding.source.split("#", 1)[0];
    const actual = interfaceRequiredProps(read(sourcePath), binding.interfaceName);
    assert.deepEqual(actual, binding.names, `${componentId} prop names must match its exact exported interface`);
    assert.match(component.propsBindingStatus, /exact-public-typescript-props/u);
    assert.match(component.propsBindingStatus, /review-pending/u);
  }

  const generator = read("scripts/generate-media-phase-projections.mjs");
  assert.match(generator, /component\.typedDefinition\.props\.filter\(\(prop\) => prop\.required === true\)\.map\(\(prop\) => prop\.name\)/u,
    "Media-owned required props must derive only from the formally validated typed definition");
  assert.match(generator, /validateTypedComponentContracts\(root, componentContracts\.components\)/u,
    "projection must fail closed unless every typed component definition validates");
  assert.match(generator, /decisionRef: ".product-experience\/decision-log\.md#PXD-083"/u,
    "projection metadata must bind the exact bounded source decision");
  for (const component of contracts.components) {
    if (!expected.has(component.id)) {
      assert.equal(component.requiredProps, undefined,
        `${component.id} must not receive public props inferred from anatomy or display name`);
      assert.ok(component.typedDefinition.props.length > 0, `${component.id} must have an exact Media-owned typed prop contract`);
      assert.ok(component.typedDefinition.props.every((prop) => typeof prop.name === "string" && typeof prop.type === "string"),
        `${component.id} props must have exact Media-owned type identities`);
      assert.equal(component.typedDefinition.inputSchema.additionalProperties, false,
        `${component.id} input schema must be closed`);
    }
  }
});
