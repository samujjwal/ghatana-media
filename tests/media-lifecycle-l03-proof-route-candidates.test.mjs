import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateMediaClosureInputState } from '../scripts/lib/media-closure-preflight.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const hash = (relative) => `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex')}`;

function validateCandidateRoutes(routes, obligations) {
  assert.ok(Array.isArray(routes) && routes.length > 0, 'L-03 candidate routes must not be empty');
  const obligationIds = new Set(obligations.map(({ id }) => id));
  const routeIds = new Set();
  for (const route of routes) {
    assert.ok(route.id && !routeIds.has(route.id), `missing or duplicate candidate route ${route.id}`);
    routeIds.add(route.id);
    assert.ok(route.obligationIds?.length, `${route.id} must map to an obligation`);
    for (const obligationId of route.obligationIds) {
      assert.ok(obligationIds.has(obligationId), `${route.id} has stale obligation ${obligationId}`);
    }
    assert.ok(route.candidateObserver?.id && route.candidateObserver.sourceRef,
      `${route.id} needs a source-identified observer candidate`);
    assert.ok(route.candidateOracle?.id && route.candidateOracle.sourceRef && route.candidateOracle.testIdentity,
      `${route.id} needs a source-identified oracle/test candidate`);
    const producerPath = route.candidateObserver.sourceRef.split('#')[0];
    const criteriaPath = route.candidateOracle.sourceRef.split('#')[0];
    const producer = readJson(producerPath);
    const criteria = readJson(criteriaPath);
    assert.equal(producer.producerId, route.candidateObserver.id,
      `${route.id} observer candidate must resolve to the registered producer ID`);
    const criterionIndex = Number(route.candidateOracle.sourceRef.split('#/criteria/')[1]);
    assert.ok(Number.isInteger(criterionIndex) && criteria.criteria[criterionIndex],
      `${route.id} oracle candidate source pointer is missing`);
    assert.equal(criteria.criteria[criterionIndex].id, route.candidateOracle.id,
      `${route.id} oracle candidate must resolve to the registered criterion ID`);
    for (const [label, sourcePath] of [
      ['producer', producerPath], ['criteria', criteriaPath], ['test', route.candidateOracle.testIdentity],
    ]) {
      assert.ok(fs.existsSync(path.join(root, sourcePath)), `${route.id} ${label} source missing: ${sourcePath}`);
      assert.equal(route.sourceDigests?.[label], hash(sourcePath), `${route.id} ${label} source digest is stale`);
    }
    if (route.candidateOracle.testDeclaration) {
      const testPath = route.candidateOracle.testIdentity;
      assert.ok(producer.unitScope.some((scope) => testPath === scope
        || testPath.startsWith(`${scope.replace(/\/$/u, '')}/`)),
      `${route.id} exact test must remain inside the registered producer scope`);
    }
    if (route.candidateOracle.testDeclaration) {
      const declaration = route.candidateOracle.testDeclaration;
      const [className, methodName] = declaration.split('#');
      const testSource = fs.readFileSync(path.join(root, route.candidateOracle.testIdentity), 'utf8');
      assert.ok(className && methodName, `${route.id} must use Class#method test declaration identity`);
      assert.match(testSource, new RegExp(`class\\s+${className}\\b`, 'u'),
        `${route.id} test class declaration is missing`);
      assert.match(testSource, new RegExp(`@Test\\s+(?:public\\s+)?void\\s+${methodName}\\s*\\(`, 'u'),
        `${route.id} exact JUnit test declaration is missing`);
      const expectedScopeByObligation = {
        'media.pdp-1.requirement.media.operation.job-lifecycle': 'PARTIAL_JOB_LIFECYCLE_ASSERTIONS_ONLY',
        'media.pdp-1.requirement.media.operation.artifact-ingest': 'PARTIAL_ARTIFACT_INGEST_ASSERTIONS_ONLY',
        'media.pdp-1.requirement.media.operation.stream-session': 'PARTIAL_STREAM_SESSION_ASSERTIONS_ONLY',
      };
      assert.equal(route.obligationIds.length, 1,
        `${route.id} must keep a scoped partial route per obligation`);
      assert.equal(route.candidateOracle.assertionScope,
        expectedScopeByObligation[route.obligationIds[0]],
        `${route.id} must disclose the exact partial assertion scope`);
    }
    assert.ok(route.candidateObserver.admission?.startsWith('NOT_REGISTERED'),
      `${route.id} must remain a non-admitted candidate`);
    assert.equal(route.independentReview, 'NOT_RUN', `${route.id} must preserve missing independent review`);
    assert.equal(route.caseDependency, 'L-02_CASE_ID_AND_EXECUTION_BINDING_NOT_ADMITTED');
  }
  return routeIds.size;
}

test('records exact 347-obligation authoritative observer/oracle gap and source-resolvable candidates only', () => {
  const obligations = readJson('config/closure/media-product-definition/obligations.json');
  const candidates = readJson('config/closure/media-product-definition/l03-proof-route-candidates.json');
  assert.equal(obligations.length, 347);
  const missingObserver = obligations.filter(({ observerIds }) => !observerIds?.length);
  const missingOracle = obligations.filter(({ oracleIds }) => !oracleIds?.length);
  assert.equal(missingObserver.length, 347, 'every current authoritative observer route remains missing');
  assert.equal(missingOracle.length, 347, 'every current authoritative oracle route remains missing');
  assert.equal(candidates.status, 'CANDIDATES_ONLY_NOT_LIFECYCLE_ADMITTED');
  assert.equal(validateCandidateRoutes(candidates.routes, obligations), 5);
  const jobRoute = candidates.routes.find(({ id }) => id === 'media.l03.candidate.production-job-idempotency');
  assert.equal(jobRoute?.candidateOracle.testDeclaration,
    'MediaAwsPostgresqlRuntimeStateTest#persistsChecksumVerifiedArtifactsIdempotentJobsAndLeasedStreams');
  assert.match(jobRoute.candidateOracle.resultCriteria.negative, /does not establish distinct attempt semantics/u);
  const artifactRoute = candidates.routes.find(({ id }) => id === 'media.l03.candidate.production-artifact-ingestion');
  assert.equal(artifactRoute?.obligationIds[0], 'media.pdp-1.requirement.media.operation.artifact-ingest');
  assert.match(artifactRoute?.candidateOracle.resultCriteria.positive ?? '', /SHA-256 completion/u);
  assert.match(artifactRoute?.candidateOracle.resultCriteria.negative ?? '', /does not establish production operation admission/u);
  const streamRoute = candidates.routes.find(({ id }) => id === 'media.l03.candidate.production-stream-session');
  assert.equal(streamRoute?.obligationIds[0], 'media.pdp-1.requirement.media.operation.stream-session');
  assert.match(streamRoute?.candidateOracle.resultCriteria.positive ?? '', /contiguous frame sequencing/u);
  assert.match(streamRoute?.candidateOracle.resultCriteria.negative ?? '', /does not establish transport equivalence/u);
  assert.ok(candidates.routes.every((route) => route.obligationIds.every((id) =>
    obligations.find(({ id: obligationId }) => obligationId === id).observerIds.length === 0
      && obligations.find(({ id: obligationId }) => obligationId === id).oracleIds.length === 0)),
  'candidate mappings must not populate authoritative obligation assignments');
  assert.equal(readJson('config/closure/media-product-definition/pending-decisions.json').status, 'PENDING');
});

test('documents why current L-02 simulation links do not yet have L-03 observer/oracle routes', () => {
  const links = readJson('config/closure/media-product-definition/l02-source-case-links.json');
  const candidates = readJson('config/closure/media-product-definition/l03-proof-route-candidates.json');
  const obligations = readJson('config/closure/media-product-definition/obligations.json');
  const producerFiles = fs.readdirSync(path.join(root, 'scripts/conformance/evidence-definitions/producers'));
  const criteriaFiles = fs.readdirSync(path.join(root, 'scripts/conformance/evidence-definitions/criteria'));
  const producers = producerFiles.map((file) => readJson(`scripts/conformance/evidence-definitions/producers/${file}`));
  const criteria = criteriaFiles.map((file) => readJson(`scripts/conformance/evidence-definitions/criteria/${file}`));
  const linkedTestPaths = new Set(links.candidateLinks.map(({ testIdentity }) => testIdentity.sourcePath));
  const linkedObligationIds = new Set(links.candidateLinks.map(({ obligationId }) => obligationId));
  const producerScopes = producers.flatMap(({ unitScope = [] }) => unitScope);
  const criterionTargets = criteria.flatMap(({ criteria: entries = [] }) => entries.map(({ measurement }) => [
    measurement?.target,
    measurement?.command,
  ].filter(Boolean).join(' ')));

  assert.equal(candidates.l02CaseLinkReview.reviewedLinkCount, links.candidateLinks.length);
  assert.equal(candidates.l02CaseLinkReview.reviewedObligationCount, linkedObligationIds.size);
  assert.equal(candidates.l02CaseLinkReview.obligationDenominator, obligations.length);
  assert.equal(candidates.l02CaseLinkReview.unmappedObligationCount,
    obligations.length - linkedObligationIds.size);
  assert.equal(obligations.length, 347, 'the authoritative denominator remains 347');
  assert.equal(candidates.l02CaseLinkReview.unmappedObligationCount, 309);
  assert.equal(candidates.l02CaseLinkReview.candidateRouteCount, 0);
  assert.equal(candidates.l02CaseLinkReview.status, 'NO_CASE_SPECIFIC_OBSERVER_OR_ORACLE_CANDIDATE_IDENTIFIED');
  assert.equal(candidates.l02CaseLinkReview.authoritativeAssignments, 'UNCHANGED_ZERO_OF_347');
  assert.ok(candidates.l02CaseLinkReview.missingSemantics[0].includes('The linked declarations'));
  assert.ok(candidates.l02CaseLinkReview.missingSemantics[1].includes('the linked simulation assertions'));
  assert.ok(linkedTestPaths.size > 0 && [...linkedTestPaths].every((sourcePath) =>
    sourcePath.startsWith('libs/media-experience-simulation/tests/') || sourcePath === 'tests/media-component-definition-proof-cases.test.mjs'),
  'the reviewed links are exact simulation or parameterized definition-case sources');
  assert.ok([...linkedTestPaths].every((testPath) => !producerScopes.some((scope) =>
    testPath === scope || testPath.startsWith(`${scope.replace(/\/$/u, '')}/`))),
  'no registered producer unit scope may be inferred for a simulation test');
  assert.ok([...linkedTestPaths].every((testPath) => !criterionTargets.some((target) => target.includes(testPath))),
    'no registered criterion may be inferred from test assertion literals alone');
  assert.ok(candidates.routes.every((route) => route.obligationIds.every((id) => !linkedObligationIds.has(id))),
    'existing runtime routes must not be repurposed for unrelated L-02 obligations');
});

test('rejects empty, missing, stale-source, or unreviewed candidate route records', () => {
  const obligations = readJson('config/closure/media-product-definition/obligations.json');
  const candidates = readJson('config/closure/media-product-definition/l03-proof-route-candidates.json');
  assert.throws(() => validateCandidateRoutes([], obligations), /must not be empty/u);
  const missing = structuredClone(candidates.routes);
  delete missing[0].candidateOracle;
  assert.throws(() => validateCandidateRoutes(missing, obligations), /oracle\/test candidate/u);
  const stale = structuredClone(candidates.routes);
  stale[0].sourceDigests.test = 'sha256:' + '0'.repeat(64);
  assert.throws(() => validateCandidateRoutes(stale, obligations), /source digest is stale/u);
  const wrongObligation = structuredClone(candidates.routes);
  wrongObligation[0].obligationIds = ['media.pdp-1.requirement.deleted'];
  assert.throws(() => validateCandidateRoutes(wrongObligation, obligations), /stale obligation/u);
  const fabricatedReview = structuredClone(candidates.routes);
  fabricatedReview[0].independentReview = 'PASS';
  assert.throws(() => validateCandidateRoutes(fabricatedReview, obligations), /NOT_RUN/u);
});

test('candidate records cannot promote Media Lifecycle inputs to ready or closure', () => {
  const input = {
    consumer: readJson('config/closure/consumer.json'),
    program: readJson('config/closure/media-product-definition/phase-program.json'),
    surface: readJson('config/closure/media-product-definition/surface.json'),
    binding: readJson('config/closure/media-product-definition/phase-binding.json'),
    obligations: readJson('config/closure/media-product-definition/obligations.json'),
    pending: readJson('config/closure/media-product-definition/pending-decisions.json'),
  };
  const result = validateMediaClosureInputState(input);
  assert.equal(result.inputStatus, 'PENDING');
  assert.equal(input.pending.closureStatus, 'BLOCKED');
  assert.deepEqual(input.pending.receipts, []);
  assert.equal(input.pending.currentness, 'UNKNOWN');
  assert.equal(input.obligations.filter(({ observerIds }) => observerIds.length > 0).length, 0);
  assert.equal(input.obligations.filter(({ oracleIds }) => oracleIds.length > 0).length, 0);
});
