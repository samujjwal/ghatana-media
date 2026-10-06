#!/usr/bin/env node
/**
 * Purpose: validate the Media Product Definition source tree and its local
 * Explorer projection without becoming a second semantic authority.
 * Consumers: local development, focused verification, and the closure matrix.
 * Non-goals: phase acceptance, Tools Evidence Generator receipts, runtime
 * qualification, owner review, or currentness generation.
 * Change policy: derive checks from canonical paths and registries; never
 * write .evidence artifacts or promote observations to acceptance.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

const root = resolve(new URL("..", import.meta.url).pathname);
const productRoot = join(root, ".product-experience");
const indexPath = join(root, "apps/media-experience-explorer/specification-artifacts.json");
const matrixPath = join(productRoot, "mandatory-surface-closure-matrix.yaml");
const failures = [];
const observations = [];

function fail(message) { failures.push(message); }
function note(message) { observations.push(message); }
function read(path) {
  try { return readFileSync(path, "utf8"); }
  catch (error) { fail(`Cannot read ${relative(root, path)}: ${error.message}`); return ""; }
}
function assertExists(relativePath) {
  if (!existsSync(join(root, relativePath))) fail(`Missing required path: ${relativePath}`);
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function unique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) fail(`Duplicate ${label}: ${value}`);
    seen.add(value);
  }
}
function idsFrom(source, expression) {
  return [...source.matchAll(expression)].map((match) => match[1]);
}

for (const path of [
  ".product-experience/README.md",
  ".product-experience/source-manifest.yaml",
  ".product-experience/authority-map.yaml",
  ".product-experience/acceptance.yaml",
  ".product-experience/gaps.yaml",
  ".product-experience/traceability.yaml",
  ".product-experience/vision-requirements-coverage.yaml",
  ".product-experience/phase-0-product-truth/applications-channels.yaml",
  ".product-experience/phase-1-design-language/DESIGN-LANGUAGE.md",
  ".product-experience/phase-2-product-experience/COMPLETE-PRODUCT-EXPERIENCE.md",
  ".product-experience/phase-3-experience-explorer/EXPERIENCE-EXPLORER.md",
  "docs/README.md",
  "docs/VISION.md",
  "docs/REQUIREMENTS.md",
  "docs/ARCHITECTURE.md",
  "docs/DESIGN.md",
  "docs/EXAMPLES.md",
  "docs/TESTING.md",
  "docs/EVIDENCE.md",
  "apps/media-experience-explorer/README.md",
  "libs/media-experience-simulation/README.md",
]) assertExists(path);

if (existsSync(join(productRoot, "currentness.yaml"))) {
  fail("currentness.yaml exists even though owner-approved Tools currentness generation is unresolved");
} else {
  note("currentness.yaml is absent as required by the unresolved owner-approved generation gate");
}

const indexSource = read(indexPath);
let artifacts = [];
try { artifacts = JSON.parse(indexSource); }
catch (error) { fail(`Explorer artifact index is not valid JSON: ${error.message}`); }
if (!Array.isArray(artifacts) || artifacts.length === 0) fail("Explorer artifact index is empty");
else {
  unique(artifacts.map((artifact) => artifact.path), "Explorer artifact path");
  const phases = new Set(["P0", "P1", "P2", "P3", "Cross-phase"]);
  for (const artifact of artifacts) {
    if (!phases.has(artifact.phase)) fail(`Unknown Explorer artifact phase for ${artifact.path}: ${artifact.phase}`);
    if (!artifact.title?.trim()) fail(`Explorer artifact has no human label: ${artifact.path}`);
    const sourcePath = join(root, artifact.path);
    if (!existsSync(sourcePath)) fail(`Explorer artifact source is missing: ${artifact.path}`);
  }
  note(`Explorer index contains ${artifacts.length} source-derived records; digest ${sha256(indexSource).slice(0, 16)}`);
}

const matrixSource = read(matrixPath);
const matrixIds = idsFrom(matrixSource, /^\s*- id: ([a-z0-9-]+)$/gmu);
const requiredMatrixIds = [
  "prompt-repo-guidance", "recursive-inventory", "surface-kind-build-unit", "ownership-boundary-placement",
  "vision-non-goals-consumers", "architecture-design", "documentation-examples", "requirements-current-state",
  "gap-backlog-classification", "feature-completeness", "correctness", "api-contracts-config",
  "generated-source-of-truth-parity", "naming", "duplication", "organization-placement", "cohesion-coupling",
  "tests-coverage", "compatibility-migration-deprecation", "affected-scope-verification", "evidence-generator-integration",
  "missing-evidence-generator-capabilities", "security", "privacy-data-governance-compliance", "observability-diagnostics",
  "reliability-resilience-operability", "performance-scalability", "accessibility-internationalization", "ai-ml-applicability",
  "build-dependency-release-readiness", "dependency-supply-chain-licensing", "repeatability-reproducibility", "convergence-stability",
];
unique(matrixIds, "closure matrix row");
for (const id of requiredMatrixIds) if (!matrixIds.includes(id)) fail(`Closure matrix is missing area: ${id}`);
if (matrixIds.length !== requiredMatrixIds.length) fail(`Closure matrix has ${matrixIds.length} rows; expected ${requiredMatrixIds.length}`);

const screenDir = join(productRoot, "phase-2-product-experience/screen-contracts");
const screenFiles = readdirSync(screenDir).filter((file) => file.endsWith(".yaml"));
const indexedScreenPaths = new Set(artifacts.filter((artifact) => artifact.path.includes("/screen-contracts/")).map((artifact) => artifact.path));
for (const file of screenFiles) {
  const path = `.product-experience/phase-2-product-experience/screen-contracts/${file}`;
  if (!indexedScreenPaths.has(path)) fail(`Screen contract is not exposed in Explorer index: ${path}`);
}
note(`${screenFiles.length} screen-contract directory records are present (47 canonical screen contracts plus one job-family specialization); ${indexedScreenPaths.size} are indexed for read-only projection`);

const actionSource = read(join(productRoot, "phase-2-product-experience/action-registry.yaml"));
const actionIds = new Set(idsFrom(actionSource, /^\s*- id: (media\.action\.[A-Za-z0-9._-]+)$/gmu));
if (actionIds.size === 0) fail("Phase 2 action registry produced no action IDs");
const referencedActions = new Set();
for (const file of screenFiles) {
  const source = read(join(screenDir, file));
  for (const action of source.matchAll(/media\.action\.[A-Za-z0-9._-]+/gu)) referencedActions.add(action[0]);
}
for (const action of referencedActions) if (!actionIds.has(action)) fail(`Screen action is not registered: ${action}`);
note(`${actionIds.size} action IDs are registered; ${referencedActions.size} distinct screen action references resolve`);

function collectMatches(sources, expression) {
  const values = new Set();
  for (const source of sources) for (const match of source.matchAll(expression)) values.add(match[1]);
  return values;
}

function assertKnown(values, known, label) {
  for (const value of values) if (!known.has(value)) fail(`${label} is not registered: ${value}`);
}

function topLevelBlocks(source) {
  const blocks = [];
  let current = [];
  for (const line of source.split(/\r?\n/u)) {
    if (/^- id: /u.test(line)) {
      if (current.length) blocks.push(current.join("\n"));
      current = [line];
    } else if (current.length) {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks;
}

function assertBlocksHaveFields(blocks, fields, label) {
  let complete = 0;
  for (const block of blocks) {
    const id = block.match(/^- id: ([^\s]+)/u)?.[1] ?? "unknown";
    const missing = fields.filter((field) => !new RegExp(`^\\s*${field}:`, "mu").test(block));
    if (missing.length) fail(`${label} ${id} is missing required fields: ${missing.join(", ")}`);
    else complete += 1;
  }
  return complete;
}

const capabilitySource = read(join(productRoot, "phase-0-product-truth/capabilities.yaml"));
const familySection = capabilitySource.split(/^families:\s*$/mu)[1]?.split(/^capabilities:\s*$/mu)[0] ?? "";
const capabilitySection = capabilitySource.split(/^capabilities:\s*$/mu)[1] ?? "";
const capabilityIds = new Set(idsFrom(capabilitySection, /^\s*- id: (media\.[A-Za-z0-9._-]+)$/gmu));
const familyIds = new Set(idsFrom(familySection, /^\s*- id: (media\.[A-Za-z0-9._-]+)$/gmu));
const capabilityFamilyRefs = collectMatches([capabilitySection], /^\s*familyId: (media\.[A-Za-z0-9._-]+)$/gmu);
const requirementSource = read(join(productRoot, "phase-0-product-truth/requirements.yaml"));
const goalsSource = read(join(productRoot, "phase-0-product-truth/goals-jtbd.yaml"));
const journeyCatalogSource = read(join(productRoot, "phase-0-product-truth/journey-catalog.yaml"));
const coverageSource = read(join(productRoot, "vision-requirements-coverage.yaml"));
const requirementIds = new Set(idsFrom(requirementSource, /^- id: (MEDIA-REQ-[A-Z0-9-]+)[ \t]*$/gmu));
const capabilityRequirementRefs = collectMatches([capabilitySection], /^\s*- (MEDIA-REQ-[A-Z0-9-]+)$/gmu);
if (capabilityIds.size !== 462) fail(`Phase 0 capability leaf denominator is ${capabilityIds.size}; expected 462`);
unique([...capabilityIds], "Phase 0 capability ID");
unique([...familyIds], "Phase 0 capability family ID");
assertKnown(capabilityFamilyRefs, familyIds, "Capability family reference");
assertKnown(capabilityRequirementRefs, requirementIds, "Capability requirement reference");
const capabilityCoreFields = [
  "familyId", "operation", "label", "definitionState", "outcome", "preconditions", "constraints",
  "actionStateReferences", "requiredAuthority", "rightsPrivacyImplications", "provenance", "acceptanceCases",
  "qualificationDimensions", "supportedChannels", "explicitUnsupportedCases", "supportDimensions", "intentRefs",
  "outcomeRefs", "stateModelRefs", "journeyRefs",
];
const capabilityBlocks = topLevelBlocks(capabilitySection);
const capabilityCoreComplete = assertBlocksHaveFields(capabilityBlocks, capabilityCoreFields, "Capability");
const operationSpecificParameterProposals = capabilityBlocks.filter((block) => !/supportedParameters:\s*Not yet enumerated/u.test(block)).length;
const capabilityJourneyGaps = capabilityBlocks.filter((block) => /journeyRefs:\s*\[\s*\]/u.test(block)).length;
note(capabilityIds.size + " Phase 0 capability leaves have " + capabilityJourneyGaps + " unresolved explicit leaf-level journey references; inherited family intent/outcome coverage remains pending P0-010 review");

const outcomeIds = new Set(idsFrom(goalsSource, /^\s*- id: (media\.goal\.[A-Za-z0-9._-]+)$/gmu));
const outcomeCoverageBlocks = journeyCatalogSource
  .split(/(?=^- outcomeRef: )/mu)
  .filter((block) => block.startsWith("- outcomeRef: "));
const coveredOutcomeIds = new Set(outcomeCoverageBlocks
  .map((block) => block.match(/^- outcomeRef: (media\.goal\.[A-Za-z0-9._-]+)$/mu)?.[1])
  .filter(Boolean));
for (const outcomeId of outcomeIds) {
  if (!coveredOutcomeIds.has(outcomeId)) fail("Vision outcome has no journey or supporting-view coverage: " + outcomeId);
}
for (const block of outcomeCoverageBlocks) {
  const outcomeId = block.match(/^- outcomeRef: ([^\s]+)$/mu)?.[1] ?? "unknown";
  if (!/^\s*(?:proposedJourneyRefs|supportingViewRefs):/mu.test(block)) {
    fail("Outcome coverage has no journey or supporting view disposition: " + outcomeId);
  }
}
const requirementBlocks = topLevelBlocks(requirementSource);
const requirementOutcomeTraceCount = requirementBlocks.filter((block) =>
  /^\s*relatedOutcomeRefs:\s*$/mu.test(block) && /\n\s*-\s*media\.goal\./mu.test(block)).length;
if (requirementIds.size !== 38) fail("Requirement denominator is " + requirementIds.size + "; expected 38");
if (requirementOutcomeTraceCount !== requirementIds.size) {
  fail("Only " + requirementOutcomeTraceCount + " of " + requirementIds.size + " requirements have an outcome trace");
}
if (!coverageSource.includes("outcomeDenominator: 10") ||
    !coverageSource.includes("explorerArtifacts: {expected: 147") ||
    !coverageSource.includes("masterPromptCoverage:") ||
    !coverageSource.includes("id: MP-73-79")) {
  fail("Vision/requirements coverage ledger does not record the current denominators and full master-prompt section coverage");
}
note(outcomeIds.size + " P0 vision outcomes have journey/supporting-view coverage; " + requirementOutcomeTraceCount + " requirement groups have outcome traces");
note(`${capabilityIds.size} Phase 0 capability leaves resolve to ${familyIds.size} families and ${requirementIds.size} requirement IDs; ${capabilityCoreComplete} expose the required definition shape; ${operationSpecificParameterProposals} have operation-specific parameter proposals and ${capabilityIds.size - operationSpecificParameterProposals} still require owner-approved bounds`);

const componentSource = read(join(productRoot, "phase-1-design-language/component-contracts.yaml"));
const componentIds = new Set(idsFrom(componentSource, /^\s*- id: (media\.component\.[A-Za-z0-9._-]+)$/gmu));
const componentSection = componentSource.split(/^components:\s*$/mu)[1]?.split(/^masterPlanCoverage:\s*$/mu)[0] ?? "";
const componentCoreFields = ["purpose", "anatomy", "variants", "states", "actions", "keyboard", "accessibility", "localization", "prohibitedUse", "semanticRole", "capabilityRefs", "actionBindingState", "sourceRef"];
const componentCoreComplete = assertBlocksHaveFields(topLevelBlocks(componentSection), componentCoreFields, "Component");
const componentCapabilityGaps = topLevelBlocks(componentSection).filter((block) => /capabilityRefs:\s*\[\s*\]/u.test(block)).length;
const screenSources = screenFiles.map((file) => read(join(screenDir, file)));
const screenIds = new Set(collectMatches(screenSources, /^screenId: (media\.view\.[A-Za-z0-9._-]+)$/gmu));
const journeyDir = join(productRoot, "phase-2-product-experience/journey-contracts");
const journeyFiles = readdirSync(journeyDir).filter((file) => file.endsWith(".yaml"));
const journeyRegistry = read(join(productRoot, "phase-2-product-experience/journey-registry.yaml"));
const journeyIds = new Set(idsFrom(journeyRegistry, /^\s*- id: (J-[0-9]+)$/gmu));
const screenRegistrySource = read(join(productRoot, "phase-2-product-experience/screen-registry.yaml"));
const screenRegistryIds = new Set(idsFrom(screenRegistrySource, /^\s*- id: (media\.view\.[A-Za-z0-9._-]+)$/gmu));
const screenComponentRefs = collectMatches(screenSources, /\b(media\.component\.[A-Za-z0-9._-]+)/gu);
const screenJourneyRefs = collectMatches(screenSources, /\b(J-[0-9]+)\b/gu);
if (screenIds.size !== 47) fail(`Screen contract ID denominator is ${screenIds.size}; expected 47 proposal views plus the non-screen verification family`);
if (screenRegistryIds.size !== 47) fail(`Screen registry ID denominator is ${screenRegistryIds.size}; expected 47 proposal views`);
assertKnown(screenIds, screenRegistryIds, "Screen contract not present in screen registry");
assertKnown(screenComponentRefs, componentIds, "Screen component reference");
assertKnown(screenJourneyRefs, journeyIds, "Screen journey reference");
const screenCoreFields = ["schemaVersion", "productId", "screenId", "status", "channel", "purpose", "anatomy", "states", "actions", "actionBindingState", "channelDispositions", "validation", "recovery", "accessibility", "localization", "sourceRefs", "journeyRefs"];
const screenCoreComplete = screenSources.filter((source) => source.includes("schemaVersion: media.screen-contract.v1")).reduce((total, source) => total + assertBlocksHaveFields([source], screenCoreFields, "Screen"), 0);

const journeySources = journeyFiles.map((file) => read(join(journeyDir, file)));
const journeyViewRefs = collectMatches(journeySources, /^\s*(?:-\s*)?view: (media\.view\.[A-Za-z0-9._-]+)$/gmu);
const journeyActionRefs = collectMatches(journeySources, /^\s*action: (media\.action\.[A-Za-z0-9._-]+)$/gmu);
const journeyFileIds = collectMatches(journeySources, /^journeyId: (J-[0-9]+)$/gmu);
assertKnown(journeyViewRefs, screenIds, "Journey view reference");
assertKnown(journeyActionRefs, actionIds, "Journey action reference");
assertKnown(journeyFileIds, journeyIds, "Journey contract ID");
const journeyCoreFields = ["schemaVersion", "productId", "journeyId", "title", "status", "outcomes", "actors", "preconditions", "steps", "terminalSuccess", "criticalNonhappyPaths", "recovery", "contextPreserved", "channelEquivalents"];
const journeyCoreComplete = journeySources.reduce((total, source) => total + assertBlocksHaveFields([source], journeyCoreFields, "Journey"), 0);
const journeyAccessibilityComplete = journeySources.filter((source) => /^\s*accessibility(?:Ref|IntentRef):/mu.test(source)).length;
if (journeyAccessibilityComplete !== journeySources.length) fail(`${journeySources.length - journeyAccessibilityComplete} journey contracts lack an accessibility reference or intent`);
const actionCapabilityIds = new Set();
for (const match of actionSource.matchAll(/capabilityRefs:\s*\[([^\]]*)\]/gu)) {
  for (const capability of match[1].matchAll(/\b(media\.[A-Za-z0-9._-]+)\b/gu)) actionCapabilityIds.add(capability[1]);
}
assertKnown(actionCapabilityIds, capabilityIds, "Action capability reference");
const actionSection = actionSource.split(/^actions:\s*$/mu)[1] ?? "";
const actionCapabilityGaps = topLevelBlocks(actionSection).filter((block) => {
  const capabilityRefs = block.match(/^[ \t]*capabilityRefs:\s*\[([^\]]*)\]/mu);
  return !capabilityRefs || capabilityRefs[1].trim().length === 0;
}).length;
note(componentCapabilityGaps + " component family gap(s) and " + actionCapabilityGaps + " proposal action(s) still need explicit capability reachability review");
const apiSource = read(join(productRoot, "phase-2-product-experience/api-experience-mapping.yaml"));
const cliSource = read(join(productRoot, "phase-2-product-experience/cli-command-registry.yaml"));
const componentActionRefs = collectMatches([componentSource], /\b(media\.action\.[A-Za-z0-9._-]+)\b/gu);
const apiActionRefs = collectMatches([apiSource], /^\s*-?\s*actionRef: (media\.action\.[A-Za-z0-9._-]+)$/gmu);
const cliActionRefs = collectMatches([cliSource], /^\s*actionRef: (media\.action\.[A-Za-z0-9._-]+)$/gmu);
assertKnown(componentActionRefs, actionIds, "Component action reference");
assertKnown(apiActionRefs, actionIds, "API action reference");
assertKnown(cliActionRefs, actionIds, "CLI action reference");
note(`${componentIds.size} Phase 1 components (${componentCoreComplete} required shapes), ${screenIds.size} Phase 2 screen contracts (${screenCoreComplete} required shapes), ${journeyViewRefs.size} journey view references, and ${journeyActionRefs.size} journey action references resolve (${journeyCoreComplete} journey shapes)`);

if (journeyIds.size !== 30) fail(`Journey registry exposes ${journeyIds.size} journeys; expected the authored denominator of 30`);
if (journeyFiles.length !== 28) fail(`Journey contract directory contains ${journeyFiles.length} files; expected the required denominator of 28`);
note(`${journeyIds.size} journeys are indexed and ${journeyFiles.length} required journey proposals have source files`);

const mainSource = read(join(root, "apps/media-experience-explorer/src/main.ts"));
const specificationSource = read(join(root, "apps/media-experience-explorer/src/specification.ts"));
if (!mainSource.includes("data-open-product-screen") || !mainSource.includes("disabled aria-describedby=\"proposal-action-note-")) {
  fail("Product proposal projection does not visibly disable unconnected proposal actions");
}
if (!mainSource.includes("renderTraceMetadata") || !specificationSource.includes("semanticFingerprint") || !specificationSource.includes("currentness")) {
  fail("Explorer source-link metadata fields are not rendered in the source-linked projection");
}
if (!mainSource.includes("renderProductContractProjection") || !mainSource.includes("sourceManifestContent") || !mainSource.includes("renderTraceMetadata(artifact, sourceManifest)")) {
  fail("Product proposal routes do not expose source-linked trace metadata");
}
if (!specificationSource.includes("PRODUCT_TRUTH_AUTHORITY")) {
  fail("Explorer authority-class metadata is not defined for the source-linked projection");
}

if (failures.length) {
  console.error(`Media Product Definition local check failed (${failures.length} failures)`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Media Product Definition local check passed");
}
for (const observation of observations) console.log(`  ${observation}`);
