import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tracked = new Set(execFileSync('git', ['ls-files', '-z'], {
  cwd: root, encoding: 'utf8'
}).split('\0').filter(Boolean));
const read = (path) => readFileSync(resolve(root, path), 'utf8');

test('retired AI Voice success-mock and dead desktop launchers are not executable source', () => {
  const retired = [
    'modules/intelligence/ai-voice/grpc_server.py',
    'docker/Dockerfile.ai-voice',
    'infra/kubernetes/ai-voice.yaml',
    'modules/intelligence/ai-voice/run-dev.sh',
    'modules/intelligence/ai-voice/run-dev.ps1',
    'modules/intelligence/ai-voice/scripts/setup-dev-env.sh',
    'scripts/start-services.sh',
    'scripts/stop-services.sh'
  ];
  for (const path of retired) {
    assert.equal(tracked.has(path), false, 'retired unqualified service must not be tracked: ' + path);
  }
});

test('active configuration and telemetry do not advertise the retired provider', () => {
  const env = read('.env.example');
  const alertRules = read('infra/monitoring/alerts/audio-video.yml');
  const dashboard = JSON.parse(read('infra/monitoring/grafana/dashboard.json'));
  assert.doesNotMatch(env, /AI_VOICE_(?:GRPC|MODEL|CLONING|DEMUCS|USE_GPU|CACHE)/u);
  assert.doesNotMatch(alertRules, /AiVoiceServiceDown|ai-voice-service/u);
  assert.doesNotMatch(JSON.stringify(dashboard), /ai-voice-service/u);
  const legacyCompose = read('config/docker-compose.prod.yml');
  assert.match(legacyCompose, /^services:\s*\{\}/mu);
  assert.match(legacyCompose, /releaseAdmission:\s*NOT_ADMITTED/u);
  assert.doesNotMatch(legacyCompose, /POSTGRES_PASSWORD|RABBITMQ_DEFAULT_PASS|image:\s*\S+:latest/u);
});

test('AI Voice retains a real host-dependent UI package, not a simulated backend', () => {
  const pkg = JSON.parse(read('modules/intelligence/ai-voice/libs/ai-voice-ui-react/package.json'));
  assert.equal(pkg.name, '@ghatana/ai-voice-ui-react');
  assert.equal(pkg.private, true);
  assert.match(pkg.description, /Host-dependent React UI/u);
  const exported = read('modules/intelligence/ai-voice/libs/ai-voice-ui-react/src/index.ts');
  for (const name of ['PhraseTimeline', 'Waveform', 'VoiceProductionWorkflow']) {
    assert.match(exported, new RegExp('\\b' + name + '\\b', 'u'));
  }
});
