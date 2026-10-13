import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";

const mediaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const toolsRoot = path.resolve(mediaRoot, "../ghatana-tools");
const toolsPackageRoots = [
  path.join(toolsRoot, "libs/product-development"),
  path.join(toolsRoot, "tools/product-development/explorer"),
];
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ghatana-tools-media-consumer-"));
const createdToolLinks = [];

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "inherit" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed with exit ${result.status}`);
}

async function readPackage(packageDir) {
  return JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
}

try {
  const packageDirs = new Map();
  for (const root of toolsPackageRoots) {
    const entries = await readdir(root, { withFileTypes: true });
    const candidates = [root, ...entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name))];
    for (const packageDir of candidates) {
      try {
        const manifest = await readPackage(packageDir);
        if (manifest.name?.startsWith("@ghatana/")) packageDirs.set(manifest.name, packageDir);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  const packageOrder = [];
  const visited = new Set();
  const visiting = new Set();
  async function visit(name) {
    if (visited.has(name)) return;
    assert.ok(
      packageDirs.has(name),
      `Tools source package ${name} is missing; this check requires the sibling ghatana-tools checkout at ${toolsRoot}`,
    );
    assert.ok(!visiting.has(name), `Tools package dependency cycle includes ${name}`);
    visiting.add(name);
    const manifest = await readPackage(packageDirs.get(name));
    for (const dependencyName of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      if (dependencyName.startsWith("@ghatana/")) await visit(dependencyName);
    }
    visiting.delete(name);
    visited.add(name);
    packageOrder.push(name);
  }

  for (const packageName of [
    "@ghatana/product-dev-explorer",
    "@ghatana/experience-explorer-contracts",
    "@ghatana/experience-package",
    "@ghatana/development-traceability",
    "@ghatana/experience-specification",
  ]) {
    await visit(packageName);
  }

  const artifactDir = path.join(tempRoot, "artifacts");
  const extractedDir = path.join(tempRoot, "packages");
  const nodeModulesDir = path.join(tempRoot, "node_modules/@ghatana");
  await Promise.all([mkdir(artifactDir, { recursive: true }), mkdir(extractedDir, { recursive: true }), mkdir(nodeModulesDir, { recursive: true })]);

  // Recreate the workspace dependency links needed for package builds when the
  // sibling checkout has not had a workspace install. These ignored node_modules
  // links are removed in finally and never participate in the consumer import.
  for (const packageName of packageOrder) {
    const packageDir = packageDirs.get(packageName);
    const manifest = await readPackage(packageDir);
    for (const dependencyName of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      if (!dependencyName.startsWith("@ghatana/") || !packageDirs.has(dependencyName)) continue;
      const dependencyLink = path.join(packageDir, "node_modules", "@ghatana", dependencyName.split("/")[1]);
      try {
        await readFile(path.join(dependencyLink, "package.json"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await mkdir(path.dirname(dependencyLink), { recursive: true });
        await symlink(packageDirs.get(dependencyName), dependencyLink, "dir");
        createdToolLinks.push(dependencyLink);
      }
    }
  }

  for (const packageName of packageOrder) {
    const packageDir = packageDirs.get(packageName);
    const manifest = await readPackage(packageDir);
    run("pnpm", ["run", "build"], packageDir);
    run("pnpm", ["pack", "--pack-destination", artifactDir], packageDir);

    const tarball = path.join(artifactDir, `ghatana-${manifest.name.split("/")[1]}-${manifest.version}.tgz`);
    const packageExtractDir = path.join(extractedDir, `${manifest.name.split("/")[1]}-${manifest.version}`);
    await mkdir(packageExtractDir, { recursive: true });
    run("tar", ["-xzf", tarball, "-C", packageExtractDir]);
    const extractedPackage = path.join(packageExtractDir, "package");
    if (manifest.exports?.["./schema"]) {
      const schemaTarget = path.join(extractedPackage, manifest.exports["./schema"]);
      assert.ok((await readFile(schemaTarget)).length > 0, `${packageName} public schema export must be included in its tarball`);
    }
    await symlink(extractedPackage, path.join(nodeModulesDir, manifest.name.split("/")[1]), "dir");
  }

  const fixtureMediaDir = path.join(tempRoot, "libs/media-experience-simulation");
  const fixtureExplorerDir = path.join(tempRoot, "apps/media-experience-explorer/src");
  const fixtureTestsDir = path.join(tempRoot, "tests");
  await Promise.all([
    mkdir(fixtureMediaDir, { recursive: true }),
    mkdir(fixtureExplorerDir, { recursive: true }),
    mkdir(fixtureTestsDir, { recursive: true }),
  ]);
  await Promise.all([
    cp(path.join(mediaRoot, "libs/media-experience-simulation/src"), path.join(fixtureMediaDir, "src"), { recursive: true }),
    cp(path.join(mediaRoot, "libs/media-experience-simulation/package.json"), path.join(fixtureMediaDir, "package.json")),
    cp(path.join(mediaRoot, "libs/media-experience-simulation/tsconfig.json"), path.join(fixtureMediaDir, "tsconfig.json")),
    cp(path.join(mediaRoot, "apps/media-experience-explorer/src/tools-consumer.ts"), path.join(fixtureExplorerDir, "tools-consumer.ts")),
    cp(path.join(mediaRoot, "tests/tools-media-consumer.test.mjs"), path.join(fixtureTestsDir, "tools-media-consumer.test.mjs")),
    cp(path.join(mediaRoot, "scripts/fixtures/tools-media-experience-candidate-consumer.test.mjs"), path.join(fixtureTestsDir, "tools-media-experience-candidate-consumer.test.mjs")),
    cp(path.join(mediaRoot, ".product-experience/pdp-3-product-experience/generated/experience-specification.candidate.json"), path.join(fixtureTestsDir, "experience-specification.candidate.json")),
  ]);
  const { parse } = createRequire(path.join(toolsRoot, 'package.json'))('yaml');
  const sourceFilesByKind = {
    actor: ['.product-experience/pdp-0-product-truth/actors-responsibilities.yaml'],
    'desired-outcome': ['.product-experience/pdp-0-product-truth/goals-jtbd.yaml'],
    'searchable-type': ['.product-experience/pdp-1-domain-data/domain-objects.yaml'],
    state: ['.product-experience/pdp-1-domain-data/states.yaml'],
    guard: [
      '.product-experience/pdp-3-product-experience/step-guard-fact-contracts.yaml',
      '.product-experience/pdp-3-product-experience/action-registry.yaml',
      '.product-experience/pdp-3-product-experience/state-transition-bindings.yaml',
      '.product-experience/pdp-1-domain-data/operations.yaml',
    ],
    authority: [
      '.product-experience/pdp-1-domain-data/authority.yaml',
      '.product-experience/pdp-0-product-truth/policy-authority-model.yaml',
      '.product-experience/pdp-1-domain-data/operations.yaml',
      '.product-experience/pdp-1-domain-data/privacy.yaml',
    ],
    requirement: ['.product-experience/pdp-0-product-truth/requirements.yaml'],
    operation: ['.product-experience/pdp-1-domain-data/operations.yaml'],
    'domain-object': ['.product-experience/pdp-1-domain-data/domain-objects.yaml'],
    'object-version': ['.product-experience/pdp-3-product-experience/step-version-binding-contracts.yaml'],
  };
  const documents = new Map();
  for (const paths of Object.values(sourceFilesByKind)) for (const source of paths) {
    if (!documents.has(source)) documents.set(source, parse(await readFile(path.join(mediaRoot, source), 'utf8')));
  }
  const refsByKind = new Map(Object.keys(sourceFilesByKind).map((kind) => [kind, new Set()]));
  const refs = (set, values) => { for (const value of values ?? []) if (typeof value === 'string') set.add(value); };
  const candidatePath = path.join(mediaRoot, '.product-experience/pdp-3-product-experience/generated/experience-specification.candidate.json');
  const candidate = JSON.parse(await readFile(candidatePath, 'utf8')).candidateModel;
  for (const journey of candidate.journeys ?? []) {
    refs(refsByKind.get('actor'), [journey.actorRef]);
    refs(refsByKind.get('desired-outcome'), [journey.desiredOutcomeRef]);
    for (const step of journey.steps ?? []) {
      for (const [field, kind] of Object.entries({
        actorRefs: 'actor', stateRefs: 'state', guardRefs: 'guard', authorityRefs: 'authority',
        requirementRefs: 'requirement', operationRefs: 'operation', supportingOperationRefs: 'operation',
        objectRefs: 'domain-object', objectVersionRefs: 'object-version',
      })) refs(refsByKind.get(kind), step.semantics?.[field]);
    }
  }
  for (const transition of candidate.transitions ?? []) refs(refsByKind.get('guard'), transition.guards);
  for (const search of candidate.search ?? []) refs(refsByKind.get('searchable-type'), search.searchableTypes);

  function selectorExists(document, selector) {
    const parts = selector.split('/').flatMap((part) => part.startsWith('@') ? [part] : part.split('.')).filter(Boolean);
    let value = document;
    for (const part of parts) {
      const keyed = /^@([A-Za-z][A-Za-z0-9]*)=(.+)$/u.exec(part);
      if (keyed) {
        if (!Array.isArray(value)) return false;
        const matches = value.filter((row) => row?.[keyed[1]] === keyed[2]);
        if (matches.length !== 1) return false;
        [value] = matches;
      } else if (Array.isArray(value)) {
        if (/^\d+$/u.test(part)) value = value[Number(part)];
        else {
          const matches = value.filter((row) => ['id', 'machineId', 'point', 'guardRef', 'stepId', 'key']
            .some((key) => row?.[key] === part));
          if (matches.length !== 1) return false;
          [value] = matches;
        }
      } else value = value?.[part];
      if (value === undefined) return false;
    }
    return true;
  }

  assert.equal(selectorExists({ records: [{ id: 'duplicate' }, { id: 'duplicate' }] }, 'records/@id=duplicate'), false,
    'ambiguous duplicate selectors must fail closed');
  assert.equal(selectorExists({ records: [{ id: 'present' }] }, 'records/@id=missing'), false,
    'missing selectors must fail closed');

  const document = (source) => documents.get(source);
  const ids = (rows) => (rows ?? []).map((row) => row?.id).filter((value) => typeof value === 'string');
  const guardFacts = document('.product-experience/pdp-3-product-experience/step-guard-fact-contracts.yaml').guardContracts.records;
  const guardRegistryRefs = guardFacts.map(({guardRef}) => guardRef);
  assert.equal(new Set(guardRegistryRefs).size, guardRegistryRefs.length, 'duplicate canonical guardRef owner');
  const actionGuardRefs = document('.product-experience/pdp-3-product-experience/action-registry.yaml').actions
    .flatMap((action) => action.actionDefinitionSemantics?.typedDefinition?.applicabilityGuards ?? []);
  const transitionGuardRefs = document('.product-experience/pdp-3-product-experience/state-transition-bindings.yaml')
    .ownerTransitionProjectionCandidates.records.flatMap((record) => record.publicTransition?.guards ?? []);
  const fallbackGuardRefs = new Set([...actionGuardRefs, ...transitionGuardRefs]);
  const operationDocument = document('.product-experience/pdp-1-domain-data/operations.yaml');
  const operationIds = [
    ...ids(operationDocument.operations),
    ...ids(operationDocument.individualOperationContracts?.records),
    ...ids(operationDocument.ownerDefinedOperationContracts?.records),
    ...ids(operationDocument.capabilityOperationContracts?.records),
  ];
  const ownerValuesByKind = {
    actor: ids(document('.product-experience/pdp-0-product-truth/actors-responsibilities.yaml').actors),
    'desired-outcome': ids(document('.product-experience/pdp-0-product-truth/goals-jtbd.yaml').outcomes),
    'searchable-type': ids(document('.product-experience/pdp-1-domain-data/domain-objects.yaml').objects),
    'domain-object': ids(document('.product-experience/pdp-1-domain-data/domain-objects.yaml').objects),
    state: document('.product-experience/pdp-1-domain-data/states.yaml').stateMachines
      .flatMap((machine) => (machine.stateDefinitions ?? []).map(({id}) => id)),
    guard: [...new Set([...guardRegistryRefs, ...actionGuardRefs, ...transitionGuardRefs])],
    requirement: ids(document('.product-experience/pdp-0-product-truth/requirements.yaml').requirements),
    operation: operationIds,
  };
  const referenceInventory = {};
  for (const [kind, values] of refsByKind) {
    const allowedSources = new Set(sourceFilesByKind[kind]);
    const valid = [];
    for (const ref of values) {
      const hash = ref.indexOf('#');
      const source = hash < 0 ? null : ref.slice(0, hash);
      const selector = hash < 0 ? null : ref.slice(hash + 1);
      const ownerMatches = source ? [] : (ownerValuesByKind[kind] ?? []).filter((candidateRef) => candidateRef === ref);
      if (!source) assert.equal(ownerMatches.length, 1,
        ownerMatches.length === 0 ? `missing ${kind} owner identity: ${ref}` : `duplicate ${kind} owner identity: ${ref}`);
      const resolved = source
        ? allowedSources.has(source) && selectorExists(documents.get(source), selector)
        : ownerMatches.length === 1;
      assert.ok(resolved, `Media ${kind} reference does not resolve to its allowlisted owner source: ${ref}`);
      valid.push(ref);
    }
    referenceInventory[kind] = valid;
  }
  await writeFile(path.join(fixtureTestsDir, 'reference-inventory.json'), JSON.stringify(referenceInventory));
  await symlink(fixtureMediaDir, path.join(nodeModulesDir, "media-experience-simulation"), "dir");

  run(
    path.join(mediaRoot, "libs/media-experience-simulation/node_modules/.bin/tsc"),
    ["-p", path.join(fixtureMediaDir, "tsconfig.json")],
    mediaRoot,
  );
  run(process.execPath, ["--experimental-strip-types", "--test", path.join(fixtureTestsDir, "tools-media-consumer.test.mjs"), path.join(fixtureTestsDir, "tools-media-experience-candidate-consumer.test.mjs")], tempRoot);
} finally {
  for (const link of createdToolLinks.reverse()) await rm(link, { force: true });
  await rm(tempRoot, { recursive: true, force: true });
}
