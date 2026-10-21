import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const read = (name) => parse(readFileSync(resolve(root, `.product-experience/pdp-1-domain-data/${name}.yaml`), "utf8"));
const jobSubmit = (operations) => operations.ownerDefinedOperationContracts.records.find((record) => record.id === "media.operation.job.submit.v1");

function validate(authority, privacy, offline) {
  const errors = [];
  const identity = authority.ownerDefinedPdp10AuthorityScopes.identityScope;
  const policy = identity.callerIdentityHintPolicy;
  const boundary = privacy.ownerDefinedPdp10Boundary;
  const consent = boundary.consentRevocation.authorityGuard;
  const retention = boundary.retentionAndErasure.authorityGuard;
  const offlineRules = offline.ownerDefinedOfflineSemantics;
  const idempotency = offlineRules.idempotencyGuard;
  const need = (condition, label) => { if (!condition) errors.push(label); };

  need(identity.requiredObservation?.includes("Current trusted identity owner observation"), "identity requires current trusted owner observation");
  for (const claim of ["tenantId", "principalId", "role", "delegation", "workspaceAuthority", "consentBoolean", "ownerLabel"])
    need(identity.callerClaimsNeverAuthority?.includes(claim), `caller claim is never authority: ${claim}`);
  need(/DENY before lookup or effect/u.test(identity.unknownOrMismatched), "identity mismatch denies before lookup/effect");
  need(policy?.externalIdentityProviderOrRuntime === "unverified; NOT_ADMITTED", "external identity provider/runtime remains unverified and not admitted");
  need(/verified host-attested tenant, principal, and current delegation/u.test(policy?.authoritativeContext ?? ""), "verified host context is authoritative");
  need(/compare-only/u.test(policy?.ingressHints ?? "") && /when absent/u.test(policy?.ingressHints ?? ""), "identity hints are compare-only and absence uses host context");
  need(/mismatch is denied before\s+lookup, fingerprinting, acceptance, or dispatch/u.test(policy?.ingressHints ?? ""), "hint mismatch denies before lookup/fingerprint/acceptance/dispatch");
  need(/never widen or replace/u.test(policy?.ingressHints ?? ""), "identity hint cannot override or widen authority");
  need(policy?.runtimeAdmission === "NOT_ADMITTED", "identity runtime admission remains NOT_ADMITTED");
  need(/Current consent-authority owner observation/u.test(consent.requiredObservation), "consent requires current owner observation");
  need(/trusted consent authority/iu.test(consent.consentMutation), "only consent authority can change consent");
  need(/caller boolean/u.test(consent.consentMutation), "caller boolean cannot establish consent");
  need(/UNKNOWN/u.test(consent.mismatchOrUnavailable), "unknown consent is not active");
  need(/exact tenant, object, immutable artifactVersion/u.test(retention.requiredObservation), "retention/hold observation binds immutable exact scope");
  need(/UNKNOWN hold\/currentness.*blocks physical purge/u.test(retention.unknownDisposition), "unknown hold/currentness blocks purge");
  need(/user assertion alone does not release/u.test(retention.holdRelease), "hold release requires current owner evidence");
  need(/exact immutable subject\/artifact version/u.test(boundary.subjectVersionBinding.requiredIdentity), "policy decisions bind immutable subject version");
  need(/distinct version/u.test(boundary.subjectVersionBinding.lineage), "correction/derivation creates distinct version");
  need(/exact trusted tenant and principal/u.test(idempotency.scope), "idempotency identity is tenant/principal scoped");
  need(/same durable receipt/u.test(idempotency.sameIdentitySameDigest), "exact duplicate cannot cause second effect");
  need(/IDEMPOTENCY_CONFLICT/u.test(idempotency.sameIdentityDifferentDigest), "digest conflict is rejected");
  need(/UNKNOWN_OUTCOME/u.test(idempotency.ambiguousOutcome), "ambiguous effect remains unknown without owner evidence");
  need(/user-supplied identity, role, delegation or consent booleans never authorize/u.test(offlineRules.reconnectProtocol[0]), "offline reconnect never trusts caller assertions");
  need(/exact immutable source\/subject version/u.test(offlineRules.reconnectProtocol[3]), "offline decisions bind exact source version");
  need(/stale values produce CONFLICT, as does changed ancestry/u.test(offlineRules.reconnectProtocol[4]), "stale draft or ancestry conflicts");
  need(/never auto-merge or last-write-wins/u.test(offlineRules.reconnectProtocol[5]), "stale draft is not merged automatically");
  return errors;
}

test("PDP-1 authority, privacy and offline source guards fail closed on missing trusted evidence", () => {
  const authority = read("authority");
  const privacy = read("privacy");
  const offline = read("offline-sync");
  assert.deepEqual(validate(authority, privacy, offline), []);
});

test("PDP-1 guard regression catches authority, consent, hold, version and replay weakening", () => {
  const authority = read("authority");
  const privacy = read("privacy");
  const offline = read("offline-sync");
  const mutants = [
    [structuredClone(authority), structuredClone(privacy), structuredClone(offline), (a) => { delete a.ownerDefinedPdp10AuthorityScopes.identityScope.requiredObservation; }],
    [structuredClone(authority), structuredClone(privacy), structuredClone(offline), (_a, p) => { p.ownerDefinedPdp10Boundary.consentRevocation.authorityGuard.consentMutation = "Caller boolean may grant consent."; }],
    [structuredClone(authority), structuredClone(privacy), structuredClone(offline), (_a, p) => { p.ownerDefinedPdp10Boundary.retentionAndErasure.authorityGuard.unknownDisposition = "Purge when hold status is unknown."; }],
    [structuredClone(authority), structuredClone(privacy), structuredClone(offline), (_a, p) => { p.ownerDefinedPdp10Boundary.subjectVersionBinding.requiredIdentity = "Latest alias is sufficient."; }],
    [structuredClone(authority), structuredClone(privacy), structuredClone(offline), (_a, _p, o) => { o.ownerDefinedOfflineSemantics.idempotencyGuard.sameIdentityDifferentDigest = "Use the new payload."; }],
    [structuredClone(authority), structuredClone(privacy), structuredClone(offline), (_a, _p, o) => { o.ownerDefinedOfflineSemantics.reconnectProtocol[4] = "Apply last write wins."; }],
  ];
  for (const [a, p, o, mutate] of mutants) {
    mutate(a, p, o);
    assert.notDeepEqual(validate(a, p, o), [], "weakened policy source must fail the focused guard");
  }
});

test("job.submit.v1 binds compare-only identity hints and excludes body tenant/principal identity", () => {
  const authority = read("authority");
  const operations = read("operations");
  const record = jobSubmit(operations);
  const request = record.ownerWireSchema.requestSchema;
  const identityInput = request.definitions.typedInputs["identity-and-authority-context"];
  const validate = (a, op) => {
    const errors = [];
    const need = (condition, label) => { if (!condition) errors.push(label); };
    const policy = a.ownerDefinedPdp10AuthorityScopes.identityScope.callerIdentityHintPolicy;
    need(op.identityAuthorityRuleRef === ".product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes/identityScope/callerIdentityHintPolicy", "operation binds exact identity authority source");
    need(op.ownerWireSchema.requestSchema.additionalProperties === false, "request object remains closed");
    for (const field of ["tenantId", "principalId"])
      need(!Object.hasOwn(op.ownerWireSchema.requestSchema.properties, field), `request excludes root ${field}`);
    need(identityInput?.properties?.payload?.properties?.tenantRef && identityInput.properties.payload.properties.principalRef && identityInput.properties.payload.properties.delegationRef, "declared nested identity input includes tenant/principal/delegation refs");
    need(/compare-only/u.test(policy.ingressHints), "policy retains compare-only hints");
    need(/Nested typed-input and target-operation body identity values are likewise compare-only and must exactly match/u.test(policy.ingressHints), "nested and target-body identities are caller hints requiring exact host-context match");
    need(/nested tenant, principal, and delegation values must exactly match the verified host-attested\s+identity/u.test(policy.bodyIdentity), "nested identity refs must match host-attested identity");
    need(/does not prohibit unrelated scope or resource selectors/u.test(policy.bodyIdentity), "unrelated scope/resource selectors remain permitted");
    need(/mismatch is denied before\s+lookup, fingerprinting, acceptance, or dispatch/u.test(policy.ingressHints), "policy retains pre-processing mismatch denial");
    need(/never widen or replace/u.test(policy.ingressHints), "policy forbids identity override");
    return errors;
  };
  assert.deepEqual(validate(authority, record), []);
  const rootTenant = structuredClone(record);
  rootTenant.ownerWireSchema.requestSchema.properties.tenantId = { type: "string" };
  assert.notDeepEqual(validate(authority, rootTenant), [], "adding root tenantId must fail");
  const rootPrincipal = structuredClone(record);
  rootPrincipal.ownerWireSchema.requestSchema.properties.principalId = { type: "string" };
  assert.notDeepEqual(validate(authority, rootPrincipal), [], "adding root principalId must fail");
  const wrongAuthorityRef = structuredClone(record);
  wrongAuthorityRef.identityAuthorityRuleRef = ".product-experience/pdp-1-domain-data/authority.yaml#ownership";
  assert.notDeepEqual(validate(authority, wrongAuthorityRef), [], "rebinding the operation to a different authority rule must fail");
  const mismatchOverride = structuredClone(authority);
  mismatchOverride.ownerDefinedPdp10AuthorityScopes.identityScope.callerIdentityHintPolicy.ingressHints = "Mismatch falls back to caller identity and may widen scope.";
  assert.notDeepEqual(validate(mismatchOverride, record), [], "mismatch override must fail");
  const nestedOverride = structuredClone(authority);
  nestedOverride.ownerDefinedPdp10AuthorityScopes.identityScope.callerIdentityHintPolicy.bodyIdentity = "Nested identity-and-authority-context fields are trusted authorities.";
  assert.notDeepEqual(validate(nestedOverride, record), [], "nested identity override must fail");
});
