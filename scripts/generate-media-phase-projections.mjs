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
import { readFile, readdir, writeFile } from "node:fs/promises";
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
      const textSource = (name) => sources.find((entry) => entry.sourceRef.endsWith(`/${name}`))?.text ?? "";
      const productTruth = textSource("PRODUCT-TRUTH.md");
      const missionSection = productTruth.match(/## Mission and intended outcomes\s+([\s\S]*?)(?=\n## )/u)?.[1] ?? "";
      const missionStatement = missionSection.split(/\n\s*\n/u)[0]?.replace(/\s+/gu, " ").trim() ?? "";
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
          statement: missionStatement,
          forWhom: `Canonical actor records: ${actors.map((actor) => actor.id).join(", ")}.`,
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
        desiredOutcomes: (goals.outcomes ?? []).map((outcome) => ({
          id: outcome.id,
          description: outcome.outcome,
          ...(outcome.actorRefs?.length === 1 ? { actorRef: outcome.actorRefs[0] } : {}),
        })),
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
        policies: (policy.productPolicy?.enforcementPoints ?? []).map((point, index) => ({
          id: `media.policy.enforcement.${index + 1}`,
          name: point.point,
          description: `Required checks: ${(point.requiredChecks ?? []).join(", ")}. Failure behavior: ${point.failure}`,
          enforcement: "strict",
        })),
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
            invariants: "No source record provides both invariant statement and violation semantics without inference.",
            journeys: `${(journeys.journeys ?? []).filter((journey) => journey.actors?.length !== 1).length} journeys have multiple actors; ProductDefinition requires one actorRef and no reviewed primary-actor mapping exists.`,
            trustContexts: "Principal kinds do not map directly to ProductDefinition trust levels.",
            successMeasures: "Quality dimensions and outcomes have no accepted ProductDefinition measure targets or baselines.",
            ownershipRules: "Owner roles are proposals; assignment of each concern to a ProductDefinition owner is pending.",
            timestamps: "No source authority records creation/update timestamps; generation time is not a source fact.",
            userIntents: `All ${(goals.intents ?? []).length} intents are omitted because the source does not assign ProductDefinition priority values; ${(goals.intents ?? []).filter((intent) => intent.actorRefs?.length !== 1).length} are also multi-actor and have no approved primary actor.`,
          },
          fieldDispositions: {
            purpose: { status: "DIRECT_SOURCE_MAPPING; OWNER_ACCEPTANCE_PENDING", source: "PRODUCT-TRUTH.md mission paragraph and actors-responsibilities.yaml actors" },
            scope: { status: "DIRECT_SOURCE_MAPPING; OWNER_ACCEPTANCE_PENDING", source: "goals-jtbd.yaml scopeStatement, includedFamilies, exclusionsFromMediaAuthority" },
            nonGoals: { status: "NO_DIRECT_PRODUCT_NON_GOAL_SOURCE; OWNER_DECISION_OPEN", source: "goals-jtbd.yaml scope exclusions are authority boundaries and are not assumed to be product non-goals" },
            actors: { status: "DIRECT_SOURCE_MAPPING; OWNER_ACCEPTANCE_PENDING", source: "actors-responsibilities.yaml actors and principals" },
            responsibilities: { status: "DIRECT_SOURCE_MAPPING; OWNER_ACCEPTANCE_PENDING", source: "actors-responsibilities.yaml actors[].responsibilities" },
            userIntents: { status: "PRIORITY_AND_ACTOR_MAPPING_OPEN", source: "goals-jtbd.yaml intents do not declare ProductDefinition priority; multi-actor intents have no approved primary actor" },
            businessIntents: { status: "NO_SOURCE_CLASSIFICATION; OWNER_DECISION_OPEN", source: "No business-intent collection in canonical PDP-0" },
            desiredOutcomes: { status: "DIRECT_SOURCE_MAPPING; OWNER_ACCEPTANCE_PENDING", source: "goals-jtbd.yaml outcomes" },
            capabilities: { status: "DIRECT_SOURCE_MAPPING; OWNER_ACCEPTANCE_PENDING", source: "capabilities.yaml capability leaves and exact requirementRefs" },
            requirements: { status: "PARTIAL_DIRECT_MAPPING; INTENT_TARGETS_UNRESOLVED", source: "requirements.yaml has exact intent traces, but ProductDefinition validation requires target userIntents with a resolved singular actor and priority" },
            domainRules: { status: "PDP-1_OWNER_DECISION_OPEN", source: "No PDP-0 records classified as ProductDefinition domainRules" },
            policies: { status: "DIRECT_FAIL_CLOSED_ENFORCEMENT_MAPPING; OWNER_ACCEPTANCE_PENDING", source: "policy-authority-model.yaml productPolicy.enforcementPoints requiredChecks and explicit failure behavior" },
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
      purpose: { sourceRef: ".product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md", sourcePath: "Mission and intended outcomes; actors-responsibilities.yaml#actors", mapping: "exact mission paragraph and generated enumeration of canonical actor IDs" },
      scope: { sourceRef: ".product-experience/pdp-0-product-truth/goals-jtbd.yaml", sourcePath: "scopeStatement, scope.includedFamilies, scope.exclusionsFromMediaAuthority", mapping: "direct source projection" },
      nonGoals: { sourceRef: null, sourcePath: null, mapping: "scope exclusions are authority boundaries, not established product non-goals" },
      actors: { sourceRef: ".product-experience/pdp-0-product-truth/actors-responsibilities.yaml", sourcePath: "actors and principals", mapping: "direct actor projection with human-to-person kind normalization" },
      responsibilities: { sourceRef: ".product-experience/pdp-0-product-truth/actors-responsibilities.yaml", sourcePath: "actors[].responsibilities", mapping: "actor-assigned responsibility statements with direct actor ownerRef" },
      userIntents: { sourceRef: ".product-experience/pdp-0-product-truth/goals-jtbd.yaml", sourcePath: "intents", mapping: "not projected; priority enum is absent and multiple actorRefs have no accepted primary actor mapping" },
      businessIntents: { sourceRef: null, sourcePath: null, mapping: "no classified source; unresolved owner decision" },
      desiredOutcomes: { sourceRef: ".product-experience/pdp-0-product-truth/goals-jtbd.yaml", sourcePath: "outcomes", mapping: "direct IDs/outcome text and actorRef only when the source declares one actor" },
      capabilities: { sourceRef: ".product-experience/pdp-0-product-truth/capabilities.yaml", sourcePath: "capabilities", mapping: "all 462 leaf identities, outcomes, and requirementRefs" },
      requirements: { sourceRef: ".product-experience/pdp-0-product-truth/requirements.yaml", sourcePath: "requirements plus nonfunctional-requirements.yaml", mapping: "direct statement/kind/priority; source traceToIntentIds are held out until target userIntent actor and priority mappings resolve" },
      domainRules: { sourceRef: null, sourcePath: null, mapping: "PDP-1 owns canonical domain rules; no accepted ProductDefinition mapping" },
      policies: { sourceRef: ".product-experience/pdp-0-product-truth/policy-authority-model.yaml", sourcePath: "productPolicy.enforcementPoints", mapping: "strict classification from explicit required checks and stop/deny/fail-closed behavior" },
      invariants: { sourceRef: ".product-experience/pdp-0-product-truth/constitution.yaml", sourcePath: "requirements", mapping: "violation behavior not supplied for all records" },
      journeys: { sourceRef: ".product-experience/pdp-0-product-truth/journey-catalog.yaml", sourcePath: "journeys", mapping: "no primary actor mapping; all 30 multi-actor journeys omitted" },
      trustContexts: { sourceRef: ".product-experience/pdp-0-product-truth/actors-responsibilities.yaml", sourcePath: "principals", mapping: "no accepted trust-level crosswalk" },
      successMeasures: { sourceRef: ".product-experience/pdp-0-product-truth/quality-policy.yaml", sourcePath: "qualityDimensions and metricDefinitions", mapping: "no accepted ProductDefinition targets or baselines" },
      ownershipRules: { sourceRef: ".product-experience/pdp-0-product-truth/actors-responsibilities.yaml", sourcePath: "accountability and responsibilityRoles", mapping: "concern-to-owner assignment remains pending" },
      createdAt: { sourceRef: null, sourcePath: null, mapping: "not supplied; empty schema field is explicitly unresolved" },
      updatedAt: { sourceRef: null, sourcePath: null, mapping: "not supplied; empty schema field is explicitly unresolved" },
    },
    fieldMappingBlockers: {
      nonGoals: ["No ProductDefinition nonGoal records with schema-defined reason fields are explicitly mapped."],
      requirements: ["Functional requirements contain direct intent IDs, but the public validator requires those targets in userIntents; those target records remain unresolved because source actor lists are multi-actor and priority is absent."],
      userIntents: ["Intent records do not directly supply required actor references and schema priority values through a resolved actor mapping."],
      businessIntents: ["No source collection is explicitly classified as business intents in the ProductDefinition sense."],
      domainRules: ["No owner-approved mapping selects source records as ProductDefinition domain rules with schema rule fields."],
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
      ".product-experience/pdp-2-design-interface-system/action-finality-grammar.yaml",
      ".product-experience/pdp-2-design-interface-system/gui/layout.yaml",
      ".product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml",
      ".product-experience/pdp-2-design-interface-system/gui/recipes/catalog.yaml",
      ".product-experience/pdp-2-design-interface-system/gui/patterns/catalog.yaml",
      ".product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml",
      ".product-experience/pdp-2-design-interface-system/media-token-aliases.yaml",
      ".product-experience/pdp-2-design-interface-system/component-contracts.yaml",
      ".product-experience/pdp-3-product-experience/navigation-contracts.yaml",
      ".product-experience/pdp-0-product-truth/state-models.yaml",
    ],
    candidate: (sources, generatedAt) => {
      const content = (path) => sources.find((source) => source.sourceRef === path)?.content ?? {};
      const typography = content(".product-experience/pdp-2-design-interface-system/typography-layout.yaml");
      const states = content(".product-experience/pdp-2-design-interface-system/semantic-state-grammar.yaml");
      const responsive = content(".product-experience/pdp-2-design-interface-system/responsive-adaptive.yaml");
      const accessibility = content(".product-experience/pdp-2-design-interface-system/accessibility.yaml");
      const localization = content(".product-experience/pdp-2-design-interface-system/localization-content.yaml");
      const finality = content(".product-experience/pdp-2-design-interface-system/action-finality-grammar.yaml");
      const layout = content(".product-experience/pdp-2-design-interface-system/gui/layout.yaml");
      const patterns = content(".product-experience/pdp-2-design-interface-system/gui/patterns/catalog.yaml");
      const componentBindings = content(".product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml");
      const recipeCatalog = content(".product-experience/pdp-2-design-interface-system/gui/recipes/catalog.yaml");
      const templateCatalog = content(".product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml");
      const componentContracts = content(".product-experience/pdp-2-design-interface-system/component-contracts.yaml");
      const navigation = content(".product-experience/pdp-3-product-experience/navigation-contracts.yaml");
      const domainStates = new Set((content(".product-experience/pdp-0-product-truth/state-models.yaml").models ?? [])
        .flatMap((model) => [
          ...(model.states ?? []).filter((state) => state && typeof state === "object" && typeof state.id === "string").map((state) => `${model.modelId}.${state.id}`),
          ...(model.rightsAssertionStates ?? []).map((state) => `${model.modelId}.rights.${state}`),
          ...(model.consentStates ?? []).map((state) => `${model.modelId}.consent.${state}`),
        ]));
      const componentIds = new Set((componentContracts.components ?? []).map((component) => component.id));
      const navigationRules = [
        ...(navigation.rules ?? []),
        ...(navigation.additionalJourneyFlows ?? []).flatMap((flow) => flow.rules ?? []),
      ];
      const bindings = (componentBindings.bindings ?? []).flatMap((binding) =>
        (binding.componentRefs ?? [])
          .filter((componentRef) => componentIds.has(componentRef) && binding.semanticRole)
          .map((componentRef) => ({
            id: `media.language.component-binding.${componentRef.replaceAll(/[^a-zA-Z0-9]+/gu, ".")}`,
            semanticConcept: binding.semanticRole,
            componentRef,
            notes: binding.status ?? "candidate binding; independent Shared owner review pending",
          })),
      );
      const domainStatePresentationMappings = (states.states ?? [])
        .filter((state) => domainStates.has(state.stateRef))
        .map((state) => ({
          id: `media.language.state-presentation.${state.stateRef.replaceAll(/[^a-zA-Z0-9]+/gu, ".")}`,
          domainStateId: state.stateRef,
          presentationEffect: `${state.label}: ${state.explanation}`,
        }));
      const outcomes = finality.rules ?? [];
      const consequentialRule = outcomes.find((rule) => /consequential effects/u.test(rule));
      return {
        id: "media.experience-language.candidate",
        subjectId: typography.productId,
        schemaVersion: experienceLanguageContract.module.EXPERIENCE_LANGUAGE_SCHEMA_VERSION,
        informationHierarchy: {
          id: "media.language.reading-order",
          levels: (typography.readingOrder ?? []).map((label, index) => ({
            level: index + 1,
            label,
            description: `Proposed reading-order level ${index + 1} from typography-layout.yaml.`,
          })),
        },
        densityProfiles: (typography.densityProfiles ?? []).map(({id,name,density,description}) => ({id,name,density,description})),
        presentationProfiles: (typography.presentationProfiles ?? []).map(({id,name,densityRef,description}) => ({id,name,densityRef,description})),
        semanticStates: (states.states ?? []).map((state) => ({
          id: state.stateRef,
          name: state.label,
          description: state.explanation,
        })),
        navigationPrinciples: navigationRules.map((description, index) => ({
          id: `media.language.navigation.${index + 1}`,
          name: `Navigation rule ${index + 1}`,
          description,
        })),
        interactionPatterns: (patterns.patterns ?? []).map((pattern) => ({
          id: pattern.id,
          name: pattern.id,
          description: pattern.intent,
          applicability: (pattern.anatomy ?? []).join(", "),
        })),
        decisionPatterns: consequentialRule ? [{
          id: "media.language.decision.consequential-effect-confirmation",
          name: "Consequential effect confirmation",
          description: consequentialRule,
          consequential: true,
        }] : [],
        recoveryPatterns: (finality.recoveryPatterns ?? []).map(({id,name,description,automaticRecovery}) => ({id,name,description,automaticRecovery})),
        progressiveDisclosureRules: (typography.progressiveDisclosureRules ?? []).map(({id,trigger,reveals,conceals}) => ({id,trigger,reveals,conceals})),
        responsiveRules: Object.entries(responsive.variants ?? {}).map(([breakpoint, variant]) => ({
          id: `media.language.responsive.${breakpoint}`,
          breakpoint: (variant.viewports ?? []).join(", "),
          behavior: variant.workMode,
        })),
        accessibilityRules: (accessibility.accessibilityRules ?? []).map(({id,standard,requirement,level}) => ({id,standard,requirement,level})),
        localizationRules: (localization.rules ?? []).map((rule, index) => ({
          id: `media.language.localization.${index + 1}`,
          concern: `Localization rule ${index + 1}`,
          strategy: rule,
        })),
        visualAuthority: {
          id: "media.language.visual-authority",
          description: "Media owns semantic aliases and composition; Shared owns primitive token values and styling behavior.",
        },
        componentBindings: bindings,
        recipeBindings: (recipeCatalog.recipes ?? []).map(({id,semanticPattern}) => ({id:`media.language.recipe-binding.${id.slice("media.gui.recipe.".length)}`,semanticPattern,recipeRef:id})),
        domainStatePresentationMappings,
        createdAt: generatedAt,
        updatedAt: generatedAt,
        _mappingReview: {
          generationTimestampSemantics: "createdAt/updatedAt record this candidate projection build only; they are not canonical Media authority timestamps.",
          mappedFields: ["id", "subjectId", "schemaVersion", "informationHierarchy", "semanticStates", "navigationPrinciples", "interactionPatterns", "decisionPatterns", "recoveryPatterns", "responsiveRules", "localizationRules", "visualAuthority", "componentBindings", "domainStatePresentationMappings", "createdAt", "updatedAt"],
          fieldDispositions: {
            id: { status: "DETERMINISTIC_CANDIDATE_IDENTIFIER", source: "projection generator" },
            subjectId: { status: "DIRECT_SOURCE_COPY", source: "typography-layout.yaml#productId" },
            schemaVersion: { status: "PUBLIC_CONTRACT_CONSTANT", source: "@ghatana/experience-language" },
            informationHierarchy: { status: "DIRECT_PROPOSAL_MAPPING", source: "typography-layout.yaml#readingOrder" },
            densityProfiles: { status: "OWNER_SELECTED_DIRECT_MAPPING", source: "typography-layout.yaml#densityProfiles" },
            presentationProfiles: { status: "OWNER_SELECTED_DIRECT_MAPPING", source: "typography-layout.yaml#presentationProfiles" },
            semanticStates: { status: "DIRECT_PROPOSAL_MAPPING", source: "semantic-state-grammar.yaml#states" },
            navigationPrinciples: { status: "DIRECT_PROPOSAL_MAPPING", source: "navigation-contracts.yaml#rules" },
            interactionPatterns: { status: "DIRECT_PROPOSAL_MAPPING", source: "gui/patterns/catalog.yaml#patterns" },
            decisionPatterns: { status: "DIRECT_PROPOSAL_MAPPING", source: "action-finality-grammar.yaml#rules" },
            recoveryPatterns: { status: "OWNER_SELECTED_DIRECT_MAPPING", source: "action-finality-grammar.yaml#recoveryPatterns" },
            progressiveDisclosureRules: { status: "OWNER_SELECTED_DIRECT_MAPPING", source: "typography-layout.yaml#progressiveDisclosureRules" },
            responsiveRules: { status: "DIRECT_PROPOSAL_MAPPING", source: "responsive-adaptive.yaml#variants" },
            accessibilityRules: { status: "OWNER_SELECTED_TARGET_REQUIRES_INDEPENDENT_REVIEW", source: "accessibility.yaml#accessibilityRules" },
            localizationRules: { status: "DIRECT_PROPOSAL_MAPPING", source: "localization-content.yaml#rules" },
            visualAuthority: { status: "DIRECT_OWNERSHIP_BOUNDARY_MAPPING", source: "DESIGN-LANGUAGE.md" },
            componentBindings: { status: "DIRECT_CANDIDATE_BINDING; OWNER_REVIEW_PENDING", source: "gui/semantic-component-bindings.yaml#bindings" },
            recipeBindings: { status: "MEDIA_RECIPE_BOUND_SHARED_ADMISSION_PENDING", source: "gui/recipes/catalog.yaml#recipes" },
            domainStatePresentationMappings: { status: "DIRECT_CANDIDATE_BINDING; PDP-0_STATE_REVIEW_PENDING", source: "semantic-state-grammar.yaml#states" },
            createdAt: { status: "PROJECTION_GENERATION_METADATA", source: "generator event" },
            updatedAt: { status: "PROJECTION_GENERATION_METADATA", source: "generator event" },
          },
          omittedCollections: {
            densityProfiles: "The Media labels simple/guided/expert do not match the public minimal/compact/standard/rich enum; no equivalence is inferred.",
            presentationProfiles: "No density profile can be bound until the source enum mismatch is resolved.",
            progressiveDisclosureRules: "The sources do not declare trigger/reveals/conceals records.",
            accessibilityRules: "The source explicitly leaves applicable standard and conformance level to the accessibility owner.",
            recoveryPatterns: "No source directly supplies the automaticRecovery boolean required by the public contract.",
            recipeBindings: "Templates and GUI patterns are not admitted Shared recipe IDs.",
          },
          ownerDecisionStatus: "PENDING; direct source projection and public validation do not establish semantic acceptance or phase closure.",
        },
      };
    },
    ownerResolvers: (sources) => {
      const componentIds = new Set((sources.find((source) => source.sourceRef.endsWith("/component-contracts.yaml"))?.content?.components ?? []).map((component) => component.id));
      const stateIds = new Set((sources.find((source) => source.sourceRef.endsWith("/state-models.yaml"))?.content?.models ?? [])
        .flatMap((model) => [
          ...(model.states ?? []).filter((state) => state && typeof state === "object" && typeof state.id === "string").map((state) => `${model.modelId}.${state.id}`),
          ...(model.rightsAssertionStates ?? []).map((state) => `${model.modelId}.rights.${state}`),
          ...(model.consentStates ?? []).map((state) => `${model.modelId}.consent.${state}`),
        ]));
      return {
        resolveComponent: (ref) => componentIds.has(ref),
        resolveDomainState: (ref) => stateIds.has(ref),
      };
    },
    candidateFieldSources: {
      id: { sourceRef: null, sourcePath: null, mapping: "deterministic candidate artifact identifier" },
      subjectId: { sourceRef: ".product-experience/pdp-2-design-interface-system/typography-layout.yaml", sourcePath: "productId", mapping: "identity copy" },
      schemaVersion: { sourceRef: "@ghatana/experience-language public export", sourcePath: "EXPERIENCE_LANGUAGE_SCHEMA_VERSION", mapping: "public contract constant" },
      informationHierarchy: { sourceRef: ".product-experience/pdp-2-design-interface-system/typography-layout.yaml", sourcePath: "readingOrder", mapping: "ordered list projected to numbered language hierarchy" },
      densityProfiles: { sourceRef: ".product-experience/pdp-2-design-interface-system/typography-layout.yaml", sourcePath: "density", mapping: "omitted; source enum differs from public contract enum" },
      presentationProfiles: { sourceRef: ".product-experience/pdp-2-design-interface-system/typography-layout.yaml", sourcePath: "density", mapping: "omitted pending a direct density mapping" },
      semanticStates: { sourceRef: ".product-experience/pdp-2-design-interface-system/semantic-state-grammar.yaml", sourcePath: "states", mapping: "direct proposed state IDs, labels, and explanations" },
      navigationPrinciples: { sourceRef: ".product-experience/pdp-3-product-experience/navigation-contracts.yaml", sourcePath: "rules and additionalJourneyFlows[].rules", mapping: "direct proposal text with deterministic candidate IDs" },
      interactionPatterns: { sourceRef: ".product-experience/pdp-2-design-interface-system/gui/patterns/catalog.yaml", sourcePath: "patterns", mapping: "direct IDs, intent, and anatomy" },
      decisionPatterns: { sourceRef: ".product-experience/pdp-2-design-interface-system/action-finality-grammar.yaml", sourcePath: "rules", mapping: "direct consequential-effect confirmation rule" },
      recoveryPatterns: { sourceRef: null, sourcePath: null, mapping: "not mapped; the source does not define automaticRecovery semantics" },
      progressiveDisclosureRules: { sourceRef: null, sourcePath: null, mapping: "no trigger/reveals/conceals source records" },
      responsiveRules: { sourceRef: ".product-experience/pdp-2-design-interface-system/responsive-adaptive.yaml", sourcePath: "variants", mapping: "direct viewport fixture and work-mode projection" },
      accessibilityRules: { sourceRef: ".product-experience/pdp-2-design-interface-system/accessibility.yaml", sourcePath: "requirements", mapping: "omitted because standard and level are not selected" },
      localizationRules: { sourceRef: ".product-experience/pdp-2-design-interface-system/localization-content.yaml", sourcePath: "rules", mapping: "direct proposal statements" },
      visualAuthority: { sourceRef: ".product-experience/pdp-2-design-interface-system/DESIGN-LANGUAGE.md", sourcePath: "Shared/Media ownership boundary", mapping: "direct ownership boundary summary; no token group binding" },
      componentBindings: { sourceRef: ".product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml", sourcePath: "bindings[].componentRefs and semanticRole", mapping: "exact Media component IDs only; external Shared admission remains pending" },
      recipeBindings: { sourceRef: ".product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml", sourcePath: "templates", mapping: "not mapped; template IDs do not establish Shared recipe IDs" },
      domainStatePresentationMappings: { sourceRef: ".product-experience/pdp-2-design-interface-system/semantic-state-grammar.yaml", sourcePath: "states[].stateRef/label/explanation", mapping: "exact references checked against PDP-0 state source; semantics remain proposal" },
      createdAt: { sourceRef: null, sourcePath: "candidate generation event", mapping: "projection build timestamp, not a product-authority timestamp" },
      updatedAt: { sourceRef: null, sourcePath: "candidate generation event", mapping: "projection build timestamp, not a product-authority timestamp" },
    },
    fieldMappingBlockers: {},
    blocker: "The required ExperienceLanguage shape is now populated from exact PDP sources wherever the public contract has a direct mapping; unresolved semantic fields and external review gates remain listed separately.",
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
      ".product-experience/pdp-3-product-experience/application-channel-registry.yaml",
      ".product-experience/pdp-3-product-experience/interaction-registry.yaml",
      ".product-experience/pdp-2-design-interface-system/component-contracts.yaml",
      ".product-experience/pdp-0-product-truth/state-models.yaml",
    ],
    candidate: (sources, generatedAt) => {
      const content = (path) => sources.find((source) => source.sourceRef === path)?.content ?? {};
      const screenRegistry = content(".product-experience/pdp-3-product-experience/screen-registry.yaml");
      const journeys = content(".product-experience/pdp-3-product-experience/journey-registry.yaml");
      const actions = content(".product-experience/pdp-3-product-experience/action-registry.yaml");
      const interactions = content(".product-experience/pdp-3-product-experience/interaction-registry.yaml");
      const channels = content(".product-experience/pdp-3-product-experience/application-channel-registry.yaml");
      const recovery = content(".product-experience/pdp-3-product-experience/recovery-finality-contracts.yaml");
      const componentContracts = content(".product-experience/pdp-2-design-interface-system/component-contracts.yaml");
      const stateModels = content(".product-experience/pdp-0-product-truth/state-models.yaml");
      const renderKind = (channelRef) => ({
        "media.channel.web": "web",
        "media.channel.cli": "cli",
        "media.channel.grpc-api": "api",
        "media.channel.http-api": "api",
        "media.channel.sdk": "other",
      })[channelRef] ?? "other";
      const screens = [
        ...(screenRegistry.screens ?? []).map((screen) => ({
          id: screen.id,
          name: screen.label,
          intent: screen.purpose,
          componentRefs: [],
          journeyRefs: [],
          stateRefs: [],
        })),
        ...(screenRegistry.laneViews ?? []).map((view) => ({
          id: view.id,
          name: view.label,
          intent: view.purpose,
          componentRefs: [],
          journeyRefs: [],
          stateRefs: [],
        })),
      ];
      const candidateActions = (actions.actions ?? []).map((action) => ({
        id: action.id,
        name: action.label,
        kind: "user",
        description: action.effect,
        preconditions: action.preconditions ?? [],
        producesEffectRefs: [],
      }));
      const allStates = (stateModels.models ?? []).flatMap((model) => (model.states ?? [])
        .filter((state) => state && typeof state === "object" && typeof state.id === "string" && typeof state.terminal === "boolean" && typeof state.meaning === "string")
        .map((state) => ({
        id: `${model.modelId}.${state.id}`,
        name: `${model.modelId}: ${state.id}`,
        description: `${model.purpose}: ${state.meaning}`,
        isTerminal: state.terminal,
        invariants: model.invariants ?? [],
      })));
      const recoveryMappings = (recovery.contracts ?? []).map((contract) => ({
        id: contract.id,
        errorKind: contract.state,
        recoveryPath: contract.allowed,
        automaticRecovery: false,
        userActionRequired: true,
      }));
      return {
        id: "media.experience-definition.candidate",
        subjectId: screenRegistry.productId,
        schemaVersion: experienceSpecificationContract.module.EXPERIENCE_SPECIFICATION_SCHEMA_VERSION,
        contextDimensions: channels.channels?.length ? [{
          id: "media.context.application-channel",
          semanticKind: "application-channel",
          displayName: "Application channel",
          importance: "primary",
          valueType: "enum",
          allowedValues: channels.channels.map((channel) => channel.channelRef),
        }] : [],
        renderTargets: (channels.channels ?? []).map((channel) => ({
          id: channel.channelRef,
          kind: renderKind(channel.channelRef),
          displayName: channel.channelRef.replace(/^media\.channel\./u, "").toUpperCase(),
          description: `${channel.role}; ${channel.support}`,
        })),
        componentContracts: (componentContracts.components ?? []).map((component) => ({
          id: component.id,
          name: component.id,
          semanticPurpose: component.purpose,
          requiredProps: [],
        })),
        views: screens,
        journeys: [],
        interactions: (interactions.interactions ?? []).filter((interaction) => actions.actions?.some((action) => action.id === interaction.effectRef)).map((interaction) => ({
          id: interaction.id,
          name: interaction.id,
          trigger: interaction.input,
          preconditions: [],
          actionRef: interaction.effectRef,
        })),
        states: allStates,
        transitions: [],
        actions: candidateActions,
        effects: [],
        finality: [],
        recovery: recoveryMappings,
        scenarios: [],
        fixtures: [],
        search: [],
        inspections: [],
        createdAt: generatedAt,
        updatedAt: generatedAt,
        _mappingReview: {
          generationTimestampSemantics: "createdAt/updatedAt record this candidate projection build only; they are not canonical Media authority timestamps.",
          mappedFields: ["id", "subjectId", "schemaVersion", "contextDimensions", "renderTargets", "componentContracts", "views", "interactions", "states", "actions", "recovery", "createdAt", "updatedAt"],
          fieldDispositions: {
            id: { status: "DETERMINISTIC_CANDIDATE_IDENTIFIER", source: "projection generator" },
            subjectId: { status: "DIRECT_SOURCE_COPY", source: "screen-registry.yaml#productId" },
            schemaVersion: { status: "PUBLIC_CONTRACT_CONSTANT", source: "@ghatana/experience-specification" },
            contextDimensions: { status: "DIRECT_PROPOSAL_MAPPING", source: "application-channel-registry.yaml#channels" },
            renderTargets: { status: "DIRECT_PROPOSAL_MAPPING", source: "application-channel-registry.yaml#channels" },
            componentContracts: { status: "PARTIAL_DIRECT_MAPPING; REQUIRED_PROPS_UNRESOLVED", source: "component-contracts.yaml#components" },
            views: { status: "DIRECT_IDENTITY_AND_PURPOSE_MAPPING; CROSS_REFERENCES_PENDING", source: "screen-registry.yaml#screens,laneViews" },
            journeys: { status: "BLOCKED_PRIMARY_ACTOR_AND_STEP_BINDINGS", source: "journey-registry.yaml#journeys" },
            interactions: { status: "PARTIAL_DIRECT_MAPPING; PRECONDITIONS_UNALLOCATED", source: "interaction-registry.yaml#interactions" },
            states: { status: "DIRECT_PROPOSAL_MAPPING; PDP-1_ACCEPTANCE_PENDING", source: "state-models.yaml#models[].states" },
            transitions: { status: "BLOCKED_CANONICAL_ACTION_AND_GUARD_BINDINGS", source: "state-models.yaml#models[].transitions" },
            actions: { status: "DIRECT_UI_PROPOSAL_MAPPING; EFFECT_LINKS_PENDING", source: "action-registry.yaml#actions" },
            effects: { status: "BLOCKED_EFFECT_KIND_AND_REVERSIBILITY_MAPPING", source: "action-registry.yaml#actions[].effect/reversible" },
            finality: { status: "BLOCKED_ACTION_SCOPED_FINALITY_MAPPING", source: "action-registry.yaml#actions[].finality" },
            recovery: { status: "DIRECT_PROPOSAL_MAPPING; CROSS_REFERENCES_PENDING", source: "recovery-finality-contracts.yaml#contracts" },
            scenarios: { status: "BLOCKED_STARTING_STATE_AND_CONTEXT_MAPPING", source: "scenario-fixture-registry.yaml#fixtures" },
            fixtures: { status: "BLOCKED_SCENARIO_LINKAGE", source: "scenario-fixture-registry.yaml#fixtures" },
            search: { status: "BLOCKED_NO_SCHEMA_SHAPED_SEARCH_AUTHORITY", source: "no direct source records" },
            inspections: { status: "BLOCKED_EXPLORER_IS_NOT_PDP-3_AUTHORITY", source: "explorer/tools-binding.yaml" },
            createdAt: { status: "PROJECTION_GENERATION_METADATA", source: "generator event" },
            updatedAt: { status: "PROJECTION_GENERATION_METADATA", source: "generator event" },
          },
          collectionCounts: {
            views: screens.length,
            registryJourneys: (journeys.journeys ?? []).length,
            projectedJourneys: 0,
            registryActions: candidateActions.length,
            registryInteractions: (interactions.interactions ?? []).length,
            projectedStates: allStates.length,
          },
          ownerDecisionStatus: "PENDING; directly projected records and schema validation do not establish semantic acceptance or phase closure.",
        },
      };
    },
    candidateFieldSources: {
      id: { sourceRef: null, sourcePath: null, mapping: "deterministic candidate artifact identifier" },
      subjectId: { sourceRef: ".product-experience/pdp-3-product-experience/screen-registry.yaml", sourcePath: "productId", mapping: "identity copy" },
      schemaVersion: { sourceRef: "@ghatana/experience-specification public export", sourcePath: "EXPERIENCE_SPECIFICATION_SCHEMA_VERSION", mapping: "public contract constant" },
      contextDimensions: { sourceRef: ".product-experience/pdp-3-product-experience/application-channel-registry.yaml", sourcePath: "channels[].channelRef", mapping: "one typed enum context dimension over the exact selected-lane channel IDs" },
      renderTargets: { sourceRef: ".product-experience/pdp-3-product-experience/application-channel-registry.yaml", sourcePath: "channels", mapping: "direct channel target records; support disposition remains proposal" },
      componentContracts: { sourceRef: ".product-experience/pdp-2-design-interface-system/component-contracts.yaml", sourcePath: "components[].id and purpose", mapping: "direct identity and purpose; public required-prop contracts remain unresolved" },
      views: { sourceRef: ".product-experience/pdp-3-product-experience/screen-registry.yaml", sourcePath: "screens and laneViews", mapping: "all 47 exact view identities, names, and purposes; cross references remain separately pending" },
      journeys: { sourceRef: ".product-experience/pdp-3-product-experience/journey-registry.yaml", sourcePath: "journeys", mapping: "not projected because the public contract requires one actorRef and current journey actor lists are multi-actor" },
      interactions: { sourceRef: ".product-experience/pdp-3-product-experience/interaction-registry.yaml", sourcePath: "interactions", mapping: "direct interaction ID/input/effectRef projection; preconditions not allocated by source" },
      states: { sourceRef: ".product-experience/pdp-0-product-truth/state-models.yaml", sourcePath: "models[].states", mapping: "direct proposed state IDs, meaning, terminality, and model invariants" },
      transitions: { sourceRef: ".product-experience/pdp-0-product-truth/state-models.yaml", sourcePath: "models[].transitions", mapping: "not projected because legal PDP-1 actionRef and guard bindings remain unresolved" },
      actions: { sourceRef: ".product-experience/pdp-3-product-experience/action-registry.yaml", sourcePath: "actions", mapping: "direct UI action identity, label, effect prose, and preconditions; user kind is a proposal classification" },
      effects: { sourceRef: ".product-experience/pdp-3-product-experience/action-registry.yaml", sourcePath: "actions[].effect/reversible", mapping: "not projected until effect kind and boolean reversibility semantics are directly classifiable" },
      finality: { sourceRef: ".product-experience/pdp-3-product-experience/action-registry.yaml", sourcePath: "actions[].finality/confirmation", mapping: "not projected because finality requires a resolved action contract and boolean confirmation/undoability" },
      recovery: { sourceRef: ".product-experience/pdp-3-product-experience/recovery-finality-contracts.yaml", sourcePath: "contracts", mapping: "direct proposed state/allowed/blocked recovery path; no automatic recovery is asserted" },
      scenarios: { sourceRef: ".product-experience/pdp-3-product-experience/scenario-fixture-registry.yaml", sourcePath: "fixtures", mapping: "not projected without exact starting-state and context-dimension bindings" },
      fixtures: { sourceRef: ".product-experience/pdp-3-product-experience/scenario-fixture-registry.yaml", sourcePath: "fixtures", mapping: "not projected without a linked ExperienceDefinition scenario" },
      search: { sourceRef: ".product-experience/pdp-3-product-experience/screen-registry.yaml", sourcePath: "screen purposes", mapping: "no schema-shaped searchable type authority is defined" },
      inspections: { sourceRef: ".product-experience/explorer/tools-binding.yaml", sourcePath: "Explorer inspection behavior", mapping: "Explorer observations are not accepted PDP-3 inspection contracts" },
      createdAt: { sourceRef: null, sourcePath: "candidate generation event", mapping: "projection build timestamp, not a product-authority timestamp" },
      updatedAt: { sourceRef: null, sourcePath: "candidate generation event", mapping: "projection build timestamp, not a product-authority timestamp" },
    },
    fieldMappingBlockers: {
      componentContracts: ["Required public component props are not supplied by component anatomy; the candidate leaves requiredProps empty rather than reclassifying anatomy as props."],
      views: ["Exact view records are projected, but component, journey, and state references remain unresolved across authorities."],
      journeys: ["Journey actor lists are multi-actor, and step-level view/action/state/transition bindings remain proposal or unresolved; the public model requires one actorRef."],
      interactions: ["Interaction IDs, triggers, and action refs are projected; action preconditions are not allocated to each interaction."],
      states: ["State records are directly projected from PDP-0 proposal source; PDP-1 state authority, transition semantics, and invariants remain pending."],
      transitions: ["Transition bindings are proposals and do not establish accepted transition semantics or references."],
      actions: ["UI action proposals are projected; canonical operation authority and action-to-effect relations are unresolved."],
      effects: ["No direct mapping supplies schema effect kinds and reversibility for every source action."],
      finality: ["Recovery/finality proposals do not provide a resolved set of ExperienceDefinition finality records."],
      recovery: ["Recovery contracts are projected as proposals; action/state/finality references and independent review remain pending."],
      scenarios: ["Scenario records describe fixtures/proposals and are not mapped to the schema's behavioral scenario contract."],
      fixtures: ["Fixture registry records do not directly supply the ExperienceDefinition fixture shape and linked source data."],
      search: ["No PDP-3 source explicitly defines search contracts in the ExperienceDefinition schema shape."],
      inspections: ["Specification inspection surfaces are Explorer behavior, not source-defined Product Experience inspection contracts."],
    },
    blocker: "The required ExperienceDefinition shape is populated from exact PDP sources wherever direct mappings exist; exact remaining semantic, cross-reference, and acceptance blockers stay listed separately.",
  },
];

const cache = new Map();
const experienceDefinition = definitions.find((definition) => definition.name === "experience-specification");
for (const directory of ["screen-contracts", "journey-contracts"]) {
  const sourceDirectory = `.product-experience/pdp-3-product-experience/${directory}`;
  const entries = await readdir(resolve(root, sourceDirectory), { withFileTypes: true });
  experienceDefinition.sources.push(...entries
    .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
    .map((entry) => `${sourceDirectory}/${entry.name}`)
    .sort());
}

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

async function validationFor(definition, candidate, sources) {
  const schema = JSON.parse(await readFile(resolve(root, definition.schemaPath), "utf8"));
  const Validator = definition.schemaDialect === "2020" ? Ajv2020 : Ajv;
  const ajv = new Validator({ allErrors: true, strict: false });
  addFormats(ajv);
  const validateSchema = ajv.compile(schema);
  const schemaValid = Boolean(validateSchema(candidate));
  const schemaBlockers = schemaValid ? [] : (validateSchema.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`);
  let publicValidatorBlockers = [];
  try {
    const ownerResolvers = definition.ownerResolvers?.(sources);
    definition.validator(candidate, ...(ownerResolvers === undefined ? [] : [ownerResolvers]));
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
const generationTimestamp = new Date().toISOString();
for (const definition of definitions) {
  const sources = await Promise.all(definition.sources.map(loadSource));
  const candidateModel = definition.candidate(sources, generationTimestamp);
  const candidateMappingReview = candidateModel._mappingReview;
  delete candidateModel._mappingReview;
  const validation = await validationFor(definition, candidateModel, sources);
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
    derivationBoundary: "candidateModel is a structurally conformant partial projection populated from direct source records where mappings exist. Empty collections represent unresolved mappings, never accepted non-applicability. createdAt/updatedAt are projection-build timestamps only; they are not canonical product timestamps. Source facts remain proposals until owners accept the mappings; this artifact does not claim semantic completeness, phase acceptance, or currentness.",
    knownBlockers: [definition.blocker],
    validation,
    acceptance: "NOT_CLAIMED",
    currentness: "NOT_GENERATED; Lifecycle authority required",
  };
  const bytes = `${JSON.stringify(projection, null, 2)}\n`;
  const outputPath = resolve(root, definition.output);
  if (checkOnly) {
    const current = await readFile(outputPath, "utf8").catch(() => null);
    let comparableCurrent = current;
    let comparableBytes = bytes;
    if (current !== null && ["experience-language", "experience-specification"].includes(definition.name)) {
      const normalizeGeneratedTimestamps = (text) => {
        try {
          const parsed = JSON.parse(text);
          parsed.candidateModel.createdAt = "<PROJECTION_GENERATION_TIMESTAMP>";
          parsed.candidateModel.updatedAt = "<PROJECTION_GENERATION_TIMESTAMP>";
          return `${JSON.stringify(parsed, null, 2)}\n`;
        } catch {
          return text;
        }
      };
      comparableCurrent = normalizeGeneratedTimestamps(current);
      comparableBytes = normalizeGeneratedTimestamps(bytes);
    }
    if (comparableCurrent !== comparableBytes) throw new Error(`${definition.output} is stale; run node scripts/generate-media-phase-projections.mjs`);
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
