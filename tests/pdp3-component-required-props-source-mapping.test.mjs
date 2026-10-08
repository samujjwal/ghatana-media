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

test("ExperienceSpecification required props map only exact typed public component contracts", () => {
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

  assert.equal(expected.size, 3, "only the source-bound public export subset is projected");
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
  assert.match(generator, /requiredProps:\s*component\.requiredProps\s*\?\?\s*\[\]/u,
    "projection must copy only an explicitly authored source mapping");
  for (const component of contracts.components) {
    if (expected.has(component.id)) continue;
    assert.equal(component.requiredProps, undefined,
      `${component.id} must not receive inferred props from anatomy or a display name`);
  }
});
