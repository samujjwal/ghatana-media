#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateMediaTerminalFrameTruth } from './lib/media-terminal-frame-truth.mjs';

const root = process.cwd();
const read = path => readFileSync(resolve(root, path), 'utf8');
const errors = validateMediaTerminalFrameTruth({
  handlerSource: read('launcher/src/main/java/com/ghatana/media/launcher/MediaHttpHandler.java'),
  testSource: read('launcher/src/test/java/com/ghatana/media/launcher/MediaHttpTerminalFrameBodyTest.java'),
  openApiSource: read('contracts/openapi/media.yaml'),
});
if (errors.length > 0) {
  console.error(`Media terminal-frame authority failed with ${errors.length} violation(s):`);
  errors.forEach(error => console.error(`- ${error}`));
  process.exit(1);
}
console.log('Media terminal frames accept bounded empty bodies without Content-Length coupling.');
