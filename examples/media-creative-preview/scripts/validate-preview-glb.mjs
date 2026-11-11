import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const validatorEntry = require.resolve("gltf-validator");
const packagePath = resolve(dirname(validatorEntry), "package.json");
const validatorPackage = JSON.parse(readFileSync(packagePath, "utf8"));
if (validatorPackage.version !== "2.0.0-dev.3.10") {
  throw new Error(`Expected pinned gltf-validator 2.0.0-dev.3.10, found ${validatorPackage.version}`);
}

const inputPath = process.argv[2];
if (!inputPath) throw new Error("Usage: node validate-preview-glb.mjs <local-glb-path>");
const validator = require("gltf-validator");
const bytes = readFileSync(inputPath);
const report = await validator.validateBytes(new Uint8Array(bytes), {
  uri: basename(inputPath),
  maxIssues: 1000,
});
const summary = {
  validator: "KhronosGroup/glTF-Validator",
  version: validatorPackage.version,
  assetSha256: createHash("sha256").update(bytes).digest("hex"),
  issueCounts: {
    errors: report.issues.numErrors,
    warnings: report.issues.numWarnings,
    infos: report.issues.numInfos,
    hints: report.issues.numHints,
  },
};
if (summary.issueCounts.errors !== 0) {
  console.error(JSON.stringify({ ...summary, issues: report.issues.messages }));
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}
