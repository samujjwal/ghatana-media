#!/usr/bin/env node
/**
 * Build the installable, digest-pinned Media client artifact set (local-file channel, same style as
 * Kernel's install set) and verify it source-free.
 *
 *   node scripts/package-media-install-set.mjs --out <empty dir>
 *
 * Output: a Maven repository layout (usable as Kernel's GHATANA_MEDIA_STAGING_REPO), `npm/*.tgz` for the
 * scanner provider, `<file>.sha256` sidecars and `media-install-manifest.json`.
 * Artifacts: com.ghatana.media:runtime-contracts (STT/job/artifact contracts),
 * dev.ghatana.documentintelligence:document-intelligence-java-client, @ghatana-media/security-scanner-provider.
 * Versions are never changed here. Does not delete caches; --out must be empty or absent.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST_NAME, SCHEMA, fileEntry, fingerprintOf, verifyInstallSet, sha256Hex } from './lib/media-install-set.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const out = args[args.indexOf('--out') + 1];
if (!out || args.indexOf('--out') < 0) { console.error('usage: package-media-install-set.mjs --out <empty dir>'); process.exit(2); }
const OUT = path.resolve(out);
if (existsSync(OUT) && readdirSync(OUT).length) { console.error(`--out ${OUT} must be empty`); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const jdk = process.env.JAVA_HOME ?? path.join(homedir(), '.gradle/jdks/eclipse_adoptium-27-amd64-linux.2');
const env = { ...process.env, JAVA_HOME: jdk };
const run = (cmd, a, cwd = ROOT) => execFileSync(cmd, a, { cwd, env, stdio: 'inherit' });
const VERSION = '0.1.0-SNAPSHOT';

const git = (...a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
const commit = git('rev-parse', 'HEAD');
const dirty = git('status', '--porcelain', '--', 'runtime-contracts', 'services/document-intelligence/clients/java', 'providers/security-scanner');

const place = (group, artifact, sources) => {
  const dir = path.join(OUT, ...group.split('.'), artifact, VERSION);
  mkdirSync(dir, { recursive: true });
  for (const [src, name] of sources) copyFileSync(src, path.join(dir, `${artifact}-${VERSION}${name}`));
  return { groupId: group, artifactId: artifact, version: VERSION };
};

// 1. runtime-contracts (Shared build conventions; DEV_SOURCE_COMPOSITE needs the sibling ghatana-shared checkout).
run('./gradlew', ['--offline', '-q', '-Pghatana.media.compositeScope=FOCUSED', '-Pghatana.media.focusedModules=stt', '-PwithSourcesJar=true',
  ':services:media:runtime-contracts:jar', ':services:media:runtime-contracts:sourcesJar',
  ':services:media:runtime-contracts:generatePomFileForMavenJavaPublication',
  ':services:media:runtime-contracts:generateMetadataFileForMavenJavaPublication']);
const rc = path.join(ROOT, 'runtime-contracts/build');
const rcCoord = place('com.ghatana.media', 'runtime-contracts', [
  [path.join(rc, `libs/runtime-contracts-${VERSION}.jar`), '.jar'],
  [path.join(rc, `libs/runtime-contracts-${VERSION}-sources.jar`), '-sources.jar'],
  [path.join(rc, 'publications/mavenJava/pom-default.xml'), '.pom'],
  [path.join(rc, 'publications/mavenJava/module.json'), '.module'],
]);

// 2. Document Intelligence Java client (standalone build; focused tests run first).
const di = path.join(ROOT, 'services/document-intelligence/clients/java');
run(path.join(ROOT, 'gradlew'), ['--offline', '-q', 'test', 'jar', 'sourcesJar', 'generatePomFileForClientPublication', 'generateMetadataFileForClientPublication'], di);
const dib = path.join(di, 'build');
const diCoord = place('dev.ghatana.documentintelligence', 'document-intelligence-java-client', [
  [path.join(dib, `libs/document-intelligence-java-client-${VERSION}.jar`), '.jar'],
  [path.join(dib, `libs/document-intelligence-java-client-${VERSION}-sources.jar`), '-sources.jar'],
  [path.join(dib, 'publications/client/pom-default.xml'), '.pom'],
  [path.join(dib, 'publications/client/module.json'), '.module'],
]);

const mavenArtifacts = [rcCoord, diCoord].map((c) => {
  const dir = path.join(...c.groupId.split('.'), c.artifactId, c.version);
  const files = readdirSync(path.join(OUT, dir)).sort().map((n) => fileEntry(OUT, path.join(dir, n)));
  for (const f of files) writeFileSync(path.join(OUT, f.path + '.sha256'), `${f.sha256}  ${f.name}\n`);
  return { ...c, files };
});

// 3. Scanner provider npm tarball (compiled dist; no runtime dependencies).
const scn = path.join(ROOT, 'providers/security-scanner');
const tsc = [process.env.MEDIA_TSC, path.join(scn, 'node_modules/typescript/bin/tsc'), path.join(ROOT, 'libs/audio-video-client/node_modules/typescript/bin/tsc'),
  path.resolve(ROOT, '../../../libs/audio-video-client/node_modules/typescript/bin/tsc')].find((p) => p && existsSync(p));
if (!tsc) throw new Error('typescript compiler not found; set MEDIA_TSC');
rmSync(path.join(scn, 'dist'), { recursive: true, force: true });
run(process.execPath, [tsc, '-p', 'tsconfig.build.json'], scn);
mkdirSync(path.join(OUT, 'npm'));
const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', path.join(OUT, 'npm')], { cwd: scn, encoding: 'utf8' }))[0];
const pkgJson = JSON.parse(readFileSync(path.join(scn, 'package.json'), 'utf8'));
const tgz = fileEntry(OUT, `npm/${packed.filename}`);
writeFileSync(path.join(OUT, tgz.path + '.sha256'), `${tgz.sha256}  ${tgz.name}\n`);
const npmPackages = [{ name: pkgJson.name, version: pkgJson.version, file: tgz.path, size: tgz.size, sha256: tgz.sha256, integrity: packed.integrity }];

const manifest = {
  schemaVersion: SCHEMA,
  mediaVersion: VERSION,
  source: { repository: 'samujjwal/ghatana-media', commit, uncommittedChangesInPackagedPaths: dirty.length > 0 },
  mavenArtifacts,
  npmPackages,
  // Packaging is not provider admission: the clients are transports/contracts only.
  providerAdmission: {
    'security-scanner': 'NOT_ADMITTED: live engine, signing key and corpus are external',
    'document-intelligence': 'NOT_ADMITTED: OCR engine/model rights and corpus are external',
    'media-stt': 'NOT_ADMITTED: English/Nepali model rights and corpus are external',
  },
};
manifest.manifestFingerprint = fingerprintOf(manifest);
writeFileSync(path.join(OUT, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(path.join(OUT, MANIFEST_NAME + '.sha256'), `${sha256Hex(readFileSync(path.join(OUT, MANIFEST_NAME)))}  ${MANIFEST_NAME}\n`);

const v = verifyInstallSet(OUT);
if (!v.ok) { for (const e of v.errors) console.error(`REFUSED ${e}`); process.exit(1); }
console.log(`PASS ${OUT}\n${manifest.manifestFingerprint}${dirty ? '\nWARNING: uncommitted changes in packaged paths' : ''}`);
