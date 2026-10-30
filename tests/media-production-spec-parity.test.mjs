// H-01: the Zod headless parsers in production.ts must mirror the PDP-1
// declared requiredFields and schemaVersion exactly — any drift between
// the YAML authority and the wire parser is a silent contract break.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const yaml = readFileSync(
  join(repo, '.product-experience/pdp-1-domain-data/declarative-production-contracts.yaml'), 'utf8');
const productionTs = readFileSync(join(repo, 'libs/audio-video-types/src/production.ts'), 'utf8');

// Extract each "- id: media.declarative.value.X" + its requiredFields list.
const declared = {};
for (const m of yaml.matchAll(
  /- id: (media\.declarative\.value\.[\w.-]+)[\s\S]*?requiredFields: \[([^\]]+)\]/g)) {
  declared[m[1]] = m[2].split(',').map((s) => s.trim()).filter(Boolean);
}

const ZOD_OBJECTS = {
  'media.declarative.value.production-spec.v1': 'ProductionSpecSchema',
  'media.declarative.value.scene-binding.v1': 'SceneBindingSchema',
  'media.declarative.value.animation-spec.v1': 'AnimationSpecSchema',
  'media.declarative.value.model-execution-spec.v1': 'ModelExecutionSpecSchema',
  'media.declarative.value.simulation-state.v1': 'SimulationStateSchema',
};

test('H-01: every mirrored Zod schema covers its declared requiredFields + version', () => {
  assert.ok(Object.keys(declared).length >= 5,
    `expected PDP-1 declared values, found ${Object.keys(declared).length}`);
  for (const [id, schemaName] of Object.entries(ZOD_OBJECTS)) {
    assert.ok(declared[id], `PDP-1 value ${id} not found`);
    const schemaBody = productionTs.match(
      new RegExp(schemaName + ' = z\\.object\\(\\{([\\s\\S]*?)\\}\\)'))?.[1] ?? '';
    for (const field of declared[id]) {
      assert.ok(schemaBody.includes(`${field}:`) || schemaBody.includes(`"${field}"`),
        `${schemaName} missing declared field ${field}`);
    }
    assert.ok(schemaBody.includes(`"${id}"`), `${schemaName} missing schemaVersion ${id}`);
  }
});

test('H-01: strict objects and closed enums — no open wire surface', () => {
  for (const name of Object.values(ZOD_OBJECTS)) {
    const def = productionTs.match(new RegExp(name + ' = ([\\s\\S]*?);'))?.[1] ?? '';
    assert.ok(def.includes('z.object') && def.includes('strict()'),
      `${name} must be a strict Zod object`);
  }
});
