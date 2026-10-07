import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const versionPolicy = JSON.parse(readFileSync(join(root, '.product-experience/development-version-policy.json'), 'utf8'));
const expectedVersion = versionPolicy.developmentVersion;
const exceptions = new Map(versionPolicy.temporaryCompatibilityExceptions.map((exception) => [exception.id, exception]));
const toolsJavaRuntimeVersion = exceptions.get('TOOLS-JAVA-RUNTIME-RC1')?.version;
const lifecycleRoot = join(root, '..', 'ghatana-lifecycle');
const lifecycleException = exceptions.get('LIFECYCLE-RUNTIME-RC1');
const lifecycleVersion = lifecycleException?.version;
const sharedTypeScriptRoot = join(root, '..', 'ghatana-shared', 'platform', 'typescript');
const toolsProductDevelopmentRoot = join(root, '..', 'ghatana-tools', 'libs', 'product-development');
const toolsProductDevelopmentPackages = [
  'development-authority',
  'development-graph',
  'development-subject',
  'development-traceability',
  'experience-explorer-contracts',
  'experience-package',
  'experience-specification',
  'implementation-handoff',
  'opportunity-model',
  'product-definition',
];
const releaseMode = process.argv.includes('--release');
const errors = [];
const activePackages = [];

if (versionPolicy.schemaVersion !== 'media.development-version-policy.v1'
    || versionPolicy.productId !== 'media'
    || versionPolicy.developmentVersion !== '0.1.0-SNAPSHOT'
    || versionPolicy.rootVersion !== versionPolicy.developmentVersion
    || versionPolicy.exceptionOwnerApproval !== 'pending'
    || versionPolicy.semanticCurrentness !== 'not-claimed'
    || exceptions.size !== versionPolicy.temporaryCompatibilityExceptions.length) {
  errors.push('development-version-policy.json is malformed or contains duplicate temporary exception IDs');
}
for (const exception of versionPolicy.temporaryCompatibilityExceptions) {
  if (!exception.owner || !exception.reason || !exception.resolution || !exception.version) {
    errors.push(`development-version-policy.json: ${exception.id ?? 'unknown'} lacks owner, version, reason, or resolution`);
  }
  if (exception.sourceFiles !== undefined && (!Array.isArray(exception.sourceFiles) || exception.sourceFiles.length === 0
      || exception.sourceFiles.some((path) => typeof path !== 'string' || path.length === 0))) {
    errors.push(`development-version-policy.json: ${exception.id ?? 'unknown'} has an invalid sourceFiles list`);
  }
}

function validateVersion(label, version, expected = expectedVersion) {
  if (releaseMode) {
    if (typeof version !== 'string' || version.includes('SNAPSHOT')) {
      errors.push(`${label}: release verification forbids SNAPSHOT versions (found ${version ?? 'missing'})`);
    }
    return;
  }
  if (version !== expected) {
    errors.push(`${label}: version must be ${expected} (found ${version ?? 'missing'})`);
  }
}

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'archive' || entry.name === '.git') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(path);
    } else if (entry.isFile() && entry.name === 'package.json') {
      checkPackage(path);
    } else if (entry.isFile() && entry.name === 'Cargo.toml') {
      checkCargoPackage(path);
    }
  }
}

function checkPackage(path) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (!manifest.name) return;

  const label = relative(root, path);
  activePackages.push({ label, manifest });
  validateVersion(`${label} (${manifest.name})`, manifest.version);

}

function checkCargoPackage(path) {
  const source = readFileSync(path, 'utf8');
  let inPackageSection = false;
  let name;
  let version;
  for (const line of source.split(/\r?\n/u)) {
    if (/^\[[^\]]+\]\s*$/u.test(line)) {
      inPackageSection = line === '[package]';
      continue;
    }
    if (!inPackageSection) continue;
    name ??= /^name\s*=\s*"([^"]+)"\s*$/u.exec(line)?.[1];
    version ??= /^version\s*=\s*"([^"]+)"\s*$/u.exec(line)?.[1];
  }
  if (!name) return;
  validateVersion(`${relative(root, path)} (${name})`, version);
}

for (const directory of ['apps', 'libs', 'modules']) {
  walk(join(root, directory));
}
checkCargoPackage(join(root, 'Cargo.toml'));

const localPackages = new Set(activePackages
  .map(({ manifest }) => manifest.name)
  .filter(Boolean));
for (const { label, manifest } of activePackages) {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (!localPackages.has(name) && !name.startsWith('@ghatana/')) continue;
      if (releaseMode) {
        if (typeof version === 'string' && version.includes('SNAPSHOT')) {
          errors.push(`${label}: ${name} in ${field} uses SNAPSHOT during release verification`);
        }
        continue;
      }
      const expected = localPackages.has(name) ? 'workspace:*' : expectedVersion;
      if (version !== expected) {
        errors.push(`${label}: ${name} in ${field} must be ${expected} (${localPackages.has(name) ? 'same repository package' : 'external Ghatana package'}; found ${version})`);
      }
    }
  }
}

const gradleProperties = readFileSync(join(root, 'gradle.properties'), 'utf8');
const gradleDependencyVersions = new Map([
  ['ghatana.shared.version', expectedVersion],
  ...versionPolicy.temporaryCompatibilityExceptions
    .filter((exception) => exception.gradleProperty)
    .map((exception) => [exception.gradleProperty, exception.version]),
]);
for (const [property, developmentVersion] of gradleDependencyVersions) {
  const match = gradleProperties.match(new RegExp(`^${property.replaceAll('.', '\\.')}=(.*)$`, 'm'));
  if (releaseMode ? !match || match[1].includes('SNAPSHOT') : match?.[1] !== developmentVersion) {
    errors.push(releaseMode
      ? `gradle.properties: ${property} must not use SNAPSHOT during release verification (found ${match?.[1] ?? 'missing'})`
      : `gradle.properties: ${property} must be ${developmentVersion} for its verified source build (found ${match?.[1] ?? 'missing'})`);
  }
}

function checkSourcePackageVersion(packagePath, label, version = expectedVersion) {
  try {
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
    if (!manifest.name) {
      errors.push(`${label}: package manifest has no package name`);
      return;
    }
    validateVersion(`${label} (${manifest.name})`, manifest.version, version);
  } catch (error) {
    if (error?.code === 'ENOENT') errors.push(`${label}: package manifest is missing`);
    else throw error;
  }
}

const sharedTypeScriptPackages = readdirSync(sharedTypeScriptRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(sharedTypeScriptRoot, entry.name, 'package.json'))
  .filter((path) => {
    try {
      readFileSync(path);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  });
for (const packagePath of sharedTypeScriptPackages) {
  checkSourcePackageVersion(packagePath, `ghatana-shared/${relative(sharedTypeScriptRoot, packagePath)}`);
}
if (sharedTypeScriptPackages.length !== 20) {
  errors.push(`ghatana-shared/platform/typescript: expected 20 composite packages (found ${sharedTypeScriptPackages.length})`);
}

for (const packageName of toolsProductDevelopmentPackages) {
  checkSourcePackageVersion(
    join(toolsProductDevelopmentRoot, packageName, 'package.json'),
    `ghatana-tools/libs/product-development/${packageName}`,
  );
}
checkSourcePackageVersion(
  join(root, '..', 'ghatana-tools', 'tools', 'product-development', 'explorer', 'package.json'),
  'ghatana-tools/tools/product-development/explorer',
);

const toolsRootBuild = readFileSync(join(root, '..', 'ghatana-tools', 'build.gradle.kts'), 'utf8');
const toolsDefaultRootVersion = /^version\s*=\s*configuredReleaseVersion\s*\?:\s*"([^"]+)"\s*$/m.exec(toolsRootBuild)?.[1];
if (toolsDefaultRootVersion !== toolsJavaRuntimeVersion) {
  errors.push(`ghatana-tools/build.gradle.kts: default root Gradle version must be ${toolsJavaRuntimeVersion} (found ${toolsDefaultRootVersion ?? 'missing'})`);
}

const rootBuild = readFileSync(join(root, 'build.gradle.kts'), 'utf8');
const rootVersion = /^version\s*=\s*"([^"]+)"\s*$/m.exec(rootBuild)?.[1];
if (releaseMode ? !rootVersion || rootVersion.includes('SNAPSHOT') : rootVersion !== versionPolicy.rootVersion) {
  errors.push(releaseMode
    ? `build.gradle.kts: root Gradle version authority must not use SNAPSHOT during release verification (found ${rootVersion ?? 'missing'})`
      : `build.gradle.kts: root Gradle version authority must set version = "${versionPolicy.rootVersion}" (found ${rootVersion ?? 'missing'})`);
}

let lifecyclePackageCount = 0;
if (readdirSync(join(root, '..'), { withFileTypes: true })
  .some((entry) => entry.isDirectory() && entry.name === 'ghatana-lifecycle')) {
  const lifecyclePackageJson = JSON.parse(readFileSync(join(lifecycleRoot, 'package.json'), 'utf8'));
  const lifecycleBuild = readFileSync(join(lifecycleRoot, 'build.gradle.kts'), 'utf8');
  const lifecycleGradleVersion = /^version\s*=\s*"([^\"]+)"\s*$/m.exec(lifecycleBuild)?.[1];
  const versionMatches = (label, version) => {
    if (releaseMode ? typeof version !== 'string' || version.includes('SNAPSHOT') : version !== lifecycleVersion) {
      errors.push(releaseMode
        ? `${label}: Lifecycle release version must not contain SNAPSHOT (found ${version ?? 'missing'})`
        : `${label}: Lifecycle development version must be ${lifecycleVersion} (found ${version ?? 'missing'})`);
    }
  };
  versionMatches('ghatana-lifecycle/package.json', lifecyclePackageJson.version);
  versionMatches('ghatana-lifecycle/build.gradle.kts', lifecycleGradleVersion);

  for (const directory of ['libs', 'tools']) {
    for (const entry of readdirSync(join(lifecycleRoot, directory), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packagePath = join(lifecycleRoot, directory, entry.name, 'package.json');
      try {
        const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
        if (!manifest.name) continue;
        lifecyclePackageCount += 1;
        versionMatches(`ghatana-lifecycle/${directory}/${entry.name}/package.json (${manifest.name})`, manifest.version);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
  if (lifecyclePackageCount !== 19) {
    errors.push(`ghatana-lifecycle: expected 19 composite TypeScript packages (found ${lifecyclePackageCount})`);
  }

  // The checked resource is a SNAPSHOT template; processResources rewrites
  // it to Lifecycle's RC1 project.version for the packaged runtime.
  const evidenceBuild = readFileSync(join(lifecycleRoot, 'tools/evidence-generator/build.gradle.kts'), 'utf8');
  const evidenceResource = readFileSync(join(lifecycleRoot, 'tools/evidence-generator/src/main/resources/evidence-generator-version.properties'), 'utf8');
  const evidenceProduct = JSON.parse(readFileSync(join(lifecycleRoot, 'tools/evidence-generator/tool-product.json'), 'utf8'));
  const generatedVersionResource = /^evidence\.generator\.version=([^\r\n]+)$/m.exec(evidenceResource)?.[1];
  const generatedResourceRule = evidenceBuild.includes('line.replaceFirst(Regex("^evidence\\\\.generator\\\\.version=.*$"), "evidence.generator.version=${project.version}")');
  const evidenceProjectVersion = /^version\s*=\s*rootProject\.version\s*$/m.test(evidenceBuild);
  if (!generatedResourceRule || !evidenceProjectVersion || generatedVersionResource !== lifecycleException?.generatedResource?.sourceTemplateVersion || evidenceProduct.version !== lifecycleVersion) {
    errors.push(`ghatana-lifecycle/tools/evidence-generator: tool-product metadata must match Lifecycle exception ${lifecycleVersion}; the resource template must match its recorded template version and processResources must generate the packaged identity from project.version`);
  }
} else {
  errors.push('ghatana-lifecycle: composite source checkout is missing; cannot verify its RC1 root, TypeScript packages, or Evidence Generator identity split');
}

if (errors.length > 0) {
  console.error('Development version policy violations:');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  const exceptionSummary = [...exceptions.values()]
    .map(({ id, owner, version }) => `${id} (${owner}: ${version})`)
    .join('; ');
  console.log(releaseMode
    ? 'Release version policy passed (no active SNAPSHOT coordinates).'
    : `Development version policy passed: ordinary Ghatana development artifacts use ${expectedVersion}; temporary compatibility exceptions: ${exceptionSummary}. Exception owners have not approved full closure.`);
}
