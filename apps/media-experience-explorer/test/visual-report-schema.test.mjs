import assert from "node:assert/strict";
import test from "node:test";

import { validateVisualReport } from "./compare-visual-references.mjs";

const files = [
  "candidate-edit-captions-desktop.png",
  "candidate-edit-captions-narrow-mobile.png",
  "explore-desktop.png",
  "explore-narrow-mobile.png",
  "specification-desktop.png",
  "specification-narrow-mobile.png",
  "verify-desktop.png",
  "verify-narrow-mobile.png",
];

function validManifest() {
  return {
    schemaVersion: "media-experience-local-visual-references.v1",
    classification: "LOCAL_VISUAL_REGRESSION_REFERENCE_AFTER_LAYOUT_FIX_NOT_CANONICAL_DESIGN_APPROVAL",
    screenshots: files.map((file) => ({
      file,
      referenceFile: "screenshots/" + file,
      inputCaptureFile: "original-user-captures/" + file,
      sha256: "a".repeat(64),
      inputCaptureSha256: "b".repeat(64),
    })),
  };
}

function validReport() {
  return {
    screenshots: files.map((file) => "/tmp/media-experience-browser-audit/" + file),
    failures: [],
    consoleErrors: [],
    pageErrors: [],
    policyViolations: [],
    manualGates: {
      screenReader: { status: "MANUAL_NOT_VERIFIED" },
      independentVisualReview: { status: "MANUAL_NOT_VERIFIED" },
      canonicalVisualReferences: { status: "NOT_SUPPLIED" },
    },
  };
}

test("browser visual report schema requires all arrays and preserves manual review gates", () => {
  assert.equal(validateVisualReport(validManifest(), validReport()), undefined);

  for (const field of ["screenshots", "failures", "consoleErrors", "pageErrors", "policyViolations"]) {
    const report = validReport();
    delete report[field];
    assert.throws(() => validateVisualReport(validManifest(), report), new RegExp("field " + field + " must be an array", "u"));
  }

  for (const [key, status] of [["screenReader", "MANUAL_NOT_VERIFIED"], ["independentVisualReview", "MANUAL_NOT_VERIFIED"], ["canonicalVisualReferences", "NOT_SUPPLIED"]]) {
    const report = validReport();
    report.manualGates[key].status = key === "canonicalVisualReferences" ? "ACCEPTED" : "VERIFIED";
    assert.throws(() => validateVisualReport(validManifest(), report), new RegExp("manualGates\\." + key, "u"));
    report.manualGates[key].status = status;
  }
});

test("browser visual report requires the exact eight expected screenshot names", () => {
  const shortManifest = validManifest();
  shortManifest.screenshots.pop();
  assert.throws(() => validateVisualReport(shortManifest, validReport()), /exact eight supported screenshot names/u);

  const shortReport = validReport();
  shortReport.screenshots.pop();
  assert.throws(() => validateVisualReport(validManifest(), shortReport), /exactly the eight expected screenshot paths/u);

  const reportWithUnknownScreenshot = validReport();
  reportWithUnknownScreenshot.screenshots[0] = "/tmp/extra.png";
  assert.throws(() => validateVisualReport(validManifest(), reportWithUnknownScreenshot), /does not exactly match/u);
});

test("local reference manifest pins separate original-input and corrected-reference hashes", () => {
  const manifest = validManifest();
  manifest.screenshots[0].referenceFile = "../unreviewed.png";
  assert.throws(() => validateVisualReport(manifest, validReport()), /pin both the original input capture/u);
  manifest.screenshots[0].referenceFile = "screenshots/" + files[0];
  manifest.screenshots[0].inputCaptureSha256 = "unknown";
  assert.throws(() => validateVisualReport(manifest, validReport()), /pin both the original input capture/u);
});

test("browser visual report rejects any recorded browser or policy failure", () => {
  const report = validReport();
  report.policyViolations.push({ directive: "script-src" });
  assert.throws(() => validateVisualReport(validManifest(), report), /contains failures/u);
});
