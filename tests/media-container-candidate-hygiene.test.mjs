import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tracked = new Set(execFileSync('git', ['ls-files', '-z'],
  { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean));
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const candidates = [
  { file: 'stt-service', module: 'modules/speech/stt-service',
    port: 50051, health: 8090, key: 'STT_GRPC_PORT' },
  { file: 'tts-service', module: 'modules/speech/tts-service',
    port: 50052, health: 8091, key: 'TTS_GRPC_PORT' },
  { file: 'vision-service', module: 'modules/vision/vision-service',
    port: 50054, health: 8092, key: 'VISION_GRPC_PORT' },
  { file: 'multimodal-service', module: 'modules/intelligence/multimodal-service',
    port: 50055, health: 8093, key: 'MULTIMODAL_GRPC_PORT' }
];

test('one canonical runtime-only image candidate per Media service', () => {
  const dockerfiles = [...tracked]
    .filter((path) => /(?:^|\/)Dockerfile(?:\.[^/]+)?$/u.test(path)
      && path !== 'scripts/Dockerfile.wave2-native-test').sort();
  assert.deepEqual(dockerfiles,
    candidates.map((candidate) => 'docker/Dockerfile.' + candidate.file).sort());
  const nativeTestDockerfile = read('scripts/Dockerfile.wave2-native-test');
  assert.match(nativeTestDockerfile, /test-only="true"/u,
    'Linux codec runtime image must be explicitly test-only');
  const target = read('gradle/libs.versions.toml').match(/^java = "(\d+)"$/mu)?.[1];
  assert.ok(target, 'Media canonical Java bytecode target must be declared');
  for (const candidate of candidates) {
    const recipe = read('docker/Dockerfile.' + candidate.file);
    const base = recipe.split('\n').find((line) => line.startsWith('FROM '));
    assert.equal(base, 'FROM eclipse-temurin:' + target + '-jre',
      candidate.file + ' candidate image must run the canonical Media JRE target');
    assert.ok(recipe.includes(candidate.module + '/build/install/' + candidate.file + '/ /app/'));
    assert.ok(recipe.includes('ENV ' + candidate.key + '=' + candidate.port));
    assert.ok(recipe.includes('AV_HEALTH_PORT=' + candidate.health));
    assert.ok(recipe.includes('EXPOSE ' + candidate.port + ' ' + candidate.health));
    assert.ok(recipe.includes('ENTRYPOINT ["/app/bin/' + candidate.file + '"]'));
    assert.match(recipe, /^USER 10001:10001\s*$/mu);
    assert.doesNotMatch(recipe, /^COPY\s+(?:\.\s+\.|buildSrc|products\/audio-video)/mu);
    assert.doesNotMatch(recipe, /shadowJar|-x\s+(?:test|compileJava|checkstyleMain)/u);
  }
});

test('Docker packaging context excludes sources and secrets by default', () => {
  const ignore = read('.dockerignore');
  assert.match(ignore, /^\*\*\/\*\s*$/mu);
  assert.doesNotMatch(ignore, /^!\.env/u);
  for (const candidate of candidates) {
    assert.ok(ignore.includes('!' + candidate.module + '/build/install/' + candidate.file + '/**'));
  }
});

test('Compose image probes preserve health ports and fail closed before publishing listeners', () => {
  const compose = read('integration-tests/docker-compose.integration.yml');
  const base = read('integration-tests/src/test/java/com/ghatana/audio/video/integration/AudioVideoContainerBase.java');
  for (const candidate of candidates.filter(({file}) =>
    file === 'stt-service' || file === 'tts-service')) {
    assert.ok(compose.includes('AV_HEALTH_PORT: "' + candidate.health + '"'),
      candidate.file + ' Compose health env must use the canonical port');
    assert.ok(compose.includes('      - "' + candidate.health + '"'),
      candidate.file + ' Compose must expose its own health port');
  }
  assert.ok(compose.includes('STT_PROVIDER_MODE: "NOP"'),
    'STT image probe must use the explicit no-provider profile');
  assert.ok(compose.includes('TTS_PROVIDER_MODE: "LOCAL_ONNX"'),
    'TTS image probe must use a profile that fails closed without model rights');
  assert.ok(base.includes('"run", "--rm", "--no-deps", serviceName'),
    'Compose probes must run each service independently and remove the container');
  assert.ok(base.includes('Duration.ofSeconds(30)'),
    'Compose startup probes must have a finite timeout');
  assert.ok(base.includes('STT_PROVIDER_NOT_ADMITTED') && base.includes('TTS_PROVIDER_NOT_ADMITTED'),
    'Image tests must assert typed provider-admission refusals');
  assert.doesNotMatch(compose, /"8080"/u,
    'Compose must not use an unrelated default health port');
});
