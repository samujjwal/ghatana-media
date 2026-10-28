#!/usr/bin/env node
/**
 * Read-only candidate decision drift detector. Never admits a provider,
 * replaces PDP-0, or authorizes model/voice/content rights.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const path = 'docs/implementation/observations/media-candidate-decision-crosswalk-2026-10-28.json';
const index = JSON.parse(read(path));

function gitBlobSha(content) {
  const bytes = Buffer.from(content, 'utf8');
  return createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
}

function sourceTable(id, text, start, end) {
  const lines = text.split('\n');
  const a = lines.findIndex((line) => line.includes(start));
  const b = lines.findIndex((line, i) => i > a && line.startsWith(end));
  assert.ok(a >= 0 && b > a, 'Source section changed: ' + id);
  const result = [];
  for (let i = a + 1; i < b; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) continue;
    const columns = line.split('|').slice(1, -1).map((v) => v.trim());
    if (columns.length < 3 || columns.some((v) => /^[-:\s]+$/u.test(v))) continue;
    if (['Technology / project','Component','Technology','Candidate(s)'].includes(columns[0])) continue;
    result.push({
      id: id + '-' + String(result.length + 1).padStart(2, '0'),
      label: columns[0], sourceLine: i + 1, originalSourceColumns: columns
    });
  }
  return result;
}

function verify() {
  assert.equal(index.schemaVersion, 'media.candidate-decision-crosswalk.v1');
  assert.equal(index.authority,
    'READ_ONLY_DISCOVERABILITY_INDEX_NOT_A_SECOND_PDP_SELECTION_PROVIDER_MANIFEST_OR_LICENSE_APPROVAL');
  const sources = Object.fromEntries(index.canonicalSourceSnapshots.map((item) => [item.id, item]));
  for (const source of index.canonicalSourceSnapshots) {
    assert.equal(gitBlobSha(read(source.path)), source.githubBlobSha,
      'Source changed; reconcile and regenerate review index: ' + source.path);
  }
  const p0 = read(sources.p0.path);
  const selectionStart = p0.indexOf('selectionRegister:');
  const selectionEnd = p0.indexOf('\nmediaArchitectureRules:', selectionStart);
  assert.ok(selectionStart >= 0 && selectionEnd > selectionStart);
  const selection = p0.slice(selectionStart, selectionEnd);
  const matches = [...selection.matchAll(/\bid:\s*(TECH-[A-Z0-9-]+)/gu)];
  const expected = matches.map((match, i) => {
    const segment = selection.slice(match.index, matches[i + 1]?.index ?? selection.length);
    const field = (name) => segment.match(new RegExp('^\\s*' + name + ':\\s*(.+)$', 'm'))?.[1]?.trim() ?? null;
    return {
      id: match[1], decision: field('decision'), qualificationStatus: field('qualificationStatus'),
      owner: field('owner'), purpose: field('purpose'), licenseClaim: field('licenseSPDX'),
      sourceRef: sources.p0.path + '#selectionRegister/' + match[1],
      sourceLine: p0.slice(0, selectionStart + match.index).split('\n').length,
      authority: 'PDP0_OWNER_ARCHITECTURE_SELECTION_NOT_ARTIFACT_ADMISSION'
    };
  });
  assert.deepEqual(index.pdp0ArchitecturalSelections, expected,
    'PDP-0 selection changed. Update the index without erasing original decisions.');
  assert.equal(expected.length, 38);
  const statuses = {};
  for (const row of expected) {
    statuses[row.decision] = (statuses[row.decision] ?? 0) + 1;
    assert.notEqual(row.qualificationStatus, 'ADMITTED');
  }
  assert.deepEqual(statuses, {SELECTED:21, CONDITIONAL:15, NOT_REQUIRED:1, REJECTED:1});

  const blueprint = read(sources.bp.path);
  const migration = read(sources.mig.path);
  const specs = {
    B3:[blueprint,'## 3. Permissive OSS','## 4.'],
    B13:[blueprint,'### 13.2 Higher-value OSS candidates','## 14.'],
    ANIM:[blueprint,'### 20.2 Candidate permissive OSS adoption','## 21.'],
    SIM:[blueprint,'### 21.3 Permissive solver/render candidates','### 21.4'],
    MIG:[migration,'# Appendix B. External candidate inventory','# Appendix C.']
  };
  for (const [id, args] of Object.entries(specs)) {
    const current = sourceTable(id, ...args);
    const recorded = index.preservedResearchSourceTables[id] ?? [];
    assert.equal(recorded.length, current.length, 'Candidate table count changed: ' + id);
    for (let i = 0; i < current.length; i++) {
      for (const [name, value] of Object.entries(current[i])) {
        assert.deepEqual(recorded[i][name], value, 'Candidate table drift: ' + id + ':' + i + ':' + name);
      }
      assert.equal(recorded[i].productionAdmitted, false);
    }
  }
  const domainRegex = new RegExp('^#### .([A-Z]+). — (.+)$','gm');
  const domains = [...blueprint.matchAll(domainRegex)].map((m) => ({id:m[1],title:m[2]}));
  assert.equal(domains.length, 22);
  assert.deepEqual(index.sourceCapabilityFamilies.map((r) => ({id:r.domainId,
    title:(blueprint.split('\n')[r.sourceLine-1] ?? '').split(' — ').slice(1).join(' — ')})),domains);
  const refs = new Set([
    ...index.pdp0ArchitecturalSelections.map((x) => 'P0:' + x.id),
    ...Object.values(index.preservedResearchSourceTables).flat().map((x) => 'REVIEW:' + x.id),
    ...index.r9AssetCandidates.map((x) => 'R9:' + x.id),
    ...index.discussionOnlyCandidates.map((x) => 'HIST:' + x.id)
  ]);
  for (const family of index.sourceCapabilityFamilies) {
    assert.ok(family.candidateSourceRefs.length, 'Missing source candidate family: ' + family.domainId);
    for (const ref of family.candidateSourceRefs) assert.ok(refs.has(ref), 'Dangling candidate ref ' + ref);
  }
  const r9 = JSON.parse(read(sources.r9.path));
  assert.deepEqual(index.r9AssetCandidates.map((x) => x.id), r9.candidates.map((x) => x.id));
  assert.ok(r9.candidates.every((x) => x.status === 'REVIEW_ONLY'));
  assert.ok(index.r9AssetCandidates.every((x) => x.productionAdmitted === false));
  const history = JSON.parse(read(sources.history.path));
  assert.deepEqual(index.discussionOnlyCandidates.map((x) => x.id),
    history.unrecordedPastCandidates.map((x) => x.id));
  assert.deepEqual(index.historicalArchitectureDecisions.map((x) => x.id),
    history.decisionHistory.map((x) => x.id));
  assert.ok(index.discussionOnlyCandidates.every((x) => x.productionAdmitted === false));
  // Existing 501-feature audits remain the feature-level authority;
  // this index only cross-links them. Do not duplicate or auto-admit feature IDs.
  const featureCoverage = index.auditFeatureCoverage;
  assert.equal(featureCoverage.recordClass, 'SOURCE_LINKS_ONLY_NOT_ATOMIC_FEATURE_ADMISSION');
  assert.deepEqual([featureCoverage.base, featureCoverage.thirdPass, featureCoverage.total],
    [428, 73, 501]);
  const sourceAuditBytes = read(featureCoverage.originalCombinedAudit.path);
  const featureProjectionBytes = read(featureCoverage.existingFeatureToPdpReconciliation.path);
  assert.equal(gitBlobSha(sourceAuditBytes),
    featureCoverage.originalCombinedAudit.githubBlobSha,
    'The 501-source feature audit changed: reconcile candidate references.');
  assert.equal(gitBlobSha(featureProjectionBytes),
    featureCoverage.existingFeatureToPdpReconciliation.githubBlobSha,
    'The 501-feature existing-PDP reconciliation changed.');
  const audit = JSON.parse(sourceAuditBytes);
  const proposal = JSON.parse(featureProjectionBytes);
  assert.deepEqual([audit.originalAudit.inventory.length, audit.thirdPassAdditions.length,
    audit.combinedCount, proposal.auditCounts.totalUnique], [428, 73, 501, 501]);
  const auditIds = [...audit.originalAudit.inventory, ...audit.thirdPassAdditions]
    .map((row) => row.audit_id);
  assert.equal(new Set(auditIds).size, 501,
    'All 501 original audit-local identities must remain distinct.');
  const count = index.counts;
  assert.equal(count.pdp0TechDecisions, 38);
  for (const [field, key] of [
    ['blueprintOssRoles','B3'], ['blueprintHigherValueCandidates','B13'],
    ['animationCandidates','ANIM'], ['simulationCandidates','SIM'],
    ['migrationAppendixCandidates','MIG']
  ]) assert.equal(count[field], index.preservedResearchSourceTables[key].length);
  assert.equal(count.r9ExactSourceAssets, 6);
  assert.equal(count.conversationOnlyAlternatives, history.unrecordedPastCandidates.length);
  assert.equal(count.sourceDomainFamilies, 22);
  assert.ok(index.explicitReconciliations.some((x) => x.key === 'ffmpeg' &&
    x.conflict.includes('COMPATIBLE_SCOPES')));
  assert.ok(index.explicitReconciliations.some((x) => x.key === 'recording' &&
    x.conflict.includes('superseded')));
  console.log('Candidate decision crosswalk PASS: 38 PDP-0 technologies, 5 historical tables, 6 R9 assets, ' +
    history.unrecordedPastCandidates.length + ' conversation-only options, 22 capability families and 501 preserved audit-local feature IDs.');
}

try { verify(); } catch (error) {
  console.error('Candidate decision crosswalk FAIL: ' + error.message);
  process.exitCode = 1;
}
