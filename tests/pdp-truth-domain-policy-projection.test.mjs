import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { resolveAcceptedDomainRuleRecords, resolvePdp05DomainRuleProjection, resolvePdp05InvariantTrustOwnershipProjection } from "../scripts/lib/product-definition-domain-rule-mapping.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const parse = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml").parse;
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const adjudication = readYaml(".product-experience/pdp-1-domain-data/state-adjudication.yaml");
const authority = readYaml(".product-experience/pdp-1-domain-data/authority.yaml");
const privacy = readYaml(".product-experience/pdp-1-domain-data/privacy.yaml");
const p0Actors = readYaml(".product-experience/pdp-0-product-truth/actors-responsibilities.yaml");
const constitution = readYaml(".product-experience/pdp-0-product-truth/constitution.yaml");
const sourceDocuments = Object.fromEntries([
  [".product-experience/pdp-0-product-truth/actors-responsibilities.yaml", p0Actors],
  [".product-experience/pdp-0-product-truth/constitution.yaml", constitution],
  [".product-experience/pdp-0-product-truth/policy-authority-model.yaml", readYaml(".product-experience/pdp-0-product-truth/policy-authority-model.yaml")],
  [".product-experience/pdp-1-domain-data/authority.yaml", authority],
  [".product-experience/pdp-1-domain-data/privacy.yaml", privacy],
  [".product-experience/pdp-1-domain-data/state-adjudication.yaml", adjudication],
].map(([ref, value]) => [ref, value]));

const expected = new Map([
  ["MEDIA-DOMAIN-RULE-001", ["machineScopedStateIdentity", true]],
  ["MEDIA-DOMAIN-RULE-002", ["requestReceiptIsQueuedJob", false]],
  ["MEDIA-DOMAIN-RULE-003", ["unknownOutcomeRule", "never-conflate-with-running-failure-or-safe-retry"]],
  ["MEDIA-DOMAIN-RULE-004", ["completedRule", "exact-output-set-integrity-authority-and-durable-result-commit-required; not-delivery-acknowledgement"]],
  ["MEDIA-DOMAIN-RULE-005", ["cancelledRule", "authoritative-no-dispatch-or-confirmed-fenced-effects-finality; request-and-observer-detach-insufficient"]],
  ["MEDIA-DOMAIN-RULE-006", ["partialSuccessRule", "terminal-only-if-declared-sub-effects-have-explicit-closed-dispositions-and-no-consequential-unknown-effect"]],
]);

function resolveSourceRef(ref, sources) {
  const marker = ref.indexOf("#");
  assert.ok(marker > 0, `source ref has path and selector: ${ref}`);
  const path = ref.slice(0, marker);
  const fragment = ref.slice(marker + 1).replace(/^\//u, "");
  assert.ok(Object.hasOwn(sources, path), `source file is in the exact PDP source set: ${path}`);
  let value = sources[path];
  if (!fragment) return value;
  for (const part of fragment.split("/")) {
    const id = /^@id=(.+)$/u.exec(part);
    if (id) {
      assert.ok(Array.isArray(value), `${ref} selects a record array`);
      value = value.find((row) => row.id === id[1]);
    } else if (Array.isArray(value) && /^\d+$/u.test(part)) value = value[Number(part)];
    else value = value?.[part];
    assert.notEqual(value, undefined, `exact source ref resolves: ${ref}`);
  }
  return value;
}

function assertInvariantOwnership(invariants, constitution, authority, privacy) {
  const targets = new Set(constitution.invariants.records.map(({ id }) => id));
  const sourceFiles = {
    ".product-experience/pdp-1-domain-data/authority.yaml": authority,
    ".product-experience/pdp-1-domain-data/privacy.yaml": privacy,
    ".product-experience/pdp-0-product-truth/policy-authority-model.yaml": readYaml(".product-experience/pdp-0-product-truth/policy-authority-model.yaml"),
  };
  const expectedSources = new Map([
    ["media.invariant.private-local-authorized-are-independent", [".product-experience/pdp-1-domain-data/privacy.yaml#ownerDefinedPdp10Boundary/classificationAndDisclosure/locality", ".product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes/identityScope"]],
    ["media.invariant.attestation-is-not-authority", [".product-experience/pdp-1-domain-data/privacy.yaml#consentModel", ".product-experience/pdp-1-domain-data/authority.yaml#consentAndIdentity"]],
    ["media.invariant.classification-floor", [".product-experience/pdp-1-domain-data/privacy.yaml#ownerDefinedPdp10Boundary/classificationAndDisclosure"]],
    ["media.invariant.untrusted-content-cannot-authorize", [".product-experience/pdp-0-product-truth/policy-authority-model.yaml#productPolicy/invariants/4", ".product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes/effectAuthority"]],
    ["media.invariant.audit-intent-precedes-effect", [".product-experience/pdp-0-product-truth/policy-authority-model.yaml#productPolicy/platformMechanics/audit", ".product-experience/pdp-1-domain-data/authority.yaml#ownership/genericAuditMechanics"]],
    ["media.invariant.revocation-stops-future-effects", [".product-experience/pdp-1-domain-data/privacy.yaml#ownerDefinedPdp10Boundary/consentRevocation", ".product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes/effectAuthority"]],
    ["media.invariant.tenant-isolation", [".product-experience/pdp-1-domain-data/privacy.yaml#ownerDefinedPdp10Boundary/tenantIsolation", ".product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes/identityScope"]],
  ]);
  assert.equal(invariants.records.length, 7);
  assert.equal(new Set(invariants.records.map(({ id }) => id)).size, 7);
  for (const row of invariants.records) {
    assert.equal(row.accountableOwner, "media", `${row.id} stays with the accountable Media semantics owner`);
    const targetId = row.projectionTargetRef.split("@id=")[1];
    assert.ok(targets.has(targetId), `${row.id} targets an exact P0 constitution invariant`);
    assert.ok(row.sourceRefs.length > 0);
    assert.deepEqual(row.sourceRefs, expectedSources.get(row.id), `${row.id} cites the exact rule selectors for its meaning`);
    for (const ref of row.sourceRefs) assert.ok(resolveSourceRef(ref, sourceFiles), `${row.id} source evidence resolves`);
    assert.ok(row.statement && row.violation && row.trustScope && row.failClosedResponse);
  }
}

function assertTrustContext(context, expectedSourceRef, expectedTrustLevel, sources) {
  assert.equal(context.sourceRef, expectedSourceRef, `${context.id} cites the exact source fact`);
  assert.equal(context.trustLevel, expectedTrustLevel, `${context.id} stays in its defined trust class`);
  assert.ok(resolveSourceRef(context.sourceRef, sources), `${context.id} source resolves`);
  assert.ok(context.forbiddenCoercions.length > 0);
  assert.ok(context.missingOrMismatch);
}

test("PDP-1 accepted product rules project to exact accountable P0 rule records", () => {
  const source = adjudication.ownerDefinedProductDefinitionDomainRules;
  assert.equal(source.authorityRef, ".product-experience/pdp-1-domain-data/state-adjudication.yaml#ownerAcceptedPolicyDecisions");
  assert.equal(source.decisionRef, ".product-experience/decision-log.md#PXD-035");
  assert.match(source.status, /projection-only/u);
  assert.match(source.status, /runtime-and-independent-P0-010-review-pending/u);
  assert.equal(source.records.length, expected.size);
  assert.equal(new Set(source.records.map(({ id }) => id)).size, expected.size);

  const accepted = adjudication.ownerAcceptedPolicyDecisions;
  for (const row of source.records) {
    const [decisionKey, value] = expected.get(row.id) ?? [];
    assert.ok(decisionKey, `unexpected rule ${row.id}`);
    assert.equal(row.sourceDecisionRef, `.product-experience/pdp-1-domain-data/state-adjudication.yaml#ownerAcceptedPolicyDecisions/${decisionKey}`);
    assert.equal(accepted[decisionKey], value, `${row.id} points to an accepted exact decision`);
    assert.equal(row.expectedDecisionValue, value);
    for (const field of ["statement", "violation", "trustScope", "trustContextRef", "accountableOwner", "ownerRef", "failClosedResponse", "projectionTargetRef"]) {
      assert.ok(typeof row[field] === "string" && row[field].trim(), `${row.id}.${field} is explicit`);
    }
    assert.equal(row.accountableOwner, "media");
    assert.equal(row.ownerRef, ".product-experience/pdp-1-domain-data/authority.yaml#ownership/mediaProductSemantics");
    assert.ok(row.projectionTargetRef.endsWith(`/@id=${row.id}`));
  }
  assert.equal(source.records.filter((row) => expected.get(row.id)[0] === "unknownOutcomeRule").length, 1);
  assert.match(source.records.find(({ id }) => id === "MEDIA-DOMAIN-RULE-003").failClosedResponse, /OUTCOME_UNKNOWN/u);
  assert.match(authority.ownerDefinedPdp10AuthorityScopes.effectAuthority.rule, /mechanism acceptance does not make a Media outcome successful/u);
});

test("P0 projection targets are exact and do not become duplicate PDP-1 authority", () => {
  const constitution = readYaml(".product-experience/pdp-0-product-truth/constitution.yaml");
  const projected = constitution.domainRules.records;
  const canonical = adjudication.ownerDefinedProductDefinitionDomainRules.records;
  assert.equal(projected.length, canonical.length);
  for (const row of canonical) {
    const p0 = projected.find(({ id }) => id === row.id);
    assert.ok(p0, `P0 has projection target for ${row.id}`);
    assert.equal(row.projectionTargetRef, `.product-experience/pdp-0-product-truth/constitution.yaml#domainRules/records/@id=${row.id}`);
    assert.equal(p0.sourceRef.replace("#/", "#"), row.sourceDecisionRef);
    assert.equal(p0.rule, row.statement);
    assert.equal(p0.violation, row.violation);
    assert.equal(p0.trustScope, row.trustScope);
    assert.equal(p0.failClosed, row.failClosedResponse);
    assert.match(p0.decisionStatus, /P0-010-independent-review-pending/u);
  }
  assert.equal(adjudication.ownerDefinedProductDefinitionDomainRules.ruleAuthority,
    "PDP-1 ownerAcceptedPolicyDecisions remains semantic authority; this collection supplies the exact PDP-0 ProductDefinition projection fields and adds no state, transition, runtime, transport, provider, or phase acceptance.");
});

test("P0 domainRules are generated through the exact six P1 owner decisions and reject semantic drift", () => {
  const p0Records = constitution.domainRules.records;
  const p1Projection = adjudication.ownerDefinedProductDefinitionDomainRules;
  const joined = resolvePdp05DomainRuleProjection({ p0Records, p1Projection,
    ownerDecisions: adjudication.ownerAcceptedPolicyDecisions, sourceDocuments });
  assert.deepEqual(joined, resolveAcceptedDomainRuleRecords(p0Records, adjudication.ownerAcceptedPolicyDecisions));
  assert.equal(joined.length, 6);
  const reject = (mutateP1 = (copy) => {}, mutateP0 = (copy) => {}) => {
    const p1 = structuredClone(p1Projection), p0 = structuredClone(p0Records);
    mutateP1(p1); mutateP0(p0);
    assert.throws(() => resolvePdp05DomainRuleProjection({ p0Records: p0, p1Projection: p1,
      ownerDecisions: adjudication.ownerAcceptedPolicyDecisions, sourceDocuments }));
  };
  reject((copy) => { copy.records[0].trustScope = "other tenant and trust context"; });
  reject((copy) => { copy.records[0].ownerRef = ".product-experience/pdp-1-domain-data/authority.yaml#ownership/genericModelExecution"; });
  reject((copy) => { copy.records[0].trustContextRef = ".product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes/effectAuthority"; });
  reject((copy) => { copy.records[0].failClosedResponse = "guess success"; });
  reject((copy) => { copy.records[0].sourceDecisionRef = ".product-experience/pdp-1-domain-data/state-adjudication.yaml#ownerAcceptedPolicyDecisions/completedRule"; });
  reject(() => {}, (copy) => { copy[0].rule = "foreign rule text"; });
  reject((copy) => { copy.records[0].accountableOwner = "ghatana-shared"; });
});

test("PDP-1 invariant, trust, and ownership definitions reject unsafe coercion and owner substitution", () => {
  const invariantSource = privacy.ownerDefinedPdp05InvariantMappings;
  assert.match(invariantSource.status, /OWNER_DEFINED_DEFINITION_ONLY/u);
  assert.match(invariantSource.status, /independent-P0-010-review-pending/u);
  assert.equal(invariantSource.records.length, 7);
  assert.equal(new Set(invariantSource.records.map(({ id }) => id)).size, 7);
  assertInvariantOwnership(invariantSource, constitution, authority, privacy);
  const resolved = resolvePdp05InvariantTrustOwnershipProjection({ constitution, p0Actors, privacy, authority, sourceDocuments });
  assert.equal(resolved.invariants, constitution.invariants.records);
  assert.equal(resolved.trustContexts, p0Actors.trustContexts.contexts);
  assert.equal(resolved.ownershipRules, p0Actors.ownershipRules.rules);
  const substitutedTrust = structuredClone(authority);
  substitutedTrust.ownerDefinedPdp05TrustAndOwnership.trustContexts[0].projectionTargetRef = ".product-experience/pdp-0-product-truth/actors-responsibilities.yaml#trustContexts/contexts/@id=media.trust.privileged";
  assert.throws(() => resolvePdp05InvariantTrustOwnershipProjection({ constitution, p0Actors, privacy, authority: substitutedTrust, sourceDocuments }), /trust class/u,
    "a valid but semantically different P0 trust target is rejected by the production resolver");
  const substitutedOwner = structuredClone(authority);
  substitutedOwner.ownerDefinedPdp05TrustAndOwnership.ownershipRules[0].projectionTargetRef = ".product-experience/pdp-0-product-truth/actors-responsibilities.yaml#ownershipRules/rules/@id=media.ownership.identity";
  assert.throws(() => resolvePdp05InvariantTrustOwnershipProjection({ constitution, p0Actors, privacy, authority: substitutedOwner, sourceDocuments }), /ownership\/accountability/u,
    "a valid but unrelated P0 accountable owner cannot replace the selected owner");
  const unrelatedTrustSource = structuredClone(authority);
  unrelatedTrustSource.ownerDefinedPdp05TrustAndOwnership.trustContexts[0].sourceRef = ".product-experience/pdp-1-domain-data/authority.yaml#ownership/mediaProductSemantics";
  assert.throws(() => resolvePdp05InvariantTrustOwnershipProjection({ constitution, p0Actors, privacy, authority: unrelatedTrustSource, sourceDocuments }), /trust class/u,
    "a resolvable but unrelated source cannot substantiate a trust row");
  const ownerCoercion = structuredClone(authority);
  ownerCoercion.ownerDefinedPdp05TrustAndOwnership.ownershipRules[0].accountableOwner = "ghatana-shared";
  ownerCoercion.ownerDefinedPdp05TrustAndOwnership.ownershipRules[0].MediaBoundary = "Media still owns meaning";
  assert.throws(() => resolvePdp05InvariantTrustOwnershipProjection({ constitution, p0Actors, privacy, authority: ownerCoercion, sourceDocuments }), /owner source, owner/u,
    "adding a Media boundary cannot coerce the exact accountable owner");
  const foreignProjectionPath = structuredClone(authority);
  foreignProjectionPath.ownerDefinedPdp05TrustAndOwnership.trustContexts[0].projectionTargetRef = ".product-experience/pdp-1-domain-data/authority.yaml#trustContexts/contexts/@id=media.trust.authenticated";
  assert.throws(() => resolvePdp05InvariantTrustOwnershipProjection({ constitution, p0Actors, privacy, authority: foreignProjectionPath, sourceDocuments }), /trust class/u,
    "a same-ID projection under a foreign source path is rejected");
  const forgedInvariant = structuredClone(privacy);
  forgedInvariant.ownerDefinedPdp05InvariantMappings.records[0].sourceRefs[0] = ".product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes/effectAuthority";
  assert.throws(() => resolvePdp05InvariantTrustOwnershipProjection({ constitution, p0Actors, privacy: forgedInvariant, authority, sourceDocuments }), /P0 statement\/violation/u,
    "the projection rejects a resolvable but semantically unrelated invariant source");
  for (const invariant of invariantSource.records) {
    assert.ok(invariant.sourceRefs.length > 0, invariant.id);
    for (const field of ["statement", "violation", "trustScope", "accountableOwner", "failClosedResponse"]) {
      assert.ok(typeof invariant[field] === "string" && invariant[field].trim(), `${invariant.id}.${field}`);
    }
    assert.equal(invariant.accountableOwner, "media");
    assert.match(invariant.failClosedResponse, /block|deny|treat content as untrusted|stop future dispatch/iu);
    const targetId = invariant.projectionTargetRef.split("@id=")[1];
    assert.ok(constitution.invariants.records.some(({ id }) => id === targetId), `${invariant.id} has exact existing P0 invariant target`);
  }
  assert.deepEqual(invariantSource.records.map(({ projectionTargetRef }) => projectionTargetRef.split("@id=")[1]).sort(),
    constitution.invariants.records.map(({ id }) => id).sort(), "the owner invariant map neither omits nor invents P0 invariant targets");

  const trust = authority.ownerDefinedPdp05TrustAndOwnership;
  assert.match(trust.status, /identity-provider-binding-and-independent-P0-010-review-pending/u);
  assert.equal(trust.trustContexts.length, 4);
  assert.equal(new Set(trust.trustContexts.map(({ id }) => id)).size, 4);
  for (const context of trust.trustContexts) {
    assert.ok(context.sourceRef);
    assert.ok(context.forbiddenCoercions.length > 0);
    assert.ok(context.missingOrMismatch);
  }
  const hostIdentity = trust.trustContexts.find(({ id }) => id === "media.trust.host-identity");
  assert.deepEqual(hostIdentity.forbiddenCoercions, ["caller-supplied-tenant-or-principal", "role-label-to-grant", "workspace-selector-to-wider-scope"]);
  assert.equal(hostIdentity.missingOrMismatch, "DENY_BEFORE_LOOKUP_OR_EFFECT");
  const finality = trust.trustContexts.find(({ id }) => id === "media.trust.effect-finality-evidence");
  assert.equal(finality.missingOrMismatch, "OUTCOME_UNKNOWN; NO_BLIND_REPLAY");
  const expectedTrustSources = new Map([
    ["media.trust.host-identity", [".product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes/identityScope", "HOST_ATTESTED_CONTEXT"]],
    ["media.trust.current-policy-decision", [".product-experience/pdp-1-domain-data/privacy.yaml#ownerDefinedPdp10Boundary/consentRevocation", "AUTHORITY_ISSUED_SCOPED_DECISION"]],
    ["media.trust.canonical-state-observation", [".product-experience/pdp-1-domain-data/state-adjudication.yaml#ownerAcceptedPolicyDecisions", "MACHINE_SCOPED_SOURCE_OBSERVATION"]],
    ["media.trust.effect-finality-evidence", [".product-experience/pdp-1-domain-data/state-adjudication.yaml#ownerAcceptedPolicyDecisions/unknownOutcomeRule", "EFFECT_OWNER_AUTHORITATIVE_EVIDENCE"]],
  ]);
  const sourceFiles = {
    ".product-experience/pdp-1-domain-data/authority.yaml": authority,
    ".product-experience/pdp-1-domain-data/privacy.yaml": privacy,
    ".product-experience/pdp-1-domain-data/state-adjudication.yaml": adjudication,
  };
  for (const context of trust.trustContexts) {
    const [expectedRef, expectedLevel] = expectedTrustSources.get(context.id) ?? [];
    assert.ok(expectedRef, `no unreviewed trust context ${context.id}`);
    assertTrustContext(context, expectedRef, expectedLevel, sourceFiles);
  }

  assert.equal(trust.ownershipRules.length, 8);
  assert.equal(new Set(trust.ownershipRules.map(({ id }) => id)).size, 8);
  const ownerFieldByRef = {
    "media.owner.product-semantics": ["mediaProductSemantics", "media"],
    "media.owner.identity-and-delegation": ["identityAuthenticationAndDelegation", "ghatana-shared-and-identity-service"],
    "media.owner.privileged-effects": ["privilegedEffects", "ghatana-action-plane"],
    "media.owner.model-execution": ["genericModelExecution", "ghatana-ai-inference"],
    "media.owner.audit-mechanics": ["genericAuditMechanics", "ghatana-shared"],
    "media.owner.event-transport": ["eventTransport", "platform-event-plane; Media-owns-event-meaning"],
    "media.owner.storage-and-erasure": ["storageMechanics", "platform-storage-owner; Media-owns-artifact-lifecycle-policy"],
    "media.owner.domain-state-semantics": ["ownerDefinedPdp10AuthorityScopes/effectAuthority", "media"],
  };
  for (const row of trust.ownershipRules) {
    const [field, expectedOwner] = ownerFieldByRef[row.id] ?? [];
    assert.ok(field, `unexpected ownership rule ${row.id}`);
    if (row.id === "media.owner.domain-state-semantics") {
      assert.equal(row.sourceRef, `.product-experience/pdp-1-domain-data/authority.yaml#${field}`);
      assert.ok(authority.ownerDefinedPdp10AuthorityScopes.effectAuthority);
    } else {
      assert.equal(row.sourceRef, `.product-experience/pdp-1-domain-data/authority.yaml#ownership/${field}`);
      assert.equal(authority.ownership[field], expectedOwner, row.id);
    }
    assert.equal(row.accountableOwner, expectedOwner.split(";", 1)[0], row.id);
    assert.ok(row.owns.length > 0);
    assert.ok(row.MediaBoundary || row.mustNotDelegateMeaningTo?.length, row.id);
  }
  assert.match(trust.failClosedRule, /missing, conflicting, stale, or outside its declared scope cannot be promoted/u);

  const wrongOwner = structuredClone(invariantSource);
  wrongOwner.records[0].accountableOwner = "ghatana-shared";
  assert.throws(() => assertInvariantOwnership(wrongOwner, constitution, authority, privacy),
    "changing an invariant's accountable owner is rejected");
  const wrongTrustClass = structuredClone(trust);
  const changedTrustClass = wrongTrustClass.trustContexts.find(({ id }) => id === "media.trust.host-identity");
  changedTrustClass.trustLevel = "AUTHORITY_ISSUED_SCOPED_DECISION";
  assert.throws(() => assertTrustContext(changedTrustClass, ...expectedTrustSources.get(changedTrustClass.id), sourceFiles),
    "host identity cannot be coerced into a policy-issued decision");
  const wrongTrustSource = structuredClone(trust);
  const changedTrustSource = wrongTrustSource.trustContexts.find(({ id }) => id === "media.trust.effect-finality-evidence");
  changedTrustSource.sourceRef = expectedTrustSources.get("media.trust.canonical-state-observation")[0];
  assert.throws(() => assertTrustContext(changedTrustSource, ...expectedTrustSources.get(changedTrustSource.id), sourceFiles),
    "state observation cannot replace effect-owner finality evidence");
  const wrongInvariantSource = structuredClone(invariantSource);
  wrongInvariantSource.records[0].sourceRefs[0] = ".product-experience/pdp-1-domain-data/privacy.yaml#ownerDefinedPdp10Boundary/tenantIsolation";
  assert.throws(() => assertInvariantOwnership(wrongInvariantSource, constitution, authority, privacy),
    "a valid but semantically unrelated privacy rule cannot replace locality semantics");
  const substitutedDecision = structuredClone(adjudication.ownerAcceptedPolicyDecisions);
  substitutedDecision.unknownOutcomeRule = "provider-status-string-is-authoritative";
  assert.throws(() => resolveAcceptedDomainRuleRecords(constitution.domainRules.records, substitutedDecision),
    "a changed canonical owner decision cannot satisfy the accepted P0 projection join");
  const substitutedP0Ref = structuredClone(constitution.domainRules.records);
  substitutedP0Ref[0].sourceRef = substitutedP0Ref[1].sourceRef;
  assert.throws(() => resolveAcceptedDomainRuleRecords(substitutedP0Ref, adjudication.ownerAcceptedPolicyDecisions),
    "a different valid decision source cannot be substituted into a domain rule");
});
