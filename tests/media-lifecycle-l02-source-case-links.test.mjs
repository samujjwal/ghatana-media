import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const proposal = JSON.parse(fs.readFileSync('config/closure/media-product-definition/l02-source-case-links.json', 'utf8'));
const obligations = JSON.parse(fs.readFileSync('config/closure/media-product-definition/obligations.json', 'utf8'));
const simulationPackage = JSON.parse(fs.readFileSync('libs/media-experience-simulation/package.json', 'utf8'));
const obligationIds = obligations.map(({ id }) => id);
const obligationsById = new Map(obligations.map((obligation) => [obligation.id, obligation]));

function registeredTestBody(source, testName) {
  const escaped = testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`test\\([\"']${escaped}[\"']\\s*,\\s*(?:async\\s+)?\\(\\)\\s*=>\\s*\\{([\\s\\S]*?)(?=\\n\\s*test\\(|$)`, 'u').exec(source);
  return match?.[1];
}

function validateLink(link) {
  assert.ok(obligationsById.has(link.obligationId), `stale obligation ${link.obligationId}`);
  const obligation = obligationsById.get(link.obligationId);
  assert.ok(obligation.caseIds.includes(link.caseId), `${link.caseId} is not a case of ${link.obligationId}`);
  const sourcePath = link.testIdentity?.sourcePath;
  assert.match(sourcePath ?? '', /^libs\/media-experience-simulation\/tests\/[a-z0-9-]+\.test\.mjs$/u,
    'test source is outside the registered simulation suite');
  assert.match(simulationPackage.scripts.test, /node --test tests\/\*\.test\.mjs/u,
    'source file is not registered by the simulation package test command');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const body = registeredTestBody(source, link.testIdentity?.testName ?? '');
  assert.ok(body, `unregistered test identity ${link.testIdentity?.testName}`);
  assert.ok(body.includes(`media.scenario.${link.caseId.slice('media.scenario.'.length)}`),
    `${link.testIdentity.testName} does not construct/assert the linked scenario`);
  assert.equal(link.scope, 'PARTIAL_CASE_ASSERTIONS_ONLY');
}

test('L-02 source-link proposal preserves all obligations and validates exact existing test identities', () => {
  assert.equal(proposal.status, 'SOURCE_LINK_PROPOSAL_PARTIAL_NOT_EXECUTION_ADMITTED');
  assert.deepEqual(proposal.obligationIds, obligationIds, 'proposal denominator must preserve every obligation ID in source order');
  assert.equal(new Set(proposal.obligationIds).size, 318);
  assert.equal(new Set(proposal.candidateLinks.map(({ obligationId }) => obligationId)).size, 12);
  assert.equal(proposal.candidateLinks.length, 29);
  assert.equal(proposal.unmappedObligationIds.length, 306);
  assert.deepEqual(new Set(proposal.unmappedObligationIds), new Set(obligationIds.filter((id) =>
    !proposal.candidateLinks.some((link) => link.obligationId === id))));

  const links = new Set();
  for (const link of proposal.candidateLinks) {
    const key = `${link.obligationId}\0${link.caseId}`;
    assert.ok(!links.has(key), `duplicate source link ${link.obligationId} ${link.caseId}`);
    links.add(key);
    validateLink(link);
  }
});

test('L-02 source links reject stale cases and unregistered or unrelated test identities', () => {
  const valid = proposal.candidateLinks[0];
  assert.throws(() => validateLink({ ...valid, obligationId: 'media.pdp-3.requirement.deleted' }), /stale obligation/u);
  assert.throws(() => validateLink({ ...valid, caseId: 'media.scenario.deleted' }), /is not a case/u);
  assert.throws(() => validateLink({
    ...valid,
    testIdentity: { ...valid.testIdentity, testName: 'missing test declaration' },
  }), /unregistered test identity/u);
  assert.throws(() => validateLink({
    ...valid,
    testIdentity: { ...valid.testIdentity, sourcePath: 'tests/pdp-0-final.test.mjs' },
  }), /outside the registered simulation suite/u);
});
