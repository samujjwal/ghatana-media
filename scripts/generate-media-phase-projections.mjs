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
      ".product-experience/pdp-0-product-truth/nonfunctional-requirements.yaml",
      ".product-experience/pdp-0-product-truth/policy-authority-model.yaml",
      ".product-experience/explorer/tools-binding.yaml",
    ],
    candidate: (sources) => {
      const source = (name) => sources.find((entry) => entry.sourceRef.endsWith(`/${name}`))?.content ?? {};
      const goals = source("goals-jtbd.yaml");
      const actorSource = source("actors-responsibilities.yaml");
      const capabilities = source("capabilities.yaml");
      const requirements = source("requirements.yaml");
      const journeys = source("journey-catalog.yaml");
      const nfr = source("nonfunctional-requirements.yaml");
      const policy = source("policy-authority-model.yaml");
      const actors = actorSource.actors ?? [];
      return {
        id: "media.product-definition",
        subjectId: capabilities.productId,
        schemaVersion: productDefinitionContract.module.PRODUCT_DEFINITION_SCHEMA_VERSION,
        purpose: {
          id: "media.purpose",
          statement: "Help people understand, create, restore, enhance, edit, animate, simulate, synchronize, compose, assess, and deliver governed media while preserving source material and disclosing material changes, evidence, and uncertainty.",
          forWhom: "Media creators, editors, reviewers, operators, and developers represented by the canonical Media actor records.",
        },
        scope: {
          id: "media.scope",
          description: goals.scopeStatement,
          inclusions: goals.scope?.includedFamilies ?? [],
          exclusions: goals.scope?.exclusionsFromMediaAuthority ?? [],
        },
        nonGoals: [],
        actors: actors.map((actor) => ({
          id: actor.id,
          name: actor.id.replace(/^media\./u, "").replaceAll("-", " "),
          kind: ({ human: "person", "machine-client": "system", "product-runtime": "system", "external-service": "external-service" })[
            actorSource.principals?.find((principal) => principal.id === actor.principalRef)?.kind
          ] ?? "system",
          description: `${actor.outcome} ${actor.authorityBoundary}`,
          responsibilities: actor.responsibilities ?? [],
        })),
        responsibilities: actors.flatMap((actor) => (actor.responsibilities ?? []).map((description, index) => ({
          id: `${actor.id}.responsibility.${index + 1}`,
          description,
          owner: actor.id,
        }))),
        userIntents: [],
        businessIntents: [],
        desiredOutcomes: (goals.outcomes ?? []).map((outcome) => ({ id: outcome.id, description: outcome.outcome })),
        capabilities: (capabilities.capabilities ?? []).map((capability) => ({
          id: capability.id,
          name: capability.label,
          description: capability.outcome,
          requirementRefs: capability.requirementIds ?? [],
        })),
        requirements: [
          ...(requirements.requirements ?? []).map((requirement) => ({
          id: requirement.id,
          statement: requirement.statement,
          kind: requirement.kind,
          priority: requirement.priority,
            traceToIntentIds: [],
          })),
          ...(nfr.requirements ?? []).map((requirement) => ({
            id: requirement.id,
            statement: requirement.statement,
            kind: "non-functional",
            priority: requirement.priority,
            traceToIntentIds: [],
          })),
        ],
        domainRules: [],
        policies: [],
        invariants: [],
        journeys: (journeys.journeys ?? []).filter((journey) => journey.actors?.length === 1).map((journey) => ({
          id: journey.id,
          name: journey.title,
          actorRef: journey.actors[0],
          steps: [journey.preconditions, journey.completion],
          ...(journey.outcomeRefs?.length === 1 ? { desiredOutcomeRef: journey.outcomeRefs[0] } : {}),
        })),
        trustContexts: [],
        successMeasures: [],
        ownershipRules: [],
        createdAt: "",
        updatedAt: "",
        _mappingReview: {
          omittedCollections: {
            businessIntents: "No source collection is classified as business intents under ProductDefinition semantics.",
            domainRules: "PDP-0 does not classify rules as ProductDefinition domain rules; canonical domain authority is PDP-1.",
            policies: "Policy source records do not assign the ProductDefinition strict/advisory enforcement enum.",
            invariants: "No source record provides both invariant statement and violation semantics without inference.",
            journeys: `${(journeys.journeys ?? []).filter((journey) => journey.actors?.length !== 1).length} journeys have multiple actors; ProductDefinition requires one actorRef and no reviewed primary-actor mapping exists.`,
            trustContexts: "Principal kinds do not map directly to ProductDefinition trust levels.",
            successMeasures: "Quality dimensions and outcomes have no accepted ProductDefinition measure targets or baselines.",
            ownershipRules: "Owner roles are proposals; assignment of each concern to a ProductDefinition owner is pending.",
            timestamps: "No source authority records creation/update timestamps; generation time is not a source fact.",
            userIntents: `All ${(goals.intents ?? []).length} intents are omitted because the source does not assign ProductDefinition priority values; ${(goals.intents ?? []).filter((intent) => intent.actorRefs?.length !== 1).length} are also multi-actor and have no approved primary actor.`,
          },
          fieldDispositions: {
            purpose: { status: "PROJECTED_PENDING_OWNER_REVIEW", source: "PRODUCT-TRUTH.md mission and goals-jtbd.yaml actors" },
            scope: { status: "PROJECTED_PENDING_OWNER_REVIEW", source: "goals-jtbd.yaml scopeStatement, includedFamilies, exclusionsFromMediaAuthority" },
            nonGoals: { status: "NO_DIRECT_PRODUCT_NON_GOAL_SOURCE; OWNER_DECISION_OPEN", source: "goals-jtbd.yaml scope exclusions are authority boundaries and are not assumed to be product non-goals" },
            actors: { status: "PROJECTED_PENDING_OWNER_REVIEW", source: "actors-responsibilities.yaml actors and principals" },
            responsibilities: { status: "PROJECTED_PENDING_OWNER_REVIEW", source: "actors-responsibilities.yaml responsibilityRoles" },
            userIntents: { status: "PRIORITY_AND_ACTOR_MAPPING_OPEN", source: "goals-jtbd.yaml intents do not declare ProductDefinition priority; multi-actor intents have no approved primary actor" },
            businessIntents: { status: "NO_SOURCE_CLASSIFICATION; OWNER_DECISION_OPEN", source: "No business-intent collection in canonical PDP-0" },
            desiredOutcomes: { status: "PROJECTED_PENDING_OWNER_REVIEW", source: "goals-jtbd.yaml outcomes" },
            capabilities: { status: "PROJECTED_PENDING_OWNER_REVIEW", source: "capabilities.yaml capability leaves" },
            requirements: { status: "PROJECTED_PENDING_OWNER_REVIEW", source: "requirements.yaml requirements and nonfunctional-requirements.yaml" },
            domainRules: { status: "PDP-1_OWNER_DECISION_OPEN", source: "No PDP-0 records classified as ProductDefinition domainRules" },
            policies: { status: "ENFORCEMENT_MAPPING_OPEN", source: "policy-authority-model.yaml; strict/advisory enum not assigned per policy" },
            invariants: { status: "VIOLATION_MAPPING_OPEN", source: "constitution.yaml and policy-authority-model.yaml do not pair every invariant with violation behavior" },
            journeys: { status: "PARTIAL; PRIMARY_ACTOR_DECISION_OPEN", source: "journey-catalog.yaml; every journey has multiple actors" },
            trustContexts: { status: "TRUST_LEVEL_MAPPING_OPEN", source: "actors-responsibilities.yaml principals; no accepted trust-level crosswalk" },
            successMeasures: { status: "TARGETS_AND_BASELINES_OPEN", source: "quality-policy.yaml dimensions and metricDefinitions; ProductDefinition targets are not assigned" },
            ownershipRules: { status: "OWNER_ASSIGNMENT_OPEN", source: "actors-responsibilities.yaml accountability and responsibility roles" },
            createdAt: { status: "NO_SOURCE_FACT", source: "No canonical creation timestamp" },
            updatedAt: { status: "NO_SOURCE_FACT", source: "No canonical update timestamp" },
          },
          requirementCapabilityMap: "No singular capabilityRef is emitted because each requirement may cover multiple leaves/families while the public schema accepts only one; capability requirementRefs preserve exact source links.",
          nonfunctionalRequirementIds: (nfr.requirements ?? []).map((item) => item.id),
          ownerDecisionStatus: "PENDING; structural validity does not establish semantic acceptance or closure.",
          policyAuthoritySourceObserved: Boolean(policy.productPolicy),
        },
      };
    },
    candidateFieldSources: {
      id: { sourceRef: null, sourcePath: null, mapping: "deterministic projection identifier; not a canonical product identifier" },
      subjectId: { sourceRef: ".product-experience/pdp-0-product-truth/capabilities.yaml", sourcePath: "productId", mapping: "identity copy" },
      schemaVersion: { sourceRef: "@ghatana/product-definition public export", sourcePath: "PRODUCT_DEFINITION_SCHEMA_VERSION", mapping: "public contract constant" },
      purpose: { sourceRef: ".product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md", sourcePath: "Mission and intended outcomes", mapping: "composed summary; proposal, owner review pending" },
      scope: { sourceRef: ".product-experience/pdp-0-product-truth/goals-jtbd.yaml", sourcePath: "scopeStatement, scope.includedFamilies, scope.exclusionsFromMediaAuthority", mapping: "direct source projection" },
      nonGoals: { sourceRef: null, sourcePath: null, mapping: "scope exclusions are authority boundaries, not established product non-goals" },
      actors: { sourceRef: ".product-experience/pdp-0-product-truth/actors-responsibilities.yaml", sourcePath: "actors and principals", mapping: "direct actor projection with human-to-person kind normalization" },
      responsibilities: { sourceRef: ".product-experience/pdp-0-product-truth/actors-responsibilities.yaml", sourcePath: "actors[].responsibilities", mapping: "actor-assigned responsibility statements with direct actor ownerRef" },
      userIntents: { sourceRef: ".product-experience/pdp-0-product-truth/goals-jtbd.yaml", sourcePath: "intents", mapping: "not projected; priority enum is absent and multiple actorRefs have no accepted primary actor mapping" },
      businessIntents: { sourceRef: null, sourcePath: null, mapping: "no classified source; unresolved owner decision" },
      desiredOutcomes: { sourceRef: ".product-experience/pdp-0-product-truth/goals-jtbd.yaml", sourcePath: "outcomes", mapping: "direct descriptions; multi-actor links omitted" },
      capabilities: { sourceRef: ".product-experience/pdp-0-product-truth/capabilities.yaml", sourcePath: "capabilities", mapping: "all 462 leaf identities, outcomes, and requirementRefs" },
      requirements: { sourceRef: ".product-experience/pdp-0-product-truth/requirements.yaml", sourcePath: "requirements plus nonfunctional-requirements.yaml", mapping: "direct functional and NFR statements; intent traces omitted because intent priority and actor mapping remain unresolved" },
      domainRules: { sourceRef: null, sourcePath: null, mapping: "PDP-1 owns canonical domain rules; no accepted ProductDefinition mapping" },
      policies: { sourceRef: ".product-experience/pdp-0-product-truth/policy-authority-model.yaml", sourcePath: "productPolicy", mapping: "no per-policy strict/advisory enforcement mapping" },
      invariants: { sourceRef: ".product-experience/pdp-0-product-truth/constitution.yaml", sourcePath: "requirements", mapping: "violation behavior not supplied for all records" },
      journeys: { sourceRef: ".product-experience/pdp-0-product-truth/journey-catalog.yaml", sourcePath: "journeys", mapping: "no primary actor mapping; all 30 multi-actor journeys omitted" },
      trustContexts: { sourceRef: ".product-experience/pdp-0-product-truth/actors-responsibilities.yaml", sourcePath: "principals", mapping: "no accepted trust-level crosswalk" },
      successMeasures: { sourceRef: ".product-experience/pdp-0-product-truth/quality-policy.yaml", sourcePath: "qualityDimensions and metricDefinitions", mapping: "no accepted ProductDefinition targets or baselines" },
      ownershipRules: { sourceRef: ".product-experience/pdp-0-product-truth/actors-responsibilities.yaml", sourcePath: "accountability and responsibilityRoles", mapping: "concern-to-owner assignment remains pending" },
      createdAt: { sourceRef: null, sourcePath: null, mapping: "not supplied; empty schema field is explicitly unresolved" },
      updatedAt: { sourceRef: null, sourcePath: null, mapping: "not supplied; empty schema field is explicitly unresolved" },
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
    blocker: "The source-backed ProductDefinition shape is structurally complete; omitted collection meanings, narrowed references, and unavailable source facts remain explicitly open in the field mapping review.",
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
  const candidateMappingReview = candidateModel._mappingReview;
  delete candidateModel._mappingReview;
  const validation = await validationFor(definition, candidateModel);
  const fieldMappingBlockers = Object.entries(definition.fieldMappingBlockers).map(([field, reasons]) => ({
    field,
    status: candidateMappingReview?.fieldDispositions?.[field]?.status ?? "BLOCKED_NO_DIRECT_LOSSLESS_MAPPING",
    ...(candidateMappingReview?.fieldDispositions?.[field]?.source ? { sourceDisposition: candidateMappingReview.fieldDispositions[field].source } : {}),
    reasons: candidateMappingReview?.fieldDispositions?.[field]?.source ? [candidateMappingReview.fieldDispositions[field].source] : reasons,
    sourceAuthoritiesReviewed: definition.sources,
  }));
  const projection = {
    projectionKind: definition.name,
    projectionStatus: "GENERATED_CANDIDATE_NOT_ACCEPTED_NOT_CURRENT",
    subjectId: candidateModel.subjectId,
    sourceAuthorities: sources.map(observeSource),
    candidateModel,
    ...(candidateMappingReview ? { candidateMappingReview } : {}),
    candidateFieldSources: definition.candidateFieldSources,
    fieldMappingBlockers,
    derivationBoundary: "candidateModel is a structurally conformant partial projection. Every required schema property is present; empty collections and blank timestamps represent unresolved mappings, not accepted non-applicability. Source facts remain proposals until owners accept the mappings; this artifact does not claim semantic completeness, phase acceptance, or currentness.",
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
