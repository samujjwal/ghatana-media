#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { auditMediaObligationDenominator } from './lib/media-obligation-denominator-audit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const requireTools = createRequire(path.resolve(root, '../ghatana-tools/package.json'));
const { parse } = requireTools('yaml');
const base = 'config/closure/media-product-definition';
const report = auditMediaObligationDenominator({
  root,
  obligations: readJson(`${base}/obligations.json`),
  program: readJson(`${base}/phase-program.json`),
  binding: readJson(`${base}/phase-binding.json`),
  surface: readJson(`${base}/surface.json`),
  traceability: parse(fs.readFileSync(path.join(root, '.product-experience/traceability.yaml'), 'utf8')),
  parseYaml: parse,
});
console.log(JSON.stringify(report, null, 2));
if (report.issues.length) process.exitCode = 1;
