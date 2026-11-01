import { rm } from 'node:fs/promises';

for (const output of [
  '../dist',
  '../dist-cjs',
  '../tsconfig.tsbuildinfo',
  '../tsconfig.build.tsbuildinfo',
  '../tsconfig.cjs.tsbuildinfo',
]) {
  await rm(new URL(output, import.meta.url), { recursive: true, force: true });
}
