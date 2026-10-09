import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enumerateExpectedMediaObligations } from '../scripts/lib/media-obligation-denominator-audit.mjs';

const relative = '.product-experience/pdp-1-domain-data/operations.yaml';
const id = 'media.test.exact-owner-rule.v1';
const parentId = 'media.test.operation.v1';
const ownerRef = `${relative}#ownerDefinedOperationContracts/records/@id=${parentId}/parameterBindingRule`;

function observe(mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-owner-rule-index-'));
  const document = {
    ownerDefinedOperationContracts: { records: [{ id: parentId, parameterBindingRule: { id, rule: 'Compare exact immutable source versions before accepting a command.' } }] },
    ownerNormativeRuleRecords: [{ id, ruleRef: ownerRef, sourceRole: 'stable-identifier-index-only' }],
  };
  try {
    mutate?.(document);
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(document));
    return enumerateExpectedMediaObligations({ root, parseYaml: JSON.parse });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('rule indexes resolve the exact owner clause and count it once', () => {
  const result = observe();
  const selected = result.records.filter(record => record.recordId === id);
  assert.equal(selected.length, 1);
  assert.match(selected[0].sourceRef, /ownerDefinedOperationContracts/);
  assert.equal(selected[0].sourceSummary, 'Compare exact immutable source versions before accepting a command.');
  assert.equal(result.issues.some(issue => issue.code === 'SOURCE_ENUMERATION_DUPLICATE_OWNER' || issue.code === 'SOURCE_ENUMERATION_RULE_INDEX'), false);
});

test('a valid foreign rule or missing owner clause cannot replace the indexed rule', () => {
  for (const mutate of [
    document => { delete document.ownerNormativeRuleRecords[0].ruleRef; },
    document => { document.ownerNormativeRuleRecords[0].ruleRef = ""; },
    document => { document.ownerNormativeRuleRecords[0].ruleRef = ownerRef.replace(parentId, 'missing-operation'); },
    document => { document.ownerDefinedOperationContracts.records[0].parameterBindingRule.id = 'media.test.foreign-rule.v1'; },
    document => { document.ownerNormativeRuleRecords[0].ruleRef = ownerRef.replace(relative, '.product-experience/pdp-1-domain-data/privacy.yaml'); },
  ]) {
    assert.ok(observe(mutate).issues.some(issue => issue.code === 'SOURCE_ENUMERATION_RULE_INDEX'));
  }
});

test('two distinct owner clauses using the same normative identity are rejected', () => {
  const result = observe(document => {
    document.ownerDefinedOperationContracts.records.push({ id: 'media.test.other-operation.v1', parameterBindingRule: { id, rule: 'A different normative meaning.' } });
  });
  assert.ok(result.issues.some(issue => issue.code === 'SOURCE_ENUMERATION_DUPLICATE_OWNER'));
});


test('an anonymous owner clause cannot acquire conflicting identities through indexes', () => {
  const result = observe(document => {
    document.ownerDefinedOperationContracts.records[0].parameterBindingRule = 'Compare the exact immutable source version.';
    document.ownerNormativeRuleRecords.push({ id: 'media.test.conflicting-index.v1', ruleRef: ownerRef });
  });
  assert.ok(result.issues.some(issue => issue.code === 'SOURCE_ENUMERATION_DUPLICATE_OWNER'));
});


test('duplicate rows are rejected while aliases from distinct collections count once', () => {
  const result = observe(document => {
    document.ownerNormativeRuleRecords.push(structuredClone(document.ownerNormativeRuleRecords[0]));
  });
  assert.ok(result.issues.some(issue => issue.code === 'SOURCE_ENUMERATION_DUPLICATE_OWNER'));
});

test('P2 index identities remain stable while their exact owner meaning is inspected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-p2-rule-index-'));
  const relative = '.product-experience/pdp-2-design-interface-system/cli-language.yaml';
  const indexId = 'media.p2.rule.test-options.v1';
  const clauseId = 'media.cli.test-options.v1';
  const document = {
    ownerDefinedInvocationRules: [{ id: clauseId, rule: 'Only exact command option applicability permits an invocation.' }],
    ownerDefinedCanonicalCommandContracts: { contracts: [{ id: 'media.cli.command.test.v1', rule: 'Bind the exact owner operation request and result.' }] },
    normativeRuleRecords: [{ id: indexId, ruleRef: `${relative}#/ownerDefinedInvocationRules/@id=${clauseId}` }],
  };
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const run = () => {
      fs.writeFileSync(file, JSON.stringify(document));
      return enumerateExpectedMediaObligations({ root, parseYaml: JSON.parse });
    };
    const selected = run().records.find(record => record.recordId === indexId);
    const command = run().records.filter(record => record.recordId === 'media.cli.command.test.v1');
    assert.equal(command.length, 1);
    assert.equal(command[0].phase, 'PDP-2');
    assert.equal(command[0].sourceSummary, 'Bind the exact owner operation request and result.');
    assert.equal(selected.sourceRef, `${relative}#/normativeRuleRecords/${indexId}`);
    assert.equal(selected.sourceSummary, document.ownerDefinedInvocationRules[0].rule);
    document.normativeRuleRecords[0].ruleRef = `#/ownerDefinedInvocationRules/@id=${clauseId}`;
    assert.equal(run().records.find(record => record.recordId === indexId).sourceSummary, selected.sourceSummary);
    for (const invalid of [null, '', `${relative}#missing`, ownerRef]) {
      document.normativeRuleRecords[0].ruleRef = invalid;
      assert.ok(run().issues.some(issue => issue.code === 'SOURCE_ENUMERATION_RULE_INDEX'));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
