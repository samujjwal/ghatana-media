import { chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
await Promise.all([
  chmod(resolve(dist, 'cli.js'), 0o755),
  chmod(resolve(dist, 'cli-dev.js'), 0o755),
]);
