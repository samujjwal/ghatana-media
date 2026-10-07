#!/usr/bin/env node
/**
 * Deterministic, read-only candidate projections for GOV-03.
 *
 * These artifacts observe Media authority files; they do not resolve owners,
 * assert phase equivalence, or claim acceptance/currentness. The public Tools
 * validators are run against explicitly partial candidates and their exact
 * blockers are stored beside the generated observations.
 *
 * Usage: node scripts/generate-media-phase-projections.mjs [--check] [--strict]
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const toolsRequire = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = toolsRequire("yaml");
const Ajv2020 = toolsRequire("ajv/dist/2020.js").default;
const Ajv = toolsRequire("ajv").default;
const addFormats = toolsRequire("ajv-formats").default;
const contractSourceRoot = resolve(root, "../ghatana-tools/libs/product-development");
async function loadContract(packageName, sourcePackage, entrypoint) {
  try {
    return { module: await import(packageName), binding: "installed-public-package-export" };
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    // Some packed snapshots ship the schema but omit dist/. In that case
    // invoke the sibling package's public src/index.ts entrypoint directly.
    return {
      module: await import(new URL(`file://${resolve(contractSourceRoot, sourcePackage, entrypoint)}`)),
      binding: "sibling-public-source-entrypoint (installed dist unavailable)",
    };
  }
}
const [productDefinitionContract, experienceLanguageContract, experienceSpecificationContract] = await Promise.all([
  loadContract("@ghatana/product-definition", "product-definition", "src/index.ts"),
  loadContract("@ghatana/experience-language", "experience-language", "src/index.ts"),
  loadContract("@ghatana/experience-specification", "experience-specification", "src/index.ts"),
]);
const checkOnly = process.argv.includes("--check");
const strict = process.argv.includes("--strict");

const definitions = [
  {
    name: "product-definition",
    output: ".product-experience/pdp-0-product-truth/generated/product-definition.candidate.json",
    schemaPackage: "@ghatana/product-definition",
    schemaPath: "../ghatana-tools/libs/product-development/product-definition/schemas/product-definition.v1.schema.json",
    schemaVersion: productDefinitionContract.module.PRODUCT_DEFINITION_SCHEMA_VERSION,
    validator: productDefinitionContract.module.validateProductDefinition,
    validatorBinding: productDefinitionContract.binding,
    schemaDialect: "2020",
    sources: [
      ".product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md",
      ".product-experience/pdp-0-product-truth/constitution.yaml",
      ".product-experience/pdp-0-product-truth/goals-jtbd.yaml",
      ".product-experience/pdp-0-product-truth/actors-responsibilities.yaml",
      ".product-experience/pdp-0-product-truth/capabilities.yaml",
      ".product-experience/pdp-0-product-truth/requirements.yaml",
      ".product-experience/pdp-0-product-truth/journey-catalog.yaml",
      ".product-experience/pdp-0-product-truth/quality-policy.yaml",
      ".product-experience/pdp-0-product-truth/policy-authority-model.yaml",
      ".product-experience/explorer/tools-binding.yaml",
    ],
    candidate: (sources) => ({
      id: findValue(sources.find((source) => source.sourceRef.endsWith("/tools-binding.yaml"))?.content, "product-picker-and-coordinate"),
      subjectId: scalar(sources, ".product-experience/pdp-0-product-truth/capabilities.yaml", "productId"),
      schemaVersion: productDefinitionContract.module.PRODUCT_DEFINITION_SCHEMA_VERSION,
    }),
    candidateFieldSources: {
      id: { sourceRef: ".product-experience/explorer/tools-binding.yaml", sourcePath: "requiredBindings.product-picker-and-coordinate", mapping: "explicit declared product coordinate" },
      subjectId: { sourceRef: ".product-experience/pdp-0-product-truth/capabilities.yaml", sourcePath: "productId", mapping: "identity copy" },
      schemaVersion: { sourceRef: "@ghatana/product-definition public export", sourcePath: "PRODUCT_DEFINITION_SCHEMA_VERSION", mapping: "public contract constant" },
    },
    fieldMappingBlockers: {
      purpose: ["No single reviewed purpose record directly supplies the required purpose statement and audience; goal and outcome records are not equivalent."],
      scope: ["The scope statement is proposal prose; the schema also requires normalized inclusions and exclusions, which are not mapped as a reviewed set."],
      nonGoals: ["No ProductDefinition nonGoal records with schema-defined reason fields are explicitly mapped."],
      actors: ["Media actor, principal, persona, and role records use distinct meanings; no owner-approved mapping selects schema actor kinds and descriptions."],
      responsibilities: ["Responsibility roles are proposed role definitions, not assigned responsibility records with an accepted owner."],
      userIntents: ["Intent records do not directly supply required actor references and schema priority values through a resolved actor mapping."],
      businessIntents: ["No source collection is explicitly classified as business intents in the ProductDefinition sense."],
      desiredOutcomes: ["Goal/outcome records contain multiple meanings and actor refs requiring unresolved owner and identifier resolution."],
      capabilities: ["The 462 capability leaves have proposal shape, but mappings to schema descriptions and requirementRefs have not been resolved and reviewed."],
      requirements: ["Requirement records are not losslessly normalized to schema kind, priority, and traceToIntentIds; scope and refs remain unresolved."],
      domainRules: ["No owner-approved mapping selects source records as ProductDefinition domain rules with schema rule fields."],
      policies: ["Policy/constitution records do not directly provide the schema enforcement enum for each rule."],
      invariants: ["No explicit source-to-schema invariant mapping supplies statement and violation pairs."],
      journeys: ["Journey catalogs have distinct contracts; actor refs, ordered string steps, and desiredOutcomeRefs are not resolved to the schema references."],
      trustContexts: ["Principal/authority records do not directly classify schema trust levels and auditRequired values."],
      successMeasures: ["Quality measures and outcomes lack an owner-approved mapping to ProductDefinition success measures and their targets."],
      ownershipRules: ["Owner role references are not assigned ownership rules with resolved owner identifiers."],
      createdAt: ["No Media authority supplies a creation timestamp for this projection; generation time is not a source fact."],
      updatedAt: ["No Media authority supplies an update timestamp for this projection; generation time is not a source fact."],
    },
    blocker: "Required ProductDefinition fields without direct source mappings remain absent; exact field-level mapping blockers are listed below.",
  },
  {
    name: "experience-language",
    output: ".product-experience/pdp-2-design-interface-system/generated/experience-language.candidate.json",
    schemaPackage: "@ghatana/experience-language",
    schemaPath: "../ghatana-tools/libs/product-development/experience-language/schemas/experience-language.v1.schema.json",
    schemaVersion: experienceLanguageContract.module.EXPERIENCE_LANGUAGE_SCHEMA_VERSION,
    validator: experienceLanguageContract.module.validateExperienceLanguage,
    validatorBinding: experienceLanguageContract.binding,
    schemaDialect: "2020",
    sources: [
      ".product-experience/pdp-2-design-interface-system/DESIGN-LANGUAGE.md",
      ".product-experience/pdp-2-design-interface-system/typography-layout.yaml",
      ".product-experience/pdp-2-design-interface-system/semantic-state-grammar.yaml",
      ".product-experience/pdp-2-design-interface-system/responsive-adaptive.yaml",
      ".product-experience/pdp-2-design-interface-system/accessibility.yaml",
      ".product-experience/pdp-2-design-interface-system/localization-content.yaml",
      ".product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml",
      ".product-experience/pdp-2-design-interface-system/gui/patterns/catalog.yaml",
      ".product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml",
      ".product-experience/pdp-2-design-interface-system/media-token-aliases.yaml",
    ],
    candidate: (sources) => ({
      subjectId: scalar(sources, ".product-experience/pdp-2-design-interface-system/typography-layout.yaml", "productId"),
      schemaVersion: experienceLanguageContract.module.EXPERIENCE_LANGUAGE_SCHEMA_VERSION,
    }),
    candidateFieldSources: {
      subjectId: { sourceRef: ".product-experience/pdp-2-design-interface-system/typography-layout.yaml", sourcePath: "productId", mapping: "identity copy" },
      schemaVersion: { sourceRef: "@ghatana/experience-language public export", sourcePath: "EXPERIENCE_LANGUAGE_SCHEMA_VERSION", mapping: "public contract constant" },
    },
    fieldMappingBlockers: {
      id: ["No canonical ExperienceLanguage identifier is declared in the Media PDP-2 sources; the productId is not reused as a language ID."],
      densityProfiles: ["The source labels simple/guided/expert do not match the schema's minimal/compact/standard/rich enum; conversion would invent equivalence."],
      presentationProfiles: ["No source defines presentation profile IDs and densityRef links using the schema contract."],
      semanticStates: ["The semantic state grammar contains proposed state refs and presentation text, but no accepted state resolver or language-owned mapping."],
      navigationPrinciples: ["No distinct navigation-principle records with stable IDs are defined in the source authorities."],
      interactionPatterns: ["GUI patterns combine anatomy, states, and intent; mapping them to generic interaction patterns needs an owner-approved classification."],
      decisionPatterns: ["No source classifies decision patterns and their consequential boolean under this schema."],
      recoveryPatterns: ["Recovery contracts do not map directly to ExperienceLanguage recovery patterns or automaticRecovery values."],
      progressiveDisclosureRules: ["Typography hierarchy and disclosure prose are not normalized to identified trigger/reveals/conceals rules."],
      responsiveRules: ["Viewport variants and responsive prose are proposals, not schema breakpoints and behaviors with an accepted support mapping."],
      accessibilityRules: ["Accessibility requirements lack selected standard/level mappings; the source explicitly leaves applicable WCAG criteria to the owner."],
      localizationRules: ["Localization prose is not normalized to identified concern/strategy records; fixture locale is not runtime support."],
      componentBindings: ["Semantic component aliases remain unadmitted; Shared component references and cross-owner resolvers are unresolved."],
      recipeBindings: ["No admitted Shared recipe IDs or Media recipe-binding authority is present."],
      domainStatePresentationMappings: ["PDP-1 state semantics and accepted state IDs remain unresolved; proposed state spellings are not promoted to domain mappings."],
      createdAt: ["No Media authority supplies an ExperienceLanguage creation timestamp; generation time is not a source fact."],
      updatedAt: ["No Media authority supplies an ExperienceLanguage update timestamp; generation time is not a source fact."],
    },
    blocker: "Required ExperienceLanguage fields without direct source mappings remain absent; exact field-level mapping blockers are listed below.",
  },
  {
    name: "experience-specification",
    output: ".product-experience/pdp-3-product-experience/generated/experience-specification.candidate.json",
    schemaPackage: "@ghatana/experience-specification",
    schemaPath: "../ghatana-tools/libs/product-development/experience-specification/schemas/experience-specification.v1.schema.json",
    schemaVersion: experienceSpecificationContract.module.EXPERIENCE_SPECIFICATION_SCHEMA_VERSION,
    validator: experienceSpecificationContract.module.validateExperienceDefinition,
    validatorBinding: experienceSpecificationContract.binding,
    schemaDialect: "draft7",
    sources: [
      ".product-experience/pdp-3-product-experience/screen-registry.yaml",
      ".product-experience/pdp-3-product-experience/journey-registry.yaml",
      ".product-experience/pdp-3-product-experience/action-registry.yaml",
      ".product-experience/pdp-3-product-experience/state-transition-bindings.yaml",
      ".product-experience/pdp-3-product-experience/scenario-fixture-registry.yaml",
      ".product-experience/pdp-3-product-experience/simulation-semantics.yaml",
      ".product-experience/pdp-3-product-experience/recovery-finality-contracts.yaml",
      ".product-experience/pdp-3-product-experience/screen-contract-schema.yaml",
    ],
    candidate: (sources) => ({
      subjectId: scalar(sources, ".product-experience/pdp-3-product-experience/screen-registry.yaml", "productId"),
      schemaVersion: experienceSpecificationContract.module.EXPERIENCE_SPECIFICATION_SCHEMA_VERSION,
    }),
    candidateFieldSources: {
      subjectId: { sourceRef: ".product-experience/pdp-3-product-experience/screen-registry.yaml", sourcePath: "productId", mapping: "identity copy" },
      schemaVersion: { sourceRef: "@ghatana/experience-specification public export", sourcePath: "EXPERIENCE_SPECIFICATION_SCHEMA_VERSION", mapping: "public contract constant" },
    },
    fieldMappingBlockers: {
      id: ["No canonical ExperienceDefinition identifier is declared in Media PDP-3 sources; productId is not reused as a definition ID."],
      contextDimensions: ["No source resolves context dimensions to typed values, allowed values, and importance under this contract."],
      renderTargets: ["Channel mentions are proposal dispositions, not resolved render-target definitions with schema kinds and display names."],
      componentContracts: ["PDP-2 component contracts and Shared primitive bindings remain proposal/unadmitted; no accepted component contract set is selected."],
      views: ["Screen records have candidate view content, but component, journey, and state refs are unresolved across source authorities."],
      journeys: ["Journey steps, actors, outcomes, and view links need owner-resolved cross-phase references; fixture coverage is not an accepted mapping."],
      interactions: ["Action intents do not yet supply schema trigger, preconditions, or resolved actionRef contracts."],
      states: ["State projections require accepted PDP-1 state definitions and resolved invariant semantics, which remain pending."],
      transitions: ["Transition bindings are proposals and do not establish accepted transition semantics or references."],
      actions: ["Action registry entries are proposal intents; operation authority, effects, preconditions, and references remain unresolved."],
      effects: ["No accepted effect contract maps action outcomes to the schema effects collection."],
      finality: ["Recovery/finality proposals do not provide a resolved set of ExperienceDefinition finality records."],
      recovery: ["Recovery contracts remain proposals without accepted action, state, and finality references."],
      scenarios: ["Scenario records describe fixtures/proposals and are not mapped to the schema's behavioral scenario contract."],
      fixtures: ["Fixture registry records do not directly supply the ExperienceDefinition fixture shape and linked source data."],
      search: ["No PDP-3 source explicitly defines search contracts in the ExperienceDefinition schema shape."],
      inspections: ["Specification inspection surfaces are Explorer behavior, not source-defined Product Experience inspection contracts."],
      createdAt: ["No Media authority supplies an ExperienceDefinition creation timestamp; generation time is not a source fact."],
      updatedAt: ["No Media authority supplies an ExperienceDefinition update timestamp; generation time is not a source fact."],
    },
    blocker: "Required ExperienceDefinition fields without direct source mappings remain absent; exact field-level mapping blockers are listed below.",
  },
];

const cache = new Map();
async function loadSource(sourceRef) {
  if (cache.has(sourceRef)) return cache.get(sourceRef);
  const text = await readFile(resolve(root, sourceRef), "utf8");
  const content = sourceRef.endsWith(".yaml") || sourceRef.endsWith(".yml") ? parse(text) : null;
  const record = Object.freeze({ sourceRef, text, content });
  cache.set(sourceRef, record);
  return record;
}

function scalar(sources, path, key) {
  const value = sources.find((source) => source.sourceRef === path)?.content?.[key];
  return typeof value === "string" ? value : "";
}

function findValue(value, wantedKey) {
  if (!value || typeof value !== "object") return undefined;
  if (!Array.isArray(value) && typeof value[wantedKey] === "string") return value[wantedKey];
  for (const child of Object.values(value)) {
    const found = findValue(child, wantedKey);
    if (found !== undefined) return found;
  }
  return undefined;
}

function observeSource({ sourceRef, text, content }) {
  const observed = {
    sourceRef,
    sha256: createHash("sha256").update(text).digest("hex"),
    bytes: Buffer.byteLength(text),
    format: content === null ? "markdown" : "yaml",
  };
  if (content && typeof content === "object" && !Array.isArray(content)) {
    observed.schemaVersion = typeof content.schemaVersion === "string" ? content.schemaVersion : null;
    observed.authority = typeof content.authority === "string" ? content.authority : null;
    observed.status = typeof content.status === "string" ? content.status : null;
    observed.topLevelFields = Object.keys(content).sort();
    const ids = [];
    const visit = (value) => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!value || typeof value !== "object") return;
      if (typeof value.id === "string") ids.push(value.id);
      Object.values(value).forEach(visit);
    };
    visit(content);
    observed.declaredIds = [...new Set(ids)].sort();
  }
  return observed;
}

async function validationFor(definition, candidate) {
  const schema = JSON.parse(await readFile(resolve(root, definition.schemaPath), "utf8"));
  const Validator = definition.schemaDialect === "2020" ? Ajv2020 : Ajv;
  const ajv = new Validator({ allErrors: true, strict: false });
  addFormats(ajv);
  const validateSchema = ajv.compile(schema);
  const schemaValid = Boolean(validateSchema(candidate));
  const schemaBlockers = schemaValid ? [] : (validateSchema.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`);
  let publicValidatorBlockers = [];
  try {
    definition.validator(candidate);
  } catch (error) {
    publicValidatorBlockers = [error instanceof Error ? error.message : String(error)];
  }
  return {
    schemaPackage: definition.schemaPackage,
    schemaContract: relative(root, resolve(root, definition.schemaPath)),
    schemaId: schema.$id,
    schemaValid,
    schemaBlockers,
    publicValidator: definition.validatorBinding,
    publicValidatorPassed: publicValidatorBlockers.length === 0,
    publicValidatorBlockers,
  };
}

const outputs = [];
for (const definition of definitions) {
  const sources = await Promise.all(definition.sources.map(loadSource));
  const candidateModel = definition.candidate(sources);
  const validation = await validationFor(definition, candidateModel);
  const fieldMappingBlockers = Object.entries(definition.fieldMappingBlockers).map(([field, reasons]) => ({
    field,
    status: "BLOCKED_NO_DIRECT_LOSSLESS_MAPPING",
    reasons,
    sourceAuthoritiesReviewed: definition.sources,
  }));
  const projection = {
    projectionKind: definition.name,
    projectionStatus: "GENERATED_CANDIDATE_NOT_ACCEPTED_NOT_CURRENT",
    subjectId: candidateModel.subjectId,
    sourceAuthorities: sources.map(observeSource),
    candidateModel,
    candidateFieldSources: definition.candidateFieldSources,
    fieldMappingBlockers,
    derivationBoundary: "Only explicitly source-backed identifiers and public schema versions are included in candidateModel. Each direct field has a source locator; all unmapped required schema fields remain absent and have an explicit blocker. Source facts remain unmerged observations until approved mappings and owners exist.",
    knownBlockers: [definition.blocker],
    validation,
    acceptance: "NOT_CLAIMED",
    currentness: "NOT_GENERATED; Lifecycle authority required",
  };
  const bytes = `${JSON.stringify(projection, null, 2)}\n`;
  const outputPath = resolve(root, definition.output);
  if (checkOnly) {
    const current = await readFile(outputPath, "utf8").catch(() => null);
    if (current !== bytes) throw new Error(`${definition.output} is stale; run node scripts/generate-media-phase-projections.mjs`);
  } else {
    await (await import("node:fs/promises")).mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, bytes);
  }
  outputs.push({ name: definition.name, output: definition.output, validation });
}

for (const output of outputs) {
  console.log(`${output.name}: ${output.output}`);
  console.log(`  schema: ${output.validation.schemaValid ? "VALID" : `BLOCKED (${output.validation.schemaBlockers.length} structural errors)`}`);
  console.log(`  public validator: ${output.validation.publicValidatorPassed ? "PASS" : `BLOCKED: ${output.validation.publicValidatorBlockers.join(" | ")}`}`);
}
const blocked = outputs.some(({ validation }) => !validation.schemaValid || !validation.publicValidatorPassed);
if (strict && blocked) process.exitCode = 1;
