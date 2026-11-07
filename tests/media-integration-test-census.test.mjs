import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const javaSourceRoot = 'integration-tests/src/test/java';
const javaSourceDir = join(repo, javaSourceRoot);
const audioVideoRoot = `${javaSourceRoot}/com/ghatana/audio/video/integration`;
const dir = join(repo, audioVideoRoot);
const census = JSON.parse(readFileSync(
  join(repo, 'docs/implementation/media-integration-test-census.v1.json'), 'utf8'));

function javaFilesUnder(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) return javaFilesUnder(absolute, relative);
    return entry.isFile() && entry.name.endsWith('.java') ? [relative] : [];
  });
}

function isCanonicalRepoRelativePosixPath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.startsWith('/')
      || /^[A-Za-z]:/.test(path) || path.includes('\\')) return false;
  const segments = path.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

const files = javaFilesUnder(javaSourceDir).map((path) => `${javaSourceRoot}/${path}`).sort();
const classifiedEntries = Object.values(census.classification)
  .flatMap((list) => list.files ?? [])
  .map((entry) => `${audioVideoRoot}/${entry.split(/[ (]/)[0]}`);
const profileJavaSources = census.profiles.flatMap((profile) => profile.sources ?? [])
  .filter((path) => path.startsWith(`${javaSourceRoot}/`) && path.endsWith('.java'));
const explicitUnrepresentedJavaFiles = census.unrepresentedSourceAreas
  .map((area) => area.path)
  .filter((path) => path.startsWith(`${javaSourceRoot}/`) && path.endsWith('.java'));
const registeredPaths = [...classifiedEntries, ...profileJavaSources, ...explicitUnrepresentedJavaFiles];

test('IT-01: classified file entries use exact Java basenames', () => {
  for (const [classification, list] of Object.entries(census.classification)) {
    for (const entry of list.files ?? []) {
      const basename = entry.split(/[ (]/)[0];
      assert.ok(basename.endsWith('.java') && !basename.includes('/')
        && isCanonicalRepoRelativePosixPath(basename),
      `${classification} has a noncanonical Java filename: ${entry}`);
    }
  }
});

test('IT-01: profile and unrepresented entries use canonical repository-relative POSIX paths', () => {
  for (const profile of census.profiles) {
    for (const path of profile.sources ?? []) {
      assert.ok(isCanonicalRepoRelativePosixPath(path),
        `${profile.id} has a noncanonical source path: ${path}`);
      assert.ok(existsSync(join(repo, path)),
        `${profile.id} source does not exist at its repository-relative path: ${path}`);
    }
  }
  for (const area of census.unrepresentedSourceAreas) {
    assert.ok(isCanonicalRepoRelativePosixPath(area.path),
      `unrepresented source area has a noncanonical path: ${area.path}`);
    if (area.path.endsWith('.java')) {
      assert.ok(area.path.startsWith(`${javaSourceRoot}/`),
        `unrepresented Java source must be under ${javaSourceRoot}: ${area.path}`);
    }
  }
});

test('IT-01: census covers every Java source in the integration-tests module', () => {
  const known = new Set(registeredPaths);
  for (const file of files) {
    assert.ok(known.has(file), `${file} is not classified, profiled, or explicitly unrepresented in media-integration-test-census.v1.json`);
  }
  for (const path of registeredPaths) {
    assert.ok(files.includes(path), `${path} is listed in media-integration-test-census.v1.json but no longer exists`);
  }
  assert.equal(new Set(classifiedEntries).size, classifiedEntries.length,
    'a Java source must not appear in more than one classification group');
  for (const profile of census.profiles) {
    const javaSources = (profile.sources ?? []).filter((path) => path.startsWith(`${javaSourceRoot}/`)
      && path.endsWith('.java'));
    assert.equal(new Set(javaSources).size, javaSources.length,
      `${profile.id} must not list a Java source more than once`);
  }
  assert.equal(new Set(explicitUnrepresentedJavaFiles).size, explicitUnrepresentedJavaFiles.length,
    'an unrepresented Java source must be listed only once');
});

test('IT-01: unrepresented directory notes do not silently classify future source files', () => {
  for (const area of census.unrepresentedSourceAreas) {
    if (!area.path.startsWith(`${javaSourceRoot}/`)) continue;
    const absolute = join(repo, area.path);
    assert.ok(statSync(absolute).isFile() && area.path.endsWith('.java'),
      `${area.path} must name an exact source file; directory notes cannot hide new unclassified files`);
  }
});

test('IT-01: scaffold files carry an explicit disabled reason, never a silent pass', () => {
  for (const file of census.classification.STUB_SCAFFOLD_DISABLED.files) {
    const src = readFileSync(join(dir, file.split(' ')[0]), 'utf8');
    assert.match(src, /@Disabled\("IT-01 scaffold/, `${file} must stay @Disabled until wired`);
  }
});

test('IT-01: runnable synthetic performance fixtures remain local-only and unqualified', () => {
  const files = census.classification.SYNTHETIC_LOCAL_FIXTURE.files;
  assert.deepEqual(files, ['PerformanceIntegrationTest.java', 'GuardedMixedStreamWorkloadIT.java']);
  const performance = readFileSync(join(dir, files[0]), 'utf8');
  assert.match(performance, /in-process byte-frame dispatch/u);
  assert.match(performance, /Qualification\.UNVERIFIED/u);
  assert.match(performance, /does not exercise\s*\*?\s*audio\/video transport, codecs, source clocks, or provider behavior/u);

  const mixed = readFileSync(join(dir, files[1]), 'utf8');
  assert.match(mixed, /Synthetic concurrent audio\+video workload/u);
  assert.match(mixed, /does not qualify rights, codecs,\s*\*?\s*transport, provider behavior, or host resource capacity/u);
  assert.match(mixed, /CLIENT_COUNTS = \{1, 16, 64\}/u);
  assert.match(mixed, /@Tag\("performance"\)/u);
  assert.deepEqual(census.classification.LOCAL_PROCESS_FIXTURE.files, ['AudioVideoContainerProcessTest.java']);
});

test('IT-01: no integration-named test body is a pure literal/simulated tautology', () => {
  for (const file of files) {
    if (!file.startsWith(`${audioVideoRoot}/`)) continue;
    const name = file.slice(audioVideoRoot.length + 1);
    if (file.endsWith('Base.java') || file.endsWith('Condition.java')) continue;
    const src = readFileSync(join(repo, file), 'utf8');
    const disabled = /@Disabled\(/.test(src);
    const className = name.replace('.java', '');
    if (census.classification.SYNTHETIC_LOCAL_FIXTURE.files.includes(name)) continue;
    if (/Integration|E2E|Load|Performance|Workflow|Journey/.test(className) && !disabled) {
      // A live integration-named suite must touch a real surface.
      assert.match(src,
        /Container|ManagedChannel|Grpc|Socket|Http|Testcontainers|AudioVideoContainerBase|ProcessBuilder|WireMock|localhost|127\.0\.0\.1/,
        `${file} names an integration surface but touches no real transport/container and is not disabled`);
    }
  }
});
