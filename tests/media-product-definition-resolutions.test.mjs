import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const p0 = ".product-experience/pdp-0-product-truth/";
const constitution = readYaml(`${p0}/constitution.yaml`);
const actors = readYaml(`${p0}/actors-responsibilities.yaml`);
const goals = readYaml(`${p0}goals-jtbd.yaml`);
const roles = new Set(actors.responsibilityRoles.map(({ id }) => id));
const rolesById = new Map(actors.responsibilityRoles.map((role) => [role.id, role]));
const goalsById = new Set(goals.outcomes.map(({ id }) => id));

function assertReferenceResolves(reference, description) {
  const separator = reference.indexOf("#");
  const path = separator < 0 ? reference : reference.slice(0, separator);
  assert.ok(path && !path.startsWith("master-plan:"), `${description}: expected a repository source path`);
  let value = readYaml(path);
  if (separator >= 0) {
    const pointer = reference.slice(separator + 1);
    assert.ok(pointer.startsWith("/"), `${description}: expected a JSON pointer`);
    for (const token of pointer.slice(1).split("/")) {
      const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
      assert.ok(value !== null && typeof value === "object" && key in value, `${description}: stale reference ${reference}`);
      value = value[key];
    }
  }
  assert.notEqual(value, null, `${description}: reference resolved to null`);
}

test("Media-owned PDP-0 rules project only PXD-035 decisions and retain proposal-only mappings pending", () => {
  assert.match(constitution.invariants.resolutionStatus, /media-owner-resolved/u);
  assert.match(constitution.invariants.resolutionStatus, /P0-010-independent-review-pending/u);
  assert.ok(constitution.invariants.records.length >= 7);
  for (const invariant of constitution.invariants.records) {
    assert.ok(invariant.statement?.length, `${invariant.id} has a statement`);
    assert.ok(invariant.violation?.length, `${invariant.id} has explicit violation behavior`);
    assert.ok(invariant.sourceRefs.length, `${invariant.id} has source evidence`);
    invariant.sourceRefs.forEach((ref) => assertReferenceResolves(ref, invariant.id));
  }

  assert.match(constitution.domainRules.status, /PXD-035/u);
  assert.equal(constitution.domainRules.records.length, 6);
  assert.ok(constitution.domainRules.records.every(({ decisionStatus }) => /P0-010-independent-review-pending/u.test(decisionStatus)));
  assert.equal(constitution.domainRules.pendingSources.length, 3);
  for (const source of constitution.domainRules.pendingSources) {
    assertReferenceResolves(source.ref, "pending domain rule source");
    assert.match(source.reason, /pending|proposal|unverified/iu);
  }
  assert.match(readYaml(".product-experience/pdp-1-domain-data/states.yaml").authorityStatus, /proposal-only/u);
  assert.match(readYaml(".product-experience/pdp-1-domain-data/transitions.yaml").authorityStatus, /proposal-only/u);
  const adjudication = readYaml(".product-experience/pdp-1-domain-data/state-adjudication.yaml");
  assert.match(adjudication.status, /owner-approved/u);
  assert.ok(constitution.domainRules.pendingSources.every(({ reason }) => /proposal|pending|unverified/iu.test(reason)));
});

test("trust and ownership decisions classify by data/effect and never infer authority from principal kind", () => {
  const trust = actors.trustContexts;
  assert.match(trust.resolutionStatus, /P0-010-independent-review-pending/u);
  assert.match(trust.principalKindInference, /forbidden/u);
  assert.match(trust.classificationBasis, /sensitivity of data and the effect/u);
  const contexts = new Map(trust.contexts.map((context) => [context.trustLevel, context]));
  assert.deepEqual([...contexts.keys()].sort(), ["admin", "authenticated", "privileged", "public"]);
  for (const context of contexts.values()) {
    assert.ok(context.dataSensitivity, `${context.id} classifies data sensitivity`);
    assert.ok(context.effectScope, `${context.id} classifies effect scope`);
    assert.equal(typeof context.auditRequired, "boolean", `${context.id} explicitly sets auditRequired`);
    assert.ok(context.auditRationale?.length, `${context.id} explains its audit decision`);
    assert.ok(context.sourceRefs.length, `${context.id} has evidence refs`);
    context.sourceRefs.forEach((ref) => assertReferenceResolves(ref, context.id));
    assert.equal("principalKind" in context, false, `${context.id} does not classify trust by principal kind`);
  }
  assert.equal(contexts.get("public").auditRequired, false, "only public, nonsensitive, read-only access has no audit requirement");
  for (const level of ["authenticated", "privileged", "admin"]) assert.equal(contexts.get(level).auditRequired, true);
  assert.equal(actors.principals.find(({ id }) => id === "media.principal.human-user").kind, "human");
  assert.equal(actors.actors.find(({ id }) => id === "media.administrator").principalRef, "media.principal.human-user");
  assert.equal(actors.principals.some(({ kind }) => contexts.has(kind)), false, "principal kinds are not trust levels");
  assert.equal(actors.ownershipRules.accountabilityIsNotPrivilege, true);

  const ownership = actors.ownershipRules.rules;
  assert.equal(new Set(ownership.map(({ concern }) => concern)).size, ownership.length, "each concern has one owner record");
  for (const rule of ownership) {
    assert.ok(roles.has(rule.accountableRoleRef), `${rule.id} references a current accountability role`);
    assert.equal(rolesById.get(rule.accountableRoleRef).grantsPermission, false, `${rule.id} accountability does not grant permission`);
    assert.ok(rule.contractOwner?.repository, `${rule.id} names the contract-owning repository`);
    assert.ok(rule.sourceRefs.length, `${rule.id} has source refs`);
    rule.sourceRefs.forEach((ref) => assertReferenceResolves(ref, rule.id));
  }
  assert.match(ownership.find(({ concern }) => concern === "canonical-media-domain-states-and-transitions").bindingStatus, /proposal-only/u);
  assert.match(ownership.find(({ concern }) => concern === "authentication-tenant-and-delegation-mechanics").bindingStatus, /unverified/u);

  const mapping = goals.authorityMapping;
  assert.match(mapping.rule, /do not identify an authenticated principal/u);
  assertReferenceResolves(mapping.accountabilitySource, "goal accountability source");
  assertReferenceResolves(mapping.trustContextSource, "goal trust source");
  for (const note of mapping.goalAuthorityNotes) {
    assert.ok(goalsById.has(note.goalRef), `stale goal reference ${note.goalRef}`);
    assertReferenceResolves(note.accountabilityRef, note.goalRef);
    assert.ok(note.externalDependency.length, `${note.goalRef} records outstanding owner boundary`);
  }
});
