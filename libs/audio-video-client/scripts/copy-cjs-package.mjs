import { copyFile, mkdir } from 'node:fs/promises';

await mkdir(new URL('../dist-cjs/', import.meta.url), { recursive: true });
await copyFile(
  new URL('../cjs-package.json', import.meta.url),
  new URL('../dist-cjs/package.json', import.meta.url),
);
