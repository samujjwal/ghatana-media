#!/usr/bin/env node
/**
 * Purpose: validate the Media Product Definition source tree and its local
 * Explorer projection without becoming a second semantic authority.
 * Consumers: local development, focused verification, and the closure matrix.
 * Non-goals: phase acceptance, lifecycle Evidence Generator receipts, runtime
 * qualification, owner review, or currentness generation.
 * Change policy: derive checks from canonical paths and registries; never
 * write .evidence artifacts or promote observations to acceptance.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

const rootArgument = process.argv.find((argument) => argument.startsWith("--root="))?.slice("--root=".length);
const root = rootArgument ? resolve(rootArgument) : resolve(new URL("..", import.meta.url).pathname);
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
  ".product-experience/pdp-0-product-truth/applications-channels.yaml",
  ".product-experience/pdp-2-design-interface-system/DESIGN-LANGUAGE.md",
  ".product-experience/pdp-3-product-experience/COMPLETE-PRODUCT-EXPERIENCE.md",
  ".product-experience/explorer/EXPERIENCE-EXPLORER.md",
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
  fail("currentness.yaml exists even though owner-approved lifecycle currentness generation is unresolved");
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
  const phases = new Set(["PDP-0", "PDP-1", "PDP-2", "PDP-3", "EXPLORER", "CROSS_PHASE", "IMPLEMENTATION", "EVIDENCE", "REFERENCE", "OBSOLETE"]);
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

const screenDir = join(productRoot, "pdp-3-product-experience/screen-contracts");
const screenFiles = readdirSync(screenDir).filter((file) => file.endsWith(".yaml"));
const indexedScreenPaths = new Set(artifacts.filter((artifact) => artifact.path.includes("/screen-contracts/")).map((artifact) => artifact.path));
for (const file of screenFiles) {
  const path = `.product-experience/pdp-3-product-experience/screen-contracts/${file}`;
  if (!indexedScreenPaths.has(path)) fail(`Screen contract is not exposed in Explorer index: ${path}`);
}
note(`${screenFiles.length} screen-contract directory records are present (47 canonical screen contracts plus one job-family specialization); ${indexedScreenPaths.size} are indexed for read-only projection`);

const actionSource = read(join(productRoot, "pdp-3-product-experience/action-registry.yaml"));
const actionIdList = idsFrom(actionSource, /^\s*- id: (media\.action\.[A-Za-z0-9._-]+)$/gmu);
unique(actionIdList, "PDP-3 action ID");
const actionIds = new Set(actionIdList);
if (actionIds.size === 0) fail("PDP-3 action registry produced no action IDs");
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

const capabilitySource = read(join(productRoot, "pdp-0-product-truth/capabilities.yaml"));
const familySection = capabilitySource.split(/^families:\s*$/mu)[1]?.split(/^capabilities:\s*$/mu)[0] ?? "";
const capabilitySection = capabilitySource.split(/^capabilities:\s*$/mu)[1] ?? "";
const capabilityIds = new Set(idsFrom(capabilitySection, /^\s*- id: (media\.[A-Za-z0-9._-]+)$/gmu));
const familyIds = new Set(idsFrom(familySection, /^\s*- id: (media\.[A-Za-z0-9._-]+)$/gmu));
const capabilityFamilyRefs = collectMatches([capabilitySection], /^\s*familyId: (media\.[A-Za-z0-9._-]+)$/gmu);
const requirementSource = read(join(productRoot, "pdp-0-product-truth/requirements.yaml"));
const goalsSource = read(join(productRoot, "pdp-0-product-truth/goals-jtbd.yaml"));
const journeyCatalogSource = read(join(productRoot, "pdp-0-product-truth/journey-catalog.yaml"));
const coverageSource = read(join(productRoot, "vision-requirements-coverage.yaml"));
const requirementIds = new Set(idsFrom(requirementSource, /^- id: (MEDIA-REQ-[A-Z0-9-]+)[ \t]*$/gmu));
const capabilityRequirementRefs = collectMatches([capabilitySection], /^\s*- (MEDIA-REQ-[A-Z0-9-]+)$/gmu);
if (capabilityIds.size !== 462) fail(`PDP-0 capability leaf denominator is ${capabilityIds.size}; expected 462`);
unique([...capabilityIds], "PDP-0 capability ID");
unique([...familyIds], "PDP-0 capability family ID");
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
note(capabilityIds.size + " PDP-0 capability leaves have " + capabilityJourneyGaps + " unresolved explicit leaf-level journey references; inherited family intent/outcome coverage remains pending owner review");

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
    !coverageSource.includes("explorerArtifacts: {rule: generated-count-equals-current-source-manifest-records-plus-the-manifest-projection}") ||
    !coverageSource.includes("masterPromptCoverage:") ||
    !coverageSource.includes("id: MP-73-79")) {
  fail("Vision/requirements coverage ledger does not record the current denominators and full master-prompt section coverage");
}
for (const [phase, localProjection, source] of [
  ["PDP-0", "PDP-0-product-truth", "pdp-0-product-truth/"],
  ["PDP-1", "PDP-1-domain-data", "pdp-1-domain-data/"],
  ["PDP-2", "PDP-2-design-interface-system", "pdp-2-design-interface-system/"],
  ["PDP-3", "PDP-3-product-experience", "pdp-3-product-experience/"],
  ["Experience-Explorer-projection", "EXPLORER", "explorer/"],
]) {
  const escapedPhase = phase.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const block = coverageSource.match(new RegExp(`- masterPromptPhase: ${escapedPhase}\\n([\\s\\S]*?)(?=\\n  - masterPromptPhase:|\\nmasterPlanCoverage:|$)`, "u"))?.[1] ?? "";
  if (!block.includes(`localProjection: ${localProjection}`) || !block.includes(source)) {
    fail(`Four-phase crosswalk misbinds ${phase}; expected ${localProjection} over ${source}`);
  }
}
if (/localProjection: (?:P0|P1|P2|P3)(?:\s|$)/mu.test(coverageSource)) {
  fail("Vision/requirements crosswalk contains legacy P0/P1/P2/P3 projections");
}
note(outcomeIds.size + " PDP-0 vision outcomes have journey/supporting-view coverage; " + requirementOutcomeTraceCount + " requirement groups have outcome traces");
note(`${capabilityIds.size} PDP-0 capability leaves resolve to ${familyIds.size} families and ${requirementIds.size} requirement IDs. Historical inline-field observation: ${capabilityCoreComplete} legacy inline shapes and ${operationSpecificParameterProposals} inline parameter proposals; this parser does not evaluate the additive owner capability/operation contracts or their reviewed bounds`);

const componentSource = read(join(productRoot, "pdp-2-design-interface-system/component-contracts.yaml"));
const componentSection = componentSource.split(/^components:\s*$/mu)[1]?.split(/^masterPlanCoverage:\s*$/mu)[0] ?? "";
const componentIdList = idsFrom(componentSection, /^\s*- id: (media\.component\.[A-Za-z0-9._-]+)$/gmu);
unique(componentIdList, "PDP-2 component ID");
const componentIds = new Set(componentIdList);
const componentCoreFields = ["purpose", "anatomy", "variants", "states", "actions", "keyboard", "accessibility", "localization", "prohibitedUse", "semanticRole", "capabilityRefs", "actionBindingState", "sourceRef"];
const componentCoreComplete = assertBlocksHaveFields(topLevelBlocks(componentSection), componentCoreFields, "Component");
const componentCapabilityGaps = topLevelBlocks(componentSection).filter((block) => /capabilityRefs:\s*\[\s*\]/u.test(block)).length;
const screenSources = screenFiles.map((file) => read(join(screenDir, file)));
const screenIds = new Set(collectMatches(screenSources, /^screenId: (media\.view\.[A-Za-z0-9._-]+)$/gmu));
const journeyDir = join(productRoot, "pdp-3-product-experience/journey-contracts");
const journeyFiles = readdirSync(journeyDir).filter((file) => file.endsWith(".yaml"));
const journeyRegistry = read(join(productRoot, "pdp-3-product-experience/journey-registry.yaml"));
const journeyIds = new Set(idsFrom(journeyRegistry, /^\s*- id: (J-[0-9]+)$/gmu));
unique(idsFrom(journeyRegistry, /^\s*- id: (J-[0-9]+)$/gmu), "PDP-3 journey ID");
const screenRegistrySource = read(join(productRoot, "pdp-3-product-experience/screen-registry.yaml"));
const screenRegistryIds = new Set(idsFrom(screenRegistrySource, /^\s*- id: (media\.view\.[A-Za-z0-9._-]+)$/gmu));
unique(idsFrom(screenRegistrySource, /^\s*- id: (media\.view\.[A-Za-z0-9._-]+)$/gmu), "PDP-3 screen ID");
const screenComponentRefs = collectMatches(screenSources, /\b(media\.component\.[A-Za-z0-9._-]+)/gu);
const screenJourneyRefs = collectMatches(screenSources, /\b(J-[0-9]+)\b/gu);
if (screenIds.size !== 47) fail(`Screen contract ID denominator is ${screenIds.size}; expected 47 proposal views plus the non-screen verification family`);
if (screenRegistryIds.size !== 47) fail(`Screen registry ID denominator is ${screenRegistryIds.size}; expected 47 proposal views`);
assertKnown(screenIds, screenRegistryIds, "Screen contract not present in screen registry");
assertKnown(screenComponentRefs, componentIds, "Screen component reference");
assertKnown(screenJourneyRefs, journeyIds, "Screen journey reference");
// v2 is the current structural contract. Empty/null values are permitted only
// when the matching binding-status field explains the unresolved authority.
const screenRequiredFields = ["schemaVersion", "contractSchemaRef", "surfaceId", "templateId", "layoutIds", "componentIds", "patternIds", "tokenDependencies", "domainObjectRefs", "operationRefs", "requirementRefs", "stateRefs", "entry", "exit", "actionConsequences", "responsiveBehavior", "fixtures", "verification", "fieldBindingStatus"];
// The v2 schema requires a status and reason but does not declare an enum.
// Pin the finite proposal-only vocabulary currently authored by the 47 screen
// contracts; adding a new value requires explicit validator review. In
// particular, no accepted/complete status is authorized by this source tree.
const allowedScreenBindingStatuses = new Set([
  "candidate-binding-pending-owner-review",
  "action-capability-crosswalk-recorded; semantic-review-pending",
  "candidate-template-link-owner-review-pending",
  "candidate-layout-link-owner-review-pending",
  "media-owner-composition-link-approved; screen-admission-pending",
  "candidate-pending-acceptance",
  "candidate-pending-owner-binding",
  "candidate; owner-binding-pending",
  "catalog-id-copied-exactly; template-binding-acceptance-pending",
  "copied-from-proposal-componentRefs; Shared-binding-pending",
  "copied-from-proposal-patternRefs; PDP2-acceptance-pending",
  "missing",
  "missing-no-existing-fixtureRefs",
  "missing; no-existing-fixtureRefs-declared",
  "no-PDP1-state-references-declared",
  "PDP-1-identities-defined; runtime-admission-pending",
  "PDP-1-exact-slices-defined; runtime-admission-pending",
  "PDP-0-states-defined-for-observation; lifecycle-transition-acceptance-pending",
  "owner-defined-action-semantics; runtime-admission-pending",
  "no-canonical-entry-contract-declared",
  "no-canonical-exit-contract-declared",
  "no-canonical-references-declared",
  "none-registered",
  "not-run",
  "not-run; no-evidence-refs",
  "pending",
  "pending-local-labels-not-canonical",
  "pending-no-canonical-layout-ids",
  "pending-owner-operation-and-effect-binding",
  "no-direct-action-capability-requirement-crosswalk",
  "pending; owner-operation-and-effect-binding-required",
  "proposal-copied-from-existing-componentRefs; Shared-binding-pending",
  "proposal-copied-from-existing-patternRefs; PDP-2-acceptance-pending",
  "proposal-copy-PDP-2-acceptance-pending",
  "proposal-copy-shared-binding-pending",
  "proposal-copy; PDP-2-acceptance-pending",
  "proposal-copy; Shared-binding-pending",
  "proposal-only; unverified",
  "proposal-unverified",
  "proposal-unverified; PDP-2-acceptance-pending",
  "proposal-unverified; central-rule-reference-only",
  "source-proposal; behavior-unverified",
  "unresolved-no-PDP-1-canonical-reference; local-UI-states-not-promoted",
  "unresolved-no-canonical-layout-ids-registered",
  "unresolved-no-catalog-match",
  "unresolved-no-direct-canonical-reference",
  "unresolved-no-exact-catalogued-reference",
  "unresolved-no-existing-componentRefs",
  "unresolved-pending-owner-binding",
  "unresolved; local-UI-state-labels-not-promoted",
  "unresolved; no existing catalog template ID matches the declared templateRef",
  "unresolved; no-canonical-layout-ids-registered",
  "unresolved; no-canonical-reference-declared",
  "unresolved; no-exact-template-catalog-match",
  "unresolved; owner-effect-binding-pending",
]);
let screenCoreComplete = 0;
for (let index = 0; index < screenSources.length; index += 1) {
  const source = screenSources[index];
  const path = `.product-experience/pdp-3-product-experience/screen-contracts/${screenFiles[index]}`;
  if (screenFiles[index] === "artifact-verification-job-family.yaml") continue;
  const missing = screenRequiredFields.filter((field) => !new RegExp(`^${field}:`, "mu").test(source));
  if (missing.length) fail(`Screen contract ${path} is missing required v2 shape: ${missing.join(", ")}`);
  else if (!source.includes("schemaVersion: media.screen-contract.v2")) fail(`Screen contract ${path} does not declare the current v2 contract schema`);
  else {
    screenCoreComplete += 1;
    const schemaRef = source.match(/^contractSchemaRef:\s*([^\s#]+)/mu)?.[1];
    if (!schemaRef || !existsSync(join(root, schemaRef))) fail(`Screen contract ${path} has an unresolved contractSchemaRef`);
    const bindingBlock = source.match(/^fieldBindingStatus:\s*\n((?:[ \t]+.*\n?)*)/mu)?.[1] ?? "";
    for (const field of screenRequiredFields.filter((candidate) => !["fieldBindingStatus", "schemaVersion", "contractSchemaRef"].includes(candidate))) {
      const status = bindingBlock.match(new RegExp(`^\\s+${field}:\\s*(.*?)\\s*$`, "mu"))?.[1];
      if (!status) {
        fail(`Screen contract ${path} lacks a fieldBindingStatus entry for ${field}`);
      } else if (/\b(?:accepted|complete|completed)\b/iu.test(status)) {
        fail(`Screen contract ${path} has an unapproved accepted/complete fieldBindingStatus for ${field}: ${status}`);
      } else if (!allowedScreenBindingStatuses.has(status)) {
        fail(`Screen contract ${path} has an unknown fieldBindingStatus for ${field}: ${status}`);
      }
    }
  }
}
if (screenCoreComplete !== 47) fail(`PDP-3 screen structural shape count is ${screenCoreComplete}; expected 47 v2 screen contracts (job-family remains a separate specialization)`);

// The only accepted screen -> requirement crosswalk currently available is
// the exact intersection of a screen's declared action capabilities and PDP-0
// requirement capability IDs. Keep operation/effect, state and oracle links
// unresolved until their owning authorities provide them.
const requirementCapabilitiesById = new Map();
for (const block of requirementBlocks) {
  const id = block.match(/^- id: (MEDIA-REQ-[A-Z0-9-]+)$/mu)?.[1];
  if (!id) continue;
  const section = block.match(/^\s*capabilityIds:\s*\n((?:\s+- [^\n]+\n?)*)/mu)?.[1] ?? "";
  for (const capability of section.matchAll(/\b(media\.[A-Za-z0-9._-]+)\b/gu)) {
    const ids = requirementCapabilitiesById.get(capability[1]) ?? new Set();
    ids.add(id);
    requirementCapabilitiesById.set(capability[1], ids);
  }
}
const registeredActionCapabilities = new Map();
for (const block of topLevelBlocks(actionSource.split(/^actions:\s*$/mu)[1] ?? "")) {
  const id = block.match(/^- id: (media\.action\.[A-Za-z0-9._-]+)$/mu)?.[1];
  if (!id) continue;
  const section = block.match(/^\s*capabilityRefs:\s*\[([^\]]*)\]/mu)?.[1] ?? "";
  registeredActionCapabilities.set(id, [...section.matchAll(/\b(media\.[A-Za-z0-9._-]+)\b/gu)].map((match) => match[1]));
}
const parseInlineRefs = (source, field, label) => {
  const section = source.match(new RegExp(`^\\s*${field}:\\s*\\[([^\\]]*)\\]`, "mu"))?.[1];
  if (section === undefined) {
    if (!new RegExp(`^\\s*${field}:\\s*\\[`, "mu").test(source)) fail(`${label} lacks an inline ${field} binding`);
    return [];
  }
  return [...section.matchAll(/[A-Za-z][A-Za-z0-9._:/-]*/gu)].map((match) => match[0]);
};
let screensWithRequirementCrosswalk = 0;
let directActionCapabilityBindings = 0;
for (const source of screenSources) {
  const screenId = source.match(/^screenId: (media\.view\.[A-Za-z0-9._-]+)$/mu)?.[1];
  if (!screenId || !screenRegistryIds.has(screenId)) continue;
  const consequenceSection = source.split(/^actionConsequences:\s*$/mu)[1]?.split(/^actionConsequencesBindingStatus:/mu)[0] ?? "";
  const consequenceBlocks = consequenceSection.split(/(?=^  - actionId: )/mu).filter((block) => /^  - actionId: /mu.test(block));
  const expectedRequirements = new Set();
  for (const block of consequenceBlocks) {
    const actionId = block.match(/^  - actionId: (media\.action\.[A-Za-z0-9._-]+)$/mu)?.[1];
    const actionCapabilities = registeredActionCapabilities.get(actionId) ?? [];
    const declaredCapabilities = parseInlineRefs(block, "capabilityRefs", `${screenId} action ${actionId}`);
    if (JSON.stringify(declaredCapabilities) !== JSON.stringify(actionCapabilities)) {
      fail(`${screenId} action ${actionId} capabilityRefs do not match the PDP-3 Action Registry`);
    }
    const actionRequirements = new Set(actionCapabilities.flatMap((capability) => [...(requirementCapabilitiesById.get(capability) ?? [])]));
    for (const requirement of actionRequirements) expectedRequirements.add(requirement);
    const declaredActionRequirements = parseInlineRefs(block, "requirementRefs", `${screenId} action ${actionId}`);
    const expectedActionRequirements = [...actionRequirements].sort();
    if (JSON.stringify(declaredActionRequirements) !== JSON.stringify(expectedActionRequirements)) {
      fail(`${screenId} action ${actionId} requirementRefs do not match the exact capability crosswalk`);
    }
    if (expectedActionRequirements.length) directActionCapabilityBindings += 1;
  }
  const declaredRequirements = parseInlineRefs(source, "requirementRefs", screenId);
  const expected = [...expectedRequirements].sort();
  if (JSON.stringify(declaredRequirements) !== JSON.stringify(expected)) {
    fail(`${screenId} requirementRefs do not match the union of registered action-capability requirement links`);
  }
  if (expected.length) screensWithRequirementCrosswalk += 1;
}
note(`${screensWithRequirementCrosswalk} of 47 screen views have direct action-capability requirement crosswalks; ${directActionCapabilityBindings} screen action bindings resolve through registered capability IDs; unresolved operation/effect, domain-state, and behavioral-oracle links remain proposal-only`);

const journeySources = journeyFiles.map((file) => read(join(journeyDir, file)));
let journeyStepsWithRequirementCrosswalk = 0;
let journeyStepsWithAction = 0;
for (const source of journeySources) {
  const stepBlocks = source.split(/(?=^\s*- view: )/mu).filter((block) => /^\s*- view: /mu.test(block));
  for (const block of stepBlocks) {
    const stepStart = block.match(/^(\s*)- view:/mu)?.[1] ?? "";
    const propertyIndent = `${stepStart}  `;
    const actionId = block.match(new RegExp(`^${propertyIndent}action: (media\\.action\\.[A-Za-z0-9._-]+)$`, "mu"))?.[1];
    if (!actionId) continue;
    journeyStepsWithAction += 1;
    const actionCapabilities = registeredActionCapabilities.get(actionId) ?? [];
    const declaredCapabilities = parseInlineRefs(block, "capabilityRefs", `journey step ${actionId}`);
    if (JSON.stringify(declaredCapabilities) !== JSON.stringify(actionCapabilities)) {
      fail(`Journey step ${actionId} capabilityRefs do not match the PDP-3 Action Registry`);
    }
    const expectedRequirements = [...new Set(actionCapabilities.flatMap((capability) => [...(requirementCapabilitiesById.get(capability) ?? [])]))].sort();
    const declaredRequirements = parseInlineRefs(block, "requirementRefs", `journey step ${actionId}`);
    if (JSON.stringify(declaredRequirements) !== JSON.stringify(expectedRequirements)) {
      fail(`Journey step ${actionId} requirementRefs do not match the exact capability crosswalk`);
    }
    if (expectedRequirements.length) journeyStepsWithRequirementCrosswalk += 1;
  }
}
note(`Historical inline action observation: ${journeyStepsWithRequirementCrosswalk} of ${journeyStepsWithAction} action-bearing journey steps map through direct Action Registry capability refs to PDP-0 requirements; current exact step role/binding observations are reported separately and semantic acceptance remains pending`);
const journeyViewRefs = collectMatches(journeySources, /^\s*(?:-\s*)?view: (media\.view\.[A-Za-z0-9._-]+)$/gmu);
const journeyActionRefs = collectMatches(journeySources, /^\s*action: (media\.action\.[A-Za-z0-9._-]+)$/gmu);
const journeyFileIds = collectMatches(journeySources, /^journeyId: (J-[0-9]+)$/gmu);
assertKnown(journeyViewRefs, screenIds, "Journey view reference");
assertKnown(journeyActionRefs, actionIds, "Journey action reference");
assertKnown(journeyFileIds, journeyIds, "Journey contract ID");
const journeyCoreFields = ["schemaVersion", "productId", "journeyId", "title", "status", "outcomes", "actors", "preconditions", "steps", "terminalSuccess", "criticalNonhappyPaths", "recovery", "contextPreserved", "channelEquivalents"];
const journeyCoreComplete = journeySources.reduce((total, source) => total + assertBlocksHaveFields([source], journeyCoreFields, "Journey"), 0);
if (journeyCoreComplete !== journeySources.length) fail(`Journey structural shape count is ${journeyCoreComplete}; expected all ${journeySources.length} contracts to expose required fields`);
for (let index = 0; index < journeySources.length; index += 1) {
  const source = journeySources[index];
  const path = `.product-experience/pdp-3-product-experience/journey-contracts/${journeyFiles[index]}`;
  if (!/^journeyId: J-[0-9]+$/mu.test(source)) fail(`Journey contract ${path} is missing a stable journeyId`);
  const stepBlocks = source.split(/(?=^\s*- (?:view|stepId): )/mu).slice(1);
  if (!stepBlocks.length) fail(`Journey contract ${path} has no journey steps`);
  for (const [stepIndex, block] of stepBlocks.entries()) {
    if (!/^\s*- (?:view|stepId):\s*\S/mu.test(block)) fail(`Journey step ${stepIndex + 1} in ${path} lacks a stable view or stepId reference`);
    const stepRequired = ["surfaceRefs", "objectRefs", "stateRefs", "canonicalOperationRef", "authorityRef", "transitionRef", "success", "failure", "degradedBehavior", "recovery", "postconditions", "requirementRefs", "verification"];
    const missing = stepRequired.filter((field) => !new RegExp(`^\\s*${field}:`, "mu").test(block));
    if (missing.length) fail(`Journey step ${stepIndex + 1} in ${path} is missing required shape: ${missing.join(", ")}`);
  }
}
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
const apiSource = read(join(productRoot, "pdp-3-product-experience/api-experience-mapping.yaml"));
const cliSource = read(join(productRoot, "pdp-3-product-experience/cli-command-registry.yaml"));
const componentActionRefs = collectMatches([componentSource], /\b(media\.action\.[A-Za-z0-9._-]+)\b/gu);
const apiActionRefs = collectMatches([apiSource], /^\s*-?\s*actionRef: (media\.action\.[A-Za-z0-9._-]+)$/gmu);
const cliActionRefs = collectMatches([cliSource], /^\s*actionRef: (media\.action\.[A-Za-z0-9._-]+)$/gmu);
assertKnown(componentActionRefs, actionIds, "Component action reference");
assertKnown(apiActionRefs, actionIds, "API action reference");
assertKnown(cliActionRefs, actionIds, "CLI action reference");
note(`${componentIds.size} PDP-2 components (${componentCoreComplete} required shapes), ${screenIds.size} PDP-3 screen contracts (${screenCoreComplete} required shapes), ${journeyViewRefs.size} journey view references, and ${journeyActionRefs.size} journey action references resolve (${journeyCoreComplete} journey shapes)`);

if (journeyIds.size !== 30) fail(`Journey registry exposes ${journeyIds.size} journeys; expected the authored denominator of 30`);
if (journeyFiles.length !== 30) fail(`Journey contract directory contains ${journeyFiles.length} files; expected 28 baseline contracts plus the explicit J-29/J-30 contracts`);
note(`${journeyIds.size} journeys are indexed and ${journeyFiles.length} journey contracts have source files (28 baseline plus J-29/J-30 extensions)`);

// Stable IDs and references are checked where the local authored registries
// provide an unambiguous shape. Semantic equivalence/acceptance remains owner
// authority and is deliberately not inferred from these structural links.
const operationSource = read(join(productRoot, "pdp-1-domain-data/operations.yaml"));
const operationIds = new Set(idsFrom(operationSource, /^\s*- id: (media\.operation(?:-slice)?\.[A-Za-z0-9._-]+)$/gmu));
unique([...operationIds], "PDP-1 operation ID");
const domainObjectSource = read(join(productRoot, "pdp-1-domain-data/domain-objects.yaml"));
const domainObjectIds = new Set(idsFrom(domainObjectSource, /^\s*- id: (media\.[A-Za-z0-9._-]+)$/gmu));
const stateSource = read(join(productRoot, "pdp-1-domain-data/states.yaml"));
const machineIds = new Set(idsFrom(stateSource, /^\s*- machineId: ([A-Za-z0-9._-]+)$/gmu));
const transitionSource = read(join(productRoot, "pdp-1-domain-data/transitions.yaml"));
const transitionRecords = transitionSource.split(/^transitionRecords:\s*$/mu)[1] ?? "";
const transitionBlocks = transitionRecords.split(/(?=^\s+- id: )/mu).filter((block) => /^\s+- id: /mu.test(block));
unique(transitionBlocks.map((block) => block.match(/^\s+- id: ([^\s]+)/mu)?.[1]).filter(Boolean), "PDP-1 transition ID");
for (const transition of transitionBlocks) {
  const id = transition.match(/^\s+- id: ([^\s]+)/mu)?.[1] ?? "unknown";
  const machine = transition.match(/^\s*sourceMachineId: ([^\s]+)/mu)?.[1];
  if (!machine || !machineIds.has(machine)) fail(`Transition ${id} has an unresolved state-machine reference`);
  const refs = transition.match(/^\s*operationRefs:\s*\[([^\]]*)\]/mu)?.[1] ?? "";
  for (const ref of refs.matchAll(/media\.operation\.[A-Za-z0-9._-]+/gu)) assertKnown(new Set([ref[0]]), operationIds, `Transition ${id} operation reference`);
}
for (const source of journeySources) {
  for (const ref of source.matchAll(/^\s*(?:canonicalOperationRef|operationRef):\s*(media\.operation(?:-slice)?\.[A-Za-z0-9._-]+)/gmu)) assertKnown(new Set([ref[1]]), operationIds, "Journey canonical operation reference");
  for (const ref of source.matchAll(/media\.operation-slice\.[A-Za-z0-9._-]+/gu)) assertKnown(new Set([ref[0]]), operationIds, "Journey required operation reference");
  for (const ref of source.matchAll(/^\s*objectRefs:\s*\n((?:\s+- [^\n]+\n?)*)/gmu)) {
    for (const id of ref[1].matchAll(/media\.[A-Za-z0-9._-]+/gu)) assertKnown(new Set([id[0]]), domainObjectIds, "Journey domain object reference");
  }
}
const requirementDomainRefs = collectMatches([requirementSource], /^\s*(?:domainObjectRefs|domainRefs):\s*\[([^\]]*)\]/gmu);
for (const ref of requirementDomainRefs) for (const id of ref.matchAll(/media\.[A-Za-z0-9._-]+/gu)) assertKnown(new Set([id[0]]), domainObjectIds, "Requirement domain reference");
const requirementCapabilityRefs = collectMatches([requirementSource], /^\s*capabilityIds:\s*\n((?:\s+- media\.[^\n]+\n?)*)/gmu);
for (const ref of requirementCapabilityRefs) for (const id of ref.matchAll(/media\.[A-Za-z0-9._-]+/gu)) assertKnown(new Set([id[0]]), capabilityIds, "Requirement capability/domain mapping");
const httpRegistry = read(join(productRoot, "pdp-3-product-experience/api/api-registry.yaml"));
const httpIds = idsFrom(httpRegistry, /^\s+- id: (media\.http\.[A-Za-z0-9._-]+)$/gmu);
unique(httpIds, "HTTP API ID");
for (const [index, block] of httpRegistry.split(/(?=^\s+- id: media\.http\.)/mu).filter((value) => /^\s+- id: media\.http\./mu.test(value)).entries()) {
  const id = httpIds[index];
  for (const field of ["contractFile", "method", "path", "operationId"]) if (!new RegExp(`^\\s+${field}:`, "mu").test(block)) fail(`HTTP API ${id} is missing required ${field} shape`);
  const contract = block.match(/^\s+contractFile:\s*([^\s#]+)/mu)?.[1];
  if (contract && !existsSync(join(productRoot, "pdp-3-product-experience/api", contract))) fail(`HTTP API ${id} has unresolved contractFile: ${contract}`);
}
const grpcRegistry = read(join(productRoot, "pdp-3-product-experience/grpc/service-registry.yaml"));
const grpcIds = idsFrom(grpcRegistry, /^\s+- id: (media\.grpc\.[A-Za-z0-9._-]+)$/gmu);
unique(grpcIds, "gRPC API ID");
for (const [index, block] of grpcRegistry.split(/(?=^\s+- id: media\.grpc\.)/mu).filter((value) => /^\s+- id: media\.grpc\./mu.test(value)).entries()) {
  const id = grpcIds[index];
  for (const field of ["contractFile", "service", "method", "source"]) if (!new RegExp(`^\\s+${field}:`, "mu").test(block)) fail(`gRPC API ${id} is missing required ${field} shape`);
  const contract = block.match(/^\s+contractFile:\s*([^\s#]+)/mu)?.[1];
  if (contract && !existsSync(join(productRoot, "pdp-3-product-experience/grpc", contract))) fail(`gRPC API ${id} has unresolved contractFile: ${contract}`);
}
const eventRegistry = read(join(productRoot, "pdp-3-product-experience/events/event-registry.yaml"));
const eventIds = idsFrom(eventRegistry, /^\s+- id: (media\.event\.[^\s]+)$/gmu);
unique(eventIds, "PDP-3 event ID");
for (const block of eventRegistry.split(/(?=^\s+- id: media\.event\.)/mu).filter((value) => /^\s+- id: media\.event\./mu.test(value))) {
  const id = block.match(/^\s+- id: ([^\s]+)/mu)?.[1];
  if (!/^\s+eventName:\s*\S/mu.test(block)) fail(`Event ${id} is missing required eventName shape`);
}
note(`Structural references checked against ${operationIds.size} PDP-1 operations, ${domainObjectIds.size} domain-object IDs, ${machineIds.size} state machines, ${httpIds.length} HTTP APIs, ${grpcIds.length} gRPC APIs, and ${eventIds.length} event IDs`);
note("Historical inline mappings and additive owner definitions are distinct; use the current PDP readiness source census for exact bindings. This local checker does not establish semantic or independent acceptance");
note("Tools Product Definition/Experience validation and lifecycle currentness outputs are not bound in this checkout; local structural checks do not establish semantic acceptance or currentness");

const mainSource = read(join(root, "apps/media-experience-explorer/src/main.ts"));
const specificationSource = read(join(root, "apps/media-experience-explorer/src/specification.ts"));
if (!mainSource.includes("renderTraceMetadata") || !specificationSource.includes("semanticFingerprint") || !specificationSource.includes("currentness")) {
  fail("Explorer source-link metadata fields are not rendered in the source-linked projection");
}
if (!mainSource.includes('if (location.hash.startsWith("#product/view/")) return "specification"')
    || !mainSource.includes("Read-only view contract preview")
    || !mainSource.includes("Its actions are not connected to product behavior")
    || !mainSource.includes("renderScreenContractPreview(activeArtifact, sourceContent ?? \"\")")
    || mainSource.includes("renderProductContractProjection")) {
  fail("Legacy screen-contract URLs must remain read-only Specification previews and must not mount Product behavior");
}
if (!mainSource.includes("sourceManifestContent") || !mainSource.includes("renderTraceMetadata(activeArtifact, sourceManifestContent)")) {
  fail("Specification source records do not expose source-linked trace metadata");
}
const explorerIndex = JSON.parse(read(join(root, "apps/media-experience-explorer/specification-artifacts.json")));
if (!explorerIndex.length || explorerIndex.some((artifact) => !artifact.artifactId || !artifact.authorityClass)) {
  fail("Explorer index is missing canonical artifact identity or manifest authority-class metadata");
}
if (!specificationSource.includes('manifestScalar(record, "authorityClass")')) {
  fail("Explorer source-linked projection does not read authority class from manifest metadata");
}

if (failures.length) {
  console.error(`Media Product Definition local check failed (${failures.length} failures)`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Media Product Definition local check passed");
}
for (const observation of observations) console.log(`  ${observation}`);
