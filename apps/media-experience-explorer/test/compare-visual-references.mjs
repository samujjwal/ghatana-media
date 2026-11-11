import { createHash } from "node:crypto";
import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { comparePngBuffers } from "./png-visual-diff.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const referenceDirectory = join(dirname(scriptPath), "visual-references/local-browser-audit-2026-11-10");
const manifestPath = join(referenceDirectory, "manifest.json");
const artifactDirectory = resolve(process.env.MEDIA_EXPLORER_ARTIFACT_DIR ?? "/tmp/media-experience-browser-audit");
const reportPath = join(artifactDirectory, "report.json");
const expectedScreenshotFiles = Object.freeze([
  "candidate-edit-captions-desktop.png",
  "candidate-edit-captions-narrow-mobile.png",
  "explore-desktop.png",
  "explore-narrow-mobile.png",
  "specification-desktop.png",
  "specification-narrow-mobile.png",
  "verify-desktop.png",
  "verify-narrow-mobile.png",
]);

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function requireManualGate(report, key, expected) {
  const actual = report.manualGates?.[key]?.status;
  if (actual !== expected) throw new Error("browser report manualGates." + key + " must remain " + expected + ", received " + String(actual));
}

export function validateVisualReport(manifest, report) {
  if (!manifest || manifest.schemaVersion !== "media-experience-local-visual-references.v1"
      || manifest.classification !== "LOCAL_VISUAL_REGRESSION_REFERENCE_AFTER_LAYOUT_FIX_NOT_CANONICAL_DESIGN_APPROVAL"
      || !Array.isArray(manifest.screenshots)) {
    throw new Error("local reference manifest schema or screenshot list is invalid");
  }
  if (!report || typeof report !== "object") throw new Error("browser audit report must be an object");
  for (const key of ["screenshots", "failures", "consoleErrors", "pageErrors", "policyViolations"]) {
    if (!Array.isArray(report[key])) throw new Error("browser audit report field " + key + " must be an array");
  }
  requireManualGate(report, "screenReader", "MANUAL_NOT_VERIFIED");
  requireManualGate(report, "independentVisualReview", "MANUAL_NOT_VERIFIED");
  requireManualGate(report, "canonicalVisualReferences", "NOT_SUPPLIED");
  if (report.failures.length || report.consoleErrors.length || report.pageErrors.length || report.policyViolations.length) {
    throw new Error("browser audit report contains failures, console/page errors, or policy violations");
  }

  const manifestNames = manifest.screenshots.map((entry) => entry?.file);
  if (manifestNames.length !== expectedScreenshotFiles.length
      || new Set(manifestNames).size !== expectedScreenshotFiles.length
      || expectedScreenshotFiles.some((name) => !manifestNames.includes(name))) {
    throw new Error("local reference manifest must contain the exact eight supported screenshot names");
  }
  for (const entry of manifest.screenshots) {
    if (entry.referenceFile !== "screenshots/" + entry.file
        || entry.inputCaptureFile !== "original-user-captures/" + entry.file
        || !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? "")
        || !/^[a-f0-9]{64}$/u.test(entry.inputCaptureSha256 ?? "")) {
      throw new Error("local reference manifest must pin both the original input capture and active screenshot hash for " + entry.file);
    }
  }
  if (report.screenshots.length !== expectedScreenshotFiles.length
      || report.screenshots.some((entry) => typeof entry !== "string")) {
    throw new Error("browser report must contain exactly the eight expected screenshot paths");
  }
  const reportNames = report.screenshots.map((entry) => entry.split(/[\\/]/u).at(-1));
  if (new Set(reportNames).size !== expectedScreenshotFiles.length
      || expectedScreenshotFiles.some((name) => !reportNames.includes(name))) {
    throw new Error("browser report screenshot set does not exactly match the eight supported screenshots");
  }
}

export async function runVisualReferenceComparison() {
  const [manifestBytes, reportBytes] = await Promise.all([readFile(manifestPath), readFile(reportPath)]);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const report = JSON.parse(reportBytes.toString("utf8"));
  validateVisualReport(manifest, report);

  for (const name of await readdir(artifactDirectory)) {
    if (name.startsWith("visual-diff-") && name.endsWith(".png")) {
      await unlink(join(artifactDirectory, name));
    }
  }

  const results = [];
  for (const entry of manifest.screenshots) {
    const referencePath = join(referenceDirectory, entry.referenceFile);
    const inputCapturePath = join(referenceDirectory, entry.inputCaptureFile);
    const actualPath = join(artifactDirectory, entry.file);
    const [referenceBytes, inputCaptureBytes, actualBytes] = await Promise.all([
      readFile(referencePath), readFile(inputCapturePath), readFile(actualPath),
    ]);
    const referenceSha256 = sha256(referenceBytes);
    const inputCaptureSha256 = sha256(inputCaptureBytes);
    const actualSha256 = sha256(actualBytes);
    if (referenceSha256 !== entry.sha256) {
      throw new Error("local reference hash mismatch for " + entry.file + ": manifest=" + entry.sha256 + " actual=" + referenceSha256);
    }
    if (inputCaptureSha256 !== entry.inputCaptureSha256) {
      throw new Error("original user input capture hash mismatch for " + entry.file + ": manifest="
        + entry.inputCaptureSha256 + " actual=" + inputCaptureSha256);
    }

    const comparison = comparePngBuffers(referenceBytes, actualBytes);
    const result = {
      name: entry.name,
      route: entry.route,
      viewport: entry.viewport,
      width: comparison.width,
      height: comparison.height,
      inputCaptureSha256,
      referenceSha256,
      actualSha256,
      differingPixels: comparison.differingPixels,
      differingChannels: comparison.differingChannels,
      differingPixelRatio: comparison.differingPixelRatio,
      maximumChannelDelta: comparison.maximumChannelDelta,
      bounds: comparison.bounds,
      samples: comparison.samples,
    };
    if (comparison.differingPixels) {
      const diffPath = join(artifactDirectory, "visual-diff-" + entry.name + ".png");
      await writeFile(diffPath, comparison.diffPng);
      result.diffPath = diffPath;
    }
    results.push(result);
  }

  const mismatches = results.filter(({ differingPixels }) => differingPixels > 0);
  const outcome = {
    result: mismatches.length ? "FAIL" : "PASS",
    scope: "local browser pixel regression only",
    references: manifest.screenshots.length,
    matches: results.length - mismatches.length,
    mismatches: mismatches.length,
    manualGates: report.manualGates,
    screenshots: results,
  };
  process.stdout.write(JSON.stringify(outcome, null, 2) + "\n");
  if (mismatches.length) process.exitCode = 1;
  return outcome;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  runVisualReferenceComparison().catch((error) => {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 1;
  });
}
