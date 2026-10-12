import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const policy = JSON.parse(readFileSync(new URL('../config/dependency-profile-policy.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../config/dependency-admission/release-artifact-lock.json', import.meta.url), 'utf8'));
const settings = readFileSync(new URL('../settings.gradle.kts', import.meta.url), 'utf8');

test('development source composites are explicit and never release eligible', () => {
  assert.equal(policy.schemaVersion, 'media.dependency-profile-policy.v1');
  assert.equal(policy.defaultProfile, 'DEV_SOURCE_COMPOSITE');
  assert.equal(policy.profiles.DEV_SOURCE_COMPOSITE.releaseEligible, false);
  assert.match(settings, /orElse\("DEV_SOURCE_COMPOSITE"\)/u);
  assert.match(settings, /sourceCompositeEnabled = mediaDependencyProfile == "DEV_SOURCE_COMPOSITE"/u);
});

test('release artifact-only profile requires owner evidence and has no admitted lock entries yet', () => {
  const release = policy.profiles.RELEASE_ARTIFACT_ONLY;
  assert.equal(release.status, 'NOT_ADMITTED');
  assert.equal(release.releaseEligible, false);
  assert.deepEqual(release.requiredDependencyIds, lock.unresolvedDependencyIds);
  for (const field of ['owner', 'ownerDecisionRef', 'coordinates', 'version', 'artifactSha256', 'licenseExpression', 'licenseReportRef', 'sbomSha256', 'installedConsumerTestRef', 'sourceFree']) {
    assert.ok(release.requiredEvidence.includes(field));
  }
  assert.equal(lock.schemaVersion, 'media.release-artifact-lock.v1');
  assert.equal(lock.status, 'NOT_ADMITTED');
  assert.deepEqual(lock.artifacts, []);
  assert.match(settings, /RELEASE_ARTIFACT_ONLY is not admitted/u);
  assert.match(settings, /sourceCompositeEnabled && ghatanaSharedPath\.exists\(\)/u);
  assert.match(settings, /isStandaloneBuild && sourceCompositeEnabled\) \{/u);
});

test('dependency boundaries preserve upstream ownership and toolchain version selection', () => {
  const owners = new Map(policy.dependencyBoundaries.map(({ id, owner }) => [id, owner]));
  assert.equal(owners.get('shared-platform-java'), 'ghatana-shared');
  assert.equal(owners.get('tools-java-runtime'), 'ghatana-tools');
  assert.equal(owners.get('kernel-product-api'), 'ghatana-kernel');
  assert.ok(policy.dependencyBoundaries.filter(({ toolchainOwnsVersionSelection }) => toolchainOwnsVersionSelection)
    .every(({ owner }) => owner !== 'ghatana-media'));
  assert.equal(policy.dependencyBoundaries.find(({ id }) => id === 'lifecycle-surface-experience-pack-candidate').nativeAdmission, 'NOT_ADMITTED');
});
