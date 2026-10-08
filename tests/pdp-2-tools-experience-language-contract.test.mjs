import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const mediaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolsRoot = path.resolve(mediaRoot, '../ghatana-tools');
const languagePackage = path.join(toolsRoot, 'libs/product-development/experience-language');
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'media-experience-language-public-export-'));
const candidate = JSON.parse(await readFile(path.join(
  mediaRoot,
  '.product-experience/pdp-2-design-interface-system/generated/experience-language.candidate.json',
), 'utf8'));
const model = candidate.candidateModel;

async function readSource(relativePath) {
  return readFile(path.join(mediaRoot, relativePath), 'utf8');
}

function idsFromList(source, field) {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `${field}:`);
  assert.notEqual(start, -1, `source registry has a ${field} list`);
  const section = [];
  for (const line of lines.slice(start + 1)) {
    if (line.length > 0 && !/^\s/u.test(line) && !/^-\s/u.test(line)) break;
    section.push(line);
  }
  return new Set(section.map((line) => line.match(/^\s*- id:\s*([^\s#]+)\s*$/u)?.[1]).filter(Boolean));
}

function parseStateIds(source) {
  const stateIds = new Set();
  const lines = source.split(/\r?\n/u);
  const starts = lines.map((line, index) => ({ line, index })).filter(({ line }) => /^- modelId:\s*([^\s#]+)\s*$/u.test(line));
  assert.ok(starts.length > 0, 'state registry contains model records');
  for (let modelIndex = 0; modelIndex < starts.length; modelIndex += 1) {
    const { line: modelLine, index: start } = starts[modelIndex];
    const modelId = modelLine.match(/^- modelId:\s*([^\s#]+)\s*$/u)[1];
    const end = starts[modelIndex + 1]?.index ?? lines.length;
    const body = lines.slice(start + 1, end);
    let foundStateDefinitions = false;
    for (let lineIndex = 0; lineIndex < body.length; lineIndex += 1) {
      const stateDeclaration = body[lineIndex].match(/^\s{2}(states|[a-zA-Z]+States):\s*(.*)$/u);
      if (!stateDeclaration) continue;
      const [, stateKey, inlineStates] = stateDeclaration;
      const namespace = stateKey === 'states' ? '' : `${stateKey.replace(/States$/u, '').replace(/(?:Assertion)?$/u, '').toLowerCase()}.`;
      foundStateDefinitions = true;
      if (inlineStates.trim().startsWith('[')) {
        for (const state of inlineStates.matchAll(/([A-Z][A-Z0-9_]*)/gu)) stateIds.add(`${modelId}.${namespace}${state[1]}`);
      } else {
        for (const line of body.slice(lineIndex + 1)) {
          if (/^\s{2}(?!-\s)\S/u.test(line)) break;
          const state = line.match(/^\s+- id:\s*([^\s#]+)\s*$/u)?.[1];
          if (state) stateIds.add(`${modelId}.${namespace}${state}`);
        }
      }
    }
    assert.ok(foundStateDefinitions, `state registry has states for ${modelId}`);
  }
  return stateIds;
}

const [packageManifest, componentSource, recipeSource, stateSource] = await Promise.all([
  readFile(path.join(languagePackage, 'package.json'), 'utf8').then(JSON.parse),
  readSource('.product-experience/pdp-2-design-interface-system/component-contracts.yaml'),
  readSource('.product-experience/pdp-2-design-interface-system/gui/recipes/catalog.yaml'),
  readSource('.product-experience/pdp-0-product-truth/state-models.yaml'),
]);
const componentIds = idsFromList(componentSource, 'components');
const recipeIds = idsFromList(recipeSource, 'recipes');
const domainStateIds = parseStateIds(stateSource);
const publicImportTarget = packageManifest.exports?.['.']?.import;
assert.equal(publicImportTarget, './dist/index.js', 'test compiles the source for the package public import target');

const stagedPackage = path.join(temporaryRoot, 'package');
const stagedDist = path.join(stagedPackage, 'dist');
const stagedNodeModules = path.join(temporaryRoot, 'node_modules/@ghatana');
await Promise.all([
  mkdir(stagedDist, { recursive: true }),
  mkdir(stagedNodeModules, { recursive: true }),
]);
await copyFile(path.join(languagePackage, 'package.json'), path.join(stagedPackage, 'package.json'));
const compile = spawnSync(path.join(languagePackage, 'node_modules/.bin/tsc'), [
  path.join(languagePackage, 'src/index.ts'),
  '--target', 'ES2022',
  '--module', 'ES2022',
  '--ignoreConfig',
  '--outDir', stagedDist,
  '--skipLibCheck',
], { cwd: languagePackage, encoding: 'utf8' });
assert.equal(compile.status, 0, `compile public ExperienceLanguage export: ${compile.stdout}\n${compile.stderr}`);
await symlink(stagedPackage, path.join(stagedNodeModules, 'experience-language'), 'dir');
const consumerPath = path.join(temporaryRoot, 'consumer.mjs');
await writeFile(consumerPath, "export { validateExperienceLanguage } from '@ghatana/experience-language';\n");
const { validateExperienceLanguage } = await import(pathToFileURL(consumerPath).href);
assert.equal(typeof validateExperienceLanguage, 'function');

const ownerResolvers = {
  resolveComponent: (ref, context) => context.subjectId === model.subjectId && componentIds.has(ref),
  resolveRecipe: (ref, context) => context.subjectId === model.subjectId && recipeIds.has(ref),
  resolveDomainState: (ref, context) => context.subjectId === model.subjectId && domainStateIds.has(ref),
};

test('Tools public ExperienceLanguage validator accepts the current candidate using Media source registries', async (t) => {
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  assert.equal(candidate.projectionKind, 'experience-language');
  assert.ok(model.recipeBindings.length > 0);
  assert.deepEqual(new Set(model.recipeBindings.map(({ recipeRef }) => recipeRef)), recipeIds);
  validateExperienceLanguage(model, ownerResolvers);
});

test('Tools public ExperienceLanguage validator rejects duplicate recipe-binding identities', () => {
  const duplicate = structuredClone(model);
  duplicate.recipeBindings.push(structuredClone(duplicate.recipeBindings[0]));
  assert.throws(() => validateExperienceLanguage(duplicate, ownerResolvers), /duplicate id/u);
});

test('Tools public ExperienceLanguage validator rejects an unregistered recipe reference', () => {
  const invalid = structuredClone(model);
  invalid.recipeBindings[0].recipeRef = 'media.gui.recipe.not-registered';
  assert.throws(() => validateExperienceLanguage(invalid, ownerResolvers), /unknown resolveRecipe/u);
});
