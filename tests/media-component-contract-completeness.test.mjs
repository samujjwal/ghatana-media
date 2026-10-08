import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const contractPath = ".product-experience/pdp-2-design-interface-system/component-contracts.yaml";
const auditPath = ".product-experience/pdp-2-design-interface-system/gui/reuse-audit.yaml";
const requiredFields = [
  "anatomy",
  "states",
  "variants",
  "actions",
  "accessibility",
  "localization",
  "prohibitedUse",
  "sourceRef",
];

function yamlSection(source, key) {
  const header = new RegExp(`^${key}:\\s*$`, "m").exec(source);
  assert.ok(header, `missing ${key} section`);
  const start = header.index + header[0].length;
  const tail = source.slice(start);
  const nextTopLevel = /^[A-Za-z][A-Za-z0-9_-]*:\s*$/m.exec(tail);
  return nextTopLevel ? tail.slice(0, nextTopLevel.index) : tail;
}

function parseComponentCandidates(source) {
  const section = yamlSection(source, "components");
  const headers = [...section.matchAll(/^-\s+id:\s*(\S+)\s*$/gm)];
  return headers.map((header, index) => {
    const end = headers[index + 1]?.index ?? section.length;
    return {
      id: header[1],
      source: section.slice(header.index, end),
    };
  });
}

function auditComponentCompleteness(source) {
  const section = yamlSection(source, "componentContractCompleteness");
  const count = Number(section.match(/^  componentCount:\s*(\d+)\s*$/m)?.[1]);
  assert.ok(Number.isFinite(count), "missing componentContractCompleteness.componentCount");
  const fieldHeader = /^  fieldCounts:\s*$/m.exec(section);
  assert.ok(fieldHeader, "missing componentContractCompleteness.fieldCounts section");
  const fieldTail = section.slice(fieldHeader.index + fieldHeader[0].length);
  const fieldEnd = /^  [A-Za-z][A-Za-z0-9_-]*:\s*$/m.exec(fieldTail);
  const fieldSection = fieldEnd ? fieldTail.slice(0, fieldEnd.index) : fieldTail;
  const fieldCounts = Object.fromEntries(
    [...fieldSection.matchAll(/^    ([A-Za-z][A-Za-z0-9_-]*):\s*(\d+)\s*$/gm)]
      .map(([, field, value]) => [field, Number(value)]),
  );
  return { count, fieldCounts, section };
}

test("reuse audit completeness counts derive from the component contract source", () => {
  const components = parseComponentCandidates(readFileSync(contractPath, "utf8"));
  const audit = auditComponentCompleteness(readFileSync(auditPath, "utf8"));

  assert.ok(components.length > 0, "component-contracts.yaml has no components");
  assert.equal(new Set(components.map(({ id }) => id)).size, components.length, "component IDs must be unique");
  assert.equal(audit.count, components.length, "reuse audit componentCount must match component contracts");

  for (const field of requiredFields) {
    const count = components.filter(({ source }) => new RegExp(`^  ${field}:`, "m").test(source)).length;
    assert.equal(count, components.length, `${field} must be present on every component contract`);
    assert.equal(audit.fieldCounts[field], count, `reuse audit fieldCounts.${field} must match component contracts`);
  }

  for (const field of ["events", "publicExport"]) {
    const count = components.filter(({ source }) => new RegExp(`^  ${field}:`, "m").test(source)).length;
    assert.equal(audit.fieldCounts[field], count, `reuse audit fieldCounts.${field} must reflect source presence`);
  }

  assert.match(audit.section, /^  status: proposal-contracts-incomplete; owner-review-pending$/m);
});
