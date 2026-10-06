#!/usr/bin/env node
/**
 * Validate explicit plan-required scopeStatus values in authored requirement,
 * capability, and journey records. Missing values require an explicit
 * owner-authored mapping; nearby prose is never semantic authority.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const files = [
  ".product-experience/pdp-0-product-truth/requirements.yaml",
  ".product-experience/pdp-0-product-truth/capabilities.yaml",
  ".product-experience/pdp-0-product-truth/journey-catalog.yaml",
];
const valid = new Set(["CURRENT", "TARGET", "DEFERRED", "RESEARCH", "COMPATIBILITY_ONLY", "NOT_APPLICABLE", "OBSOLETE"]);

// Deliberately empty until an owner authors a specific record-to-status decision.
export const ownerAuthoredMappings = new Map();

export function validateScopeStatuses(source, relativePath, mappings = ownerAuthoredMappings, expectedCount) {
  const records = [...source.matchAll(/^( *)(- id: ([^\r\n]+))\r?\n/gmu)];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const indent = record[1].length;
    const id = record[3].trim();
    const start = record.index + record[0].length;
    let end = source.length;
    for (let next = index + 1; next < records.length; next += 1) {
      if (records[next][1].length <= indent) {
        end = records[next].index;
        break;
      }
    }
    const block = source.slice(start, end);
    const matches = [...block.matchAll(/^( +)scopeStatus:\s*([^\s#]+)\s*$/gmu)]
      .filter((match) => match[1].length > indent);
    if (matches.length > 1) throw new Error(`${relativePath}: duplicate scopeStatus for ${id}`);
    const status = matches[0]?.[2] ?? mappings.get(`${relativePath}#${id}`);
    if (!status) throw new Error(`${relativePath}: missing explicit scopeStatus for ${id}`);
    if (!valid.has(status)) throw new Error(`${relativePath}: invalid scopeStatus ${status} for ${id}`);
  }
  if (expectedCount !== undefined && records.length !== expectedCount) {
    throw new Error(`${relativePath}: found ${records.length} records; expected ${expectedCount}`);
  }
  return source;
}

function main() {
  for (const relativePath of files) {
    const source = readFileSync(join(root, relativePath), "utf8");
    validateScopeStatuses(source, relativePath, ownerAuthoredMappings,
      relativePath.endsWith("journey-catalog.yaml") ? 30 : undefined);
    console.log(`${relativePath}: explicit scopeStatus values validated`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
