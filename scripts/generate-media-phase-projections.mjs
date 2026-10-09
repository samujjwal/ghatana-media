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
import { validateBusinessMeasureDefinitions, resolveAcceptedDomainRuleRecords } from "./lib/product-definition-domain-rule-mapping.mjs";

import { resolveExperienceDefinitionSemantics } from "./lib/media-experience-definition-mapping.mjs";

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
const [experienceLanguageContract, experienceSpecificationContract] = await Promise.all([
  loadContract("@ghatana/experience-language", "experience-language", "src/index.ts"),
  loadContract("@ghatana/experience-specification", "experience-specification", "src/index.ts"),
]);
// ProductDefinition's local public source includes X-01's optional timestamps
// and plural journey actors. The installed package can lag this source until
// publication, so validate the source API and retain installed-artifact
// verification as an explicit pending gate.
const productDefinitionContract = {
  module: await import(new URL(`file://${resolve(contractSourceRoot, "product-definition", "src/index.ts")}`)),
  binding: "sibling public source entrypoint; package publication and installed-artifact verification pending",
};
const checkOnly = process.argv.includes("--check");
const strict = process.argv.includes("--strict");
const businessIntentMeasureId = (businessIntentId) => `${businessIntentId}.measure`;

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
      ".product-experience/pdp-1-domain-data/state-adjudication.yaml",
      ".product-experience/pdp-0-product-truth/goals-jtbd.yaml",
      ".product-experience/pdp-0-product-truth/profile-semantics.yaml",
      ".product-experience/pdp-0-product-truth/intent-resolutions.yaml",
      ".product-experience/pdp-0-product-truth/actors-responsibilities.yaml",
      ".product-experience/pdp-0-product-truth/capabilities.yaml",
      ".product-experience/pdp-0-product-truth/requirements.yaml",
      ".product-experience/pdp-0-product-truth/journey-catalog.yaml",
      ".product-experience/pdp-0-product-truth/journey-actor-resolutions.yaml",
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
      const constitution = source("constitution.yaml");
      const stateAdjudication = source("state-adjudication.yaml");
      const intentResolutions = source("intent-resolutions.yaml");
      const actorSource = source("actors-responsibilities.yaml");
      const capabilities = source("capabilities.yaml");
      const requirements = source("requirements.yaml");
      const journeys = source("journey-catalog.yaml");
      const journeyActorResolutions = source("journey-actor-resolutions.yaml");
      const invariantRecords = constitution.invariants?.records ?? [];
      const trustContextRecords = actorSource.trustContexts?.contexts ?? [];
      const ownershipRuleRecords = actorSource.ownershipRules?.rules ?? [];
      const nfr = source("nonfunctional-requirements.yaml");
      const policy = source("policy-authority-model.yaml");
      const intentResolutionById = new Map((intentResolutions.intents ?? []).map((resolution) => [resolution.id, resolution]));
      const resolvedUserIntents = (goals.intents ?? []).flatMap((intent) => {
        const resolution = intentResolutionById.get(intent.id);
        if (resolution?.actorStatus !== "resolved" || typeof resolution.actorRef !== "string" || !["must", "should", "could", "wont"].includes(resolution.priority)) return [];
        return [{ id: intent.id, actor: resolution.actorRef, intent: intent.description, priority: resolution.priority }];
      });
      const resolvedUserIntentIds = new Set(resolvedUserIntents.map((intent) => intent.id));
      const unresolvedUserIntentIds = (goals.intents ?? []).filter((intent) => !resolvedUserIntentIds.has(intent.id)).map((intent) => intent.id);
      const userIntentsFullyResolved = unresolvedUserIntentIds.length === 0;
      const intentTracesWithUnresolvedTargets = (requirements.requirements ?? []).flatMap((requirement) => {
        const unresolvedIntentRefs = (requirement.traceToIntentIds ?? []).filter((intentId) => !resolvedUserIntentIds.has(intentId));
        return unresolvedIntentRefs.length ? [{ requirementId: requirement.id, unresolvedIntentRefs }] : [];
      });
      const unresolvedIntentTraceRefCount = intentTracesWithUnresolvedTargets.reduce((count, entry) => count + entry.unresolvedIntentRefs.length, 0);
      const requirementsFullyResolved = intentTracesWithUnresolvedTargets.length === 0;
      const requirementTraceDispositionCounts = (requirements.requirements ?? []).reduce((counts, requirement) => {
        const refs = requirement.traceToIntentIds ?? [];
        const resolvedCount = refs.filter((intentId) => resolvedUserIntentIds.has(intentId)).length;
        if (refs.length && resolvedCount === refs.length) counts.fullyResolved++;
        else if (resolvedCount > 0) counts.partial++;
        else counts.unresolved++;
        return counts;
      }, { fullyResolved: 0, partial: 0, unresolved: 0 });
      const journeyResolutionById = new Map((journeyActorResolutions.journeys ?? []).map((resolution) => [resolution.id, resolution]));
      const projectedJourneys = (journeys.journeys ?? []).flatMap((journey) => {
        const resolution = journeyResolutionById.get(journey.id);
        if (!resolution || !Array.isArray(resolution.collaboratorActorRefs) || resolution.collaboratorActorRefs.length === 0) return [];
        return [{
          id: journey.id,
          name: journey.title,
          ...(resolution.actorStatus === "resolved" && typeof resolution.initiatingActorRef === "string"
            ? { actorRef: resolution.initiatingActorRef }
            : {}),
          actorRefs: resolution.collaboratorActorRefs,
          steps: [journey.preconditions, journey.completion],
          ...(journey.outcomeRefs?.length === 1 ? { desiredOutcomeRef: journey.outcomeRefs[0] } : {}),
        }];
      });
      const unresolvedJourneyIds = (journeys.journeys ?? []).filter((journey) => journeyResolutionById.get(journey.id)?.actorStatus !== "resolved").map((journey) => journey.id);
      const journeyInitiatorsFullyResolved = unresolvedJourneyIds.length === 0;
      const businessIntentMeasureProposals = (goals.businessIntents ?? [])
        .filter(({ measuredBy }) => typeof measuredBy === "string" && measuredBy.trim().length > 0)
        .map(({ id, measuredBy }) => ({
          businessIntentId: id,
          successMeasureId: businessIntentMeasureId(id),
          description: measuredBy,
        }));
      const businessIntentMeasureIdById = new Map(businessIntentMeasureProposals
        .map(({ businessIntentId, successMeasureId }) => [businessIntentId, successMeasureId]));
      validateBusinessMeasureDefinitions(goals, capabilities, source("profile-semantics.yaml"));
      const businessMeasureContracts = new Map((goals.successMeasureContracts?.records ?? [])
        .map((record) => [record.id, record]));
      const domainRuleRecords = resolveAcceptedDomainRuleRecords(
        constitution.domainRules?.records ?? [],
        stateAdjudication.ownerAcceptedPolicyDecisions,
      );
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
        nonGoals: (goals.nonGoals ?? []).map(({ id, description, reason }) => ({ id, description, reason })),
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
        userIntents: resolvedUserIntents,
        businessIntents: (goals.businessIntents ?? []).map(({ id, description }) => ({
          id,
          description,
          ...(businessIntentMeasureIdById.has(id) ? { measuredBy: businessIntentMeasureIdById.get(id) } : {}),
        })),
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
            traceToIntentIds: (requirement.traceToIntentIds ?? []).filter((intentId) => resolvedUserIntentIds.has(intentId)),
          })),
          ...(nfr.requirements ?? []).map((requirement) => ({
            id: requirement.id,
            statement: requirement.statement,
            kind: "non-functional",
            priority: requirement.priority,
            traceToIntentIds: [],
          })),
        ],
        domainRules: domainRuleRecords.map(({ id, name, rule, rationale }) => ({ id, name, rule, rationale })),
        policies: (policy.productPolicy?.enforcementPoints ?? []).map((point, index) => ({
          id: `media.policy.enforcement.${index + 1}`,
          name: point.point,
          description: `Required checks: ${(point.requiredChecks ?? []).join(", ")}. Failure behavior: ${point.failure}`,
          enforcement: "strict",
        })),
        invariants: invariantRecords.map(({ id, statement, violation }) => ({ id, statement, violation })),
        journeys: projectedJourneys,
        trustContexts: trustContextRecords.map((context) => ({
          id: context.id,
          level: context.trustLevel,
          description: `${context.dataSensitivity}; ${context.effectScope}. ${context.auditRationale}`,
          auditRequired: context.auditRequired,
        })),
        successMeasures: businessIntentMeasureProposals.map(({ businessIntentId, successMeasureId, description }) => {
          const contract = businessMeasureContracts.get(successMeasureId);
          return {
            id: successMeasureId,
            description,
            ...(contract ? {
              metric: `${contract.metric} (unit: ${contract.unit}; denominator: ${contract.denominator}; applicability: ${contract.applicability}; acceptance: ${contract.acceptanceCriterion}; evidence: ${contract.evidenceMethod}; numerator: ${contract.numerator}; calculation: ${contract.calculation}; value unit: ${contract.valueUnit}; outcomes: ${contract.outcomeRefs.join(", ")}; capability trace: ${contract.capabilityRefs.join(", ")}; profile axes: ${contract.profileAxisRefs.join(", ")}; profile binding: ${contract.profileBinding}; baseline policy: ${contract.baselinePolicy}; target policy: ${contract.targetPolicy}; population: ${contract.populationEnumeration})`,
              baseline: contract.baseline,
              target: contract.target,
            } : {}),
          };
        }),
        ownershipRules: ownershipRuleRecords.map((rule) => ({
          id: rule.id,
          concern: rule.concern,
          owner: rule.accountableRoleRef,
        })),
        _mappingReview: {
          omittedCollections: {
            domainRules: `${domainRuleRecords.length} source rules map from bounded Media-owner decisions under state-adjudication.yaml#ownerAcceptedPolicyDecisions, accepted as a projection under PXD-035. PDP-1 remains the semantic authority; this is a ProductDefinition projection only. Proposal-only machine/transition records remain excluded; P0-010 independent review remains pending.`,
            journeys: journeyInitiatorsFullyResolved
              ? `All ${(journeys.journeys ?? []).length} initiating actorRefs have source-bound P0-04 decisions; all collaborator actorRefs are directly projected. Independent review remains pending.`
              : `${unresolvedJourneyIds.length} initiating actorRefs remain omitted because P0-04 did not select one; all collaborator actorRefs are directly projected. Independent review remains pending.`,
            timestamps: "createdAt and updatedAt are optional authored metadata; omitted intentionally because no Media source provides timestamp provenance.",
            userIntents: `${resolvedUserIntents.length} of ${(goals.intents ?? []).length} intents map from explicit P0-04 actor/priority decisions; ${unresolvedUserIntentIds.length} actor resolutions remain unresolved. Independent review is pending.`,
          },
          mappedCollections: {
            invariants: `${invariantRecords.length} exact statement/violation records from constitution.yaml; P0-010 review pending.`,
            trustContexts: `${trustContextRecords.length} contexts directly map trustLevel, dataSensitivity, effectScope, and auditRequired; P0-010 review pending.`,
            ownershipRules: `${ownershipRuleRecords.length} concerns map to exact accountableRoleRef owner IDs; contractOwner and executionAuthority remain separate source evidence and are not folded into owner/delegatedTo.`,
            userIntents: `${resolvedUserIntents.length} of ${(goals.intents ?? []).length} source intents have exact actor/priority decisions; P0-010 independent review pending.`,
            journeys: `${projectedJourneys.length} of ${(journeys.journeys ?? []).length} source journeys have exact representative initiators; all source collaborator actors remain projected; P0-010 independent review pending.`,
            businessIntentMeasures: `${businessIntentMeasureProposals.length} source businessIntent.measuredBy statements are projected as exact description-only proposals with deterministic IDs; no metric, profile applicability, target, baseline, qualitative acceptance criterion, or qualification is asserted.`,
            successMeasures: `${businessIntentMeasureProposals.length} source-bound measures project their authored metric, unit, denominator, applicability, acceptance criterion, evidence method, and explicit NOT_EVALUATED/NOT_SET baseline/target fields. No numeric result or qualification is asserted; PXD-048 accepts the source crosswalk and calculation definition; measured population, independent calibration, and qualification remain NOT_EVALUATED.`,
          },
          businessIntentMeasureProposals: businessIntentMeasureProposals.map((proposal) => ({
            ...proposal,
            sourceRef: "goals-jtbd.yaml#/businessIntents",
            sourceField: "measuredBy",
            contractRef: `.product-experience/pdp-0-product-truth/goals-jtbd.yaml#/successMeasureContracts/records[${proposal.successMeasureId}]`,
            contract: businessMeasureContracts.get(proposal.successMeasureId) ?? null,
            disposition: "SOURCE_DEFINED_MEASUREMENT_CONTRACT; TARGET_NOT_SET; BASELINE_AND_QUALIFICATION_NOT_EVALUATED; COORDINATOR_AND_INDEPENDENT_REVIEW_PENDING",
          })),
          ownershipRuleDetails: ownershipRuleRecords.map((rule) => ({
            id: rule.id,
            accountableRoleRef: rule.accountableRoleRef,
            executionAuthority: rule.executionAuthority,
            contractOwner: rule.contractOwner ?? null,
            bindingStatus: rule.bindingStatus ?? null,
          })),
          fieldDispositions: {
            id: { status: "DETERMINISTIC_CANDIDATE_IDENTIFIER", source: "projection generator; no canonical ProductDefinition ID source" },
            subjectId: { status: "DIRECT_SOURCE_COPY", source: "capabilities.yaml#productId" },
            schemaVersion: { status: "PUBLIC_CONTRACT_CONSTANT", source: "@ghatana/product-definition#PRODUCT_DEFINITION_SCHEMA_VERSION" },
            purpose: { status: "DIRECT_SOURCE_MAPPING; OWNER_ACCEPTANCE_PENDING", source: "PRODUCT-TRUTH.md mission paragraph and actors-responsibilities.yaml actors" },
            scope: { status: "DIRECT_SOURCE_MAPPING; OWNER_ACCEPTANCE_PENDING", source: "goals-jtbd.yaml scopeStatement, includedFamilies, exclusionsFromMediaAuthority" },
            nonGoals: { status: "OWNER_SELECTED_DIRECT_MAPPING; P0-010_REVIEW_PENDING", source: "goals-jtbd.yaml#nonGoals explicit Media product-owner decisions with schema reason fields" },
            actors: { status: "DIRECT_SOURCE_MAPPING; OWNER_ACCEPTANCE_PENDING", source: "actors-responsibilities.yaml actors and principals" },
            responsibilities: { status: "DIRECT_SOURCE_MAPPING; OWNER_ACCEPTANCE_PENDING", source: "actors-responsibilities.yaml actors[].responsibilities" },
            userIntents: { status: userIntentsFullyResolved ? "DIRECT_SOURCE_MAPPING; OWNER_DECISION_RECORDED; INDEPENDENT_REVIEW_PENDING" : `PARTIAL_DIRECT_MAPPING; ${unresolvedUserIntentIds.length}_ACTOR_RESOLUTIONS_OPEN; INDEPENDENT_REVIEW_PENDING`, source: "goals-jtbd.yaml#intents joined by exact id to intent-resolutions.yaml#intents" },
            businessIntents: { status: "OWNER_SELECTED_DIRECT_MAPPING; P0-010_REVIEW_PENDING", source: "goals-jtbd.yaml#businessIntents explicit owner-selected business outcomes and measures" },
            desiredOutcomes: { status: "DIRECT_SOURCE_MAPPING; OWNER_ACCEPTANCE_PENDING", source: "goals-jtbd.yaml outcomes" },
            capabilities: { status: "DIRECT_SOURCE_MAPPING; OWNER_ACCEPTANCE_PENDING", source: "capabilities.yaml capability leaves and exact requirementRefs" },
            requirements: { status: requirementsFullyResolved ? "DIRECT_SOURCE_MAPPING; ALL_INTENT_TARGETS_RESOLVED" : `PARTIAL_DIRECT_MAPPING; ${intentTracesWithUnresolvedTargets.length}_REQUIREMENTS_HAVE_UNRESOLVED_INTENT_TARGETS`, source: "requirements.yaml#requirements[].traceToIntentIds filtered to the exact resolved ProductDefinition userIntents" },
            domainRules: { status: `${domainRuleRecords.length}_BOUNDED_PDP1_OWNER_DECISIONS_PROJECTED; PXD-035_ACCEPTED; P0-010_INDEPENDENT_REVIEW_PENDING`, source: "constitution.yaml#domainRules.records joined by exact sourceRef to state-adjudication.yaml#ownerAcceptedPolicyDecisions; proposal-only state/transition records excluded" },
            policies: { status: "DIRECT_FAIL_CLOSED_ENFORCEMENT_MAPPING; OWNER_ACCEPTANCE_PENDING", source: "policy-authority-model.yaml productPolicy.enforcementPoints requiredChecks and explicit failure behavior" },
            invariants: { status: "DIRECT_STATEMENT_AND_VIOLATION_MAPPING; P0-010_REVIEW_PENDING", source: "constitution.yaml#invariants.records" },
            journeys: { status: `DIRECT_MULTI_ACTOR_MAPPING; ${unresolvedJourneyIds.length}_OPTIONAL_INITIATING_ACTORS_UNRESOLVED; INDEPENDENT_REVIEW_PENDING`, source: "journey-catalog.yaml#journeys joined by exact id to journey-actor-resolutions.yaml#journeys#collaboratorActorRefs; actorRef only when initiatingActorRef is resolved" },
            trustContexts: { status: "DIRECT_LEVEL_SENSITIVITY_EFFECT_AND_AUDIT_MAPPING; P0-010_REVIEW_PENDING", source: "actors-responsibilities.yaml#trustContexts.contexts" },
            successMeasures: { status: `${businessIntentMeasureProposals.length}_SOURCE_DEFINED_MEASUREMENT_CONTRACTS_PROJECTED; TARGET_NOT_SET; BASELINE_AND_QUALIFICATION_NOT_EVALUATED; OWNER_ACCEPTED_DEFINITION_SOURCE_CROSSWALK; MEASURED_POPULATION_AND_INDEPENDENT_CALIBRATION_NOT_EVALUATED`, source: "goals-jtbd.yaml#businessIntents[].measuredBy joined by exact successMeasure ID to goals-jtbd.yaml#successMeasureContracts.records; no numeric results inferred" },
            ownershipRules: { status: "DIRECT_ACCOUNTABLE_ROLE_TO_OWNER_MAPPING; CONTRACT_OWNER_AND_EXECUTION_AUTHORITY_RETAINED_SEPARATELY; P0-010_REVIEW_PENDING", source: "actors-responsibilities.yaml#ownershipRules.rules" },
            timestamps: { status: "OPTIONAL_AUTHORED_METADATA_OMITTED_INTENTIONALLY", source: "No source timestamp provenance is available; generation time is not authored metadata" },
          },
          requirementCapabilityMap: "No singular capabilityRef is emitted because each requirement may cover multiple leaves/families while the public schema accepts only one; capability requirementRefs preserve exact source links.",
          nonfunctionalRequirementIds: (nfr.requirements ?? []).map((item) => item.id),
          unresolvedUserIntentIds,
          intentTracesWithUnresolvedTargets,
          unresolvedJourneyIds,
          ownerDecisionStatus: "PENDING; structural validity does not establish semantic acceptance or closure.",
          contractPublicationStatus: "PENDING; local public source validated, package publication and isolated installed-artifact verification not performed.",
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
      nonGoals: { sourceRef: ".product-experience/pdp-0-product-truth/goals-jtbd.yaml", sourcePath: "nonGoals", mapping: "explicit bounded product non-goals with source-authored reasons" },
      actors: { sourceRef: ".product-experience/pdp-0-product-truth/actors-responsibilities.yaml", sourcePath: "actors and principals", mapping: "direct actor projection with human-to-person kind normalization" },
      responsibilities: { sourceRef: ".product-experience/pdp-0-product-truth/actors-responsibilities.yaml", sourcePath: "actors[].responsibilities", mapping: "actor-assigned responsibility statements with direct actor ownerRef" },
      userIntents: { sourceRef: ".product-experience/pdp-0-product-truth/intent-resolutions.yaml", sourcePath: "intents joined by exact id to goals-jtbd.yaml#intents", mapping: "project only exact resolved actor and priority records; unresolved actor targets remain outside the candidate" },
      businessIntents: { sourceRef: ".product-experience/pdp-0-product-truth/goals-jtbd.yaml", sourcePath: "businessIntents[].id/description/measuredBy", mapping: "direct business intent text; measuredBy links to the exact source-defined measurement contract by deterministic measure ID" },
      desiredOutcomes: { sourceRef: ".product-experience/pdp-0-product-truth/goals-jtbd.yaml", sourcePath: "outcomes", mapping: "direct IDs/outcome text and actorRef only when the source declares one actor" },
      capabilities: { sourceRef: ".product-experience/pdp-0-product-truth/capabilities.yaml", sourcePath: "capabilities", mapping: "all 462 leaf identities, outcomes, and requirementRefs" },
      requirements: { sourceRef: ".product-experience/pdp-0-product-truth/requirements.yaml", sourcePath: "requirements[].traceToIntentIds; goals-jtbd.yaml#intents; intent-resolutions.yaml#intents", mapping: "retain exact refs only for target userIntents resolved to a schema actor and priority; unresolved targets are listed in mapping review" },
      domainRules: { sourceRef: ".product-experience/pdp-0-product-truth/constitution.yaml", sourcePath: "domainRules.records joined to PDP-1 state-adjudication.yaml#ownerAcceptedPolicyDecisions by exact sourceRef", mapping: "project only records with bounded Media-owner decision status and an exact ownerAcceptedPolicyDecisions source ref; PXD-035 accepts this bounded mapping, PDP-1 remains semantic authority, proposal-only machine and transition rules are excluded, P0-010 independent review pending" },
      policies: { sourceRef: ".product-experience/pdp-0-product-truth/policy-authority-model.yaml", sourcePath: "productPolicy.enforcementPoints", mapping: "strict classification from explicit required checks and stop/deny/fail-closed behavior" },
      invariants: { sourceRef: ".product-experience/pdp-0-product-truth/constitution.yaml", sourcePath: "invariants.records", mapping: "direct statement/violation pairs; source-bound proposal, P0-010 review pending" },
      journeys: { sourceRef: ".product-experience/pdp-0-product-truth/journey-actor-resolutions.yaml", sourcePath: "journeys[].collaboratorActorRefs joined by exact id to journey-catalog.yaml#journeys; initiatingActorRef only when resolved", mapping: "project all exact source collaborator actorRefs; omit actorRef for unresolved initiators" },
      trustContexts: { sourceRef: ".product-experience/pdp-0-product-truth/actors-responsibilities.yaml", sourcePath: "trustContexts.contexts", mapping: "direct trustLevel, sensitivity/effect description and auditRequired" },
      successMeasures: { sourceRef: ".product-experience/pdp-0-product-truth/goals-jtbd.yaml", sourcePath: "businessIntents[].measuredBy joined by exact deterministic measure ID to successMeasureContracts.records", mapping: "project source-authored metric, unit, denominator, applicability, criterion, evidence method, and explicit NOT_EVALUATED baseline/qualification plus NOT_SET target; no measurement result or qualification is inferred; PXD-048 accepts exact definition source crosswalk and percentage/unknown-value semantics; measured profile population and independent calibration remain NOT_EVALUATED" },
      ownershipRules: { sourceRef: ".product-experience/pdp-0-product-truth/actors-responsibilities.yaml", sourcePath: "ownershipRules.rules", mapping: "accountableRoleRef becomes schema owner; contractOwner and executionAuthority are preserved separately in mapping review" },
      createdAt: { sourceRef: null, sourcePath: null, mapping: "optional authored metadata omitted intentionally because no source timestamp provenance exists" },
      updatedAt: { sourceRef: null, sourcePath: null, mapping: "optional authored metadata omitted intentionally because no source timestamp provenance exists" },
    },
    fieldMappingBlockers: {
      requirements: ["Some requirement rows retain partially resolved or unresolved intent targets. Only exact resolved targets are projected; unresolved rows and refs remain recorded in mapping review."],
      userIntents: ["Only exact P0-04 actor and priority resolutions are projected. Unresolved actor targets remain omitted; P0-010 independent review remains pending."],
      domainRules: [],
      successMeasures: [],
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
      "docs/migration/expert-reviewed-master-plan.md",
      ".product-experience/pdp-2-design-interface-system/typography-layout.yaml",
      ".product-experience/pdp-2-design-interface-system/semantic-state-grammar.yaml",
      ".product-experience/pdp-2-design-interface-system/responsive-adaptive.yaml",
      ".product-experience/pdp-2-design-interface-system/accessibility.yaml",
      ".product-experience/pdp-2-design-interface-system/localization-content.yaml",
      ".product-experience/pdp-2-design-interface-system/action-finality-grammar.yaml",
      ".product-experience/pdp-2-design-interface-system/gui/layout.yaml",
      ".product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml",
      ".product-experience/pdp-2-design-interface-system/gui/patterns/catalog.yaml",
      ".product-experience/pdp-2-design-interface-system/gui/recipes/catalog.yaml",
      ".product-experience/pdp-2-design-interface-system/gui/recipe-chain-review.yaml",
      ".product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml",
      ".product-experience/pdp-2-design-interface-system/media-token-aliases.yaml",
      ".product-experience/pdp-2-design-interface-system/component-contracts.yaml",
      ".product-experience/pdp-3-product-experience/navigation-contracts.yaml",
      ".product-experience/pdp-0-product-truth/state-models.yaml",
    ],
    candidate: (sources, generatedAt) => {
      const content = (path) => sources.find((source) => source.sourceRef === path)?.content ?? {};
      const typography = content(".product-experience/pdp-2-design-interface-system/typography-layout.yaml");
      const masterPlan = sources.find((source) => source.sourceRef === "docs/migration/expert-reviewed-master-plan.md")?.text ?? "";
      const states = content(".product-experience/pdp-2-design-interface-system/semantic-state-grammar.yaml");
      const responsive = content(".product-experience/pdp-2-design-interface-system/responsive-adaptive.yaml");
      const accessibility = content(".product-experience/pdp-2-design-interface-system/accessibility.yaml");
      const localization = content(".product-experience/pdp-2-design-interface-system/localization-content.yaml");
      const finality = content(".product-experience/pdp-2-design-interface-system/action-finality-grammar.yaml");
      const layout = content(".product-experience/pdp-2-design-interface-system/gui/layout.yaml");
      const patterns = content(".product-experience/pdp-2-design-interface-system/gui/patterns/catalog.yaml");
      const templates = content(".product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml");
      const recipeCatalog = content(".product-experience/pdp-2-design-interface-system/gui/recipes/catalog.yaml");
      const recipeChainReview = content(".product-experience/pdp-2-design-interface-system/gui/recipe-chain-review.yaml");
      const componentBindings = content(".product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml");
      const componentContracts = content(".product-experience/pdp-2-design-interface-system/component-contracts.yaml");
      const navigation = content(".product-experience/pdp-3-product-experience/navigation-contracts.yaml");
      const templateIds = new Set((templates.templates ?? []).map((template) => template.id));
      const patternIds = new Set((patterns.patterns ?? []).map((pattern) => pattern.id));
      const recipeRecords = recipeCatalog.recipes ?? [];
      if (recipeCatalog.status?.startsWith("OWNER_APPROVED_AS_DEFINITION_RECIPES") !== true
        || recipeRecords.length !== templateIds.size
        || new Set(recipeRecords.map((recipe) => recipe.id)).size !== recipeRecords.length
        || new Set(recipeRecords.map((recipe) => recipe.templateRef)).size !== templateIds.size
        || recipeRecords.some((recipe) => !templateIds.has(recipe.templateRef)
          || !patternIds.has(recipe.semanticPattern)
          || !(templates.templates.find((template) => template.id === recipe.templateRef)?.patterns ?? []).includes(recipe.semanticPattern))) {
        throw new Error("Media GUI recipe catalog must contain one owner-approved recipe per template and select a registered pattern from that template");
      }
      if (recipeChainReview.recipeCatalog?.status !== "OWNER_APPROVED_AS_DEFINITION_RECIPES"
        || recipeChainReview.recipeCatalog?.records?.length !== recipeRecords.length) {
        throw new Error("GUI recipe chain review must reconcile the owner-approved recipe catalog and preserve its exact record count");
      }
      const reviewedRecipes = new Map((recipeChainReview.recipeCatalog.records ?? []).map((recipe) => [recipe.id, recipe]));
      if (recipeRecords.some((recipe) => {
        const reviewed = reviewedRecipes.get(recipe.id);
        return !reviewed || reviewed.templateRef !== recipe.templateRef || reviewed.semanticPattern !== recipe.semanticPattern;
      })) {
        throw new Error("GUI recipe chain review must preserve exact recipe-to-template-to-pattern links");
      }
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
      const disclosureSection = masterPlan.match(/## 14\.1 Small shell, broad capability\s+([\s\S]*?)(?=\n## )/u)?.[1] ?? "";
      const disclosureModes = [
        { sourceLabel: "Simple", id: "simple", reveals: "intent and safe defaults" },
        { sourceLabel: "Guided", id: "guided", reveals: "quality, style, duration, reference, output, and privacy choices" },
        { sourceLabel: "Expert", id: "expert", reveals: "typed graph, curves, solver limits, generation, color, audio, and encoding controls" },
      ];
      const densityEnums = { simple: "minimal", guided: "standard", expert: "rich" };
      const accessibilityTarget = masterPlan.match(/Target WCAG 2\.2 AA for supported Web processes/u)?.[0];
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
        densityProfiles: Object.entries(typography.density ?? {}).flatMap(([sourceLabel, description]) => densityEnums[sourceLabel] ? [{
          id: `media.language.density.${sourceLabel}`,
          name: sourceLabel,
          density: densityEnums[sourceLabel],
          description,
        }] : []),
        presentationProfiles: Object.entries(typography.density ?? {}).flatMap(([sourceLabel, description]) => densityEnums[sourceLabel] ? [{
          id: `media.language.presentation.${sourceLabel}`,
          name: sourceLabel,
          densityRef: `media.language.density.${sourceLabel}`,
          description,
        }] : []),
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
        recoveryPatterns: (finality.recoveryPatterns ?? []).map((pattern) => ({
          id: pattern.id,
          name: pattern.name,
          description: pattern.description,
          automaticRecovery: pattern.automaticRecovery,
        })),
        progressiveDisclosureRules: disclosureSection && disclosureSection.includes("Switching levels preserves edits and authority")
          ? disclosureModes.map((mode) => ({
            id: `media.language.disclosure.${mode.id}`,
            trigger: `User selects ${mode.sourceLabel} disclosure level.`,
            reveals: mode.reveals,
          })) : [],
        responsiveRules: Object.entries(responsive.variants ?? {}).map(([breakpoint, variant]) => ({
          id: `media.language.responsive.${breakpoint}`,
          breakpoint: (variant.viewports ?? []).join(", "),
          behavior: variant.workMode,
        })),
        accessibilityRules: accessibilityTarget ? (accessibility.requirements ?? []).map((requirement, index) => ({
          id: `media.language.accessibility.${index + 1}`,
          standard: "WCAG 2.2",
          requirement,
          level: "AA",
        })) : [],
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
        recipeBindings: recipeRecords.map(({ id, semanticPattern }) => ({
          id: `media.language.recipe-binding.${id.slice("media.gui.recipe.".length)}`,
          semanticPattern,
          recipeRef: id,
        })),
        domainStatePresentationMappings,
        createdAt: generatedAt,
        updatedAt: generatedAt,
        _mappingReview: {
          generationTimestampSemantics: "createdAt/updatedAt record this candidate projection build only; they are not canonical Media authority timestamps.",
          mappedFields: ["id", "subjectId", "schemaVersion", "informationHierarchy", "densityProfiles", "presentationProfiles", "semanticStates", "navigationPrinciples", "interactionPatterns", "decisionPatterns", "recoveryPatterns", "progressiveDisclosureRules", "responsiveRules", "accessibilityRules", "localizationRules", "visualAuthority", "componentBindings", "recipeBindings", "domainStatePresentationMappings", "createdAt", "updatedAt"],
          fieldDispositions: {
            id: { status: "DETERMINISTIC_CANDIDATE_IDENTIFIER", source: "projection generator" },
            subjectId: { status: "DIRECT_SOURCE_COPY", source: "typography-layout.yaml#productId" },
            schemaVersion: { status: "PUBLIC_CONTRACT_CONSTANT", source: "@ghatana/experience-language" },
            informationHierarchy: { status: "DIRECT_PROPOSAL_MAPPING", source: "typography-layout.yaml#readingOrder" },
            densityProfiles: { status: "DIRECT_SOURCE_MAPPING_WITH_EXPLICIT_OWNER_SELECTED_ENUM", source: "typography-layout.yaml#density; P2-01 selected mapping simple→minimal, guided→standard, expert→rich" },
            presentationProfiles: { status: "DIRECT_DENSITY_PROFILE_BINDING", source: "typography-layout.yaml#density" },
            semanticStates: { status: "DIRECT_PROPOSAL_MAPPING", source: "semantic-state-grammar.yaml#states" },
            navigationPrinciples: { status: "DIRECT_PROPOSAL_MAPPING", source: "navigation-contracts.yaml#rules" },
            interactionPatterns: { status: "DIRECT_PROPOSAL_MAPPING", source: "gui/patterns/catalog.yaml#patterns" },
            decisionPatterns: { status: "DIRECT_PROPOSAL_MAPPING", source: "action-finality-grammar.yaml#rules" },
            recoveryPatterns: { status: "DIRECT_AUTHORED_RECOVERY_PATTERN_MAPPING", source: "action-finality-grammar.yaml#recoveryPatterns" },
            progressiveDisclosureRules: { status: "DIRECT_MASTER_PLAN_MAPPING", source: "expert-reviewed-master-plan.md#14.1" },
            responsiveRules: { status: "DIRECT_PROPOSAL_MAPPING", source: "responsive-adaptive.yaml#variants" },
            accessibilityRules: { status: "DIRECT_REQUIREMENTS_WITH_SELECTED_TARGET; CONFORMANCE_UNVERIFIED", source: "expert-reviewed-master-plan.md#14.5 WCAG 2.2 AA; accessibility.yaml#requirements" },
            localizationRules: { status: "DIRECT_PROPOSAL_MAPPING", source: "localization-content.yaml#rules" },
            visualAuthority: { status: "DIRECT_OWNERSHIP_BOUNDARY_MAPPING", source: "DESIGN-LANGUAGE.md" },
            componentBindings: { status: "DIRECT_CANDIDATE_BINDING; OWNER_REVIEW_PENDING", source: "gui/semantic-component-bindings.yaml#bindings" },
            recipeBindings: { status: "OWNER_APPROVED_MEDIA_RECIPE_MAPPING; SHARED_AND_SCREEN_INSTANCE_ADMISSION_PENDING", source: "gui/recipes/catalog.yaml#recipes; exact template/pattern links reconciled by gui/recipe-chain-review.yaml" },
            domainStatePresentationMappings: { status: "DIRECT_CANDIDATE_BINDING; PDP-0_STATE_REVIEW_PENDING", source: "semantic-state-grammar.yaml#states" },
            createdAt: { status: "PROJECTION_GENERATION_METADATA", source: "generator event" },
            updatedAt: { status: "PROJECTION_GENERATION_METADATA", source: "generator event" },
          },
          omittedCollections: {
            densityProfiles: "Explicit P2-01 enum selection maps simple→minimal, guided→standard, expert→rich; mapping remains subject to owner acceptance.",
            presentationProfiles: "Presentation profiles bind one-to-one to the three source density descriptions; no additional layouts are implied.",
            progressiveDisclosureRules: "Triggers are selection of each disclosure level; revealed content is taken from master plan §14.1. Concealment is unspecified.",
            accessibilityRules: "WCAG 2.2 AA is the declared target; mapped requirements do not establish conformance or replace specialist review.",
            recoveryPatterns: "Authored recovery IDs, names, descriptions, and automaticRecovery decisions map directly; unknown outcomes require reconciliation and are not automatically recovered.",
            recipeBindings: `${recipeRecords.length} owner-approved GUI recipe identities and their exact primary pattern refs are projected. Shared public-package binding and all 47 screen-instance admissions remain pending.`,
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
      const recipeIds = new Set((sources.find((source) => source.sourceRef.endsWith("/gui/recipes/catalog.yaml"))?.content?.recipes ?? []).map((recipe) => recipe.id));
      return {
        resolveComponent: (ref) => componentIds.has(ref),
        resolveDomainState: (ref) => stateIds.has(ref),
        resolveRecipe: (ref) => recipeIds.has(ref),
      };
    },
    candidateFieldSources: {
      id: { sourceRef: null, sourcePath: null, mapping: "deterministic candidate artifact identifier" },
      subjectId: { sourceRef: ".product-experience/pdp-2-design-interface-system/typography-layout.yaml", sourcePath: "productId", mapping: "identity copy" },
      schemaVersion: { sourceRef: "@ghatana/experience-language public export", sourcePath: "EXPERIENCE_LANGUAGE_SCHEMA_VERSION", mapping: "public contract constant" },
      informationHierarchy: { sourceRef: ".product-experience/pdp-2-design-interface-system/typography-layout.yaml", sourcePath: "readingOrder", mapping: "ordered list projected to numbered language hierarchy" },
      densityProfiles: { sourceRef: ".product-experience/pdp-2-design-interface-system/typography-layout.yaml", sourcePath: "density", mapping: "explicit P2-01 enum mapping simple→minimal, guided→standard, expert→rich" },
      presentationProfiles: { sourceRef: ".product-experience/pdp-2-design-interface-system/typography-layout.yaml", sourcePath: "density", mapping: "one presentation profile per density source record" },
      semanticStates: { sourceRef: ".product-experience/pdp-2-design-interface-system/semantic-state-grammar.yaml", sourcePath: "states", mapping: "direct proposed state IDs, labels, and explanations" },
      navigationPrinciples: { sourceRef: ".product-experience/pdp-3-product-experience/navigation-contracts.yaml", sourcePath: "rules and additionalJourneyFlows[].rules", mapping: "direct proposal text with deterministic candidate IDs" },
      interactionPatterns: { sourceRef: ".product-experience/pdp-2-design-interface-system/gui/patterns/catalog.yaml", sourcePath: "patterns", mapping: "direct IDs, intent, and anatomy" },
      decisionPatterns: { sourceRef: ".product-experience/pdp-2-design-interface-system/action-finality-grammar.yaml", sourcePath: "rules", mapping: "direct consequential-effect confirmation rule" },
      recoveryPatterns: { sourceRef: ".product-experience/pdp-2-design-interface-system/action-finality-grammar.yaml", sourcePath: "recoveryPatterns", mapping: "direct authored recovery pattern ID/name/description and automaticRecovery decision" },
      progressiveDisclosureRules: { sourceRef: "docs/migration/expert-reviewed-master-plan.md", sourcePath: "§14.1 disclosure levels", mapping: "level selection triggers and authored revealed content; no concealment claim" },
      responsiveRules: { sourceRef: ".product-experience/pdp-2-design-interface-system/responsive-adaptive.yaml", sourcePath: "variants", mapping: "direct viewport fixture and work-mode projection" },
      accessibilityRules: { sourceRef: ".product-experience/pdp-2-design-interface-system/accessibility.yaml", sourcePath: "requirements; docs/migration/expert-reviewed-master-plan.md#14.5 target", mapping: "requirements tagged WCAG 2.2 AA target; conformance remains unverified" },
      localizationRules: { sourceRef: ".product-experience/pdp-2-design-interface-system/localization-content.yaml", sourcePath: "rules", mapping: "direct proposal statements" },
      visualAuthority: { sourceRef: ".product-experience/pdp-2-design-interface-system/DESIGN-LANGUAGE.md", sourcePath: "Shared/Media ownership boundary", mapping: "direct ownership boundary summary; no token group binding" },
      componentBindings: { sourceRef: ".product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml", sourcePath: "bindings[].componentRefs and semanticRole", mapping: "exact Media component IDs only; external Shared admission remains pending" },
      recipeBindings: { sourceRef: ".product-experience/pdp-2-design-interface-system/gui/recipes/catalog.yaml", sourcePath: "recipes[].id/semanticPattern; gui/recipe-chain-review.yaml#recipeCatalog reconciles templateRef and semanticPattern", mapping: "exact owner-approved GUI recipe identities with catalog-validated template and pattern links; Shared and screen-instance admission remain pending" },
      domainStatePresentationMappings: { sourceRef: ".product-experience/pdp-2-design-interface-system/semantic-state-grammar.yaml", sourcePath: "states[].stateRef/label/explanation", mapping: "exact references checked against PDP-0 state source; semantics remain proposal" },
      createdAt: { sourceRef: null, sourcePath: "candidate generation event", mapping: "projection build timestamp, not a product-authority timestamp" },
      updatedAt: { sourceRef: null, sourcePath: "candidate generation event", mapping: "projection build timestamp, not a product-authority timestamp" },
    },
    fieldMappingBlockers: {
      densityProfiles: [],
      presentationProfiles: [],
      progressiveDisclosureRules: [],
      accessibilityRules: [],
      recoveryPatterns: [],
      recipeBindings: [],
    },
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
      ".product-experience/pdp-3-product-experience/experience-source-bindings.yaml",
      "libs/media-experience-simulation/src/fixtures.ts",
      ".product-experience/pdp-3-product-experience/screen-contract-schema.yaml",
      ".product-experience/pdp-3-product-experience/application-channel-registry.yaml",
      ".product-experience/pdp-3-product-experience/interaction-registry.yaml",
      ".product-experience/pdp-3-product-experience/search-inspection-contracts.yaml",
      ".product-experience/pdp-2-design-interface-system/component-contracts.yaml",
      ".product-experience/pdp-0-product-truth/journey-actor-resolutions.yaml",
      ".product-experience/pdp-0-product-truth/actors-responsibilities.yaml",
      ".product-experience/pdp-0-product-truth/goals-jtbd.yaml",
      ".product-experience/pdp-0-product-truth/journey-catalog.yaml",
      ".product-experience/pdp-0-product-truth/state-models.yaml",
      ".product-experience/pdp-1-domain-data/domain-objects.yaml",
      ".product-experience/pdp-1-domain-data/states.yaml",
    ],
    candidate: (sources, generatedAt) => {
      const content = (path) => sources.find((source) => source.sourceRef === path)?.content ?? {};
      const screenRegistry = content(".product-experience/pdp-3-product-experience/screen-registry.yaml");
      const journeys = content(".product-experience/pdp-3-product-experience/journey-registry.yaml");
      const actions = content(".product-experience/pdp-3-product-experience/action-registry.yaml");
      const interactions = content(".product-experience/pdp-3-product-experience/interaction-registry.yaml");
      const channels = content(".product-experience/pdp-3-product-experience/application-channel-registry.yaml");
      const recovery = content(".product-experience/pdp-3-product-experience/recovery-finality-contracts.yaml");
      const experienceBindings = content(".product-experience/pdp-3-product-experience/experience-source-bindings.yaml");
      const scenarioFixtures = content(".product-experience/pdp-3-product-experience/scenario-fixture-registry.yaml");
      const fixtureSource = sources.find((source) => source.sourceRef === "libs/media-experience-simulation/src/fixtures.ts")?.text ?? "";
      const searchInspections = content(".product-experience/pdp-3-product-experience/search-inspection-contracts.yaml");
      const searchInspection = { ...searchInspections, search: searchInspections.searches ?? searchInspections.search ?? [] };
      const componentContracts = content(".product-experience/pdp-2-design-interface-system/component-contracts.yaml");
      const p0JourneyActorResolutions = content(".product-experience/pdp-0-product-truth/journey-actor-resolutions.yaml");
      const p0Actors = content(".product-experience/pdp-0-product-truth/actors-responsibilities.yaml");
      const p0Goals = content(".product-experience/pdp-0-product-truth/goals-jtbd.yaml");
      const p0JourneyCatalog = content(".product-experience/pdp-0-product-truth/journey-catalog.yaml");
      const stateModels = content(".product-experience/pdp-0-product-truth/state-models.yaml");
      const p0InitiatorResolutions = (p0JourneyActorResolutions.journeys ?? [])
        .filter(({ actorStatus, initiatingActorRef }) => actorStatus === "resolved" && typeof initiatingActorRef === "string");
      const p3JourneyCoverage = journeys.coverageObservation ?? {};
      const journeyStepBindings = p3JourneyCoverage.stepBindings ?? {};
      const p3Steps = p3JourneyCoverage.orderedStepCount ?? 0;
      const journeyStepGapCounts = {
        stepViewLinked: journeyStepBindings.screenContractRef?.linked ?? 0,
        stepViewUnresolved: journeyStepBindings.screenContractRef?.unresolved ?? 0,
        stepActionLinked: journeyStepBindings.action?.linked ?? 0,
        stepActionUnresolved: journeyStepBindings.action?.unresolved ?? 0,
        stepObjectRefsEmpty: journeyStepBindings.objectRefs?.empty ?? 0,
        stepStateRefsEmpty: journeyStepBindings.stateRefs?.empty ?? 0,
        canonicalOperationRefsNull: journeyStepBindings.canonicalOperationRef?.[""] ?? journeyStepBindings.canonicalOperationRef?.null ?? journeyStepBindings.canonicalOperationRef?.["null"] ?? 0,
        canonicalOperationCandidateRefs: journeyStepBindings.canonicalOperationRef?.nonNullCandidateRefs ?? 0,
        authorityRefsNull: journeyStepBindings.authorityRef?.[""] ?? journeyStepBindings.authorityRef?.null ?? journeyStepBindings.authorityRef?.["null"] ?? 0,
        transitionRefsNull: journeyStepBindings.transitionRef?.[""] ?? journeyStepBindings.transitionRef?.null ?? journeyStepBindings.transitionRef?.["null"] ?? 0,
        requirementRefsEmpty: journeyStepBindings.requirementRefs?.empty ?? 0,
        verificationNotRun: journeyStepBindings.verification?.notRun ?? 0,
        verificationEvidencePresent: journeyStepBindings.verification?.evidenceRefsPresent ?? 0,
        verificationAccepted: journeyStepBindings.verification?.accepted ?? 0,
      };
      const p3JourneysWithScenarioRefs = p3JourneyCoverage.scenarioReferences?.journeysWithRefs ?? 0;
      const p3JourneysWithoutScenarioRefs = p3JourneyCoverage.scenarioReferences?.journeysWithoutRefs ?? 0;
      const screenContractByViewId = new Map(sources
        .filter((source) => source.sourceRef.startsWith(".product-experience/pdp-3-product-experience/screen-contracts/") && source.content?.screenId)
        .map((source) => [source.content.screenId, source.content]));
      const journeyContracts = sources
        .filter((source) => source.sourceRef.startsWith(".product-experience/pdp-3-product-experience/journey-contracts/") && source.content?.journeyId)
        .map((source) => source.content);
      const journeyContractById = new Map(journeyContracts.map((contract) => [contract.journeyId, contract]));
      const sourceViews = [...(screenRegistry.screens ?? []), ...(screenRegistry.laneViews ?? [])];
      const sourceViewById = new Map(sourceViews.map((view) => [view.id, view]));
      const p0ActorIds = new Set((p0Actors.actors ?? []).map((actor) => actor.id));
      const p0OutcomeIds = new Set((p0Goals.outcomes ?? []).map((outcome) => outcome.id));
      const p0JourneyById = new Map((p0JourneyCatalog.journeys ?? []).map((journey, index) => [journey.id, { journey, index }]));
      const p0InitiatorByJourneyId = new Map(p0InitiatorResolutions.map((resolution) => [resolution.id, resolution]));
      const journeyProjectionAudit = { projected: [], omitted: [], sourceNullTransitions: [] };
      const projectedJourneys = (journeys.journeys ?? []).flatMap((journey) => {
        const actorResolution = p0InitiatorByJourneyId.get(journey.pdp0JourneyRef);
        const sourceJourneyEntry = p0JourneyById.get(journey.pdp0JourneyRef);
        const contract = journeyContractById.get(journey.pdp0JourneyRef);
        const sourceRef = sourceJourneyEntry ? `.product-experience/pdp-0-product-truth/journey-catalog.yaml#/journeys/${sourceJourneyEntry.index}` : null;
        const actorIsGrounded = actorResolution?.actorStatus === "resolved"
          && typeof actorResolution.initiatingActorRef === "string"
          && actorResolution.sourceRef === `journey-catalog.yaml#/journeys/${sourceJourneyEntry?.index}`
          && sourceJourneyEntry?.journey?.actors?.includes(actorResolution.initiatingActorRef)
          && p0ActorIds.has(actorResolution.initiatingActorRef)
          && contract?.journeyId === journey.pdp0JourneyRef;
        if (!actorIsGrounded) {
          journeyProjectionAudit.omitted.push({ journeyId: journey.id, reason: "actorRef lacks a valid bounded P0-04 resolution, matching catalog source and PDP-0/contract actor membership", sourceRef });
          return [];
        }
        const outcomeRefs = sourceJourneyEntry.journey.outcomeRefs ?? [];
        const contractOutcomes = contract.outcomes ?? [];
        const desiredOutcomeRef = outcomeRefs.length === 1 && p0OutcomeIds.has(outcomeRefs[0])
          && contractOutcomes.length === 1 && contractOutcomes[0] === outcomeRefs[0]
          ? outcomeRefs[0]
          : undefined;
        const projectedSteps = [];
        let projectedExplicitIntentCount = 0;
        let projectedViewPurposeIntentCount = 0;
        const sourceSteps = contract.steps ?? [];
        const authoredStepIdCounts = new Map();
        for (const sourceStep of sourceSteps) if (typeof sourceStep.stepId === "string") authoredStepIdCounts.set(sourceStep.stepId, (authoredStepIdCounts.get(sourceStep.stepId) ?? 0) + 1);
        for (const [index, step] of (contract.steps ?? []).entries()) {
          const viewRef = typeof step.view === "string" ? step.view : (typeof step.viewRef === "string" ? step.viewRef : undefined);
          const view = viewRef ? sourceViewById.get(viewRef) : undefined;
          const hasUniqueAuthoredId = typeof step.stepId === "string" && authoredStepIdCounts.get(step.stepId) === 1;
          const stepId = hasUniqueAuthoredId ? step.stepId : `${journey.id}.step-${String(index + 1).padStart(2, "0")}`;
          const explicitIntent = typeof step.intent === "string" ? step.intent
            : typeof step.viewIntent === "string" ? step.viewIntent
              : typeof step.label === "string" ? step.label : undefined;
          const intent = explicitIntent ?? (view && typeof view.purpose === "string" ? view.purpose : undefined);
          if (typeof intent !== "string" || intent.trim().length === 0) {
            journeyProjectionAudit.sourceNullTransitions.push({ journeyId: journey.id, stepOrdinal: index + 1, sourceStepId: step.stepId ?? null, projectedStepId: null, sourceTransitionRef: step.transitionRef ?? null, projectedTransitionRefs: null, disposition: step.transitionRef == null ? "UNRESOLVED_SOURCE_NULL; STEP_OMITTED_FOR_MISSING_INTENT" : "SOURCE_TRANSITION_NOT_MAPPED; STEP_OMITTED_FOR_MISSING_INTENT" });
            journeyProjectionAudit.omitted.push({ journeyId: journey.id, stepOrdinal: index + 1, sourceStepId: step.stepId ?? null, projectionStepIdCandidate: stepId, reason: "no exact authored intent, label, or directly linked view purpose; result text is not an intent", sourceRef: `${journey.contract}#/steps/${index}` });
            continue;
          }
          const transitionRefs = [];
          if (explicitIntent) projectedExplicitIntentCount += 1;
          else projectedViewPurposeIntentCount += 1;
          journeyProjectionAudit.sourceNullTransitions.push({ journeyId: journey.id, stepOrdinal: index + 1, sourceStepId: step.stepId ?? null, projectedStepId: stepId, sourceTransitionRef: step.transitionRef ?? null, sourceTransitionDisposition: step.transitionDisposition ?? null, projectedTransitionRefs: transitionRefs, disposition: step.transitionRef == null ? "UNRESOLVED_SOURCE_NULL; EMPTY_ARRAY_IS_SCHEMA_PLACEHOLDER_ONLY" : "SOURCE_TRANSITION_NOT_MAPPED" });
          projectedSteps.push({ stepId, intent, ...(view ? { viewRef: view.id } : {}), transitionRefs });
        }
        const projected = { id: journey.id, name: journey.title, actorRef: actorResolution.initiatingActorRef, steps: projectedSteps, ...(desiredOutcomeRef ? { desiredOutcomeRef } : {}) };
        journeyProjectionAudit.projected.push({ journeyId: journey.id, sourceRef, actorRef: projected.actorRef, projectedStepCount: projectedSteps.length, sourceOutcomeRefs: outcomeRefs, desiredOutcomeRef: desiredOutcomeRef ?? null, intentSources: { explicit: projectedExplicitIntentCount, linkedViewPurposeProposalOnly: projectedViewPurposeIntentCount } });
        return [projected];
      });
      const projectedJourneyIds = new Set(projectedJourneys.map((journey) => journey.id));
      const journeyProjectionBlocker = `A partial source-grounded PDP-3 journey projection now includes ${projectedJourneys.length}/${(journeys.journeys ?? []).length} journeys and ${projectedJourneys.reduce((count, journey) => count + journey.steps.length, 0)}/${p3Steps} steps. Exact resolved P0-04 representative actors support actorRef at proposal scope; five singleton source/contract outcomes support desiredOutcomeRef. Step-view ${journeyStepGapCounts.stepViewLinked} linked/${journeyStepGapCounts.stepViewUnresolved} unresolved; step-action ${journeyStepGapCounts.stepActionLinked} linked/${journeyStepGapCounts.stepActionUnresolved} unresolved. Remaining gaps: ${journeyProjectionAudit.omitted.length} step rows lack an exact intent source (including J-29's four rows); ${journeyStepGapCounts.transitionRefsNull} source transitionRef values are null; ${journeyProjectionAudit.sourceNullTransitions.filter((step) => step.sourceTransitionRef == null && step.sourceTransitionDisposition?.status === "NOT_APPLICABLE_WITH_REASON").length} have explicit source no-mutation reasons. These source dispositions do not resolve the public transition projection. Public transitionRefs empty arrays are schema placeholders only and do not assert no transitions. Other P3 step bindings remain open: objectRefs empty ${journeyStepGapCounts.stepObjectRefsEmpty}, stateRefs empty ${journeyStepGapCounts.stepStateRefsEmpty}, authorityRef null ${journeyStepGapCounts.authorityRefsNull}, requirementRefs empty ${journeyStepGapCounts.requirementRefsEmpty}, verification not-run ${journeyStepGapCounts.verificationNotRun}. ${p3JourneysWithScenarioRefs}/${(journeys.journeys ?? []).length} journeys have scenario refs. Projection is candidate-only; P0/PDP-3 semantic acceptance and lifecycle closure remain pending.`;
      const componentIds = new Set((componentContracts.components ?? []).map((component) => component.id));
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
          componentRefs: (screenContractByViewId.get(screen.id)?.componentIds ?? []).filter((componentRef) => componentIds.has(componentRef)),
          journeyRefs: (screen.journeyRefs ?? []).filter((journeyRef) => projectedJourneyIds.has(journeyRef)),
          stateRefs: [],
        })),
        ...(screenRegistry.laneViews ?? []).map((view) => ({
          id: view.id,
          name: view.label,
          intent: view.purpose,
          componentRefs: (screenContractByViewId.get(view.id)?.componentIds ?? []).filter((componentRef) => componentIds.has(componentRef)),
          journeyRefs: (view.journeyRefs ?? []).filter((journeyRef) => projectedJourneyIds.has(journeyRef)),
          stateRefs: [],
        })),
      ];
      const definedSemantics = resolveExperienceDefinitionSemantics(actions.actions ?? [], recovery.contracts ?? []);
      const candidateActions = (actions.actions ?? []).map((action) => ({
        id: action.id,
        name: action.label,
        kind: "user",
        description: action.effect,
        preconditions: action.preconditions ?? [],
        producesEffectRefs: definedSemantics.effectRefsByAction.get(action.id) ?? [],
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
      const stateIds = new Set(allStates.map((state) => state.id));
      const linkedScenarioIds = new Set([
        ...journeyContracts.flatMap((journey) => journey.scenarioRefs ?? []),
        ...(actions.actions ?? []).flatMap((action) => action.scenarioRefs ?? []),
      ]);
      const fixtureByScenarioId = new Map((scenarioFixtures.fixtures ?? []).map((fixture) => [fixture.id, fixture]));
      const bindingsByScenarioId = new Map((experienceBindings.scenarioStartingStateBindings ?? []).map((binding) => [binding.scenarioRef, binding]));
      const scenarioRecords = [...linkedScenarioIds].flatMap((scenarioId) => {
        const fixture = fixtureByScenarioId.get(scenarioId);
        const binding = bindingsByScenarioId.get(scenarioId);
        if (!fixture || !binding || !stateIds.has(binding.startingStateRef)) return [];
        const sourceKeyExists = new RegExp(`^[ \\t]*[\"']${binding.sourceFixtureKey}[\"']:[ \\t]*`, "mu").test(fixtureSource);
        if (!sourceKeyExists) return [];
        return [{
          scenario: {
            id: fixture.id,
            name: fixture.id,
            contextDimensions: {},
            startingStateRef: binding.startingStateRef,
            description: fixture.initialConditions,
          },
          fixture: {
            id: `media.fixture.${fixture.id.slice("media.scenario.".length)}`,
            scenarioRef: fixture.id,
            data: {
              sourceFixtureRef: fixture.sourceFixtureRef,
              sourcePath: "libs/media-experience-simulation/src/fixtures.ts",
              sourceFixtureKey: binding.sourceFixtureKey,
              initialConditions: fixture.initialConditions,
              expected: fixture.expected,
            },
          },
        }];
      });
      const recoverySourceProposals = (recovery.contracts ?? []).map((contract) => ({
        id: contract.id,
        stateProposal: contract.state,
        allowedProposal: contract.allowed,
        blockedProposal: contract.blocked,
      }));
      const legacyFinalityMappings = (actions.actions ?? [])
        .filter((action) => typeof action.finality === "string" && typeof action.reversible === "boolean"
          && typeof action.confirmation === "string"
          && /require a separate explicit confirmation before dispatch/iu.test(action.confirmation))
        .map((action) => ({
          id: `${action.id}.finality`,
          actionRef: action.id,
          description: action.finality,
          confirmationRequired: true,
          undoable: action.reversible,
        }));
      const explicitFinalityActions = new Set(definedSemantics.finality.map((entry) => entry.actionRef));
      const finalityMappings = [...legacyFinalityMappings.filter((entry) => !explicitFinalityActions.has(entry.actionRef)), ...definedSemantics.finality];
      const recoveryMappingComplete = (recovery.contracts ?? []).length > 0 && definedSemantics.recoveries.length === recovery.contracts.length;
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
          requiredProps: component.requiredProps ?? [],
        })),
        views: screens,
        journeys: projectedJourneys,
        interactions: (interactions.interactions ?? []).filter((interaction) => actions.actions?.some((action) => action.id === interaction.effectRef)).map((interaction) => ({
          id: interaction.id,
          name: interaction.id,
          trigger: interaction.input,
          preconditions: actions.actions.find((action) => action.id === interaction.effectRef)?.preconditions ?? [],
          actionRef: interaction.effectRef,
        })),
        states: allStates,
        transitions: [],
        actions: candidateActions,
        effects: definedSemantics.effects,
        finality: finalityMappings,
        recovery: definedSemantics.recoveries,
        scenarios: scenarioRecords.map((record) => record.scenario),
        fixtures: scenarioRecords.map((record) => record.fixture),
        search: (searchInspection.search ?? []).map((entry) => ({
          id: entry.id,
          name: entry.name,
          searchableTypes: entry.searchableTypes,
          description: entry.description,
        })),
        inspections: (searchInspection.inspections ?? []).map((entry) => ({
          id: entry.id,
          projectionKind: entry.projectionKind,
          description: entry.description,
        })),
        createdAt: generatedAt,
        updatedAt: generatedAt,
        _mappingReview: {
          generationTimestampSemantics: "createdAt/updatedAt record this candidate projection build only; they are not canonical Media authority timestamps.",
            mappedFields: ["id", "subjectId", "schemaVersion", "contextDimensions", "renderTargets", "componentContracts", "views", "journeys", "interactions", "states", "actions", "recovery", "scenarios", "fixtures", "search", "inspections", "createdAt", "updatedAt"],
          fieldDispositions: {
            id: { status: "DETERMINISTIC_CANDIDATE_IDENTIFIER", source: "projection generator" },
            subjectId: { status: "DIRECT_SOURCE_COPY", source: "screen-registry.yaml#productId" },
            schemaVersion: { status: "PUBLIC_CONTRACT_CONSTANT", source: "@ghatana/experience-specification" },
            contextDimensions: { status: "DIRECT_PROPOSAL_MAPPING", source: "application-channel-registry.yaml#channels" },
            renderTargets: { status: "DIRECT_PROPOSAL_MAPPING", source: "application-channel-registry.yaml#channels" },
            componentContracts: { status: "PARTIAL_DIRECT_MAPPING; EXACT_PROPS_FOR_SOURCE_BOUND_SUBSET", source: "component-contracts.yaml#components[].requiredProps; components[].propsSourceRef" },
      views: { status: "DIRECT_IDENTITY_PURPOSE_COMPONENT_AND_JOURNEY_REF_MAPPING; PDP1_STATE_REFS_PENDING", source: "screen-registry.yaml#screens,laneViews,journeyRefs; screen-contracts/*.yaml#componentIds" },
            journeys: { status: `PARTIAL_SOURCE_PROJECTION_${projectedJourneys.length}_OF_${(journeys.journeys ?? []).length}_JOURNEYS_${projectedJourneys.reduce((count, journey) => count + journey.steps.length, 0)}_OF_${p3Steps}_STEPS; OWNER_REVIEW_PENDING`, source: "journey-registry.yaml#journeys; journey-contracts/*.yaml#steps; pdp-0-product-truth/journey-actor-resolutions.yaml#journeys; journey-catalog.yaml#journeys; goals-jtbd.yaml#outcomes; screen-registry.yaml#screens,laneViews" },
            interactions: { status: "DIRECT_INTERACTION_AND_ACTION_PRECONDITION_MAPPING", source: "interaction-registry.yaml#interactions; action-registry.yaml#actions[].preconditions" },
            states: { status: "DIRECT_PDP-0_STATE_PROPOSAL_MAPPING; PDP-1_RECONCILIATION_AND_OWNER_ACCEPTANCE_PENDING", source: "state-models.yaml#models[].states; pdp-1-domain-data/states.yaml#stateMachines" },
            transitions: { status: "BLOCKED_CANONICAL_ACTION_AND_GUARD_BINDINGS", source: "state-models.yaml#models[].transitions" },
            actions: { status: "DIRECT_UI_PROPOSAL_MAPPING; EFFECT_KIND_AND_CONDITIONAL_REVERSIBILITY_UNRESOLVED", source: "action-registry.yaml#actions" },
            effects: { status: "DIRECT_EXPLICIT_UNCONDITIONAL_DEFINITION_SUBSET; REMAINDER_AND_CONDITIONAL_REVERSIBILITY_UNRESOLVED", source: "action-registry.yaml#actions[].actionDefinitionSemantics.publicEffect" },
            finality: { status: "DIRECT_EXPLICIT_CONFIRMATION_AND_BOOLEAN_REVERSIBILITY_SUBSET; REMAINDER_UNRESOLVED", source: "action-registry.yaml#actions[].actionDefinitionSemantics.publicFinality plus explicit legacy confirmation/finality/reversible" },
            recovery: { status: recoveryMappingComplete ? "OWNER_ACCEPTED_DEFINITION_RECORDS; RUNTIME_AND_INDEPENDENT_ACCEPTANCE_NOT_ADMITTED" : "SOURCE_PROPOSALS_AND_CROSS-REFERENCES_RECORDED; PUBLIC_BOOLEAN_BINDINGS_UNRESOLVED", source: "recovery-finality-contracts.yaml#contracts[].definitionSemantics.publicRecovery; experience-source-bindings.yaml#recoveryCrossReferences" },
            scenarios: { status: "DIRECT_LINKED_FIXTURE_AND_CANONICAL_START_STATE_SUBSET; CONTEXT_AND_REMAINDER_UNRESOLVED", source: "scenario-fixture-registry.yaml#fixtures; experience-source-bindings.yaml#scenarioStartingStateBindings; journey-contracts/*.yaml#scenarioRefs; state-models.yaml#models[].states" },
            fixtures: { status: "DIRECT_SCENARIO_AND_SOURCE_SEED_REFERENCE_SUBSET; INLINE_PAYLOAD_AND_REMAINDER_UNRESOLVED", source: "scenario-fixture-registry.yaml#fixtures; libs/media-experience-simulation/src/fixtures.ts" },
            search: { status: "DIRECT_SOURCE_PROPOSAL; TYPE_OWNER_AND_QUERY_REVIEW_PENDING", source: "search-inspection-contracts.yaml#search and sourceBindings.searches" },
            inspections: { status: "DIRECT_SOURCE_PROPOSAL; SOURCE_OWNER_REVIEW_PENDING", source: "search-inspection-contracts.yaml#inspections and sourceBindings.inspections" },
            createdAt: { status: "PROJECTION_GENERATION_METADATA", source: "generator event" },
            updatedAt: { status: "PROJECTION_GENERATION_METADATA", source: "generator event" },
          },
          collectionCounts: {
            views: screens.length,
            registryJourneys: (journeys.journeys ?? []).length,
            projectedJourneys: projectedJourneys.length,
            registryActions: candidateActions.length,
              registryInteractions: (interactions.interactions ?? []).length,
              projectedStates: allStates.length,
              explicitFinalityCandidates: finalityMappings.length,
              linkedScenarioCandidates: scenarioRecords.length,
              linkedFixtureCandidates: scenarioRecords.length,
            searchContracts: (searchInspection.search ?? []).length,
            inspectionContracts: (searchInspection.inspections ?? []).length,
          },
          journeyBindingAudit: {
            p0InitiatorAvailability: {
              sourceRef: ".product-experience/pdp-0-product-truth/journey-actor-resolutions.yaml",
              resolvedCount: p0InitiatorResolutions.length,
              sourceCount: (p0JourneyActorResolutions.journeys ?? []).length,
              projectedAsCandidateActorRefs: projectedJourneys.length,
              disposition: "BOUNDED_MEDIA_OWNER_REPRESENTATIVE_INITIATORS_PROJECTED_AS_CANDIDATE_ACTOR_REFS; COLLABORATORS_AND_AUTHORIZATION_UNCHANGED; P0-010_AND_PDP3_OWNER_REVIEW_PENDING",
            },
            p3OrderedStepCount: p3Steps,
            sourceJourneyCount: (journeys.journeys ?? []).length,
            projectedJourneyCount: projectedJourneys.length,
            projectedStepCount: projectedJourneys.reduce((count, journey) => count + journey.steps.length, 0),
            desiredOutcomeProjection: { projectedCount: projectedJourneys.filter((journey) => journey.desiredOutcomeRef).length, omittedMultipleOrMismatchedSourceOutcomeCount: projectedJourneys.filter((journey) => !journey.desiredOutcomeRef).length, source: "PDP-0 and PDP-3 exact singleton outcome intersection" },
            stepIntentProjection: {
              explicitSourceIntentCount: journeyProjectionAudit.projected.reduce((count, item) => count + item.intentSources.explicit, 0),
              linkedViewPurposeProposalOnlyCount: journeyProjectionAudit.projected.reduce((count, item) => count + item.intentSources.linkedViewPurposeProposalOnly, 0),
              omitted: journeyProjectionAudit.omitted,
              viewPurposeDisposition: "SOURCE_PROPOSAL_ONLY; DIRECT_VIEW_PURPOSE_TEXT_COPIED_VERBATIM; OWNER_REVIEW_AND_SEMANTIC_ACCEPTANCE_PENDING; RESULT_TEXT_NEVER_USED_AS_INTENT",
              idTransformation: "Preserve unique source-authored stepId; otherwise use <journeyId>.step-<two-digit source ordinal> as deterministic projection-only ID, including missing or repeated IDs.",
            },
            transitionProjection: {
              sourceNullCount: journeyProjectionAudit.sourceNullTransitions.filter((step) => step.sourceTransitionRef == null).length,
              sourceNoMutationReasonCount: journeyProjectionAudit.sourceNullTransitions.filter((step) => step.sourceTransitionRef == null && step.sourceTransitionDisposition?.status === "NOT_APPLICABLE_WITH_REASON").length,
              rows: journeyProjectionAudit.sourceNullTransitions,
              disposition: "Source transitionRef null requires separate source applicability review; explicit no-mutation reasons are retained without inferring public transition mapping. Public transitionRefs: [] is only a required schema placeholder and is not evidence that no transitions exist.",
            },
            projectedSourceRows: journeyProjectionAudit.projected,
            omittedJourneys: journeyProjectionAudit.omitted.filter((entry) => !entry.stepOrdinal),
            stepBindingCounts: journeyStepGapCounts,
            stepViewBindingSourceAudit: journeyStepBindings.screenContractRef ?? {},
            journeyScenarioReferenceCounts: { withRefs: p3JourneysWithScenarioRefs, withoutRefs: p3JourneysWithoutScenarioRefs },
            remainingGap: journeyProjectionBlocker,
          },
          ownerDecisionStatus: "PENDING; directly projected records and schema validation do not establish semantic acceptance or phase closure.",
          definitionSemantics: { projectedEffects: definedSemantics.effects.length, projectedExplicitFinality: definedSemantics.finality.length, conditionalOrUnknownActions: definedSemantics.conditionalActions, projectedRecoveries: definedSemantics.recoveries.length, recoverySourceCount: (recovery.contracts ?? []).length, recoveryMappingComplete, admission: "NOT_ADMITTED; DEFINITION_ONLY" },
          recoverySourceProposals,
          recoverySourceCrossReferences: experienceBindings.recoveryCrossReferences ?? [],
        },
      };
    },
    ownerResolvers: (sources) => {
      const domainObjects = sources.find((source) => source.sourceRef.endsWith("/domain-objects.yaml"))?.content?.objects ?? [];
      const searchableTypeIds = new Set(domainObjects.map((object) => object.id));
      const actorIds = new Set(sources.find((source) => source.sourceRef.endsWith("/actors-responsibilities.yaml"))?.content?.actors?.map((actor) => actor.id) ?? []);
      const outcomeIds = new Set(sources.find((source) => source.sourceRef.endsWith("/goals-jtbd.yaml"))?.content?.outcomes?.map((outcome) => outcome.id) ?? []);
      return { resolveReference: (kind, ref) => (kind === "searchable-type" && searchableTypeIds.has(ref)) || (kind === "actor" && actorIds.has(ref)) || (kind === "desired-outcome" && outcomeIds.has(ref)) };
    },
    candidateFieldSources: {
      id: { sourceRef: null, sourcePath: null, mapping: "deterministic candidate artifact identifier" },
      subjectId: { sourceRef: ".product-experience/pdp-3-product-experience/screen-registry.yaml", sourcePath: "productId", mapping: "identity copy" },
      schemaVersion: { sourceRef: "@ghatana/experience-specification public export", sourcePath: "EXPERIENCE_SPECIFICATION_SCHEMA_VERSION", mapping: "public contract constant" },
      contextDimensions: { sourceRef: ".product-experience/pdp-3-product-experience/application-channel-registry.yaml", sourcePath: "channels[].channelRef", mapping: "one typed enum context dimension over the exact selected-lane channel IDs" },
      renderTargets: { sourceRef: ".product-experience/pdp-3-product-experience/application-channel-registry.yaml", sourcePath: "channels", mapping: "direct channel target records; support disposition remains proposal" },
      componentContracts: { sourceRef: ".product-experience/pdp-2-design-interface-system/component-contracts.yaml", sourcePath: "components[].id, purpose, requiredProps, and propsSourceRef", mapping: "direct identity and purpose; required prop names are copied only when explicitly bound to a typed public component interface; all other component records remain unresolved" },
      views: { sourceRef: ".product-experience/pdp-3-product-experience/screen-registry.yaml", sourcePath: "screens and laneViews with exact journeyRefs; screen-contracts/*.yaml#componentIds", mapping: "all 47 exact view identities, names, purposes, resolvable component refs, and 132 journeyRefs are projected directly; only PDP-1 stateRefs remain unbound" },
      journeys: { sourceRef: ".product-experience/pdp-3-product-experience/journey-registry.yaml", sourcePath: "journeys; journey-contracts/*.yaml#steps; P0 journey-actor-resolutions.yaml; journey-catalog.yaml; goals-jtbd.yaml; screen-registry view purposes", mapping: "project source-grounded journey IDs/names and bounded representative actor refs; preserve unique authored step IDs, otherwise derive ordinal projection IDs; use explicit intent or exact linked view purpose as a proposal-only intent; map only matching singleton desired outcomes; preserve null transitions as unresolved review metadata and schema-required empty-array placeholders; withhold steps lacking exact intent" },
      interactions: { sourceRef: ".product-experience/pdp-3-product-experience/interaction-registry.yaml", sourcePath: "interactions[].effectRef; action-registry.yaml#actions[].preconditions", mapping: "direct exact action linkage and the referenced action's authored preconditions" },
      states: { sourceRef: ".product-experience/pdp-0-product-truth/state-models.yaml", sourcePath: "models[].states; PDP-1 states.yaml stateMachines", mapping: "direct proposed state IDs, meaning, terminality, and invariants; identity extraction does not accept PDP-1 semantics" },
      transitions: { sourceRef: ".product-experience/pdp-0-product-truth/state-models.yaml", sourcePath: "models[].transitions", mapping: "not projected because legal PDP-1 actionRef and guard bindings remain unresolved" },
      actions: { sourceRef: ".product-experience/pdp-3-product-experience/action-registry.yaml", sourcePath: "actions", mapping: "direct UI action identity, label, effect prose, and preconditions; user kind is a proposal classification" },
      effects: { sourceRef: ".product-experience/pdp-3-product-experience/action-registry.yaml", sourcePath: "actions[].actionDefinitionSemantics.publicEffect", mapping: "only explicit owner-reviewed unconditional public effect definitions; conditional or unknown reversibility is retained as unmappable review metadata" },
      finality: { sourceRef: ".product-experience/pdp-3-product-experience/action-registry.yaml", sourcePath: "actions[].actionDefinitionSemantics.publicFinality plus explicit legacy confirmation/finality/reversible", mapping: "direct explicit reviewed public finality definitions and legacy subset with explicit confirmation and source boolean reversibility; conditional and unknown mappings remain unresolved" },
      recovery: { sourceRef: ".product-experience/pdp-3-product-experience/recovery-finality-contracts.yaml", sourcePath: "contracts[].definitionSemantics.publicRecovery plus experience-source-bindings.yaml#recoveryCrossReferences", mapping: "exact owner-reviewed public recovery definitions with authored booleans; source applicability and blocked behavior remain in review metadata, not runtime or evidence admission" },
      scenarios: { sourceRef: ".product-experience/pdp-3-product-experience/experience-source-bindings.yaml", sourcePath: "scenarioStartingStateBindings plus exact journey/action scenarioRefs", mapping: "project only scenario IDs with an exact source fixture seed and a resolvable canonical startingStateRef; leave contextDimensions empty when none are asserted" },
      fixtures: { sourceRef: ".product-experience/pdp-3-product-experience/scenario-fixture-registry.yaml", sourcePath: "fixtures plus libs/media-experience-simulation/src/fixtures.ts", mapping: "linked fixture descriptor references exact scenario, fixture key, source path and authored conditions; source payload is not copied or treated as runtime evidence" },
      search: { sourceRef: ".product-experience/pdp-3-product-experience/search-inspection-contracts.yaml", sourcePath: "search[] and sourceBindings.searches", mapping: "schema-shaped search records with exact PDP-1 type refs; query execution and owner acceptance remain pending" },
      inspections: { sourceRef: ".product-experience/pdp-3-product-experience/search-inspection-contracts.yaml", sourcePath: "inspections[] and sourceBindings.inspections", mapping: "schema-shaped projection-kind records; source review and runtime admission remain pending" },
      createdAt: { sourceRef: null, sourcePath: "candidate generation event", mapping: "projection build timestamp, not a product-authority timestamp" },
      updatedAt: { sourceRef: null, sourcePath: "candidate generation event", mapping: "projection build timestamp, not a product-authority timestamp" },
    },
    fieldMappingBlockers: {
      componentContracts: ["Required props are directly mapped only for component contracts with exact typed public-interface source refs; the remaining component families have no source-bound typed prop contract and retain empty candidate arrays."],
      views: ["View identity, purpose, exact resolvable component refs, and all 132 source journeyRefs are directly projected; only PDP-1 stateRefs remain unbound."],
      journeys: ["PDP-3 journey mappings remain unresolved per the generated journey binding audit."],
      interactions: [],
      states: [],
      transitions: ["PDP-0 transition proposals lack resolved PDP-1 actionRefs and guard references; the P1 state/operation owners have not accepted a legal source-to-target binding."],
      actions: ["The 146 UI action records supply exact labels, prose, and preconditions, but do not select canonical PDP-1 operationRefs or exact action-to-effect bindings for producesEffectRefs."],
      effects: ["The action source does not classify each effect into the public effect-kind enum; six reversible values are conditional prose while the schema requires a boolean, so those cannot be narrowed without owner decisions."],
      finality: ["Only actions whose confirmation prose explicitly requires confirmation and whose reversible field is a boolean have a candidate finality record; other confirmation wording and conditional reversibility remain unresolved."],
      recovery: ["Five recovery narratives and exact action/scenario cross-references are retained in source review metadata; the source does not provide the public automaticRecovery/userActionRequired booleans or all canonical state/finality references."],
      scenarios: ["Scenario residual counts are derived from exact projected records and the registered fixture denominator; context dimensions are not asserted."],
      fixtures: ["Only fixtures with a projected linked scenario and an exact fixture key in the local simulation source are emitted; records carry source descriptors, not an inlined executable payload."],
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
  const schemaTarget = resolveTopLevelSchema(schema);
  const projectionFieldInventory = {
    schemaId: schema.$id,
    fields: Object.entries(schemaTarget.properties ?? {}).map(([name]) => ({
      name,
      required: (schemaTarget.required ?? []).includes(name),
    })),
  };
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
    projectionFieldInventory,
    schemaValid,
    schemaBlockers,
    publicValidator: definition.validatorBinding,
    publicValidatorPassed: publicValidatorBlockers.length === 0,
    publicValidatorBlockers,
  };
}

function resolveTopLevelSchema(schema) {
  let current = schema;
  const visited = new Set();
  while (typeof current?.$ref === "string") {
    const reference = current.$ref;
    if (!reference.startsWith("#/")) throw new Error(`Projection schema has an unsupported top-level reference: ${reference}`);
    if (visited.has(reference)) throw new Error(`Projection schema has a recursive top-level reference: ${reference}`);
    visited.add(reference);
    current = reference.slice(2).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
      .reduce((value, part) => value?.[part], schema);
    if (!current || typeof current !== "object") throw new Error(`Projection schema reference does not resolve: ${reference}`);
  }
  return current;
}

function candidateFieldCoverageDiagnostics(inventory, candidateModel, candidateFieldSources, candidateMappingReview, fieldMappingBlockers) {
  const diagnostics = [];
  const schemaFields = inventory.fields.map(({ name }) => name);
  const schemaFieldSet = new Set(schemaFields);
  const sourceFieldSet = new Set(Object.keys(candidateFieldSources));
  const dispositionFields = candidateMappingReview?.fieldDispositions ?? {};
  const blockers = new Set(Object.entries(fieldMappingBlockers)
    .filter(([, reasons]) => Array.isArray(reasons)
      && reasons.some((reason) => typeof reason === "string" && reason.trim()))
    .map(([field]) => field));
  const emptyCollectionDispositions = candidateMappingReview?.emptyCollectionDispositions ?? {};

  for (const field of schemaFields) {
    const mapping = candidateFieldSources[field];
    if (!mapping || typeof mapping.mapping !== "string" || !mapping.mapping.trim()) {
      diagnostics.push(`${field} has no source-mapping record for its public schema field`);
    }
    const disposition = dispositionFields[field]
      ?? (["createdAt", "updatedAt"].includes(field) ? dispositionFields.timestamps : undefined);
    if (!disposition?.status || !disposition?.source) {
      diagnostics.push(`${field} has no mapping disposition for its public schema field`);
    }
    if (!Object.hasOwn(candidateModel, field)) {
      const inventoryField = inventory.fields.find(({ name }) => name === field);
      const intentionalOmission = inventoryField && !inventoryField.required
        && disposition?.status === "OPTIONAL_AUTHORED_METADATA_OMITTED_INTENTIONALLY"
        && /omitted intentionally/iu.test(mapping?.mapping ?? "");
      if (inventoryField?.required || !intentionalOmission) {
        diagnostics.push(`${field} is omitted from candidateModel without an explicit optional omission disposition`);
      }
    } else if (Array.isArray(candidateModel[field]) && candidateModel[field].length === 0
      && !blockers.has(field)
      && !(emptyCollectionDispositions[field]?.status === "EMPTY_SOURCE_SET_CONFIRMED" && emptyCollectionDispositions[field]?.source)) {
      diagnostics.push(`${field} is an empty candidate collection without a blocker or explicit empty-source disposition`);
    }
  }

  for (const field of Object.keys(candidateModel)) {
    if (!schemaFieldSet.has(field)) diagnostics.push(`${field} is present in candidateModel but absent from the public schema field inventory`);
  }
  for (const field of sourceFieldSet) {
    if (!schemaFieldSet.has(field)) diagnostics.push(`${field} has a candidate field source but is absent from the public schema field inventory`);
  }
  for (const field of Object.keys(dispositionFields)) {
    if (!schemaFieldSet.has(field) && field !== "timestamps") {
      diagnostics.push(`${field} has a mapping disposition but is absent from the public schema field inventory`);
    }
  }
  for (const field of Object.keys(fieldMappingBlockers)) {
    if (!schemaFieldSet.has(field)) diagnostics.push(`${field} has blocker metadata but is absent from the public schema field inventory`);
  }
  for (const field of Object.keys(emptyCollectionDispositions)) {
    if (!schemaFieldSet.has(field)) diagnostics.push(`${field} has an empty-source disposition but is absent from the public schema field inventory`);
  }
  return diagnostics;
}

const outputs = [];
const generationTimestamp = new Date().toISOString();
for (const definition of definitions) {
  const sources = await Promise.all(definition.sources.map(loadSource));
  const candidateModel = definition.candidate(sources, generationTimestamp);
  const fieldMappingBlockersForProjection = { ...definition.fieldMappingBlockers };
  if (definition.name === "product-definition") {
    const byRef = new Map(sources.map(({ sourceRef, content }) => [sourceRef, content]));
    const goals = byRef.get(".product-experience/pdp-0-product-truth/goals-jtbd.yaml") ?? {};
    const intentResolutions = byRef.get(".product-experience/pdp-0-product-truth/intent-resolutions.yaml") ?? {};
    const requirements = byRef.get(".product-experience/pdp-0-product-truth/requirements.yaml") ?? {};
    const resolvedIntentIds = new Set((intentResolutions.intents ?? [])
      .filter((resolution) => resolution.actorStatus === "resolved"
        && typeof resolution.actorRef === "string"
        && ["must", "should", "could", "wont"].includes(resolution.priority))
      .map(({ id }) => id));
    const unresolvedIntentIds = (goals.intents ?? [])
      .filter(({ id }) => !resolvedIntentIds.has(id))
      .map(({ id }) => id);
    const unresolvedRequirementTargets = (requirements.requirements ?? []).flatMap((requirement) =>
      (requirement.traceToIntentIds ?? []).filter((intentId) => !resolvedIntentIds.has(intentId))
        .map((intentId) => ({ requirementId: requirement.id, intentId })));
    if (unresolvedIntentIds.length === 0) delete fieldMappingBlockersForProjection.userIntents;
    else fieldMappingBlockersForProjection.userIntents = [
      `${unresolvedIntentIds.length} of ${(goals.intents ?? []).length} ProductDefinition userIntents lack exact resolved actor/priority records.`,
    ];
    if (unresolvedRequirementTargets.length === 0) delete fieldMappingBlockersForProjection.requirements;
    else fieldMappingBlockersForProjection.requirements = [
      `${unresolvedRequirementTargets.length} requirement trace refs target unresolved or absent ProductDefinition userIntents.`,
    ];
  }
  if (definition.name === "experience-specification") {
    const scenarioFixtureRegistry = sources.find((source) => source.sourceRef === ".product-experience/pdp-3-product-experience/scenario-fixture-registry.yaml")?.content;
    const registeredScenarioCount = scenarioFixtureRegistry?.fixtures?.length ?? 0;
    const projectedScenarioCount = candidateModel.scenarios?.length ?? 0;
    fieldMappingBlockersForProjection.journeys = [candidateModel._mappingReview.journeyBindingAudit.remainingGap];
    const definitionReview = candidateModel._mappingReview.definitionSemantics;
    if (definitionReview.recoveryMappingComplete) delete fieldMappingBlockersForProjection.recovery;
    else fieldMappingBlockersForProjection.recovery = [`${definitionReview.recoverySourceCount - definitionReview.projectedRecoveries} existing recovery records lack reviewed typed definition mappings; no booleans inferred from prose.`];
    fieldMappingBlockersForProjection.actions = [`Only ${candidateModel.actions.filter((action) => action.producesEffectRefs.length).length} of ${candidateModel.actions.length} existing actions have directly mapped effect references; remaining canonical operation/effect relationships stay open.`];
    fieldMappingBlockersForProjection.effects = [`${definitionReview.projectedEffects} exact unconditional effect definitions are projected; conditional or unknown reversibility remains unrepresentable as a public boolean, and the remaining action population is unresolved.`];
    fieldMappingBlockersForProjection.scenarios = [
      `Only ${projectedScenarioCount} of ${registeredScenarioCount} registry records have an exact source-fixture state that maps to a canonical PDP-0 state; ${Math.max(0, registeredScenarioCount - projectedScenarioCount)} remain unresolved, and context dimensions are not asserted.`,
    ];
  }
  const candidateMappingReview = candidateModel._mappingReview;
  delete candidateModel._mappingReview;
  const { projectionFieldInventory, ...validation } = await validationFor(definition, candidateModel, sources);
  const fieldCoverageDiagnostics = candidateFieldCoverageDiagnostics(
    projectionFieldInventory,
    candidateModel,
    definition.candidateFieldSources,
    candidateMappingReview,
    fieldMappingBlockersForProjection,
  );
  if (fieldCoverageDiagnostics.length > 0) {
    throw new Error(`${definition.name} projection field coverage failed:\n${fieldCoverageDiagnostics.map((entry) => `- ${entry}`).join("\n")}`);
  }
  const fieldMappingBlockers = Object.entries(fieldMappingBlockersForProjection)
    .filter(([, reasons]) => reasons.some((reason) => typeof reason === "string" && reason.trim()))
    .map(([field, reasons]) => ({
    field,
    status: candidateMappingReview?.fieldDispositions?.[field]?.status ?? "BLOCKED_NO_DIRECT_LOSSLESS_MAPPING",
    ...(candidateMappingReview?.fieldDispositions?.[field]?.source ? { sourceDisposition: candidateMappingReview.fieldDispositions[field].source } : {}),
    reasons: reasons.length > 0 ? reasons : (candidateMappingReview?.fieldDispositions?.[field]?.source ? [candidateMappingReview.fieldDispositions[field].source] : []),
    sourceAuthoritiesReviewed: definition.sources,
    }));
  const projection = {
    projectionKind: definition.name,
    projectionStatus: "GENERATED_CANDIDATE_NOT_ACCEPTED_NOT_CURRENT",
    subjectId: candidateModel.subjectId,
    sourceAuthorities: sources.map(observeSource),
    candidateModel,
    ...(candidateMappingReview ? { candidateMappingReview } : {}),
    projectionFieldInventory,
    candidateFieldSources: definition.candidateFieldSources,
    fieldMappingBlockers,
    derivationBoundary: "candidateModel is a structurally conformant partial projection populated from direct source records where mappings exist. Empty collections represent unresolved mappings, never accepted non-applicability. Where a contract requires generated timestamps, they are projection-build metadata rather than canonical product timestamps; optional ProductDefinition timestamps are omitted when source provenance is absent. Source facts remain proposals until owners accept the mappings; this artifact does not claim semantic completeness, phase acceptance, or currentness.",
    knownBlockers: [definition.blocker],
    validation,
    ...(definition.name === "product-definition" ? {
      installedArtifactVerification: "PENDING; candidate validated against sibling public source entrypoint; installed package publication and isolated consumer verification remain open.",
    } : {}),
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
