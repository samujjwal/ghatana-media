#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildMediaW3SourceCaseMap,
  parseMediaW3YamlFromWorkspace,
  validateMediaW3SourceCaseMap,
} from './lib/media-w3-source-case-map.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRef = 'config/closure/media-product-definition/w3-pdp0-source-case-map.json';
const parseYaml = parseMediaW3YamlFromWorkspace(root);
const result = buildMediaW3SourceCaseMap({ root, parseYaml });
validateMediaW3SourceCaseMap(result, { root, parseYaml, expected: result });
const rendered = `${JSON.stringify(result, null, 2)}\n`;
const output = path.join(root, outputRef);
if (process.argv.includes('--check')) {
  if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== rendered) {
    console.error(`W3 source case-map drift: ${outputRef}`);
    process.exitCode = 1;
  } else {
    console.log(`W3 source case map is current: 54 source identities, ${result.pdp0CaseMap.obligationCount} PDP-0 open slots, ${result.pdp0CaseMap.candidateLinkedObligationCount} PDP-0 candidate-linked obligations.`);
  }
} else {
  fs.writeFileSync(output, rendered);
  console.log(`Wrote ${outputRef}: 54 source identities, ${result.pdp0CaseMap.obligationCount} PDP-0 open slots, ${result.pdp0CaseMap.candidateLinkedObligationCount} PDP-0 candidate-linked obligations.`);
}
