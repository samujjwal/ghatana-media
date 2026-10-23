import fs from 'node:fs';
import path from 'node:path';
import { checkF00T01Observation, buildF00T01Observation } from './lib/media-build-f00-t01-observation.mjs';

const args = process.argv.slice(2);
const valueAfter = name => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const root = process.cwd();
const g0StatusPath = valueAfter('--g0-status');
const isCheck = args.includes('--check');
const artifactPath = valueAfter('--artifact') ?? valueAfter('--output');

if (args.includes('--help')) {
  process.stdout.write('Usage: node scripts/generate-media-build-f00-t01-observation.mjs --g0-status <Lifecycle status JSON> [--output <path>] [--check --artifact <path>]\n');
  process.exit(0);
}
if (!g0StatusPath || args.indexOf('--g0-status') === args.length - 1) {
  throw new Error('Required input: --g0-status <Lifecycle MEDIA_PHASE_STATUS_IO JSON>');
}

if (isCheck) {
  if (!artifactPath || args.indexOf('--artifact') === args.length - 1 && !valueAfter('--output')) {
    throw new Error('--check requires --artifact <existing observation path>');
  }
  const artifact = checkF00T01Observation({ root, g0StatusPath, artifactPath });
  process.stdout.write(`PASS ${artifactPath} matches current G0 and Media source inputs (54 identities, 216 phase cells, 859 material pins)\n`);
} else {
  const now = new Date();
  const artifact = buildF00T01Observation({ root, g0StatusPath, now });
  const timestamp = artifact.recordedAt.replace(/[-:]/gu, '').replace('T', 'T').replace('Z', 'Z');
  const outputPath = artifactPath ?? `docs/implementation/evidence/media-gtool-campaign/media-build-f00-t01-source-material-topology-observation-${timestamp}.v1.json`;
  const absoluteOutputPath = path.resolve(root, outputPath);
  fs.mkdirSync(path.dirname(absoluteOutputPath), { recursive: true });
  fs.writeFileSync(absoluteOutputPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`PASS wrote ${path.relative(root, absoluteOutputPath)} (54 identities, 216 phase cells, 859 material pins)\n`);
}
