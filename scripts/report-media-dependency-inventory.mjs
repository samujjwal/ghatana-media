import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildMediaDependencyInventory, renderDependencyInventoryMarkdown } from "./lib/media-dependency-inventory.mjs";

const root = process.cwd();
const jsonPath = resolve(root, "build/dependency-inventory/media-dependency-inventory.v1.json");
const markdownPath = resolve(root, "build/dependency-inventory/media-dependency-inventory.v1.md");
const report = buildMediaDependencyInventory(root);
for (const path of [jsonPath, markdownPath]) mkdirSync(dirname(path), { recursive: true });
writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync(markdownPath, renderDependencyInventoryMarkdown(report), "utf8");
process.stdout.write(`Source inventory written to ${jsonPath} and ${markdownPath}\n`);
process.stdout.write(`${JSON.stringify(report.denominators, null, 2)}\n`);
