import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const partition = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/migration-pending-owner-partition-499.json"), "utf8"));
const claims = new Map(partition.records.filter(({ sourceOwnerPhase }) => sourceOwnerPhase === "PDP-2").map((row) => [row.claimId, row]));
const sources = new Map();
const load = (file) => {
  if (!sources.has(file)) sources.set(file, parse(readFileSync(resolve(root, file), "utf8")));
  return sources.get(file);
};
const decode = (part) => part.replace(/~1/gu, "/").replace(/~0/gu, "~");
const allClausesPresent = (value, clauses) => {
  const observed = JSON.stringify(value);
  return clauses.every((clause) => observed.includes(clause));
};
function removeClauseFromValue(value, clause) {
  if (typeof value === "string") return value.replaceAll(clause, "[material clause removed]");
  if (Array.isArray(value)) return value.map((item) => removeClauseFromValue(item, clause));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key.replaceAll(clause, "removed-material-key"),
      removeClauseFromValue(item, clause),
    ]));
  }
  return value;
}
function resolveRef(ref) {
  const [file, pointer] = ref.split("#");
  return pointer.split("/").filter(Boolean).reduce((value, raw) => {
    const token = decode(raw);
    const id = token.match(/^@id=(.+)$/u);
    if (id) return Array.isArray(value) ? value.find((row) => row?.id === id[1]) : undefined;
    return value?.[token];
  }, load(file));
}

// These mappings only assert the exact owner clauses named below. The wider source
// claim and any independent/runtime acceptance remain outside this test's effect.
const mappedClaims = [
  ["MPSEM-0017-C003", ".product-experience/pdp-2-design-interface-system/component-contracts.yaml#/ownerDefinedComponentRules/@id=media.component.source-change-and-evidence-boundary.v1", ["A source relocation preserves existing behavior, identities, authority checks, and side effects", "new product behavior is specified as a separate change", "actual public boundary covers the required typed inputs, states, actions, errors, and accessibility behavior", "Safety-critical authority, denial, uncertainty, finality, and budget rules must be explicit", "Desired quality is a target, not a guarantee"]],
  ["MPSEM-0033-C001", ".product-experience/pdp-2-design-interface-system/animation-simulation-grammar.yaml#ownerDefinedClockPresentation", ["mediaPresentation", "audioSamples", "simulation", "story", "wallClock", "cross-clock, cross-stream, timebase, frame-rate, sample-rate, and drift conversion uses the exact referenced PDP-1 definition", "missing mapping disables conversion"]],
  ["MPSEM-0034-C001", ".product-experience/pdp-2-design-interface-system/api/async-operations.yaml#/ownerDefinedAsyncRules/@id=media.async.definition-and-run-state-separation.v1", ["A versioned workflow definition contains only its declared stages, typed parameters, policy references, and dependency edges", "Each invocation is a separately identified run", "Run status never rewrites the definition", "workflow graph alone grants no dispatch authority or runtime execution"]],
  ["MPSEM-0037-C001", ".product-experience/pdp-2-design-interface-system/component-contracts.yaml#/ownerDefinedComponentRules/@id=media.component.erasure-retention-provenance.v1", ["Immutable output versions and provenance do not require retaining source media or personal content forever", "Apply the exact lifecycle decision to content and derivatives", "retain only provenance fields required and permitted for audit", "remove protected content from copied caches/previews/temporary artifacts", "legal hold or undeletable external copy as a separately scoped disposition"]],
  ["MPSEM-0077-C001", ".product-experience/pdp-2-design-interface-system/component-contracts.yaml#/components/@id=media.component.intent-launcher", ["choose a Media outcome without selecting an implementation provider", "must-not-expose-model-or-provider-selection-as-a-normal-intent-choice"]],
  ["MPSEM-0090-C001", ".product-experience/pdp-2-design-interface-system/animation-simulation-grammar.yaml#mediaSemanticResponsibilityBoundary", ["mediaMeaningProjectsAndAssets", "processingSpecificationsAndOperations", "jobPolicyAndState", "timelineAndExactTime", "animationAndSimulationPresentation", "mediaQualityPolicy", "rightsAndPrivacy", "deliveryAndExecutionPolicy", "P2 consumes and presents those meanings", "does not create a second authority"]],
  ["MPSEM-0022-C004", ".product-experience/pdp-2-design-interface-system/semantic-state-grammar.yaml#/ownerDefinedStatePresentationRules/@id=media.ui.behavior-preserving-relocation.v1", ["preserves the prior behavior, identities, authorization checks, side effects, error/finality semantics, and persistence boundaries", "New behavior is a separately identified change"]],
  ["MPSEM-0025-C002", ".product-experience/pdp-2-design-interface-system/api/conventions.yaml#/ownerDefinedProjectionRules/@id=media.api.authored-source-projection-authority.v1", ["Authored owner sources and explicitly versioned overlays are the only inputs", "Generated files are outputs, never the primary place to change semantics"]],
  ["MPSEM-0025-C004", ".product-experience/pdp-2-design-interface-system/api/conventions.yaml#/ownerDefinedProjectionRules/@id=media.api.authored-source-projection-authority.v1", ["Generated files are outputs, never the primary place to change semantics", "cannot add an operation, field, status, authority, or finality rule"]],
  ["MPSEM-0310-C004", ".product-experience/pdp-2-design-interface-system/api/conventions.yaml#/ownerDefinedProjectionRules/@id=media.api.contract-generation-and-transport-verification.v1", ["Endpoint paths, methods, status/result meanings, schemas, and operation bindings are authored in the versioned owner contract", "actual bound transport", "A passing schema-only test or generated fixture test is not actual transport parity"]],
  ["MPSEM-0025-C001", ".product-experience/pdp-2-design-interface-system/api/conventions.yaml#/ownerDefinedProjectionRules/@id=media.api.authored-source-projection-authority.v1", ["Authored owner sources and explicitly versioned overlays are the only inputs", "Generated files are outputs, never the primary place to change semantics", "cannot add an operation, field, status, authority, or finality rule that its accepted inputs do not contain"]],
  ["MPSEM-0060-C002", ".product-experience/pdp-2-design-interface-system/api/compatibility.yaml#/ownerDefinedCompatibilityRules/@id=media.api.no-parallel-product-fork.v1", ["one current semantic owner", "Do not create a parallel V2 product or preserve an indefinite compatibility-code fork", "explicit owner-approved migration path", "versioned compatibility window", "end condition"]],
  ["MPSEM-0473-C002", ".product-experience/pdp-2-design-interface-system/api/conventions.yaml#ownerDefinedExecutionBoundary", ["The product-native execution boundary is owned by Media", "Tools may provide development and authoring mechanics", "not production execution, durable dispatch, or product finality", "selects no deployment technology, service topology, or runtime", "does not claim runtime implementation, qualification, or admission"]],
  ["MPSEM-0171-C003", ".product-experience/pdp-2-design-interface-system/gui/patterns/catalog.yaml#/acceptance/criteria/0", ["references canonical Media state and action contracts"]],
  ["MPSEM-0331-C004", ".product-experience/pdp-2-design-interface-system/api/conventions.yaml#/authorityAndProjection/projectionConstraints", ["Do not add an OpenAPI schema, route, status, header, or example as a product rule unless its owning rule and operation binding are approved"]],
  ["MPSEM-0259-C003", ".product-experience/pdp-2-design-interface-system/localization-content.yaml#/ownerDefinedLocalizationRules/@id=media.localization.original-and-intermediate-precision.v1", ["Preserve the exact original value and every retained intermediate value", "cannot overwrite the canonical value", "conversion that changes precision must produce a separately identified derived value", "exact conversion, rounding mode, and disclosed loss", "unknown precision or conversion history remains unknown"]],
  ["MPSEM-0352-C003", ".product-experience/pdp-2-design-interface-system/api/retry-timeout-unknown-outcome.yaml#ownerDefinedReplayPersistenceRequirement", ["durably commits the trusted tenant", "client request key", "canonical effect-bearing request fingerprint", "replay fence", "prior result/receipt before the first externally visible effect", "retention boundary and expiry are explicit", "changed fingerprint conflicts", "perform no second effect"]],
  ["MPSEM-0353-C001", ".product-experience/pdp-2-design-interface-system/cli-language.yaml#/ownerDefinedMachineOutputRules/@id=media.cli.effective-configuration-redaction.v1", ["resolutionOrder", "explicit-flag", "environment", "selected-project-or-profile-file", "user-config", "product-default", "cannot be overridden by any flag, environment variable, project/profile file, user config, or product default", "Reject unknown or conflicting profile fields"]],
  ["MPSEM-0374-C006", ".product-experience/pdp-0-product-truth/reuse-decisions.yaml#mediaArchitectureRules/externalStackSelectionRule", ["candidate-library or engine selection is not an integration mandate", "exact admitted Media capability/profile", "demonstrated Ghatana reuse gap", "select the smallest stack", "One qualified implementation is selected for an exact capability/profile", "do not keep parallel adapters or silently fall back"]],
  ["MPSEM-0103-C002", ".product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml#packagingClassificationBoundary", ["STANDALONE_CLOSURE", "PROPOSED_INITIAL_CLASSIFICATION_ONLY", "does not establish a package schema", "exact reuse dispositions", "actualOwnerSchema", "NOT_ESTABLISHED_BY_THIS_CLASSIFICATION", "Shared package publication, consumer binding, implementation admission, and independent conformance remain open"]],
  ["MPSEM-0458-C003", ".product-experience/pdp-0-product-truth/reuse-decisions.yaml#selectionRegister/externalCandidates/@id=TECH-FFMPEG", ["TECH-FFMPEG", "REJECTED_FOR_DEFAULT_BUNDLE", "exact-build-license-is-configuration-dependent", "build-configuration-specific-legal-review-would-be-required-for-exception", "not-installed-or-activated"]],
  ["MPSEM-0296-C005", ".product-experience/interface-parity/operation-parity.yaml#ownerDefinedSourceTruthMatrix", ["Every inventoried public method, path, SDK method, and UI action has an exact identity", "source owner", "implementation/source evidence", "explicit semantic disposition", "unknown or unsupported identity is named as a gap rather than inferred from its label"]],
  ["MPSEM-0157-C002", ".product-experience/pdp-2-design-interface-system/gui/screen-composition-schema.yaml#semanticCoverageRequirement", ["meaning-actors-outcomes-requirements", "domain-time-units", "authority-and-rights", "state-failure-and-finality", "dependencies-and-nfrs"]],
  ["MPSEM-0159-C003", ".product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml#architectureIdentityBoundary", ["one canonical PDP-1 authority", "may not create independent business state machines", "duplicate external service schemas", "new transition meaning", "alternate finality", "field-level projection, loss/rejection, error/finality mapping"]],
  ["MPSEM-0165-C001", ".product-experience/pdp-2-design-interface-system/api/identifiers.yaml#ownerDefinedIdentityReconciliation", ["resolve the exact existing owning glossary/domain/operation identity", "Reuse and register an equivalent authority instead of inventing a duplicate alias", "If no existing owner identity has the required meaning, define a new versioned Media identity", "External service schema identities remain owned by that service"]],
  ["MPSEM-0161-C001", ".product-experience/pdp-2-design-interface-system/api/conventions.yaml#/ownerDefinedProjectionRules/@id=media.api.authored-source-projection-authority.v1", ["external schemas remain with their service owner", "a local copy of an external service schema does not become its authoritative source"]],
  ["MPSEM-0158-C002", ".product-experience/pdp-2-design-interface-system/gui/reuse-audit.yaml#grammarCoverageInventory", ["visual", "interaction", "content", "accessibility", "responsive", "terminal", "SOURCE_INVENTORY_ONLY", "grammar-acceptance"]],
  ["MPSEM-0309-C001", ".product-experience/pdp-2-design-interface-system/api/conventions.yaml#ownerDefinedHealthAndDiagnosticsBoundary", ["liveness, readiness, and detailed diagnostics as three independently named contracts", "readiness answers whether the explicitly required dependencies", "detailed diagnostics expose only separately authorized, authenticated, redacted information", "Missing, stale, or unobservable dependency state is UNKNOWN", "no current endpoint, runtime health behavior, or authentication acceptance is claimed"]],
  ["MPSEM-0365-C002", ".product-experience/pdp-2-design-interface-system/component-contracts.yaml#/ownerDefinedComponentRules/@id=media.component.erasure-retention-provenance.v1", ["Apply the exact lifecycle decision to content and derivatives", "retain only provenance fields required and permitted for audit", "legal hold or undeletable external copy as a separately scoped disposition"]],
  ["MPSEM-0385-C002", ".product-experience/pdp-2-design-interface-system/component-contracts.yaml#/ownerDefinedComponentRules/@id=media.component.optional-ai-planner-isolation.v1", ["An unavailable or unqualified optional AI planner does not make a separately defined deterministic editing operation unavailable", "preserve the exact deterministic input, edit, validation, and save path", "Do not silently substitute another model/provider", "Planner availability, model qualification, and runtime behavior remain independently unevaluated"]],
  ["MPSEM-0291-C003", ".product-experience/pdp-0-product-truth/profile-semantics.yaml#fallbackSemantics", ["frameRateChange", "durationChange", "permitted", "allowedOutputRates", "maximumTemporalDeviation", "minimumDuration", "maximumDuration", "editOrNarrativeDisposition"]],
  ["MPSEM-0455-C001", ".product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml#dependencyGapResolutionRule", ["extend that dependency owner's public contract with its approval", "extract only genuinely reusable mechanics with owner approval", "use a bounded integration against an exact public artifact/version", "select an external component only after recording why the internal candidate is inadequate", "Never fork or copy Shared, Tools, or Kernel", "Scope a blocker to its exact capability, profile, channel, and deployment boundary"]],
  ["MPSEM-0450-C001", ".product-experience/pdp-2-design-interface-system/gui/patterns/activity-attention.yaml#ownerDefinedAttentionNotificationScope", ["action-required", "material-degradation", "approval-required", "long-running-work-completed", "delivery-outcome", "critical-security-or-rights-issue", "authoritative current fact or event", "delivery, display, read state, or omission is an acknowledgment"]],
  ["MPSEM-0449-C002", ".product-experience/pdp-2-design-interface-system/component-contracts.yaml#/ownerDefinedComponentRules/@id=media.component.job-outcome-and-safe-next-action.v1", ["exact submitted operation and authoritative recorded outcome", "states whether work may still be running", "exact immutable version is inspectable", "integrity, access, rights, and review requirements are satisfied", "job success alone is insufficient", "next action explicitly supported by the current operation contract"]],
  ["MPSEM-0452-C002", ".product-experience/pdp-2-design-interface-system/gui/patterns/catalog.yaml#/patterns/@id=media.gui.pattern.creation-plan-review", ["Review proposed outcome, material choices, support, and consequences before execution", "draft", "confirm-or-edit"]],
  ["MPSEM-0177-C004", ".product-experience/pdp-2-design-interface-system/gui/patterns/catalog.yaml#/ownerDefinedPatternRules/@id=media.gui.rights-consent-currentness-before-effect.v1", ["Before each affected consequential operation, revalidate current admission, consent, and rights", "under the same tenant/principal and operation scope", "Stale, revoked, expired, missing, or unavailable evidence remains unresolved/denied", "a prior screen review, cached valid label, or user confirmation does not authorize a later effect"]],
  ["MPSEM-0029-C004", ".product-experience/pdp-2-design-interface-system/semantic-state-grammar.yaml#/ownerDefinedStatePresentationRules/@id=media.ui.state-presentation-not-state-machine.v1", ["Media owns state meaning, transition, scheduling, and persistence"]],
  ["MPSEM-0033-C003", ".product-experience/pdp-2-design-interface-system/animation-simulation-grammar.yaml#ownerDefinedClockPresentation", ["rationalMediaAndSimulationStoryTime", "sampleBoundary", "sourceFrameSampleMapping", "cross-clock, cross-stream, timebase, frame-rate, sample-rate, and drift conversion", "wallClock"]],
  ["MPSEM-0035-C004", ".product-experience/pdp-2-design-interface-system/component-contracts.yaml#/ownerDefinedComponentRules/@id=media.component.bounded-repair-loop.v1", ["finite per-operation bound for attempt count, elapsed time, and resource budget", "an unknown outcome is reconciled before continuing"]],
  ["MPSEM-0041-C001", ".product-experience/pdp-2-design-interface-system/component-contracts.yaml#/ownerDefinedComponentRules/@id=media.component.navigation-and-safety-visibility.v1", ["keeping the current location, primary task navigation, Cancel, Undo", "access/rights denial, uncertainty, and safety warnings discoverable and operable"]],
  ["MPSEM-0042-C003", ".product-experience/pdp-2-design-interface-system/cli-language.yaml#/ownerDefinedInvocationRules/@id=media.cli.cross-channel-canonical-action-identity.v1", ["Every command in the one canonical registry has one unique command ID", "explicit actionRef that resolves by exact ID to the Media action registry", "exact operation ID/version or an explicit non-domain disposition", "no command or alias may be inferred", "sole source for help/completion", "current command registry contains 12 synthetic fixture commands", "does not establish production CLI/Web/API transport binding or runtime admission"]],
  ["MPSEM-0042-C005", ".product-experience/pdp-2-design-interface-system/cli-language.yaml#ownerDefinedMachineOutputRules", ["stdout contains exactly one versioned result or error object", "cannot change stable JSON keys, reason codes, command effects, or exit-code meaning", "stdout contains only one complete JSON object per line", "Ctrl-C or another local interruption while waiting stops the local wait only", "remote cancellation is a separate explicit operation"]],
  ["MPSEM-0074-C001", ".product-experience/pdp-2-design-interface-system/semantic-state-grammar.yaml#/ownerDefinedStatePresentationRules/@id=media.ui.state-presentation-not-state-machine.v1", ["Brand strings, CSS classes, screen names, and localized labels never create states, transitions, finality, or scheduling policy"]],
  ["MPSEM-0193-C004", ".product-experience/pdp-2-design-interface-system/semantic-state-grammar.yaml#/ownerDefinedStatePresentationRules/@id=media.ui.no-semantic-dummy-input.v1", ["does not require a placeholder artifact, source file, or dummy input", "necessary to the selected Media operation"]],
  ["MPSEM-0204-C002", ".product-experience/pdp-2-design-interface-system/component-contracts.yaml#/ownerDefinedComponentRules/@id=media.component.risk-bounded-analysis-selection.v1", ["selects only operations eligible for the exact source, purpose, rights, profile, and budget", "measured improvement is greater than the declared artifact risk", "A default pipeline never applies every enhancer"]],
  ["MPSEM-0236-C002", ".product-experience/pdp-2-design-interface-system/api/compatibility.yaml#acceptance/criteria", ["changes are classified for request and response compatibility", "semantic changes are not disguised as additive"]],
  ["MPSEM-0300-C002", ".product-experience/pdp-2-design-interface-system/component-contracts.yaml#/ownerDefinedComponentRules/@id=media.component.acceptance-after-durable-identity.v1", ["stable tenant/principal-scoped identity and durable owner receipt before acceptance is reported", "unknown commit results remain unknown"]],
  ["MPSEM-0311-C001", ".product-experience/pdp-2-design-interface-system/api/idempotency.yaml#ownerDefinedIdempotencySemantics", ["trustedTenantId", "trustedPrincipalIdWhenOperationScoped", "exactCanonicalOperationId", "operationVersion", "clientRequestKey", "canonicalValidatedRequestFingerprint"]],
  ["MPSEM-0311-C005", ".product-experience/pdp-2-design-interface-system/api/retry-timeout-unknown-outcome.yaml#ownerDefinedRetrySemantics", ["read-only observation before considering any resubmission", "never mint a new request identity"]],
  ["MPSEM-0311-C006", ".product-experience/pdp-2-design-interface-system/api/retry-timeout-unknown-outcome.yaml#ownerDefinedRetrySemantics", ["read-only observation before considering any resubmission", "never mint a new request identity"]],
  ["MPSEM-0312-C003", ".product-experience/pdp-2-design-interface-system/api/retry-timeout-unknown-outcome.yaml#ownerDefinedRetrySemantics", ["provider-supplied parameters cannot override reserved tenant, principal, authorization, budget, routing, profile-version, or idempotency fields"]],
  ["MPSEM-0314-C003", ".product-experience/pdp-2-design-interface-system/semantic-state-grammar.yaml#/ownerDefinedStatePresentationRules/@id=media.ui.state-presentation-not-state-machine.v1", ["never create states, transitions, finality, or scheduling policy"]],
  ["MPSEM-0315-C001", ".product-experience/pdp-2-design-interface-system/api/cancellation.yaml#ownerDefinedCancellationSemantics", ["does not issue a server cancellation request", "local poll only ends observation"]],
  ["MPSEM-0315-C003", ".product-experience/pdp-2-design-interface-system/api/errors.yaml#ownerDefinedErrorSemantics", ["stable Media reason code", "partial result is listed only by exact inspectable output-version references", "UNKNOWN_OUTCOME"]],
  ["MPSEM-0316-C001", ".product-experience/pdp-2-design-interface-system/cli-language.yaml#/ownerDefinedInvocationRules/@id=media.cli.cross-channel-canonical-action-identity.v1", ["explicit canonical action ID and exact operation/version binding", "equal to the binding used by the corresponding Web/API command", "command spelling, route shape, provider name, or fixture label never establishes equivalence"]],
  ["MPSEM-0163-C001", ".product-experience/pdp-2-design-interface-system/component-contracts.yaml#/ownerDefinedComponentRules/@id=media.component.upstream-owner-source-first.v1", ["route the requirement to the authoritative source phase and correct that source first", "cannot repair it with a local override, duplicate taxonomy, or generated artifact edit", "Record the exact owner source and selector"]],
  ["MPSEM-0167-C002", ".product-experience/pdp-2-design-interface-system/api/conventions.yaml#/ownerDefinedProjectionRules/@id=media.api.authored-source-projection-authority.v1", ["external schemas remain with their service owner", "a local copy of an external service schema does not become its authoritative source"]],
  ["MPSEM-0171-C002", ".product-experience/pdp-2-design-interface-system/component-contracts.yaml#/ownerDefinedComponentRules/@id=media.component.typed-parameter-boundaries.v1", ["finite declared type, unit when dimensional, accepted range or finite enum", "Reject unknown or conflicting values"]],
  ["MPSEM-0331-C001", ".product-experience/pdp-2-design-interface-system/cli-language.yaml#/ownerDefinedInvocationRules/@id=media.cli.finite-command-family-registry.v1", ["finite set of registered command identities", "Wildcards, implicit aliases, or a parameter value cannot introduce a new command"]],
  ["MPSEM-0339-C001", ".product-experience/pdp-2-design-interface-system/cli-language.yaml#/machineOutput/productExitCodeTaxonomy/codes/@id=media.cli.exit.invalid-request", ["invalid-arguments-or-input-validation"]],
  ["MPSEM-0342-C001", ".product-experience/pdp-2-design-interface-system/cli-language.yaml#/machineOutput/productExitCodeTaxonomy/codes/@id=media.cli.exit.capability-unavailable", ["required-capability-unavailable-or-unqualified"]],
  ["MPSEM-0334-C006", ".product-experience/pdp-2-design-interface-system/cli-language.yaml#/ownerDefinedInvocationRules/@id=media.cli.literal-argument-boundary.v1", ["Treat user-supplied values, paths, filter expressions, profile names, and request text as literal data", "Never interpolate them into a shell command"]],
  ["MPSEM-0335-C001", ".product-experience/pdp-2-design-interface-system/cli-language.yaml#/ownerDefinedMachineOutputRules/@id=media.cli.machine-output-exit-semantics.v1", ["stdout contains exactly one versioned result or error object", "diagnostics and progress use stderr"]],
  ["MPSEM-0335-C002", ".product-experience/pdp-2-design-interface-system/cli-language.yaml#/ownerDefinedMachineOutputRules/@id=media.cli.machine-output-exit-semantics.v1", ["diagnostics and progress use stderr", "color-disabled output contains no ANSI escapes"]],
  ["MPSEM-0335-C005", ".product-experience/pdp-2-design-interface-system/cli-language.yaml#/ownerDefinedMachineOutputRules/@id=media.cli.machine-output-exit-semantics.v1", ["TTY, color, quiet, and width choices may change presentation only", "Non-TTY output remains line-oriented", "color-disabled output contains no ANSI escapes"]],
  ["MPSEM-0335-C006", ".product-experience/pdp-2-design-interface-system/cli-language.yaml#/ownerDefinedMachineOutputRules/@id=media.cli.machine-output-exit-semantics.v1", ["TTY, color, quiet, and width choices may change presentation only", "cannot change stable JSON keys, reason codes, command effects, or exit-code meaning"]],
  ["MPSEM-0336-C003", ".product-experience/pdp-2-design-interface-system/cli-language.yaml#/ownerDefinedMachineOutputRules/@id=media.cli.wait-timeout-semantics.v1", ["returns the requested final result or an explicit non-success"]],
  ["MPSEM-0336-C005", ".product-experience/pdp-2-design-interface-system/cli-language.yaml#/ownerDefinedMachineOutputRules/@id=media.cli.wait-timeout-semantics.v1", ["client timeout bounds observation", "does not cancel the remote job, prove failure, or authorize a blind resubmission"]],
  ["MPSEM-0346-C001", ".product-experience/pdp-2-design-interface-system/api/async-operations.yaml#/ownerDefinedAsyncRules/@id=media.async.timeout-and-unknown-finality.v1", ["local interruption ends observation only", "report unknown finality when authoritative evidence is unavailable"]],
  ["MPSEM-0350-C001", ".product-experience/pdp-2-design-interface-system/api/errors.yaml#ownerDefinedErrorSemantics", ["partial output is not full success", "unavailable references are omitted rather than guessed"]],
  ["MPSEM-0353-C002", ".product-experience/pdp-2-design-interface-system/component-contracts.yaml#/ownerDefinedComponentRules/@id=media.component.typed-parameter-boundaries.v1", ["finite declared type, unit when dimensional, accepted range or finite enum", "Reject unknown or conflicting values"]],
  ["MPSEM-0353-C003", ".product-experience/pdp-2-design-interface-system/cli-language.yaml#/ownerDefinedMachineOutputRules/@id=media.cli.effective-configuration-redaction.v1", ["`config show` reports effective values only for declared configuration fields", "safe source category", "without exposing credentials, tokens, secrets, or protected content", "if a value cannot be safely classified, omit it"]],
  ["MPSEM-0354-C002", ".product-experience/pdp-2-design-interface-system/api/auth.yaml#acceptance/criteria", ["authorize tenant/workspace/project/resource and action independently"]],
  ["MPSEM-0358-C001", ".product-experience/pdp-2-design-interface-system/api/auth.yaml#acceptance/criteria", ["authenticate through admitted Shared identity boundary"]],
  ["MPSEM-0358-C004", ".product-experience/pdp-2-design-interface-system/api/http-canonical-adapters.yaml#/adapterRules/@id=media.http.adapter-rule.no-effect-on-reject", ["rejects before mutation, dispatch, stream attachment, or frame acceptance"]],
  ["MPSEM-0367-C004", ".product-experience/pdp-2-design-interface-system/component-contracts.yaml#/ownerDefinedComponentRules/@id=media.component.erasure-retention-provenance.v1", ["do not require retaining source media or personal content forever", "Apply the exact lifecycle decision to content and derivatives"]],
  ["MPSEM-0370-C001", ".product-experience/pdp-2-design-interface-system/trust-provenance-grammar.yaml#ownerDefinedOriginClassification", ["media.origin.edited", "media.origin.generatively-enhanced", "media.origin.ai-generated", "media.origin.simulation-generated", "Edited and generatively enhanced are distinct classes", "neither implies validation, measurement, truth, ownership, license, or permission"]],
  ["MPSEM-0376-C001", ".product-experience/pdp-2-design-interface-system/api/async-operations.yaml#/ownerDefinedAsyncRules/@id=media.async.parent-child-budget-and-cancellation-scope.v1", ["deadline, cancellation policy, and remaining budget propagate to each child stage", "child completion remains scoped to that child"]],
  ["MPSEM-0299-C004", ".product-experience/pdp-2-design-interface-system/api/async-operations.yaml#/ownerDefinedAsyncRules/@id=media.async.group-retry-item-finality.v1", ["retains each item's exact original operation and request identity", "Completed eligible items are reused and not resubmitted", "unknown outcome is read-only reconciled", "unresolved ambiguity blocks that item's resubmission", "never mark a partial group complete"]],
  ["MPSEM-0376-C004", ".product-experience/pdp-2-design-interface-system/api/async-operations.yaml#/ownerDefinedAsyncRules/@id=media.async.child-output-lifecycle-boundary.v1", ["retains its exact immutable output identity and parent/child operation provenance", "only for the lifecycle and retention scope authorized by its owning Media policy", "Later parent failure does not erase or rewrite a completed child effect", "neither automatically retained forever nor implicitly deleted with its parent"]],
  ["MPSEM-0034-C002", ".product-experience/pdp-2-design-interface-system/api/async-operations.yaml#/ownerDefinedAsyncRules/@id=media.async.definition-and-run-state-separation.v1", ["A versioned workflow definition contains only its declared stages, typed parameters, policy references, and dependency edges", "Each invocation is a separately identified run", "Run status never rewrites the definition", "parameter or policy values never stand in for run state", "a workflow graph alone grants no dispatch authority or runtime execution"]],
  ["MPSEM-0440-C004", ".product-experience/pdp-2-design-interface-system/component-contracts.yaml#/ownerDefinedComponentRules/@id=media.component.contextual-workspace-navigation.v1", ["Storyboard, Editor, Audio, Captions, Versions, and Outputs", "exact project task", "stable destinations"]],
  ["MPSEM-0441-C004", ".product-experience/pdp-2-design-interface-system/component-contracts.yaml#/ownerDefinedComponentRules/@id=media.component.navigation-and-safety-visibility.v1", ["Cancel, Undo where valid", "access/rights denial, uncertainty, and safety warnings discoverable and operable"]],
  ["MPSEM-0444-C003", ".product-experience/pdp-2-design-interface-system/typography-layout.yaml#repeatSafeStepDisclosure", ["does not require a second confirmation dialog", "remain unchanged and current", "A prior confirmation is scoped to the exact action and facts shown"]],
  ["MPSEM-0446-C003", ".product-experience/pdp-2-design-interface-system/component-contracts.yaml#/ownerDefinedComponentRules/@id=media.component.undo-redo-effect-boundary.v1", ["versioned local edit history", "never reverse a published delivery, external provider effect, consent decision"]],
  ["MPSEM-0447-C003", ".product-experience/pdp-2-design-interface-system/api/concurrency.yaml#rules", ["define conflict behavior per operation for stale preconditions", "do not equate a job attempt with a resource revision", "does not establish compare-and-set support or immutable storage"]],
  ["MPSEM-0449-C003", ".product-experience/pdp-2-design-interface-system/api/async-operations.yaml#/ownerDefinedAsyncRules/@id=media.async.timeout-and-unknown-finality.v1", ["unknown finality when authoritative evidence is unavailable", "reconcile the same operation before retry"]],
  ["MPSEM-0450-C004", ".product-experience/pdp-2-design-interface-system/api/correlation.yaml#ownerDefinedProtectedInspectorRule", ["separately authenticated protected inspector", "exact tenant, principal, operation, and resource scope", "revalidate current read authority", "Redact credentials, secrets, raw media, prompts, transcript text, and personal data", "never a bearer capability", "denies the inspector response"]],
  ["MPSEM-0452-C004", ".product-experience/pdp-2-design-interface-system/motion.yaml#ownerDefinedPhotosensitivitySafePlayback", ["Before playback", "flashing or motion", "applicable content-risk check", "safe-playback disposition", "missing, stale, or unsupported analysis as a clean result", "block automatic or uninterrupted playback", "warning before playback", "safe alternative", "no-universal-safe-flashing-threshold-is-defined-here", "no-runtime-detector-or-player-behavior-is-claimed"]],
  ["MPSEM-0040-C005", ".product-experience/pdp-0-product-truth/reuse-decisions.yaml#mediaArchitectureRules/componentLicenseBoundary/processIsolationDoesNotWaiveLicenseRule", ["Container, process, or adapter isolation narrows execution and authority boundaries but does not waive license", "patent", "attribution", "redistribution", "dataset", "model-weight", "codec", "native-library", "plugin", "font", "or asset terms", "complete direct and transitive", "DENY_SELECTION_OR_DISTRIBUTION"]],
  ["MPSEM-0122-C001", ".product-experience/pdp-0-product-truth/constitution.yaml#invariants", ["MEDIA-INV-001", "MEDIA-INV-002", "MEDIA-INV-003", "MEDIA-INV-004", "MEDIA-INV-005", "MEDIA-INV-006", "MEDIA-INV-007", "media-owner-resolved", "P0-010-independent-review-pending"]],
  ["MPSEM-0187-C004", ".product-experience/pdp-0-product-truth/quality-policy.yaml#personAndIdentityInferenceRule/anonymousTrackIdsByDefault", ["prefer a random, non-semantic track identifier", "scope is limited to that asset/version or session", "Do not create a reusable cross-tenant or global identity key", "only when the exact operation requires it and current purpose-specific authority", "A scoped track identifier is not automatically anonymous", "never-infer-person-identity"]],
  ["MPSEM-0303-C002", ".product-experience/pdp-1-domain-data/operations.yaml#individualOperationContracts/records/@id=media.operation-slice.append-upload-chunk", ["zero-based-and-contiguous", "current-nextChunkIndex", "matching-persisted-index-length-digest-receipt", "reject-conflicting-content-without-a-second-write", "no-automatic-replay-after-unknown", "chunk-acknowledgement-does-not-enter-VERIFYING-or-AVAILABLE"]],
  ["MPSEM-0388-C005", ".product-experience/pdp-0-product-truth/policy-authority-model.yaml#productPolicy/inputAndExecutionThreats/browserToLocalWorkerBoundary", ["loopback is not authentication or authorization", "authenticated pairing", "current tenant, principal, browser origin, worker instance, and narrowly scoped file grant", "explicit origin allowlist", "anti-CSRF/rebinding controls on every request", "Origin metadata alone is never identity proof", "reject-before-local-file-read-or-effect"]],
  ["MPSEM-0458-C004", ".product-experience/pdp-0-product-truth/reuse-decisions.yaml#mediaArchitectureRules/enabledCodecBuildEvidenceRule", ["exact executable binary digest", "build recipe and configuration flags", "enabled codec/demuxer/muxer/protocol set", "complete direct and transitive linked-component inventory", "observed runtime capability set must match", "blocks selection or distribution", "does not itself establish license clearance", "no build is admitted or qualified"]],
  ["MPSEM-0459-C001", ".product-experience/pdp-0-product-truth/reuse-decisions.yaml#mediaArchitectureRules/historicalCandidateInventoryDisposition", ["docs/migration/expert-reviewed-master-plan.md", "Appendix B. External candidate inventory", "complete historical Appendix B candidate table", "intended role and evaluation constraint", "historical candidate discussion rather than a current procurement or integration list", "selectionRegister is the current owner-authored decision subset", "omission alone is not acceptance, rejection, evaluation, or a replacement decision", "never mandates integration", "HISTORICAL_SOURCE_PRESERVATION_ONLY"]],
];

test("PDP-2 migration candidates resolve to exact owner clauses and reject clause weakening", () => {
  assert.equal(claims.size, 97, "the exact current PDP-2 pending leaf population is complete");
  assert.equal(new Set(mappedClaims.map(([id]) => id)).size, mappedClaims.length);
  assert.equal(mappedClaims.length, 96, "96 normative/interface definition claims have exact owner-clause mappings");
  for (const [claimId, targetRef, clauses] of mappedClaims) {
    const sourceClaim = claims.get(claimId);
    assert.ok(sourceClaim, `${claimId} belongs to the current PDP-2 pending cohort`);
    const value = resolveRef(targetRef);
    assert.ok(value, `${targetRef} resolves using exact YAML keys and @id selectors`);
    assert.ok(allClausesPresent(value, clauses), `${claimId} owner clause preserves each material predicate`);
    for (const clause of clauses) {
      const weakenedOwnerValue = removeClauseFromValue(structuredClone(value), clause);
      assert.equal(allClausesPresent(weakenedOwnerValue, clauses), false,
        `${claimId} source value mutation removing ${clause} is rejected`);
    }
  }
  const externalEvidenceClaim = claims.get("MPSEM-0458-C001");
  assert.equal(externalEvidenceClaim?.exactSourceText, "**Specific correction:** OpenVDB’s official license page identifies MPL-2.0");
  assert.ok(externalEvidenceClaim.sourceRefs?.some((ref) => ref.includes("openvdb.org/license"))
    || externalEvidenceClaim.exactSourceText.includes("MPL-2.0"),
  "the OpenVDB row is accounted as historical external license evidence, not a Media candidate or admission");
  const masterPlan = readFileSync(resolve(root, "docs/migration/expert-reviewed-master-plan.md"), "utf8");
  assert.match(masterPlan, /\[W02\].*https:\/\/www\.openvdb\.org\/license\//u,
    "the OpenVDB fact retains its exact external source citation; no Media candidate record is invented");
  assert.equal(claims.size, mappedClaims.length + 1,
    "the remaining leaf is a historical external-source fact, not a new Media capability or owner contract");
  assert.deepEqual([...claims.keys()].filter((claimId) => claimId !== "MPSEM-0458-C001" && !mappedClaims.some(([mappedId]) => mappedId === claimId)),
    [], "every other exact PDP-2 claim ID belongs to the mapped owner-clause population");
});

test("Appendix B candidate history preserves every role/condition without treating it as the current decision register", () => {
  const masterPlan = readFileSync(resolve(root, "docs/migration/expert-reviewed-master-plan.md"), "utf8");
  const appendix = masterPlan.split("# Appendix B. External candidate inventory — only after the Ghatana reuse gate", 2)[1]
    ?.split("# Appendix C.", 1)[0];
  assert.ok(appendix, "the exact historical Appendix B source section remains present");
  const candidateRows = appendix.split("\n").filter((line) => line.startsWith("|") && !line.startsWith("|---") && !line.includes("Candidate(s) | Intended role"));
  assert.equal(candidateRows.length, 32, "all 32 historical candidate role/evaluation rows are preserved");
  for (const row of candidateRows) {
    const cells = row.split("|").map((cell) => cell.trim()).filter(Boolean);
    assert.equal(cells.length, 3, "each row keeps candidate identity, intended role, and evaluation constraint");
    assert.ok(cells.every((cell) => cell.length > 0), "no historical candidate role or condition is silently dropped");
  }
  const reuse = load(".product-experience/pdp-0-product-truth/reuse-decisions.yaml");
  const disposition = reuse.mediaArchitectureRules.historicalCandidateInventoryDisposition;
  assert.equal(disposition.historicalSource.section, "Appendix B. External candidate inventory — only after the Ghatana reuse gate");
  assert.equal(disposition.scopeStatus, "HISTORICAL_SOURCE_PRESERVATION_ONLY; no candidate is admitted");
  assert.match(disposition.currentRegisterRelationship, /omission alone is not acceptance, rejection, evaluation, or a replacement decision/u);
  assert.match(disposition.currentRegisterRelationship, /never mandates integration/u);
  for (const mutate of [
    (x) => { x.scopeStatus = "SELECTED_FOR_INTEGRATION"; },
    (x) => { x.currentRegisterRelationship = x.currentRegisterRelationship.replace("omission alone is not acceptance, rejection, evaluation, or a replacement decision", "omission means rejected"); },
    (x) => { x.historicalSource.section = "Appendix A"; },
  ]) {
    const candidate = structuredClone(disposition);
    mutate(candidate);
    const valid = candidate.scopeStatus === "HISTORICAL_SOURCE_PRESERVATION_ONLY; no candidate is admitted"
      && candidate.historicalSource.section === "Appendix B. External candidate inventory — only after the Ghatana reuse gate"
      && /omission alone is not acceptance, rejection, evaluation, or a replacement decision/u.test(candidate.currentRegisterRelationship)
      && /never mandates integration/u.test(candidate.currentRegisterRelationship);
    assert.equal(valid, false, "each semantic mutation is rejected by the bounded disposition predicate");
  }
});

test("one canonical CLI registry binds every fixture command to an exact action and operation disposition", () => {
  const cli = load(".product-experience/pdp-3-product-experience/cli-command-registry.yaml");
  const actionSource = load(".product-experience/pdp-3-product-experience/action-registry.yaml");
  const identityRule = load(".product-experience/pdp-2-design-interface-system/cli-language.yaml")
    .ownerDefinedInvocationRules.find(({ id }) => id === "media.cli.cross-channel-canonical-action-identity.v1");
  const actionMap = new Map(actionSource.actions.map((action) => [action.id, action]));
  const isBound = (registry, actions) => Array.isArray(registry.commands)
    && registry.commands.length === 12
    && new Set(registry.commands.map(({ id }) => id)).size === registry.commands.length
    && new Set(registry.commands.map(({ canonicalCommand }) => canonicalCommand)).size === registry.commands.length
    && registry.commands.every((command) => {
      const action = actions.get(command.actionRef);
      const definition = action?.actionDefinitionSemantics?.typedDefinition;
      if (!action || action.id !== command.actionRef || !Array.isArray(definition?.exactOperationRefs)
        || !definition.domainOperationDisposition) return false;
      if (command.operationRef && !definition.exactOperationRefs.includes(command.operationRef)) return false;
      return definition.exactOperationRefs.length > 0;
    });
  assert.equal(isBound(cli, actionMap), true);
  assert.equal(cli.status, "implemented-local-fixture-command-simulator; production-runtime-cli-not-connected");
  assert.equal(identityRule.canonicalRegistryRef, ".product-experience/pdp-3-product-experience/cli-command-registry.yaml");
  assert.match(identityRule.registryCoverageRule, /Every command in the one canonical registry/u);
  for (const mutate of [
    (registry) => { registry.commands[0].actionRef = "media.action.invented-by-command-name"; },
    (registry) => { registry.commands[0].id = registry.commands[1].id; },
    (registry) => { registry.commands[0].operationRef = "media.operation.unrelated"; },
    (registry) => { registry.commands.pop(); },
  ]) {
    const registry = structuredClone(cli);
    mutate(registry);
    assert.equal(isBound(registry, actionMap), false, "unknown actions, duplicate or missing rows, and operation mismatches fail");
  }
});

test("PXD-047 packaging classification cannot be promoted into a package or Shared binding", () => {
  const path = ".product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml";
  const source = load(path);
  const rule = source.packagingClassificationBoundary;
  const norm = source.normativeRuleRecords.find(({ id }) => id === "media.p2.rule.gui-packaging-classification-boundary.v1");
  const resolvedNorm = resolveRef(norm.ruleRef);
  const complete = (candidate) => candidate?.proposal === "STANDALONE_CLOSURE"
    && candidate.proposalStatus === "PROPOSED_INITIAL_CLASSIFICATION_ONLY"
    && candidate.currentSourcePopulation?.componentDefinitions === 31
    && candidate.currentSourcePopulation?.exactObservedPublicSourceContracts === 3
    && candidate.currentSourcePopulation?.retainedContractOnlyCompositions === 28
    && candidate.actualOwnerSchema === "NOT_ESTABLISHED_BY_THIS_CLASSIFICATION"
    && candidate.status?.includes("Shared package publication, consumer binding, implementation admission, and independent conformance remain open")
    && candidate.requiredBeforePackageUse?.includes("exact-public-export-for-each-bound-family")
    && candidate.prohibitedInference?.includes("contract-only-family-as-implemented")
    && Boolean(resolvedNorm)
    && norm.acceptanceEffect === "none"
    && norm.sourceAuthority === ".product-experience/decision-log.md#PXD-047";

  assert.equal(complete(rule), true);
  for (const mutate of [
    (x) => { x.proposalStatus = "ACCEPTED_PACKAGE_SCHEMA"; },
    (x) => { x.actualOwnerSchema = "@ghatana/design-system"; },
    (x) => { x.currentSourcePopulation.retainedContractOnlyCompositions = 27; },
    (x) => { x.requiredBeforePackageUse = x.requiredBeforePackageUse.filter((item) => item !== "exact-public-export-for-each-bound-family"); },
    (x) => { x.prohibitedInference = x.prohibitedInference.filter((item) => item !== "contract-only-family-as-implemented"); },
    (x) => { x.status = "package published and consumer bound"; },
  ]) {
    const candidate = structuredClone(rule);
    mutate(candidate);
    assert.equal(complete(candidate), false, "classification weakening cannot pass as package/conformance evidence");
  }
  assert.equal(norm.ruleRef, `${path}#packagingClassificationBoundary`);
});

test("Media origin classes preserve edited, generative, AI, and simulation distinctions without implying acceptance", () => {
  const sourcePath = ".product-experience/pdp-2-design-interface-system/trust-provenance-grammar.yaml";
  const source = load(sourcePath);
  const claim = claims.get("MPSEM-0370-C001");
  const rule = source.ownerDefinedOriginClassification;
  assert.ok(claim?.exactSourceText.includes("Origin labels distinguish source, edited, generatively enhanced, AI-generated and simulation-generated output"));
  assert.equal(rule.id, "media.trust.origin-classification-and-lineage.v1");
  const ids = new Set(rule.classes.map(({ id }) => id));
  for (const id of [
    "media.origin.source-preserved",
    "media.origin.edited",
    "media.origin.generatively-enhanced",
    "media.origin.ai-generated",
    "media.origin.simulation-generated",
  ]) assert.ok(ids.has(id));
  const norm = source.normativeRuleRecords.find(({ ruleRef }) => ruleRef.endsWith("#ownerDefinedOriginClassification"));
  assert.equal(norm?.id, "media.p2.rule.origin-classification-and-lineage.v1");
  assert.equal(norm?.acceptanceEffect, "none");
  const classes = (candidate) => new Set(candidate.ownerDefinedOriginClassification.classes.map(({ id }) => id));
  for (const id of ["media.origin.edited", "media.origin.generatively-enhanced", "media.origin.ai-generated", "media.origin.simulation-generated"]) {
    const weakened = structuredClone(source);
    weakened.ownerDefinedOriginClassification.classes = weakened.ownerDefinedOriginClassification.classes.filter((item) => item.id !== id);
    assert.equal(classes(weakened).has(id), false, `${id} omission cannot be mistaken for a complete origin taxonomy`);
  }
  const collapsed = structuredClone(source);
  const generative = collapsed.ownerDefinedOriginClassification.classes.find(({ id }) => id === "media.origin.generatively-enhanced");
  generative.id = "media.origin.edited";
  assert.equal(new Set(collapsed.ownerDefinedOriginClassification.classes.map(({ id }) => id)).size, ids.size - 1,
    "generative and edited classes cannot be collapsed into one identity");
  assert.equal(rule.classificationRules.some((text) => text.includes("neither implies validation, measurement, truth, ownership, license, or permission")), true);
});

test("CLI identity contract requires exact action and operation bindings across channels and fails closed for fixtures", () => {
  const source = load(".product-experience/pdp-2-design-interface-system/cli-language.yaml");
  const rule = source.ownerDefinedInvocationRules.find(({ id }) => id === "media.cli.cross-channel-canonical-action-identity.v1");
  assert.equal(rule.requiredBindingFields.join("|"), "commandId|canonicalActionId|operationId|operationVersion|webBindingRef|apiBindingRef|cliBindingRef");
  assert.ok(rule.equalityRules.some((text) => text.includes("webBindingRef.actionId==canonicalActionId")));
  assert.ok(rule.equalityRules.some((text) => text.includes("apiBindingRef.actionId==canonicalActionId")));
  assert.ok(rule.equalityRules.some((text) => text.includes("everyBinding.operationVersion==operationVersion")));
  assert.match(rule.currentPopulation, /12 synthetic fixture commands/u);
  assert.match(rule.currentPopulation, /does not establish production CLI\/Web\/API transport binding/u);
  assert.equal(rule.scopeStatus.includes("NOT_ADMITTED"), true);
  const bindingValid = (candidate) => candidate?.commandId && candidate.canonicalActionId && candidate.operationId
    && candidate.operationVersion && candidate.webBindingRef?.actionId === candidate.canonicalActionId
    && candidate.apiBindingRef?.actionId === candidate.canonicalActionId
    && candidate.cliBindingRef?.actionId === candidate.canonicalActionId
    && [candidate.webBindingRef, candidate.apiBindingRef, candidate.cliBindingRef]
      .every((binding) => binding.operationId === candidate.operationId && binding.operationVersion === candidate.operationVersion);
  const valid = {
    commandId: "fixture-command",
    canonicalActionId: "media.action.project.inspect",
    operationId: "media.operation-slice.inspect-project",
    operationVersion: "v1",
    webBindingRef: { actionId: "media.action.project.inspect", operationId: "media.operation-slice.inspect-project", operationVersion: "v1" },
    apiBindingRef: { actionId: "media.action.project.inspect", operationId: "media.operation-slice.inspect-project", operationVersion: "v1" },
    cliBindingRef: { actionId: "media.action.project.inspect", operationId: "media.operation-slice.inspect-project", operationVersion: "v1" },
  };
  assert.equal(bindingValid(valid), true);
  for (const mutate of [
    (value) => { value.cliBindingRef.actionId = "media.action.project.create"; },
    (value) => { value.apiBindingRef.operationId = "media.operation-slice.create-project"; },
    (value) => { value.webBindingRef.operationVersion = "v2"; },
    (value) => { delete value.cliBindingRef.operationId; },
  ]) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    assert.equal(bindingValid(invalid), false, "name similarity or a partial cross-channel tuple cannot establish equivalence");
  }
  const registry = load(".product-experience/pdp-3-product-experience/cli-command-registry.yaml");
  assert.match(registry.executionScope, /deterministic-synthetic-fixtures-only/u);
  assert.match(registry.status, /production-runtime-cli-not-connected/u,
    "the authored rule does not invent production command bindings from fixture names");
});

test("downstream findings return to the authoritative source phase instead of creating local rule copies", () => {
  const source = load(".product-experience/pdp-2-design-interface-system/component-contracts.yaml");
  const claim = claims.get("MPSEM-0163-C001");
  const rule = source.ownerDefinedComponentRules.find(({ id }) => id === "media.component.upstream-owner-source-first.v1");
  assert.ok(claim?.exactSourceText.includes("A missing upstream rule found in Explorer must be fixed at its owning phase first"));
  assert.deepEqual(rule.ownerOrder, ["pdp0_product_truth", "pdp1_domain_data", "pdp2_design_interface_system", "pdp3_product_experience"]);
  const required = [
    "correct that source first",
    "cannot repair it with a local override, duplicate taxonomy, or generated artifact edit",
    "Record the exact owner source and selector",
  ];
  for (const clause of required) assert.ok(rule.rule.includes(clause));
  const weakened = structuredClone(rule);
  weakened.rule = weakened.rule.replace("cannot repair it with a local override, duplicate taxonomy, or generated artifact edit", "may repair it with a local override");
  assert.equal(required.every((clause) => weakened.rule.includes(clause)), false,
    "a downstream local override cannot satisfy the source-first rule");
  assert.equal(source.normativeRuleRecords.find(({ ruleRef }) => ruleRef.includes(rule.id))?.acceptanceEffect, "none");
});

test("config show has an effective-value and secret-redaction contract without claiming configuration mutation", () => {
  const source = load(".product-experience/pdp-2-design-interface-system/cli-language.yaml");
  const claim = claims.get("MPSEM-0353-C003");
  const rule = source.ownerDefinedMachineOutputRules.find(({ id }) => id === "media.cli.effective-configuration-redaction.v1");
  assert.ok(claim?.exactSourceText.includes("`config show` reports effective values and safe provenance, never secrets"));
  assert.equal(rule.requiredFields.join("|"), "effectiveValues|sourceByField|redactedFields");
  for (const category of ["explicit-flag", "environment", "selected-project-or-profile-file", "user-config", "product-default", "unknown"]) {
    assert.ok(rule.sourceCategories.includes(category));
  }
  const required = [
    "without exposing credentials, tokens, secrets, or protected content",
    "Secret-bearing values are always redacted",
    "if a value cannot be safely classified, omit it",
    "The command is read-only and cannot write, activate, authorize, or broaden a configuration value",
  ];
  for (const clause of required) assert.ok(rule.rule.includes(clause));
  assert.deepEqual(rule.resolutionOrder, ["explicit-flag", "environment", "selected-project-or-profile-file", "user-config", "product-default"]);
  assert.match(rule.nonOverridablePolicyRule, /cannot be overridden by any flag, environment variable, project\/profile file, user config, or product default/u);
  assert.ok(rule.precedenceEvidence.includes("applied-policy-constraint"));
  assert.ok(rule.negativeCases.includes("higher-precedence-value-overrides-nonoverridable-policy"));
  const missingPolicy = structuredClone(rule);
  missingPolicy.nonOverridablePolicyRule = "Last value wins.";
  assert.equal(/cannot be overridden/u.test(missingPolicy.nonOverridablePolicyRule), false,
    "source precedence never overrides hard policy constraints");
  for (const clause of required) {
    const weakened = rule.rule.replaceAll(clause, "removed condition");
    assert.equal(required.every((candidate) => weakened.includes(candidate)), false);
  }
  assert.equal(source.normativeRuleRecords.find(({ ruleRef }) => ruleRef.includes(rule.id))?.acceptanceEffect, "none");
});

test("repeat-safe-step prompt reduction cannot reuse stale consent or authorize a changed effect", () => {
  const source = load(".product-experience/pdp-2-design-interface-system/typography-layout.yaml");
  const claim = claims.get("MPSEM-0444-C003");
  const rule = source.repeatSafeStepDisclosure;
  assert.ok(claim?.exactSourceText.includes("Repeated safe technical steps do not need repeated dialogs"));
  assert.ok(rule.unchangedFacts.includes("exactSourceAndObjectVersions"));
  assert.ok(rule.recheckBeforeRepeat.includes("currentConsentAndRights"));
  assert.ok(rule.negativeCases.includes("repeat-after-consent-expiry-or-revocation"));
  assert.ok(rule.negativeCases.includes("repeat-destructive-or-external-effect-under-read-only-classification"));
  assert.equal(source.normativeRuleRecords.find(({ id }) => id === "media.p2.rule.repeat-safe-step-disclosure.v1")?.acceptanceEffect, "none");
  const valid = (candidate) => candidate.unchangedFacts.includes("exactSourceAndObjectVersions")
    && candidate.recheckBeforeRepeat.includes("currentConsentAndRights")
    && candidate.rule.includes("consent may have expired or been revoked")
    && candidate.rule.includes("A prior confirmation is scoped to the exact action and facts shown")
    && candidate.negativeCases.includes("repeat-after-consent-expiry-or-revocation");
  assert.equal(valid(rule), true);
  const weakened = structuredClone(rule);
  weakened.rule = weakened.rule.replace("authority or consent may have expired or been revoked", "authority and consent remain current");
  assert.equal(valid(weakened), false, "a stale authority or consent context cannot inherit a prior prompt confirmation");
});

test("API generation and transport evidence cannot promote schema-only checks to wire parity", () => {
  const source = load(".product-experience/pdp-2-design-interface-system/api/conventions.yaml");
  const claim = claims.get("MPSEM-0310-C004");
  const rule = source.ownerDefinedProjectionRules.find(({ id }) => id === "media.api.contract-generation-and-transport-verification.v1");
  assert.ok(claim?.exactSourceText.includes("Endpoints and status codes are authored in the contract, generated into SDKs/fixtures and tested against the actual transport"));
  for (const evidence of ["exact-owner-contract-version", "actual-transport-test-source", "valid-request-response-cases", "invalid-request-authority-and-finality-cases", "observed-test-result"]) {
    assert.ok(rule.requiredEvidence.includes(evidence));
  }
  for (const clause of [
    "independent transport conformance test sends valid and invalid contract cases through the actual bound transport",
    "A passing schema-only test or generated fixture test is not actual transport parity",
    "status remains NOT_EVALUATED and no wire/runtime conformance is claimed",
  ]) assert.ok(rule.rule.includes(clause));
  for (const item of ["schema-validation-only-reported-as-transport-test", "fixture-roundtrip-reported-as-runtime-parity", "missing-transport-test-marked-passing"]) {
    assert.ok(rule.negativeCases.includes(item));
  }
  const weakened = structuredClone(rule);
  weakened.rule = weakened.rule.replace("A passing schema-only test or generated fixture test is not actual transport parity", "schema-only tests establish transport parity");
  assert.equal(weakened.rule.includes("is not actual transport parity"), false);
  assert.equal(source.normativeRuleRecords.find(({ ruleRef }) => ruleRef.includes(rule.id))?.acceptanceEffect, "none");
});

test("API compatibility remains one product and rejects an indefinite compatibility fork", () => {
  const source = load(".product-experience/pdp-2-design-interface-system/api/compatibility.yaml");
  const claim = claims.get("MPSEM-0060-C002");
  const rule = source.ownerDefinedCompatibilityRules.find(({ id }) => id === "media.api.no-parallel-product-fork.v1");
  assert.match(claim?.exactSourceText ?? "", /parallel .*V2 product.* indefinite compatibility code fork/u);
  for (const clause of [
    "Do not create a parallel V2 product or preserve an indefinite compatibility-code fork",
    "explicit owner-approved migration path",
    "versioned compatibility window",
    "end condition",
  ]) assert.ok(rule.rule.includes(clause));
  assert.deepEqual(rule.requiredEvidence, ["exact-owner-contract-version", "old-and-new-semantic-diff", "affected-client-population", "migration-and-deprecation-window", "explicit-end-condition"]);
  for (const weakened of [
    { ...rule, rule: rule.rule.replace("Do not create a parallel V2 product or preserve an indefinite compatibility-code fork", "parallel V2 forks may continue indefinitely") },
    { ...rule, requiredEvidence: rule.requiredEvidence.filter((item) => item !== "explicit-end-condition") },
  ]) {
    const valid = weakened.rule.includes("Do not create a parallel V2 product or preserve an indefinite compatibility-code fork")
      && weakened.requiredEvidence.includes("explicit-end-condition");
    assert.equal(valid, false, "compatibility cannot be treated as bounded without migration and sunset conditions");
  }
  assert.equal(source.normativeRuleRecords.find(({ id }) => id === "media.p2.rule.api-no-parallel-product-fork.v1")?.acceptanceEffect, "none");
});

test("localization preserves canonical, original, and retained intermediate precision", () => {
  const source = load(".product-experience/pdp-2-design-interface-system/localization-content.yaml");
  const claim = claims.get("MPSEM-0259-C003");
  const rule = source.ownerDefinedLocalizationRules.find(({ id }) => id === "media.localization.original-and-intermediate-precision.v1");
  assert.ok(claim?.exactSourceText.includes("Preserve original and intermediate precision"));
  for (const field of ["sourceValueAndVersion", "retainedIntermediateValueAndVersion", "canonicalUnitOrTimebase", "exactConversionAndRoundingWhenChanged", "disclosedPrecisionLoss"]) {
    assert.ok(rule.requiredEvidence.includes(field));
  }
  for (const weakened of [
    { ...rule, rule: rule.rule.replace("every retained intermediate value", "only the final value") },
    { ...rule, rule: rule.rule.replace("cannot overwrite the canonical value", "may overwrite the canonical value") },
    { ...rule, requiredEvidence: rule.requiredEvidence.filter((field) => field !== "disclosedPrecisionLoss") },
  ]) {
    assert.equal(weakened.rule.includes("every retained intermediate value")
      && weakened.rule.includes("cannot overwrite the canonical value")
      && weakened.requiredEvidence.includes("disclosedPrecisionLoss"), false,
    "localized presentation cannot erase canonical or intermediate precision");
  }
  assert.equal(source.normativeRuleRecords.find(({ id }) => id === "media.p2.rule.localization-original-intermediate-precision.v1")?.acceptanceEffect, "none");
});

test("persisted mutation replay requires a pre-effect durable owner record and fail-closed reconciliation", () => {
  const source = load(".product-experience/pdp-2-design-interface-system/api/retry-timeout-unknown-outcome.yaml");
  const claim = claims.get("MPSEM-0352-C003");
  const rule = source.ownerDefinedReplayPersistenceRequirement;
  assert.ok(claim?.exactSourceText.includes("Mutation retry/replay uses persisted keys"));
  for (const field of ["trustedTenantId", "exactCanonicalOperationId", "operationVersion", "clientRequestKey", "canonicalEffectBearingRequestFingerprint", "replayFence", "priorResultOrReceipt", "retentionBoundary"]) {
    assert.ok(rule.requiredPersistedFields.includes(field));
  }
  for (const required of [
    "durably commits",
    "before the first externally visible effect",
    "After restart or response loss",
    "a changed fingerprint conflicts",
    "Concurrent duplicates share one effect under the fence",
    "perform no second effect",
  ]) assert.ok(rule.rule.includes(required));
  for (const weakened of [
    { ...rule, requiredPersistedFields: rule.requiredPersistedFields.filter((field) => field !== "replayFence") },
    { ...rule, requiredPersistedFields: rule.requiredPersistedFields.filter((field) => field !== "priorResultOrReceipt") },
    { ...rule, rule: rule.rule.replace("before the first externally visible effect", "after the first externally visible effect") },
    { ...rule, rule: rule.rule.replace("perform no second effect", "a second effect may run") },
  ]) {
    const complete = ["replayFence", "priorResultOrReceipt"].every((field) => weakened.requiredPersistedFields.includes(field))
      && weakened.rule.includes("before the first externally visible effect")
      && weakened.rule.includes("perform no second effect");
    assert.equal(complete, false, "a non-durable or incomplete record cannot authorize mutation replay");
  }
  assert.equal(rule.runtimeStatus, "NOT_EVALUATED");
  assert.equal(rule.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(source.normativeRuleRecords.find(({ id }) => id === "media.p2.rule.api-mutation-replay-persistence-prerequisite.v1")?.acceptanceEffect, "none");
});

test("screen composition requires exact sources for product meaning, domain, authority, finality, dependencies, and NFRs", () => {
  const source = load(".product-experience/pdp-2-design-interface-system/gui/screen-composition-schema.yaml");
  const claim = claims.get("MPSEM-0157-C002");
  const coverage = source.semanticCoverageRequirement;
  assert.ok(claim?.exactSourceText.includes("Meaning, actors, outcomes, requirements, capabilities, domain/time/units, authority, states, failure/finality, dependencies and NFRs"));
  assert.equal(coverage.categories.length, 5);
  const ids = new Set(coverage.categories.map(({ id }) => id));
  for (const id of ["meaning-actors-outcomes-requirements", "domain-time-units", "authority-and-rights", "state-failure-and-finality", "dependencies-and-nfrs"]) assert.ok(ids.has(id));
  const requiredSources = coverage.categories.flatMap(({ requiredRefs }) => requiredRefs);
  for (const sourceRef of requiredSources) assert.ok(existsSync(resolve(root, sourceRef)), `${sourceRef} exists as an owner-source dependency`);
  const categoryPredicates = {
    "meaning-actors-outcomes-requirements": ["exact product goal", "actors, outcomes, requirement", "applicable capability"],
    "domain-time-units": ["canonical owner definitions", "exact conversion profiles", "presentation text cannot redefine them"],
    "authority-and-rights": ["authority and rights/consent source", "confirmation is not permission"],
    "state-failure-and-finality": ["exact owning machine or operation", "visual labels and job progress cannot invent completion"],
    "dependencies-and-nfrs": ["applicable measurable quality/NFR clauses", "unknown or unqualified status"],
  };
  const valid = (candidate) => candidate.categories.length === 5
    && ids.size === new Set(candidate.categories.map(({ id }) => id)).size
    && [...ids].every((id) => candidate.categories.some((category) => category.id === id && category.requiredRefs.length > 0
      && categoryPredicates[id].every((clause) => category.rule.includes(clause))));
  assert.equal(valid(coverage), true);
  for (const mutate of [
    (candidate) => { candidate.categories = candidate.categories.filter(({ id }) => id !== "authority-and-rights"); },
    (candidate) => { candidate.categories.find(({ id }) => id === "domain-time-units").requiredRefs = []; },
    (candidate) => { candidate.categories.find(({ id }) => id === "state-failure-and-finality").rule = "Use the screen label as the finality source."; },
  ]) {
    const weakened = structuredClone(coverage);
    mutate(weakened);
    assert.equal(valid(weakened), false, "a screen cannot silently lose a semantic owner category or source");
  }
  assert.match(coverage.status, /per-screen source coverage and acceptance remain independently reviewable/u);
  assert.equal(source.normativeRuleRecords.find(({ id }) => id === "media.p2.rule.gui-composition-semantic-coverage.v1")?.acceptanceEffect, "none");
});

test("attention items use a finite evidence-backed reason set without implying delivery or action authority", () => {
  const source = load(".product-experience/pdp-2-design-interface-system/gui/patterns/activity-attention.yaml");
  const claim = claims.get("MPSEM-0450-C001");
  const rule = source.ownerDefinedAttentionNotificationScope;
  assert.ok(claim?.exactSourceText.includes("Notify for action required, material degradation, approval, completion of long work, delivery outcome or critical security/rights problems"));
  assert.deepEqual(rule.allowedReasons, ["action-required", "material-degradation", "approval-required", "long-running-work-completed", "delivery-outcome", "critical-security-or-rights-issue"]);
  assert.ok(rule.requiredEvidence.includes("authoritative-current-fact-or-event"));
  assert.ok(rule.negativeCases.includes("notify-from-unverified-status"));
  assert.ok(rule.negativeCases.includes("notification-opened-as-action-authority"));
  assert.ok(rule.negativeCases.includes("delivery-treated-as-completion"));
  assert.ok(rule.rules.some((item) => item.includes("each consequential next action rechecks current access, policy, rights, and finality")));
  assert.equal(source.normativeRuleRecords.find(({ id }) => id === "media.p2.rule.gui-attention-notification-scope.v1")?.acceptanceEffect, "none");
  for (const weakened of [
    { ...rule, allowedReasons: rule.allowedReasons.filter((reason) => reason !== "material-degradation") },
    { ...rule, requiredEvidence: rule.requiredEvidence.filter((fact) => fact !== "authoritative-current-fact-or-event") },
    { ...rule, rules: rule.rules.filter((item) => !item.includes("each consequential next action rechecks current access")) },
  ]) {
    assert.equal(weakened.allowedReasons.includes("material-degradation")
      && weakened.requiredEvidence.includes("authoritative-current-fact-or-event")
      && weakened.rules.some((item) => item.includes("each consequential next action rechecks current access")), false,
    "missing notification evidence or action reauthorization cannot pass as a complete rule");
  }
});

test("rights and consent presentation requires fresh exact-scope revalidation before consequential work", () => {
  const source = load(".product-experience/pdp-2-design-interface-system/gui/patterns/catalog.yaml");
  const claim = claims.get("MPSEM-0177-C004");
  const rule = source.ownerDefinedPatternRules.find(({ id }) => id === "media.gui.rights-consent-currentness-before-effect.v1");
  assert.ok(claim?.exactSourceText.includes("admission and consent rechecked"));
  for (const field of ["exactRightOrConsentIdentity", "subjectAndScope", "sourceAndVersion", "effectiveAndExpiryFacts", "currentObservationStatus", "affectedOperationRef"]) assert.ok(rule.requiredFields.includes(field));
  for (const testCase of ["cached-valid-consent-used-after-expiry", "scope-changed-after-review", "prior-screen-confirmation-reused-for-new-operation", "missing-currentness-treated-as-admitted", "revoked-consent-displayed-as-valid"]) assert.ok(rule.negativeCases.includes(testCase));
  const weakened = structuredClone(rule);
  weakened.rule = weakened.rule.replace("Before each affected consequential operation, revalidate current admission, consent, and rights", "Review consent once when the screen opens");
  assert.equal(weakened.rule.includes("Before each affected consequential operation, revalidate current admission, consent, and rights"), false);
  const scopeWeakened = structuredClone(rule);
  scopeWeakened.requiredFields = scopeWeakened.requiredFields.filter((field) => field !== "affectedOperationRef");
  assert.equal(scopeWeakened.requiredFields.includes("affectedOperationRef"), false);
  assert.match(rule.scopeStatus, /no consent authority or runtime revalidation implementation is claimed/u);
  assert.equal(source.normativeRuleRecords.find(({ id }) => id === "media.p2.rule.gui-rights-consent-currentness-before-effect.v1")?.acceptanceEffect, "none");
});

test("job outcome summary does not infer safe output, completion, or the next action", () => {
  const source = load(".product-experience/pdp-2-design-interface-system/component-contracts.yaml");
  const claim = claims.get("MPSEM-0449-C002");
  const rule = source.ownerDefinedComponentRules.find(({ id }) => id === "media.component.job-outcome-and-safe-next-action.v1");
  assert.ok(claim?.exactSourceText.includes("Explain what happened, which output is safe, whether anything may still be running, and the next permitted action"));
  for (const field of ["exactJobAndOperationIdentity", "executionState", "effectFinality", "possiblyStillRunningOrNotEstablished", "exactOutputVersionAndVerificationDisposition", "currentAccessAndRightsDisposition", "permittedNextActionOrNone"]) assert.ok(rule.requiredFacts.includes(field));
  for (const testCase of ["success-means-output-safe", "missing-observation-means-not-running", "partial-output-reported-as-full-success", "unknown-finality-hidden", "action-inferred-from-label"]) assert.ok(rule.negativeCases.includes(testCase));
  const weakened = structuredClone(rule);
  weakened.rule = weakened.rule.replace("job success alone is insufficient", "job success establishes safe output");
  assert.equal(weakened.rule.includes("job success alone is insufficient"), false);
  const noOutputIdentity = structuredClone(rule);
  noOutputIdentity.requiredFacts = noOutputIdentity.requiredFacts.filter((field) => field !== "exactOutputVersionAndVerificationDisposition");
  assert.equal(noOutputIdentity.requiredFacts.includes("exactOutputVersionAndVerificationDisposition"), false);
  assert.match(rule.scopeStatus, /no runtime observation, output verification, or action authority is admitted/u);
  assert.equal(source.normativeRuleRecords.find(({ id }) => id === "media.p2.rule.component-job-outcome-safe-next-action.v1")?.acceptanceEffect, "none");
});

test("CLI JSONL and local interruption semantics preserve stable records and remote effect uncertainty", () => {
  const source = load(".product-experience/pdp-2-design-interface-system/cli-language.yaml");
  const claim = claims.get("MPSEM-0042-C005");
  const jsonl = source.ownerDefinedMachineOutputRules.find(({ id }) => id === "media.cli.jsonl-record-framing.v1");
  const interrupt = source.ownerDefinedMachineOutputRules.find(({ id }) => id === "media.cli.local-interruption-boundary.v1");
  assert.ok(claim?.exactSourceText.includes("stable JSON/JSONL, exit codes and interruption semantics"));
  assert.deepEqual(jsonl.recordKinds, ["result", "error", "progress"]);
  assert.ok(jsonl.requiredFieldsByKind.error.includes("reasonCode"));
  assert.ok(jsonl.requiredFieldsByKind.progress.includes("observedValueOrUnknown"));
  assert.match(jsonl.rule, /one complete JSON object per line/u);
  assert.match(jsonl.rule, /output format cannot change command effects or exit-code meaning/u);
  assert.ok(interrupt.requiredSemantics.includes("unknown-finality-when-unresolved"));
  assert.ok(interrupt.requiredSemantics.includes("remote-cancel-operation-remains-distinct"));
  for (const forbidden of ["SIGINT-reported-as-confirmed-server-cancellation", "local-interrupt-triggers-blind-new-request", "timeout-or-signal-mapped-to-job-failure-without-owner-finality"]) {
    assert.ok(interrupt.negativeCases.includes(forbidden));
  }
  const weakened = structuredClone(interrupt);
  weakened.rule = weakened.rule.replace("does not cancel the remote job, confirm cancellation, establish failure, or authorize a resubmission", "cancels the remote job and permits resubmission");
  assert.equal(weakened.rule.includes("does not cancel the remote job"), false);
  assert.equal(interrupt.scopeStatus.includes("no connected CLI runtime"), true);
  for (const normativeId of ["media.p2.rule.cli-jsonl-framing.v1", "media.p2.rule.cli-local-interruption-boundary.v1"]) {
    assert.equal(source.normativeRuleRecords.find(({ id }) => id === normativeId)?.acceptanceEffect, "none");
  }
});
