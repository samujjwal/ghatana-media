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
import { createRequire } from "node:module";

const rootArgument = process.argv.find((argument) => argument.startsWith("--root="))?.slice("--root=".length);
const root = rootArgument ? resolve(rootArgument) : resolve(new URL("..", import.meta.url).pathname);
const productRoot = join(root, ".product-experience");
const require = createRequire(import.meta.url);
const { parse: parseYaml } = require("yaml");
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

// Read scalar values from a deliberately narrow YAML mapping shape. This is
// not a general YAML parser: callers first select a known mapping and this
// helper implements YAML scalar folding/quoting for its direct scalar fields.
// Keeping the decoded value exact lets the finite status vocabulary remain
// fail-closed while accepting the multiline YAML spellings used by contracts.
function decodeYamlScalar(lines, startIndex, keyIndent, indicator) {
  const style = indicator[0];
  const header = indicator[1].trim();
  const contentLines = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && line.match(/^\s*/u)[0].length <= keyIndent) break;
    contentLines.push(line);
  }
  const nonBlankIndent = contentLines.filter((line) => line.trim()).reduce((minimum, line) =>
    Math.min(minimum, line.match(/^\s*/u)[0].length), Infinity);
  const content = contentLines.map((line) => line.trim() ? line.slice(nonBlankIndent) : "");

  if (style === ">" || style === "|") {
    const chomping = header.slice(1).includes("-") ? "strip" : header.slice(1).includes("+") ? "keep" : "clip";
    const folded = style === ">"
      ? content.reduce((result, line, index) => {
        if (index === 0) return line;
        const previous = content[index - 1];
        return result + (line && previous ? " " : "\n") + line;
      }, "")
      : content.join("\n");
    return chomping === "strip" ? folded : chomping === "keep" ? `${folded}${"\n".repeat(contentLines.filter((line) => !line.trim()).length + 1)}` : `${folded}\n`;
  }

  const quoted = style === "'" || style === '"';
  if (quoted) {
    let value = header;
    for (const line of content) {
      if (style === "'" && value.endsWith("'") && !value.endsWith("''")) break;
      if (style === '"' && /(?<!\\)"\s*$/u.test(value)) break;
      value += `${value.endsWith("\\") ? "" : " "}${line.trim()}`;
    }
    if (style === "'") {
      if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/''/gu, "'");
      return value;
    }
    try { return JSON.parse(value); }
    catch { return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value; }
  }

  const plainLines = [header, ...content].filter((line) => line.trim());
  return plainLines.join(" ").replace(/\s+#.*$/u, "").trim();
}

function directYamlMappingScalars(source, parentKey) {
  const lines = source.split(/\r?\n/u);
  const parentIndex = lines.findIndex((line) => new RegExp(`^${parentKey}:\\s*$`, "u").test(line));
  if (parentIndex < 0) return new Map();
  const result = new Map();
  for (let index = parentIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && line.match(/^\s*/u)[0].length === 0) break;
    const match = line.match(/^(\s+)([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]+(.*)|[ \t]*)$/u);
    if (!match || match[1].length !== 2) continue;
    const scalar = match[3] ?? "";
    result.set(match[2], decodeYamlScalar(lines, index, match[1].length, [scalar[0], scalar]));
  }
  return result;
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

function resolveStableAnchor(source, anchor) {
  const prefix = ".product-experience/pdp-0-product-truth/campaign-extensions.yaml#";
  if (typeof anchor !== "string" || !anchor.startsWith(prefix)) return undefined;
  let value = source;
  for (const segment of anchor.slice(prefix.length).split("/").filter(Boolean)) {
    if (segment.startsWith("@id=")) {
      if (!Array.isArray(value)) return undefined;
      value = value.find((record) => record?.id === segment.slice(4));
    } else {
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      value = value[segment];
    }
    if (value === undefined || value === null) return undefined;
  }
  return value;
}

const capabilitySource = read(join(productRoot, "pdp-0-product-truth/capabilities.yaml"));
const parsedCapabilityDefinitions = parseYaml(capabilitySource);
const familySection = capabilitySource.split(/^families:\s*$/mu)[1]?.split(/^capabilities:\s*$/mu)[0] ?? "";
const capabilitySection = capabilitySource.split(/^capabilities:\s*$/mu)[1] ?? "";
const capabilityIds = new Set(idsFrom(capabilitySection, /^\s*- id: (media\.[A-Za-z0-9._-]+)$/gmu));
const familyIds = new Set(idsFrom(familySection, /^\s*- id: (media\.[A-Za-z0-9._-]+)$/gmu));
const capabilityFamilyRefs = collectMatches([capabilitySection], /^\s*familyId: (media\.[A-Za-z0-9._-]+)$/gmu);
const requirementSource = read(join(productRoot, "pdp-0-product-truth/requirements.yaml"));
const goalsSource = read(join(productRoot, "pdp-0-product-truth/goals-jtbd.yaml"));
const leafReviewSource = read(join(productRoot, "pdp-0-product-truth/capability-leaf-review.yaml"));
const campaignExtensionPath = join(productRoot, "pdp-0-product-truth/campaign-extensions.yaml");
const campaignExtensionSource = read(campaignExtensionPath);
const journeyCatalogSource = read(join(productRoot, "pdp-0-product-truth/journey-catalog.yaml"));
const coverageSource = read(join(productRoot, "vision-requirements-coverage.yaml"));
const requirementIds = new Set(idsFrom(requirementSource, /^- id: (MEDIA-REQ-[A-Z0-9-]+)[ \t]*$/gmu));
const capabilityRequirementRefs = collectMatches([capabilitySection], /^\s*- (MEDIA-REQ-[A-Z0-9-]+)$/gmu);
let parsedLeafReview;
try { parsedLeafReview = parseYaml(leafReviewSource); }
catch (error) { fail(`PDP-0 capability leaf review is not valid YAML: ${error.message}`); parsedLeafReview = {}; }
if (capabilityIds.size !== 469) fail(`PDP-0 current capability definition population is ${capabilityIds.size}; expected 462 preserved historical leaves plus 7 explicit definition extensions`);
if (familyIds.size !== 38) fail(`PDP-0 historical capability family denominator is ${familyIds.size}; expected 38`);
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
if (requirementIds.size !== 38) fail("Historical requirement-family denominator is " + requirementIds.size + "; expected 38");
const intentIds = new Set(idsFrom(goalsSource, /^\s*- id: (media\.intent\.[A-Za-z0-9._-]+)$/gmu));
const ownerAdjudicationRows = parsedLeafReview.ownerCapabilityLeafAdjudication?.records ?? [];
const ownerAdjudicationIds = new Set(ownerAdjudicationRows.map(({ capabilityRef }) => capabilityRef).filter(Boolean));
if (intentIds.size !== 19) fail(`Historical intent denominator is ${intentIds.size}; expected 19`);
if (ownerAdjudicationIds.size !== 462) fail(`Owner adjudication denominator is ${ownerAdjudicationIds.size}; expected 462`);
for (const id of ownerAdjudicationIds) {
  if (!capabilityIds.has(id)) fail(`Historical owner-adjudicated capability is missing from the current definition source: ${id}`);
}
let campaignExtensions;
try { campaignExtensions = parseYaml(campaignExtensionSource); }
catch (error) { fail(`PDP-0 campaign extension is not valid YAML: ${error.message}`); campaignExtensions = {}; }
const definitionPopulation = campaignExtensions.currentDefinitionPopulation ?? {};
const extensionRows = definitionPopulation.records ?? [];
const extensionIds = new Set(extensionRows.map(({ capabilityId }) => capabilityId));
const unadjudicatedCurrentIds = new Set([...capabilityIds].filter((id) => !ownerAdjudicationIds.has(id)));
if (definitionPopulation.historicalCapabilityLeavesPreserved !== 462
    || definitionPopulation.currentCapabilityDefinitions !== 469
    || definitionPopulation.definitionExtensionCapabilityLeaves !== 7
    || definitionPopulation.ownerAdjudications !== 462
    || definitionPopulation.ownerApproval !== "NOT_CLAIMED"
    || definitionPopulation.independentAcceptance !== "NOT_CLAIMED") {
  fail("PDP-0 definition extension census must preserve 462 historical owner-adjudicated leaves and explicitly account for seven delegated source extensions");
}
const expectedExtensionIds = [
  "media.generate.video.preset.manage",
  "media.generate.video.shot-condition",
  "media.job.schedule.manage",
  "media.master.audio.creative-effect.apply",
  "media.project.scene.patch-merge",
  "media.quality.audio.content-similarity.assess",
  "media.recipe.specification.compile",
].sort();
if (extensionRows.length !== 7 || extensionIds.size !== 7
    || [...extensionIds].sort().join(",") !== expectedExtensionIds.join(",")
    || [...extensionIds].some((id) => !unadjudicatedCurrentIds.has(id))
    || [...unadjudicatedCurrentIds].some((id) => !extensionIds.has(id))) {
  fail("Current capability definitions must equal the 462 preserved owner-adjudicated leaves plus the seven explicitly recorded definition extensions");
}
for (const row of extensionRows) {
  if (row.ownerApproval !== "NOT_CLAIMED" || row.independentAcceptance !== "NOT_CLAIMED") {
    fail(`Capability definition extension ${row.capabilityId} must not claim owner or independent acceptance`);
  }
}
let extensionApplicabilitySource;
let parsedApplicationsChannels;
try {
  parsedApplicationsChannels = parseYaml(read(join(productRoot, "pdp-0-product-truth/applications-channels.yaml")));
  extensionApplicabilitySource = parsedApplicationsChannels.coordinatorDefinitionExtensionApplicability;
}
catch (error) { fail(`PDP-0 definition extension applicability is not valid YAML: ${error.message}`); extensionApplicabilitySource = {}; }
const extensionApplicabilityRows = extensionApplicabilitySource.records ?? [];
const extensionApplicabilityIds = new Set(extensionApplicabilityRows.map(({ capabilityRef }) => capabilityRef));
if (extensionApplicabilitySource.status !== "USER_DELEGATED_PDP0_APPLICABILITY_DECISIONS; source-current; independent acceptance pending"
    || extensionApplicabilitySource.ownerApproval !== "NOT_CLAIMED"
    || extensionApplicabilitySource.independentAcceptance !== "NOT_CLAIMED"
    || extensionApplicabilitySource.executionAdmission !== "NOT_ADMITTED"
    || extensionApplicabilityRows.length !== 7 || extensionApplicabilityIds.size !== 7
    || [...extensionIds].some((id) => !extensionApplicabilityIds.has(id))) {
  fail("All seven definition extensions need a separate, source-current applicability record that preserves the 462 owner-adjudication boundary");
}
let extensionTopology = {};
let extensionSurfaceRegistry = {};
try {
  extensionTopology = JSON.parse(read(join(productRoot, "surfaces/media-physical-topology.v1.json")));
  extensionSurfaceRegistry = parseYaml(read(join(productRoot, "surface-registry.yaml")));
} catch (error) { fail(`PDP-0 definition extension surface authorities are invalid: ${error.message}`); }
const extensionPhysicalRows = extensionTopology.manifestCandidates ?? [];
const extensionCompositionRows = extensionTopology.compositions ?? [];
const extensionConsumerRows = extensionTopology.consumerCrosswalk ?? [];
const extensionSurfaceIds = new Set([
  ...extensionPhysicalRows.map(({ surfaceId }) => surfaceId),
  ...extensionCompositionRows.map(({ surfaceId }) => surfaceId),
  ...extensionConsumerRows.map(({ surfaceId }) => surfaceId),
]);
const extensionNonDecisionSurfaceIds = new Set([
  ...extensionPhysicalRows
    .filter(({ phaseApplicability }) => phaseApplicability?.["PDP-0"]?.disposition === "NOT_APPLICABLE_SUPPORT")
    .map(({ surfaceId }) => surfaceId),
  ...(extensionSurfaceRegistry.surfaces ?? [])
    .filter(({ applicabilityDisposition }) => applicabilityDisposition === "NOT_ACTIVE_ARCHIVED")
    .map(({ surfaceId }) => surfaceId),
]);
const extensionChannelIds = new Set([
  ...(parsedApplicationsChannels?.channels ?? []).map(({ id }) => id),
  ...(parsedApplicationsChannels?.ownerDefinedChannels?.records ?? []).map(({ id }) => id),
]);
const extensionLogicalCandidatesByChannel = new Map((extensionSurfaceRegistry.surfaces ?? []).length
  ? (extensionSurfaceRegistry.channelSurfaceProposals?.mappings ?? []).map(({ channelRef, candidateSurfaceRefs }) => [channelRef, candidateSurfaceRefs ?? []])
  : []);
const sortRefs = (refs) => [...new Set(refs ?? [])].sort().join("\0");
for (const row of extensionRows) {
  const applicability = extensionApplicabilityRows.find(({ capabilityRef }) => capabilityRef === row.capabilityId);
  const capability = parsedCapabilityDefinitions.capabilities.find(({ id }) => id === row.capabilityId);
  const selectedChannels = (capability?.supportedChannels ?? []).map((channel) => `media.channel.${channel}`);
  const owner = applicability?.sourceOwnerSurfaceRef;
  const ownerConsumer = extensionConsumerRows.find(({ surfaceId }) => surfaceId === owner);
  const expectedPhysical = applicability?.resolution?.physicalSurfaceRefs ?? [];
  const ownerPhysicalIds = new Set(ownerConsumer?.physicalRefs ?? []);
  const descendsFromSource = (composition, ancestors = new Set()) => {
    if (ancestors.has(composition.surfaceId)) return false;
    const next = new Set(ancestors).add(composition.surfaceId);
    return (composition.children ?? []).some((child) => expectedPhysical.includes(child)
      || extensionCompositionRows.some((nested) => nested.surfaceId === child && descendsFromSource(nested, next)));
  };
  const expectedComposites = extensionCompositionRows.filter((composition) => descendsFromSource(composition)).map(({ surfaceId }) => surfaceId);
  const expectedIncludedSurfaces = [owner, ...expectedPhysical, ...expectedComposites].filter(Boolean);
  const decision = applicability?.decision ?? {};
  const resolution = applicability?.resolution ?? {};
  const expectedExcludedChannels = [...extensionChannelIds].filter((id) => id !== applicability?.candidateChannelRef);
  const expectedExcludedSurfaces = [...extensionSurfaceIds].filter((id) => !expectedIncludedSurfaces.includes(id)
    && !extensionNonDecisionSurfaceIds.has(id));
  const mappedLogicalCandidates = extensionLogicalCandidatesByChannel.get(applicability?.candidateChannelRef) ?? [];
  const expectedOwnerProposalRefs = (applicability?.sourceAuditIds ?? []).map((id) =>
    `docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json#originalAudit.inventory/@audit_id=${id}/owner_surface_proposal`);
  if (!applicability
      || row.channelApplicabilityProposalRef !== `.product-experience/pdp-0-product-truth/applications-channels.yaml#coordinatorDefinitionExtensionApplicability/records/@capabilityRef=${row.capabilityId}`
      || sortRefs(applicability.declaredSupportedChannelRefs) !== sortRefs(row.declaredSupportedChannelRefs)
      || selectedChannels.length !== 1 || applicability.candidateChannelRef !== selectedChannels[0]
      || !applicability.sourceAuditIds?.length || !applicability.sourceOwnerSurfaceProposalRefs?.length
      || sortRefs(applicability.sourceOwnerSurfaceProposalRefs) !== sortRefs(expectedOwnerProposalRefs)
      || !ownerConsumer || !mappedLogicalCandidates.includes(owner)
      || expectedPhysical.length !== 1 || expectedPhysical.some((id) => !ownerPhysicalIds.has(id))
      || sortRefs(resolution.logicalConsumerSurfaceRefs) !== sortRefs([owner])
      || sortRefs(resolution.physicalSurfaceRefs) !== sortRefs(expectedPhysical)
      || sortRefs(resolution.compositeSurfaceRefs) !== sortRefs(expectedComposites)
      || sortRefs(decision.includedSurfaceRefs) !== sortRefs(expectedIncludedSurfaces)
      || sortRefs(decision.excludedSurfaceRefs?.map(({ surfaceRef }) => surfaceRef)) !== sortRefs(expectedExcludedSurfaces)
      || sortRefs(decision.excludedChannelRefs?.map(({ channelRef }) => channelRef)) !== sortRefs(expectedExcludedChannels)
      || decision.includedChannelRef !== applicability.candidateChannelRef
      || decision.status !== "DELEGATED_PDP0_APPLICABILITY_DECISION"
      || decision.sourceOfDecision !== "explicit-user-delegated-Media-owner-PDP-0-applicability-only"
      || decision.decisionRef !== ".product-experience/decision-log.md#PXD-207"
      || decision.ownerApproval !== "NOT_CLAIMED" || decision.independentAcceptance !== "NOT_CLAIMED"
      || decision.executionAdmission !== "NOT_ADMITTED") {
    fail(`Definition extension ${row.capabilityId} has an incomplete exact source-bound applicability proposal`);
  }
}
const parsedRequirements = parseYaml(requirementSource).requirements ?? [];
for (const { capabilityId, requirementRef } of extensionRows) {
  const requirementId = requirementRef?.match(/@id=(MEDIA-REQ-[A-Z0-9-]+)/u)?.[1];
  const family = parsedRequirements.find(({ id }) => id === requirementId);
  if (!family?.capabilityIds?.includes(capabilityId)) fail(`Definition extension ${capabilityId} must be linked from its owning requirement family ${requirementId ?? "<missing>"}`);
}
const extension = campaignExtensions.records?.find((record) => record.id === "AUD-SPEC-020");
if (!extension) fail("PDP-0 campaign extension is missing stable record AUD-SPEC-020");
else {
  const canonical = campaignExtensions.canonicalDenominator ?? {};
  for (const [field, expected] of Object.entries({ capabilityLeaves: 462, requirementFamilies: 38, intents: 19, ownerAdjudications: 462 })) {
    if (canonical[field] !== expected) fail(`AUD-SPEC-020 canonicalDenominator.${field} is ${canonical[field]}; expected ${expected}`);
  }
  if (extension.stableFeatureId !== "media.rules.manage" || extension.campaignId !== "media.pdp0.501-campaign") fail("AUD-SPEC-020 extension has an unexpected feature or campaign identity");
  if (extension.coordinatorScopeDecision?.disposition !== "INCLUDED_IN_PDP0_CAMPAIGN") fail("AUD-SPEC-020 lacks an explicit PDP-0 coordinator scope decision");
  if (extension.coordinatorScopeDecision?.ownerApproval !== "NOT_CLAIMED" || extension.coordinatorScopeDecision?.independentAcceptance !== "NOT_CLAIMED") fail("AUD-SPEC-020 must leave owner and independent acceptance NOT_CLAIMED");
  for (const [field, expected] of Object.entries({ implementationState: "UNKNOWN", qualificationState: "NOT_EVALUATED", runtimeAvailability: "UNKNOWN", executionAdmission: "NOT_ADMITTED" })) {
    if (extension.coordinatorScopeDecision?.[field] !== expected) fail(`AUD-SPEC-020 coordinator state ${field} must remain ${expected}`);
  }
  if (extension.capabilityDefinition?.id !== "media.rules.manage" || extension.requirementDefinition?.id !== "MEDIA-REQ-CAP-RULES" || extension.intentDefinition?.id !== "media.intent.manage-reusable-rules") fail("AUD-SPEC-020 typed capability, requirement, and intent definitions are not bound by stable IDs");
  const applicability = extension.channelApplicability?.records?.find((record) => record.capabilityRef === "media.rules.manage")?.channelApplicability ?? [];
  const proposed = new Set(["media.channel.web", "media.channel.api", "media.channel.embedded", "media.channel.http-api", "media.channel.grpc-api", "media.channel.sdk", "media.channel.cli", "media.channel.product-integration"]);
  const expectedChannels = new Set([...proposed, "media.channel.legacy-desktop", "media.channel.agent", "media.channel.event"]);
  const actualChannels = new Set(applicability.map((decision) => decision.channelRef));
  if (actualChannels.size !== 11 || [...expectedChannels].some((channel) => !actualChannels.has(channel))) fail("AUD-SPEC-020 must declare exactly the eight proposal channels and three explicit non-applicability channels");
  if (applicability.filter((decision) => decision.disposition === "PROPOSED_APPLICABLE").length !== 8) fail("AUD-SPEC-020 must have exactly eight proposed applicable channels");
  for (const channel of ["media.channel.legacy-desktop", "media.channel.agent", "media.channel.event"]) {
    if (!applicability.find((decision) => decision.channelRef === channel)?.rationale) fail(`AUD-SPEC-020 ${channel} N/A decision requires a rationale`);
  }
  // Resolve every proposed channel against the existing physical, composite, and logical
  // surface denominator. These are definition-scope proposals only, never owner receipts.
  let surfaceRegistry;
  let physicalTopology;
  try {
    surfaceRegistry = parseYaml(read(join(productRoot, "surface-registry.yaml")));
    physicalTopology = JSON.parse(read(join(productRoot, "surfaces/media-physical-topology.v1.json")));
  } catch (error) {
    fail(`AUD-SPEC-020 surface applicability authorities are invalid: ${error.message}`);
    surfaceRegistry = {};
    physicalTopology = {};
  }
  const physicalCandidates = physicalTopology.manifestCandidates ?? [];
  const composites = physicalTopology.compositions ?? [];
  const consumers = physicalTopology.consumerCrosswalk ?? [];
  const registrySurfaces = surfaceRegistry.surfaces ?? [];
  const logicalIds = new Set(consumers.map((row) => row.surfaceId));
  const allSurfaceIds = new Set([
    ...physicalCandidates.map((row) => row.surfaceId),
    ...composites.map((row) => row.surfaceId),
    ...consumers.map((row) => row.surfaceId),
  ]);
  if (physicalCandidates.length !== 26 || composites.length !== 7 || consumers.length !== 21
      || registrySurfaces.length !== 21 || allSurfaceIds.size !== 54
      || registrySurfaces.some((row) => !logicalIds.has(row.surfaceId))) {
    fail("AUD-SPEC-020 surface crosswalk must preserve the exact 54-identity PDP-0 denominator (26 physical, 7 composite, 21 logical)");
  }
  const mappingRows = surfaceRegistry.channelSurfaceProposals?.mappings ?? [];
  const mappingsByChannel = new Map(mappingRows.map((row) => [row.channelRef, row.candidateSurfaceRefs ?? []]));
  const transportRefs = [...(mappingsByChannel.get("media.channel.http-api") ?? []), ...(mappingsByChannel.get("media.channel.grpc-api") ?? [])];
  const expectedSurfaceRefsByChannel = new Map(mappingsByChannel);
  // The generic API mapping is scoped to a different PDP-0 proposal (Recorder capture).
  // AUD-SPEC-020 explicitly defines API as an umbrella over HTTP and gRPC.
  expectedSurfaceRefsByChannel.set("media.channel.api", [...new Set(transportRefs)]);
  const consumerById = new Map(consumers.map((row) => [row.surfaceId, row]));
  const physicalIds = new Set(physicalCandidates.map((row) => row.surfaceId));
  const compositeIds = new Set(composites.map((row) => row.surfaceId));
  const expectedDispositionByChannel = new Map([
    ...["media.channel.web", "media.channel.api", "media.channel.embedded", "media.channel.http-api", "media.channel.grpc-api", "media.channel.sdk", "media.channel.cli", "media.channel.product-integration"].map((channel) => [channel, "PROPOSED_APPLICABLE"]),
    ["media.channel.legacy-desktop", "NOT_APPLICABLE_ARCHIVED"],
    ["media.channel.agent", "NOT_APPLICABLE_NON_INVOCATION"],
    ["media.channel.event", "NOT_APPLICABLE_NON_INVOCATION"],
  ]);
  const sorted = (values) => [...values].sort();
  if (applicability.length !== expectedDispositionByChannel.size
      || new Set(applicability.map((row) => row.channelRef)).size !== expectedDispositionByChannel.size) {
    fail("AUD-SPEC-020 must resolve exactly eight proposed channels and three scoped N/A channels");
  }
  for (const row of applicability) {
    const expectedDisposition = expectedDispositionByChannel.get(row.channelRef);
    const resolution = row.surfaceResolution ?? {};
    const expectedLogical = expectedSurfaceRefsByChannel.get(row.channelRef) ?? [];
    const expectedPhysical = [...new Set(expectedLogical.flatMap((surfaceId) => consumerById.get(surfaceId)?.physicalRefs ?? []))];
    const expectedComposites = composites
      .filter((composition) => (composition.children ?? []).some((child) => expectedPhysical.includes(child)))
      .map((composition) => composition.surfaceId);
    const logicalRefs = resolution.logicalConsumerSurfaceRefs ?? [];
    const physicalRefs = resolution.physicalSurfaceRefs ?? [];
    const compositeRefs = resolution.compositeSurfaceRefs ?? [];
    if (!expectedDisposition || row.disposition !== expectedDisposition) {
      fail(`AUD-SPEC-020 ${row.channelRef} has an invalid or promoted applicability disposition`);
    }
    if (sorted(logicalRefs).join("\0") !== sorted(expectedLogical).join("\0")
        || sorted(physicalRefs).join("\0") !== sorted(expectedPhysical).join("\0")
        || sorted(compositeRefs).join("\0") !== sorted(expectedComposites).join("\0")) {
      fail(`AUD-SPEC-020 ${row.channelRef} must crosswalk exactly to its current registered surface identities`);
    }
    if ([...logicalRefs].some((id) => !logicalIds.has(id))
        || [...physicalRefs].some((id) => !physicalIds.has(id))
        || [...compositeRefs].some((id) => !compositeIds.has(id))) {
      fail(`AUD-SPEC-020 ${row.channelRef} references an unknown or newly invented surface identity`);
    }
    if (row.channelRef === "media.channel.api"
        && (resolution.kind !== "UMBRELLA_INHERITS_EXACT_TRANSPORT_SURFACES"
          || sorted(resolution.inheritsChannelRefs ?? []).join("\0") !== sorted(["media.channel.http-api", "media.channel.grpc-api"]).join("\0"))) {
      fail("AUD-SPEC-020 protocol-neutral API must inherit the exact HTTP and gRPC consumer surfaces");
    }
    if (expectedDisposition === "PROPOSED_APPLICABLE" && resolution.kind !== "DIRECT_DEFINITION_SCOPE"
        && row.channelRef !== "media.channel.api") {
      fail(`AUD-SPEC-020 ${row.channelRef} must remain a direct definition-scope proposal`);
    }
    if (expectedDisposition !== "PROPOSED_APPLICABLE"
        && (resolution.kind !== "COORDINATOR_PROPOSED_SCOPED_NOT_APPLICABLE"
          || resolution.ownerApproval !== "NOT_CLAIMED" || !row.rationale?.trim())) {
      fail(`AUD-SPEC-020 ${row.channelRef} scoped N/A must remain a reasoned coordinator proposal with owner approval NOT_CLAIMED`);
    }
  }
  const channelApplicabilityRecord = extension.channelApplicability?.records?.find((record) => record.capabilityRef === "media.rules.manage");
  if (extension.channelApplicability?.status !== "PROPOSAL_ONLY; cannot satisfy owner acceptance, independent acceptance, closure, admission, or runtime support"
      || channelApplicabilityRecord?.ownerApproval !== "NOT_CLAIMED"
      || channelApplicabilityRecord?.independentAcceptance !== "NOT_CLAIMED"
      || channelApplicabilityRecord?.applicabilityState !== "PROPOSED; owner disposition pending"
      || channelApplicabilityRecord?.implementationState !== "UNKNOWN"
      || channelApplicabilityRecord?.qualificationState !== "NOT_EVALUATED"
      || channelApplicabilityRecord?.runtimeAvailability !== "UNKNOWN"
      || channelApplicabilityRecord?.executionAdmission !== "NOT_ADMITTED") {
    fail("AUD-SPEC-020 channel applicability must remain proposal-only with owner acceptance unclaimed");
  }
  if (extension.compileAcceptance?.outputs?.normalizedSemanticGraph !== "media.rules.normalized-semantic-graph" || extension.compileAcceptance?.outputs?.semanticFingerprint !== "media.rules.semantic-fingerprint") fail("AUD-SPEC-020 P0 compile acceptance must expose typed graph and fingerprint outputs");
  const auditDimensions = extension.validationCoverage?.auditValidationDimensions ?? {};
  const expectedDimensions = ["positive", "negative", "unavailable", "UNKNOWN_or_explicit_NA", "rights_license", "manual_agent_parity_when_applicable", "source_version_and_provenance"];
  const auditReference = "docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json";
  let auditRecord;
  try {
    auditRecord = JSON.parse(read(join(root, auditReference))).originalAudit?.inventory?.find((row) => row.audit_id === "AUD-SPEC-020");
  } catch { auditRecord = undefined; }
  if (!auditRecord || extension.validationCoverage?.sourceValidationRef !== `${auditReference}#originalAudit.inventory/@audit_id=AUD-SPEC-020/validations_required` ||
      JSON.stringify([...expectedDimensions].sort()) !== JSON.stringify([...(auditRecord.validations_required ?? [])].sort())) {
    fail("AUD-SPEC-020 validation coverage does not match its source audit validation dimensions");
  }
  for (const dimension of expectedDimensions) {
    if (!auditDimensions[dimension]?.caseRefs?.length || !auditDimensions[dimension]?.criterion) fail(`AUD-SPEC-020 validation coverage is missing source-bound cases/criterion for ${dimension}`);
    for (const anchor of auditDimensions[dimension]?.caseRefs ?? []) {
      if (!anchor.includes("#records/@id=AUD-SPEC-020/") || /\[[0-9.]+\]/u.test(anchor) || resolveStableAnchor(campaignExtensions, anchor) === undefined) {
        fail(`AUD-SPEC-020 ${dimension} validation anchor is stale or lacks stable selectors: ${anchor}`);
      }
    }
  }
  if (auditDimensions.manual_agent_parity_when_applicable?.disposition !== "JUSTIFIED_NA") fail("AUD-SPEC-020 agent-parity N/A requires an explicit justified disposition");
  const compileBinding = extension.validationCoverage?.compileEquivalenceAndFingerprint;
  if (!compileBinding?.boundToNormalizedSemanticGraph || !compileBinding?.boundToStableSemanticFingerprint ||
      compileBinding?.compileAcceptanceId !== extension.compileAcceptance?.id ||
      resolveStableAnchor(campaignExtensions, compileBinding?.compileAcceptanceRef) !== extension.compileAcceptance ||
      resolveStableAnchor(campaignExtensions, compileBinding?.criterionRef) !== extension.compileAcceptance?.criterion) {
    fail("AUD-SPEC-020 normalized graph equivalence and stable fingerprint are not source-bound validation criteria");
  }
}
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
note(`${capabilityIds.size} current PDP-0 capability definitions resolve to ${familyIds.size} families and ${requirementIds.size} requirement IDs; ${ownerAdjudicationIds.size} historical owner adjudications remain canonical. Seven source extensions have separate source-current applicability records; independent acceptance remains pending and AUD-SPEC-020 remains a separate campaign extension. Historical inline-field observation: ${capabilityCoreComplete} legacy inline shapes and ${operationSpecificParameterProposals} inline parameter proposals`);

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
  "Exact action-registry typed-definition guards in actionConsequences.guardRefs; runtime NOT_ADMITTED",
  "Exact action-registry typed-definition effects, finality, and recovery in actionConsequences; runtime NOT_ADMITTED",
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
  // Exact multiline scalar values currently authored by screen contracts.
  // These remain proposal-only statuses; the list stays finite and does not
  // turn any local observation into owner or phase acceptance.
  "NO_APPLICABLE_SCREEN_LOCAL_TOKEN_DEPENDENCY; PDP-2 component contracts own internal styling and this screen adds no token override; negative: do not invent aliases or redefine Shared values",
  "Exact P1 owner-action/operation and linked journey-step object refs; runtime NOT_ADMITTED",
  "Exact action registry and journey-step operation refs; runtime NOT_ADMITTED",
  "Exact action-registry guards; runtime NOT_ADMITTED",
  "Exact action-registry effects/finality/recovery; runtime NOT_ADMITTED",
  "Exact action-registry typed definitions; runtime NOT_ADMITTED",
  "Exact P2 global and selected-layout responsive rules; screen-specific overrides empty; verification NOT_RUN",
  "NO_APPLICABLE_FIXTURE_FOR_P3B_CONTRACT_PREVIEW; P3-F permits honest definition-only previews without synthetic scenario fixtures; negative: do not claim rendered or runtime fixture coverage.",
  "EXACT_JOURNEY_STEP_SCENARIO_BINDING_FOR_LISTED_REFS; runtime NOT_ADMITTED.",
  "Media-owned job outcome composition selected from exact job observation, outcome evidence, and safe recovery anatomy; renderer and acceptance pending",
  "Media-owned exact version comparison composition selected from source playback, paired result comparison, and provenance; renderer and acceptance pending",
  "exact-selected-Media-component-composition; renderer/Shared-binding-and-acceptance-pending",
  "NO_APPLICABLE; source actions are local selection and declare no domain object; negative: do not infer project creation or provider binding",
  "NO_APPLICABLE; source actions are local selection and linked steps declare no Media operation; negative: do not infer submission or mutation",
  "NO_APPLICABLE; local choice is not PDP-1 lifecycle state; negative: it cannot authorize a transition",
  "exact action guards in entry; missing or unknown guard evidence keeps action unavailable",
  "exact local effect, finality, and recovery in exit; runtime not admitted",
  "EXACT_JOURNEY_STEP_SCENARIO_BINDING_FOR_LISTED_REFS; unlinked refs are retained as proposals and are NO_APPLICABLE to this screen-step preview; negative: do not claim those refs as rendered/runtime coverage.",
  "Exact PDP-2 semantic token aliases declared in tokenDependencies",
  "Exact P1 owner-action wire and linked journey-step object refs; job-attempt and job-lease preserve status dimensions; runtime NOT_ADMITTED",
  "exact job and attempt state definitions; dimensions remain orthogonal",
  "exact host identity, job tuple, read authority and freshness requirements authored",
  "exact observation and non-inference rules authored; runtime unknown where no receipt exists",
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
    const bindingStatuses = directYamlMappingScalars(source, "fieldBindingStatus");
    for (const field of screenRequiredFields.filter((candidate) => !["fieldBindingStatus", "schemaVersion", "contractSchemaRef"].includes(candidate))) {
      const status = bindingStatuses.get(field);
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
  registeredActionCapabilities.set(id, parseReferenceList(block, "capabilityRefs", `${id} in Action Registry`, 2));
}
function parseReferenceList(source, field, label, indent) {
  const indentation = " ".repeat(indent);
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const propertyPattern = new RegExp(`^${indentation}${escapedField}:[ \\t]*(.*)$`, "mu");
  const propertyMatch = propertyPattern.exec(source);
  if (!propertyMatch) {
    fail(`${label} lacks a ${field} binding`);
    return [];
  }

  const lines = source.split(/\r?\n/u);
  const propertyIndex = source.slice(0, propertyMatch.index).split(/\r?\n/u).length - 1;
  const inlineValue = propertyMatch[1].trim();
  let flowValue = inlineValue;
  let continuationIndex = propertyIndex + 1;
  if (flowValue === "") {
    while (continuationIndex < lines.length && !lines[continuationIndex].trim()) continuationIndex += 1;
    const next = lines[continuationIndex] ?? "";
    if (next.match(/^[ \t]*/u)[0].length > indent && next.trimStart().startsWith("[")) {
      flowValue = next.trim();
      continuationIndex += 1;
    }
  }
  if (flowValue.startsWith("[")) {
    while (!flowValue.includes("]") && continuationIndex < lines.length) {
      const line = lines[continuationIndex];
      if (line.trim() && line.match(/^[ \t]*/u)[0].length <= indent) break;
      flowValue += ` ${line.trim()}`;
      continuationIndex += 1;
    }
    const inlineMatch = flowValue.match(/^\[([\s\S]*)\][ \t]*(?:#.*)?$/u);
    if (!inlineMatch) {
      fail(`${label} has a malformed ${field} flow list`);
      return [];
    }
    return [...inlineMatch[1].matchAll(/[A-Za-z][A-Za-z0-9._:/-]*/gu)].map((match) => match[0]);
  }

  // Empty mapping value followed by exactly-indented sequence items is the
  // block-list spelling of the same authored YAML sequence. Do not search
  // descendants: nested lists are not direct bindings for this field.
  if (inlineValue !== "") {
    fail(`${label} has a malformed ${field} binding; expected an inline or block list`);
    return [];
  }
  const itemIndent = `${indentation}  `;
  const refs = [];
  let sawItem = false;
  for (let index = propertyIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const lineIndent = line.match(/^[ \t]*/u)[0];
    if (lineIndent.length <= indent) break;
    const item = line.match(new RegExp(`^${itemIndent}-[ \\t]+(.+?)[ \\t]*(?:#.*)?$`, "u"));
    if (!item) {
      fail(`${label} has a malformed ${field} block list`);
      return [];
    }
    sawItem = true;
    refs.push(...[...item[1].matchAll(/[A-Za-z][A-Za-z0-9._:/-]*/gu)].map((match) => match[0]));
  }
  if (!sawItem) fail(`${label} has an empty ${field} block list; use [] to declare no references`);
  return refs;
}
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
    const declaredCapabilities = parseReferenceList(block, "capabilityRefs", `${screenId} action ${actionId}`, 4);
    if (JSON.stringify(declaredCapabilities) !== JSON.stringify(actionCapabilities)) {
      fail(`${screenId} action ${actionId} capabilityRefs do not match the PDP-3 Action Registry`);
    }
    const actionRequirements = new Set(actionCapabilities.flatMap((capability) => [...(requirementCapabilitiesById.get(capability) ?? [])]));
    for (const requirement of actionRequirements) expectedRequirements.add(requirement);
    const declaredActionRequirements = parseReferenceList(block, "requirementRefs", `${screenId} action ${actionId}`, 4);
    const expectedActionRequirements = [...actionRequirements].sort();
    if (JSON.stringify(declaredActionRequirements) !== JSON.stringify(expectedActionRequirements)) {
      fail(`${screenId} action ${actionId} requirementRefs do not match the exact capability crosswalk`);
    }
    if (expectedActionRequirements.length) directActionCapabilityBindings += 1;
  }
  const declaredRequirements = parseReferenceList(source, "requirementRefs", screenId, 0);
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
    const declaredCapabilities = parseReferenceList(block, "capabilityRefs", `journey step ${actionId}`, stepStart.length + 2);
    if (JSON.stringify(declaredCapabilities) !== JSON.stringify(actionCapabilities)) {
      fail(`Journey step ${actionId} capabilityRefs do not match the PDP-3 Action Registry`);
    }
    const expectedRequirements = [...new Set(actionCapabilities.flatMap((capability) => [...(requirementCapabilitiesById.get(capability) ?? [])]))].sort();
    const declaredRequirements = parseReferenceList(block, "requirementRefs", `journey step ${actionId}`, stepStart.length + 2);
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
// Transition records are the two-space-indented list directly under
// transitionRecords. Deeply nested triggerCases also contain `- id` entries;
// their indentation must not create top-level transition blocks.
const transitionBlocks = transitionRecords.split(/(?=^  - id: )/mu).filter((block) => /^  - id: /mu.test(block));
unique(transitionBlocks.map((block) => block.match(/^  - id: ([^\s]+)/mu)?.[1]).filter(Boolean), "PDP-1 transition ID");
for (const transition of transitionBlocks) {
  const id = transition.match(/^  - id: ([^\s]+)/mu)?.[1] ?? "unknown";
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
