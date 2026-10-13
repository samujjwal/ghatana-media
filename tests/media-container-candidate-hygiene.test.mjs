import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean));
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const candidates = [{"file":"stt-service","module":"modules/speech/stt-service","port":50051,"key":"STT_GRPC_PORT"},{"file":"tts-service","module":"modules/speech/tts-service","port":50052,"key":"TTS_GRPC_PORT"},{"file":"vision-service","module":"modules/vision/vision-service","port":50054,"key":"VISION_GRPC_PORT"},{"file":"multimodal-service","module":"modules/intelligence/multimodal-service","port":50055,"key":"MULTIMODAL_GRPC_PORT"}];
test('one canonical runtime-only image candidate per Media service', () => {
  const dockerfiles = [...tracked].filter((p) => /(?:^|\/)Dockerfile(?:\.[^/]+)?$/u.test(p)).sort();
  assert.deepEqual(dockerfiles, candidates.map((c) => 'docker/Dockerfile.' + c.file).sort());
  for (const c of candidates) {
    const recipe = read('docker/Dockerfile.' + c.file);
    assert.match(recipe, /^FROM eclipse-temurin:21-jre-jammy\s*$/mu);
    assert.ok(recipe.includes(c.module + '/build/install/' + c.file + '/ /app/'));
    assert.ok(recipe.includes('ENV ' + c.key + '=' + c.port));
    assert.ok(recipe.includes('EXPOSE ' + c.port));
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
