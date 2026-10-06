#!/usr/bin/env node
/**
 * Check design-system ownership and screen-composition shape locally.
 * Shared package binding, pixel-reference review, and accessibility
 * certification remain external/native gates.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const failures = [];
const read = (relativePath) => readFileSync(join(root, relativePath), "utf8");
const fail = (message) => failures.push(message);

const styleAuthority = read(".product-experience/pdp-2-design-interface-system/gui/style-authority.yaml");
for (const requiredText of [
  "authority:",
  "semanticAuthority: false",
  "rawTokenAndGeometryExceptions: true",
  "sharedBinding:",
  "sibling-repository:ghatana-shared/config/design-system-public-api.json",
  "status: EXTERNAL_PACKAGE_AND_OWNER_REVIEW_PENDING",
]) {
  if (!styleAuthority.includes(requiredText)) fail(`style authority is missing ${requiredText}`);
}

const screenDir = join(root, ".product-experience/pdp-3-product-experience/screen-contracts");
const screenFiles = readdirSync(screenDir).filter((file) => file.endsWith(".yaml"));
if (screenFiles.length !== 48) fail(`screen composition inventory contains ${screenFiles.length} YAML files; expected 48`);
for (const file of screenFiles) {
  const source = read(`.product-experience/pdp-3-product-experience/screen-contracts/${file}`);
  if (file === "artifact-verification-job-family.yaml") continue;
  for (const field of ["templateContract:", "layoutContract:", "patternRefs:", "accessibility:", "localization:"]) {
    if (!source.includes(field)) fail(`${file} is missing ${field}`);
  }
}

const stylesheet = read("apps/media-experience-explorer/src/styles.css");
const rawValues = stylesheet.match(/#[0-9a-f]{3,8}\b/giu) ?? [];
if (rawValues.length > 0 && !styleAuthority.includes("rawTokenAndGeometryExceptions: true")) {
  fail(`stylesheet contains ${rawValues.length} raw color values without an explicit local-only exception policy`);
}

if (failures.length) {
  console.error(`Media design conformance check failed (${failures.length} failures)`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Media design conformance source check passed");
  console.log(`  ${screenFiles.length} screen files expose composition, accessibility, and localization fields`);
  console.log(`  ${rawValues.length} local raw color values remain explicitly classified as projection exceptions`);
  console.log("  Shared binding, pixel-reference, and independent accessibility review remain pending");
}
