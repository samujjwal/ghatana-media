import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean));
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const candidates = [{"file":"stt-service","module":"modules/speech/stt-service","port":50051,"health":8090,"key":"STT_GRPC_PORT"},{"file":"tts-service","module":"modules/speech/tts-service","port":50052,"health":8091,"key":"TTS_GRPC_PORT"},{"file":"vision-service","module":"modules/vision/vision-service","port":50054,"health":8092,"key":"VISION_GRPC_PORT"},{"file":"multimodal-service","module":"modules/intelligence/multimodal-service","port":50055,"health":8093,"key":"MULTIMODAL_GRPC_PORT"}];
test('one canonical runtime-only image candidate per Media service', () => {
  const dockerfiles = [...tracked].filter((p) => /(?:^|\/)Dockerfile(?:\.[^/]+)?$/u.test(p)).sort();
  assert.deepEqual(dockerfiles, candidates.map((c) => 'docker/Dockerfile.' + c.file).sort());
  const target = read('gradle/libs.versions.toml').match(/^java = "(\d+)"$/mu)?.[1];
  assert.ok(target, 'Media canonical Java target must be declared');
  for (const c of candidates) {
    const recipe = read('docker/Dockerfile.' + c.file);
    assert.match(recipe, new RegExp('^FROM eclipse-temurin:' + target + '-jre\\s*
    assert.ok(recipe.includes(c.module + '/build/install/' + c.file + '/ /app/'));
    assert.ok(recipe.includes('ENV ' + c.key + '=' + c.port));
    assert.ok(recipe.includes('AV_HEALTH_PORT=' + c.health));
    assert.ok(recipe.includes('EXPOSE ' + c.port + ' ' + c.health));
    assert.ok(recipe.includes('ENTRYPOINT ["/app/bin/' + c.file + '"]'));
    assert.match(recipe, /^USER 10001:10001\s*$/mu);
    assert.doesNotMatch(recipe, /^COPY\s+(?:\.\s+\.|buildSrc|products\/audio-video)/mu);
    assert.doesNotMatch(recipe, /shadowJar|-x\s+(?:test|compileJava|checkstyleMain)/u);
  }
});
test('Docker packaging context excludes sources and secrets by default', () => {
  const ignore = read('.dockerignore');
  assert.match(ignore, /^\*\*\/\*\s*$/mu);
  assert.doesNotMatch(ignore, /^!\.env/u);
  for (const c of candidates) {
    assert.ok(ignore.includes('!' + c.module + '/build/install/' + c.file + '/**'));
  }
});
, 'mu'),
      'candidate container JVM must match canonical Media Java bytecode target');
    assert.ok(recipe.includes(c.module + '/build/install/' + c.file + '/ /app/'));
    assert.ok(recipe.includes('ENV ' + c.key + '=' + c.port));
    assert.ok(recipe.includes('AV_HEALTH_PORT=' + c.health));
    assert.ok(recipe.includes('EXPOSE ' + c.port + ' ' + c.health));
    assert.ok(recipe.includes('ENTRYPOINT ["/app/bin/' + c.file + '"]'));
    assert.match(recipe, /^USER 10001:10001\s*$/mu);
    assert.doesNotMatch(recipe, /^COPY\s+(?:\.\s+\.|buildSrc|products\/audio-video)/mu);
    assert.doesNotMatch(recipe, /shadowJar|-x\s+(?:test|compileJava|checkstyleMain)/u);
  }
});
test('Docker packaging context excludes sources and secrets by default', () => {
  const ignore = read('.dockerignore');
  assert.match(ignore, /^\*\*\/\*\s*$/mu);
  assert.doesNotMatch(ignore, /^!\.env/u);
  for (const c of candidates) {
    assert.ok(ignore.includes('!' + c.module + '/build/install/' + c.file + '/**'));
  }
});
