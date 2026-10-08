#!/usr/bin/env node
import {
  buildMediaProductDefinitionResidualReport,
  renderMediaProductDefinitionResidualJson,
  renderMediaProductDefinitionResidualMarkdown,
} from "./lib/media-product-definition-residuals.mjs";

const unknownOptions = process.argv.slice(2).filter((argument) => argument !== "--json");
if (unknownOptions.length) {
  console.error(`Unknown option(s): ${unknownOptions.join(", ")}`);
  console.error("Usage: node scripts/report-media-definition-residuals.mjs [--json]");
  process.exit(2);
}

const report = buildMediaProductDefinitionResidualReport();
process.stdout.write(process.argv.includes("--json")
  ? renderMediaProductDefinitionResidualJson(report)
  : renderMediaProductDefinitionResidualMarkdown(report));

if (report.diagnostics.length) process.exitCode = 1;
