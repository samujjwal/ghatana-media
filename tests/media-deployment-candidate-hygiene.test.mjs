import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const services = [
  { id: 'stt', source: 'infra/kubernetes/stt-deployment.yaml', port: 50051, health: 8090 },
  { id: 'tts', source: 'infra/kubernetes/tts-deployment.yaml', port: 50052, health: 8091 },
  { id: 'vision', source: 'infra/kubernetes/vision-service.yaml', port: 50054, health: 8092 },
  { id: 'multimodal', source: 'infra/kubernetes/multimodal-service.yaml', port: 50055, health: 8093 }
];

test('static Media manifests cannot accidentally deploy unqualified workloads', () => {
  for (const c of services) {
    const src = read(c.source);
    assert.match(src, /NOT_ADMITTED static integration candidate/u);
    assert.match(src, /^\s*replicas:\s*0\s*$/mu);
    assert.ok(src.includes('registry.invalid/ghatana-media/' + c.id + '-service:not-admitted'));
    assert.match(src, /imagePullPolicy: Never/u);
    assert.doesNotMatch(src, /image:\s*[^\n]+:latest|optional: true|replicas:\s*[1-9]/u);
    assert.ok(src.includes('containerPort: ' + c.port), c.id + ' gRPC container port');
    assert.ok(src.includes('port: ' + c.port), c.id + ' gRPC service port');
    assert.ok(src.includes('containerPort: ' + c.health), c.id + ' health container port');
  }
  assert.doesNotMatch(read(services[2].source), /kind:\s*HorizontalPodAutoscaler/u);
  const multimodal = read(services[3].source);
  assert.match(multimodal, /VISION_SERVICE_PORT: "50054"/u);
});

test('Helm is opt-in, immutable-digest only and has no retired AI Voice backend', () => {
  const values = read('infra/helm/audio-video/values.yaml');
  const template = read('infra/helm/audio-video/templates/services.yaml');
  const chart = read('infra/helm/audio-video/Chart.yaml');
  for (const c of services) {
    assert.match(values, new RegExp('(?:^|\\n)' + c.id + ':\\n  enabled: false', 'u'));
    assert.match(template, new RegExp('required "[^"]+" \\.Values\\.' + c.id + '\\.image\\.digest', 'u'));
    assert.ok(values.includes('grpc: ' + c.port), c.id + ' expected gRPC');
    assert.ok(values.includes('health: ' + c.health), c.id + ' expected health');
    assert.ok(template.includes('.Values.' + c.id + '.ports.grpc | quote'), c.id + ' bound gRPC port');
    assert.ok(template.includes('.Values.' + c.id + '.ports.health | quote'), c.id + ' bound HTTP health port');
    assert.ok(template.includes('name: ' + c.id.toUpperCase() + '_GRPC_PORT'), c.id + ' gRPC env supplied');

  }
  assert.doesNotMatch(template, /\.image\.tag\s*\|\s*default|\.Values\.aiVoice|optional: true/u);
  assert.doesNotMatch(values, /aiVoice:|tag: ""|enabled: true/u);
  assert.match(chart, /release-admission: "NOT_ADMITTED"/u);
});

test('Prometheus monitors real internal metrics paths, not retired mocks', () => {
  const prom = read('prometheus.audio-video.yml');
  assert.doesNotMatch(prom, /ai-voice-service|actuator\/prometheus|audio-video-production|environment: "prod"/u);
  assert.equal((prom.match(/metrics_path: "\/metrics"/gu) ?? []).length, 4);
  for (const c of services) assert.ok(prom.includes(c.id + '-service:' + c.health));
});

test('root Media runtime and old monitoring candidates are inert until release admission', () => {
  const deployment = read('deploy/k8s/deployment.yaml');
  assert.match(deployment, /NON-DEPLOYABLE compatibility record/u);
  assert.match(deployment, /MEDIA_RUNTIME_ENABLED: "false"/u);
  assert.match(deployment, /MEDIA_RUNTIME_ENVIRONMENT: "internal"/u);
  assert.match(deployment, /replicas: 0/u);
  assert.match(deployment, /image: registry\.invalid\/ghatana-media\/runtime:not-admitted/u);
  assert.match(deployment, /imagePullPolicy: Never/u);
  assert.match(deployment, /minAvailable: 0/u);
  assert.doesNotMatch(deployment, /replicas: [1-9]|MEDIA_RUNTIME_ENABLED: "true"|ghatana\/media:0\.1\.0/u);
  const monitor = read('monitoring/docker-compose.monitoring.yml');
  assert.match(monitor, /^services: \{\}$/mu);
  assert.match(monitor, /releaseAdmission: NOT_ADMITTED/u);
  assert.doesNotMatch(monitor, /GRAFANA_ADMIN_PASSWORD|postgres:postgres|restart: unless-stopped/u);
});
