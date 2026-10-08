import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { validateScopeStatuses } from "../scripts/normalize-media-scope-status.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);

test("canonical Media product-definition authority is structurally closed locally", () => {
  const output = execFileSync(process.execPath, ["scripts/check-product-definition-authority.mjs"], { cwd: root, encoding: "utf8" });
  assert.match(output, /authority check passed/u);
});

test("PDP3 screen registry has 47 structurally complete v2 canonical screen proposals", () => {
  const experienceRoot = resolve(root, ".product-experience/pdp-3-product-experience");
  const registry = readFileSync(resolve(experienceRoot, "screen-registry.yaml"), "utf8");
  const schemaPath = ".product-experience/pdp-3-product-experience/screen-contract-schema.yaml";
  const schema = readFileSync(resolve(root, schemaPath), "utf8");
  const requiredFields = [
    "contractSchemaRef", "surfaceId", "templateId", "layoutIds", "componentIds", "patternIds",
    "tokenDependencies", "domainObjectRefs", "operationRefs", "stateRefs", "entry", "exit",
    "actionConsequences", "responsiveBehavior", "fixtures", "verification", "fieldBindingStatus",
  ];
  assert.match(registry, new RegExp(`^contractSchemaRef: ${schemaPath.replaceAll(".", "\\.")}$`, "mu"));
  assert.match(schema, /^contractVersion: media\.screen-contract\.v2$/mu);
  for (const field of requiredFields) assert.ok(schema.includes(`  - ${field}\n`), `schema missing required field ${field}`);

  const screenRecords = [...registry.matchAll(/^- id: (media\.view\.[^\n]+)\n([\s\S]*?)(?=^- id: |^coverage:|^contextualSpecializations:|$(?![\s\S]))/gmu)];
  assert.equal(screenRecords.length, 47, "canonical screen registry denominator must remain 47");
  const screenIds = screenRecords.map(([, id]) => id);
  assert.equal(new Set(screenIds).size, 47, "canonical screen IDs must be unique");
  const templateCatalog = readFileSync(resolve(root, ".product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml"), "utf8");
  const knownTemplates = new Set([...templateCatalog.matchAll(/^  - id: ([^\n]+)$/gmu)].map(([, id]) => id));
  const centralResponsiveAuthority = ".product-experience/pdp-2-design-interface-system/gui/layout.yaml";

  for (const [, screenId, record] of screenRecords) {
    const contractRef = record.match(/^  - (screen-contracts\/[^\n]+)$/mu)?.[1];
    assert.ok(contractRef, `${screenId} must have one contract ref`);
    const contract = readFileSync(resolve(experienceRoot, contractRef), "utf8");
    assert.match(contract, /^schemaVersion: media\.screen-contract\.v2$/mu, `${screenId} schema version`);
    for (const field of requiredFields) assert.match(contract, new RegExp(`^${field}:`, "mu"), `${screenId} missing ${field}`);
    const bindingStatus = contract.match(/^fieldBindingStatus:\n([\s\S]*?)(?=^[A-Za-z][A-Za-z0-9]*:|$(?![\s\S]))/mu)?.[1] ?? "";
    for (const field of requiredFields.filter((name) => !["contractSchemaRef", "fieldBindingStatus"].includes(name))) {
      assert.match(bindingStatus, new RegExp(`^  ${field}:`, "mu"), `${screenId} missing binding-status reason for ${field}`);
    }
    assert.match(contract, /^surfaceId: media\.surface\.web$/mu, `${screenId} candidate surface`);
    const templateId = contract.match(/^templateId: (.+)$/mu)?.[1];
    if (templateId && templateId !== "null") assert.ok(knownTemplates.has(templateId), `${screenId} unresolved template ${templateId}`);
    for (const field of ["componentIds", "patternIds"]) {
      const value = contract.match(new RegExp(`^${field}:(.*)$`, "mu"))?.[1];
      assert.ok(value !== undefined, `${screenId} ${field} must be an array`);
      if (value.trim()) assert.match(value.trim(), /^\[[^\n]*\]$/u, `${screenId} ${field} must use YAML array syntax`);
      else assert.match(contract, new RegExp(`^${field}:\\n(?:(?:  - [^\\n]*|    \\[\\])\\n)*`, "mu"), `${screenId} ${field} must be a YAML list`);
    }
    const actions = [...(contract.match(/^actions:\n((?:- [^\n]*\n)*)/mu)?.[1] ?? "").matchAll(/^- ([^\n]+)$/gmu)].map(([, id]) => id);
    const consequencesBody = contract.match(/^actionConsequences:\n([\s\S]*?)(?=^[A-Za-z][A-Za-z0-9]*:|$(?![\s\S]))/mu)?.[1] ?? "";
    const consequenceIds = [...consequencesBody.matchAll(/^  - actionId: ([^\n]+)$/gmu)].map(([, id]) => id);
    assert.equal(consequenceIds.length, actions.length, `${screenId} consequence count must match actions`);
    assert.deepEqual(consequenceIds, actions, `${screenId} consequence refs must match action IDs and order`);
    if (actions.length) {
      assert.match(consequencesBody, /effectRef: (?:null|unresolved)/u, `${screenId} must not invent action effects`);
      assert.match(consequencesBody, /(?:bindingStatus|status): pending/u, `${screenId} action consequences remain unresolved`);
    }
    assert.match(contract, new RegExp(`^responsiveBehavior:[\\s\\S]*?${centralResponsiveAuthority.replaceAll(".", "\\.")}`, "mu"), `${screenId} responsive authority must be central PDP-2`);
    assert.match(contract, /^verification:\n  status: not-run\n/mu, `${screenId} verification remains unrun`);
    assert.ok(/^  evidenceRefs: \[\]$/mu.test(contract) || /^  evidenceRefs:\n    \[\]$/mu.test(contract), `${screenId} must not invent verification evidence`);
  }
});

test("acceptance inputs use the four canonical PDP phases and keep Explorer outside the phase ledger", () => {
  const acceptance = readFileSync(resolve(root, ".product-experience/acceptance.yaml"), "utf8");
  assert.match(acceptance, /^schemaVersion: media\.product-acceptance-inputs\.v2$/mu);
  assert.match(acceptance, /^canonicalPdpPhases: \[PDP-0, PDP-1, PDP-2, PDP-3\]$/mu);

  const phaseStart = acceptance.indexOf("phaseAcceptanceInputs:\n");
  const phaseEnd = acceptance.indexOf("\nprojectionAcceptanceInputs:", phaseStart);
  assert.notEqual(phaseStart, -1, "missing phaseAcceptanceInputs");
  assert.notEqual(phaseEnd, -1, "missing projectionAcceptanceInputs after phase inputs");
  const phaseSection = acceptance.slice(phaseStart + "phaseAcceptanceInputs:\n".length, phaseEnd);
  const parseRecords = (section) => section.trim().split(/\n(?=- id: )/u).map((record) => ({
    id: record.match(/^- id: (\S+)$/mu)?.[1],
    phase: record.match(/^  phase: (PDP-[0-3])$/mu)?.[1],
    decisionInput: record.match(/^  decisionInput: (\S+)$/mu)?.[1],
    legacyId: record.match(/^  legacyId: (\S+)$/mu)?.[1],
    prerequisite: record.match(/^  prerequisite: (\S+)$/mu)?.[1],
    text: record,
  }));
  const phaseRows = parseRecords(phaseSection);
  assert.deepEqual([...new Set(phaseRows.map(({ phase }) => phase))], ["PDP-0", "PDP-1", "PDP-2", "PDP-3"]);
  assert.deepEqual(phaseRows.slice(0, 9).map(({ id, phase }) => [id, phase]), [
    ...Array.from({ length: 9 }, (_, index) => [`ACCEPT-INPUT-P0-${String(index + 2).padStart(3, "0")}`, "PDP-0"]),
  ]);
  assert.deepEqual(phaseRows.slice(9).map(({ id, phase, legacyId }) => [id, phase, legacyId]), [
    ["ACCEPT-INPUT-PDP-1", "PDP-1", undefined],
    ["ACCEPT-INPUT-PDP-2", "PDP-2", "ACCEPT-INPUT-P1"],
    ["ACCEPT-INPUT-PDP-3", "PDP-3", "ACCEPT-INPUT-P2"],
  ]);
  for (const legacyId of ["ACCEPT-INPUT-P1", "ACCEPT-INPUT-P2", "ACCEPT-INPUT-P3"]) {
    assert.deepEqual(acceptance.split("\n").filter((line) => line.includes(legacyId)), [`  legacyId: ${legacyId}`]);
  }
  assert.deepEqual(phaseRows.slice(9).map(({ decisionInput }) => decisionInput), [
    "pending-prerequisite-PDP-0-independent-P0-010-acceptance-and-human-review",
    "pending-prerequisite-PDP-1-and-human-review",
    "pending-prerequisite-PDP-2-and-full-experience-review",
  ]);
  assert.deepEqual(phaseRows.slice(9).map(({ prerequisite }) => prerequisite), [
    "independent-PDP-0-acceptance-including-P0-010",
    "accepted-PDP-1-canonical-domain-and-data-model",
    "accepted-PDP-2-design-language-and-interface-system",
  ]);
  assert.deepEqual(phaseRows.slice(0, 9).map(({ decisionInput }) => decisionInput), [
    ...Array.from({ length: 8 }, () => "pending-no-acceptance-recorded"),
    "pending-independent-review-not-executed",
  ]);

  const projectionStart = acceptance.indexOf("projectionAcceptanceInputs:\n");
  const projectionEnd = acceptance.indexOf("\ngeneratedResults:", projectionStart);
  assert.notEqual(projectionStart, -1, "missing projectionAcceptanceInputs");
  assert.notEqual(projectionEnd, -1, "missing generatedResults after projection inputs");
  const projectionSection = acceptance.slice(projectionStart + "projectionAcceptanceInputs:\n".length, projectionEnd);
  const projectionRows = parseRecords(projectionSection);
  assert.deepEqual(projectionRows.map(({ id, legacyId, phase }) => [id, legacyId, phase]), [
    ["ACCEPT-INPUT-PROJECTION-EXPLORER", "ACCEPT-INPUT-P3", undefined],
  ]);
  assert.match(projectionSection, /^  projection: EXPERIENCE-EXPLORER$/mu);
  assert.match(projectionSection, /^  decisionInput: pending-prerequisite-PDP-3-tools-binding-browser-evidence-and-human-review$/mu);
  assert.match(projectionSection, /^  prerequisite: accepted-PDP-3-product-experience$/mu);
  assert.doesNotMatch(projectionSection, /^  phase:/mu);
  assert.doesNotMatch(phaseSection, /EXPLORER|^- id: ACCEPT-INPUT-P[123]$/mu);
  assert.match(phaseRows[11].text, /journey-contracts\/live-session-loss-consent-change-and-bounded-recovery\.yaml/u);
  assert.match(phaseRows[11].text, /journey-contracts\/check-which-processing-options-are-eligible\.yaml/u);
  assert.doesNotMatch(acceptance, /^laterPhaseAcceptanceInputs:/mu);
});

test("active authority and experience metadata use canonical PDP labels without renaming stable IDs", () => {
  const authority = readFileSync(resolve(root, ".product-experience/authority-map.yaml"), "utf8");
  assert.match(authority, /- phase: PDP-0[\s\S]*?- phase: PDP-2[\s\S]*?- phase: PDP-3/mu);
  assert.match(authority, /outsidePdpPhases: true/u);
  assert.match(authority, /id: ART-P1-PHASE-1-DESIGN-LANGUAGE-DESIGN-LANGUAGE-MD/u);
  assert.match(authority, /id: ART-P2-PHASE-2-PRODUCT-EXPERIENCE-COMPLETE-PRODUCT-EXPERIENCE-MD/u);
  assert.match(authority, /P1-006/u);
  assert.doesNotMatch(authority, /canonical-if-and-when-the-P[12]-scope-is-accepted/u);

  const explorer = readFileSync(resolve(root, ".product-experience/explorer/EXPERIENCE-EXPLORER.md"), "utf8");
  assert.match(explorer, /Explorer is outside the four PDP phases/u);
  assert.match(explorer, /PDP-3 definitions remain unaccepted, and Explorer projection acceptance remains outstanding/u);
  assert.doesNotMatch(explorer, /Phase 3 is not accepted/u);

  const fixtures = readFileSync(resolve(root, ".product-experience/pdp-3-product-experience/scenario-fixture-registry.yaml"), "utf8");
  assert.match(fixtures, /content-payload-owned-by-PDP-3/u);
  assert.match(fixtures, /pdp3PayloadState:/u);
  assert.doesNotMatch(fixtures, /phase3PayloadState|content-payload-owned-by-Phase-3/u);

  const journey = readFileSync(resolve(root, ".product-experience/pdp-3-product-experience/journey-contracts/clean-noisy-interview-audio.yaml"), "utf8");
  assert.match(journey, /PDP-0 outcome[\s\S]*PDP-3 screen registry/u);
  assert.match(journey, /pdp3-action-state-scenario-channel-and-owner-bindings-pending; not-accepted/u);
});

test("active cross-phase metadata uses canonical PDP labels while stable exception identities remain intact", () => {
  const experienceRoot = resolve(root, ".product-experience/pdp-3-product-experience");
  const journeyRegistry = readFileSync(resolve(experienceRoot, "journey-registry.yaml"), "utf8");
  assert.match(journeyRegistry, /^pdp0Authority:/mu);
  assert.match(journeyRegistry, /^additionalPdp0JourneyCount: 2$/mu);
  assert.match(journeyRegistry, /^  pdp0JourneyRef: J-01$/mu);
  assert.match(journeyRegistry, /PDP-3 acceptance/u);
  assert.doesNotMatch(journeyRegistry, /phase0Authority|phase0JourneyRef|additionalPhase0JourneyCount|Phase-2 acceptance/u);

  const contracts = execFileSync("rg", ["--files", "--hidden", resolve(experienceRoot, "journey-contracts")], { cwd: root, encoding: "utf8" })
    .trim().split("\n").filter(Boolean);
  assert.ok(contracts.length >= 28, "expected the complete active journey contract set");
  for (const path of contracts) {
    const content = readFileSync(path, "utf8");
    assert.doesNotMatch(content, /phase0Authority|phase0JourneyRef|Phase-2 acceptance|phase-0-grounded/u, path);
    if (/^pdp0JourneyRef:/mu.test(content)) {
      assert.match(content, /^pdp0Authority: \.product-experience\/pdp-0-product-truth\/journey-catalog\.yaml$/mu, path);
      assert.match(content, /^pdp0JourneyRef: J-\d{2}$/mu, path);
    }
    if (content.includes("phase0-critical-exception")) {
      assert.match(content, /^- id: phase0-critical-exception$/mu, path);
    }
  }

  const fixtures = readFileSync(resolve(root, ".product-experience/explorer/scenario-fixtures.yaml"), "utf8");
  assert.match(fixtures, /^    pdp3Ref: media\.scenario\.first-use-empty$/mu);
  assert.doesNotMatch(fixtures, /^    phase2Ref:/mu);
  const projections = readFileSync(resolve(root, ".product-experience/explorer/view-projections.yaml"), "utf8");
  assert.match(projections, /PDP-3-declared-context-dimensions/u);
  assert.match(projections, /PDP-0-to-PDP-3-references/u);

  const actions = readFileSync(resolve(experienceRoot, "action-registry.yaml"), "utf8");
  assert.match(actions, /proposal-derived-from-PDP-2-component-intent/u);
  assert.doesNotMatch(actions, /proposal-derived-from-phase-1-component-intent/u);
  const screens = readFileSync(resolve(experienceRoot, "screen-contracts/job-status.yaml"), "utf8");
  assert.match(screens, /bound-to-existing-PDP-3-actions/u);
  assert.match(screens, /pdp-0:journey:J-02/u);

  for (const file of ["media-token-aliases.yaml", "typography-layout.yaml"]) {
    const metadata = readFileSync(resolve(root, ".product-experience/pdp-2-design-interface-system", file), "utf8");
    assert.match(metadata, /^  pdp0:/mu);
    assert.doesNotMatch(metadata, /^  phase0:/mu);
  }

  const gaps = readFileSync(resolve(root, ".product-experience/gaps.yaml"), "utf8");
  assert.match(gaps, /^- id: GAP-MEDIA-PHASE2-COVERAGE$/mu);
  assert.match(gaps, /^- id: GAP-MEDIA-PHASE1-COMPONENT-COVERAGE$/mu);
  assert.match(gaps, /PDP-0, PDP-1, PDP-2,\s+and PDP-3 checks/u);
  assert.match(gaps, /PDP-0-through-PDP-3-certification/u);
  const verification = readFileSync(resolve(root, ".product-experience/explorer/verification-matrix.yaml"), "utf8");
  assert.match(verification, /462-PDP-0-capability-leaves/u);
});

test("PDP3-005 journey steps are structured, provenance-bound proposals across all 30 contracts", () => {
  const journeyRoot = resolve(root, ".product-experience/pdp-3-product-experience/journey-contracts");
  const files = execFileSync("rg", ["--files", "--hidden", journeyRoot], { cwd: root, encoding: "utf8" })
    .trim().split("\n").filter(Boolean).sort();
  assert.equal(files.length, 30, "PDP3-005 contract denominator, including J-29 and J-30");

  const required = [
    "surfaceRefs", "objectRefs", "stateRefs", "canonicalOperationRef", "authorityRef", "decisionRef",
    "transitionRef", "handoffRef", "success", "failure", "degradedBehavior", "recovery", "postconditions",
    "requirementRefs", "verification",
  ];
  const screenRegistry = readFileSync(resolve(root, ".product-experience/pdp-3-product-experience/screen-registry.yaml"), "utf8");
  const journeyCatalog = readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/journey-catalog.yaml"), "utf8");
  const journeys = new Map();

  for (const path of files) {
    const content = readFileSync(path, "utf8");
    const journeyId = content.match(/^journeyId: (J-\d{2})$/mu)?.[1];
    assert.ok(journeyId, `${path} must declare a source-grounded journey ID`);
    assert.match(journeyCatalog, new RegExp(`^- id: ${journeyId}$`, "mu"), `${journeyId} must exist in PDP-0 catalog`);
    assert.ok(!journeys.has(journeyId), `${journeyId} must be unique`);
    const lines = content.split(/\r?\n/u);
    const stepsKey = lines.findIndex((line) => /^steps:\s*$/u.test(line));
    assert.notEqual(stepsKey, -1, `${journeyId} must declare steps`);
    let sectionEnd = stepsKey + 1;
    while (sectionEnd < lines.length && !/^[A-Za-z][A-Za-z0-9]*:/u.test(lines[sectionEnd])) sectionEnd++;
    const firstListItem = lines.slice(stepsKey + 1, sectionEnd).find((line) => /^ {0,8}-\s/u.test(line));
    assert.ok(firstListItem, `${journeyId} must have a steps list`);
    const stepIndent = firstListItem.match(/^( *)-/u)[1].length;
    const listItems = [];
    for (let index = stepsKey + 1; index < sectionEnd; index++) {
      const item = lines[index].match(new RegExp(`^ {${stepIndent}}-\\s*(.*)$`, "u"));
      if (!item) continue;
      assert.match(item[1], /^[A-Za-z][A-Za-z0-9_-]*\s*:/u, `${journeyId} step at line ${index + 1} must be a mapping, not a bare string`);
      listItems.push({ start: index, indent: stepIndent });
    }
    assert.ok(listItems.length > 0, `${journeyId} must have structured steps`);
    const stepIds = [];
    const declaredStepIds = [];
    for (let itemIndex = 0; itemIndex < listItems.length; itemIndex++) {
      const item = listItems[itemIndex];
      let end = sectionEnd;
      for (let index = item.start + 1; index < sectionEnd; index++) {
        const nextItem = lines[index].match(/^( {0,2})-\s/u);
        if (nextItem && nextItem[1].length <= item.indent) { end = index; break; }
      }
      const block = lines.slice(item.start, end).join("\n");
      const stepId = block.match(/^\s{0,4}(?:-\s*)?(?:stepId|view):\s*(["']?)([^\s"']+)\1/mu)?.[2];
      const declaredStepId = block.match(/^\s{0,4}(?:-\s*)?stepId:\s*(["']?)([^\s"']+)\1/mu)?.[2];
      assert.ok(stepId, `${journeyId} step ${itemIndex + 1} needs a source-grounded stepId or view`);
      stepIds.push(stepId);
      if (declaredStepId) declaredStepIds.push(declaredStepId);
      const fieldIndent = " ".repeat(item.indent + 2);
      for (const field of required) {
        assert.match(block, new RegExp(`^${fieldIndent}${field}:`, "mu"), `${journeyId}/${stepId} missing ${field}`);
      }
      const bindingStart = block.search(new RegExp(`^${fieldIndent}bindingStatus:\\s*$`, "mu"));
      assert.notEqual(bindingStart, -1, `${journeyId}/${stepId} missing bindingStatus mapping`);
      const bindingBlock = block.slice(bindingStart).split(new RegExp(`\\n${fieldIndent}[A-Za-z][A-Za-z0-9]*:`, "u"))[0];
      const bindingReason = bindingBlock.match(new RegExp(`^${fieldIndent}  reason:\\s*(.+)$`, "mu"))?.[1]?.trim();
      for (const field of required) {
        const directReason = bindingBlock.match(new RegExp(`^${fieldIndent}  ${field}:\\s*(.+)$`, "mu"))?.[1]?.trim();
        const listedReason = new RegExp(`^${fieldIndent}    - ${field}$`, "mu").test(bindingBlock);
        const fieldBlock = block.match(new RegExp(`^${fieldIndent}${field}:\\n([\\s\\S]*?)(?=^${fieldIndent}[A-Za-z][A-Za-z0-9]*:|$(?![\\s\\S]))`, "mu"))?.[1] ?? "";
        const localStatus = fieldBlock.match(/^\s+status: ([^\n]+)$/mu)?.[1];
        assert.ok(directReason || listedReason || localStatus,
          `${journeyId}/${stepId} missing binding status/reason for ${field}`);
        const reason = directReason ?? bindingReason ?? localStatus;
        assert.ok(reason && /pending|candidate|unresolved|not-run|not-specified|not-accepted/iu.test(reason),
          `${journeyId}/${stepId} binding reason for ${field} must retain its proposal/unresolved status`);
      }
      const verificationBlock = block.match(new RegExp(`^${fieldIndent}verification:\\n([\\s\\S]*?)(?=^${fieldIndent}[A-Za-z][A-Za-z0-9]*:|$(?![\\s\\S]))`, "mu"))?.[1] ?? "";
      assert.match(verificationBlock, /^\s+status: not-run$/mu, `${journeyId}/${stepId} verification must remain not-run`);
      const emptyEvidenceField = (field) => new RegExp(`^\\s+${field}:\\s*\\[\\]\\s*$|^\\s+${field}:\\s*\\n\\s+\\[\\]\\s*$`, "mu").test(verificationBlock);
      const hasActualEvidence = /^\s+actualEvidence:/mu.test(verificationBlock);
      if (hasActualEvidence) {
        assert.ok(emptyEvidenceField("actualEvidence"), `${journeyId}/${stepId} actualEvidence must be exactly empty`);
      }
      assert.ok(hasActualEvidence || /^\s+evidenceRefs:/mu.test(verificationBlock),
        `${journeyId}/${stepId} verification must declare actualEvidence or evidenceRefs`);
      assert.ok(emptyEvidenceField(hasActualEvidence ? "actualEvidence" : "evidenceRefs"),
        `${journeyId}/${stepId} verification evidence list must be exactly empty`);
      const operation = block.match(new RegExp(`^${fieldIndent}canonicalOperationRef:\\s*(.+)$`, "mu"))?.[1].trim();
      assert.ok(operation === "null" || /^media\.operation\.[a-z0-9.-]+$/u.test(operation),
        `${journeyId}/${stepId} canonicalOperationRef must be null or a logical operation ID, never a transport route`);
      const screenRef = block.match(new RegExp(`^${fieldIndent}screenContractRef:\\s*([^\\s]+)$`, "mu"))?.[1];
      if (screenRef) {
        const experienceRoot = resolve(root, ".product-experience/pdp-3-product-experience");
        const registryRelativeRef = screenRef.startsWith(".product-experience/pdp-3-product-experience/")
          ? screenRef.slice(".product-experience/pdp-3-product-experience/".length)
          : screenRef;
        assert.match(registryRelativeRef, /^screen-contracts\/[\w.-]+\.yaml$/u,
          `${journeyId}/${stepId} screen ref must follow the screen-registry contractRefs convention`);
        assert.ok(existsSync(resolve(experienceRoot, registryRelativeRef)), `${journeyId}/${stepId} screen contract ref must exist`);
        assert.ok(screenRegistry.includes(`  - ${registryRelativeRef}\n`),
          `${journeyId}/${stepId} screen contract ref must be listed by the canonical screen registry`);
      }
      const view = block.match(new RegExp(`^${fieldIndent}view:\\s*([^\\s]+)$`, "mu"))?.[1];
      if (view) assert.ok(screenRegistry.includes(`- id: ${view}\n`), `${journeyId}/${stepId} view must exist in screen registry`);
    }
    assert.equal(new Set(declaredStepIds).size, declaredStepIds.length, `${journeyId} declared stepIds must be unique`);
    journeys.set(journeyId, stepIds);
  }

  assert.equal(journeys.size, 30, "all 30 distinct journey IDs must be represented");
  assert.deepEqual(journeys.get("J-29"), [
    "detect-loss-or-consent-change", "fence-new-frame-submission", "reconcile-dispatched-frame-effects", "present-bounded-return-state",
  ]);
  assert.deepEqual(journeys.get("J-30"), [
    "establish-scope-and-permissions", "inspect-profile-and-provider-dimensions", "preserve-unknown-or-unavailable-reasons", "return-eligible-options-with-provenance",
  ]);
});

test("gRPC source inventory status matches the active proto census without changing pending bindings", () => {
  const registry = readFileSync(resolve(root, ".product-experience/pdp-3-product-experience/grpc/service-registry.yaml"), "utf8");
  const operations = readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/operations.yaml"), "utf8");
  assert.match(registry, /^status: active-source-inventory; observed-proto-projections; protocol-authority-unselected; operation-bindings-proposal-only; owner-review-pending$/mu);
  assert.match(registry, /^observedRpcCount: 43$/mu);
  assert.match(registry, /^requestedRpcCount: 43\nunresolvedRpcCount: 0$/mu);
  assert.match(operations, /all 43 identities accounted for; 17 domain-operation family refs remain proposals; 26 identities are unresolved including transport-only\/provider-admin roles/u);
  assert.equal([...registry.matchAll(/^    experienceBinding: pending-owner-review$/gmu)].length, 43);
});

test("PDP1 operation proposal preserves source denominators and the complete proposal field shape", () => {
  const registry = readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/operations.yaml"), "utf8");
  const requiredFields = [
    "operationId", "consumerActor", "authority", "context", "preconditions", "inputSemantics", "effect",
    "affectedObjects", "transition", "events", "risk", "reversibility", "commitFinality", "downstreamEffects",
    "failure", "partialSuccess", "unknownOutcome", "retry", "idempotency", "recovery", "evidenceAudit", "nextSafeAction",
  ];
  const records = [...registry.matchAll(/^  - id: (media\.operation\.[^\n]+)\n([\s\S]*?)(?=^  - id: media\.operation\.|^channelFamilies:)/gmu)];
  assert.equal(records.length, 14, "nine organizational families include five source-specific operations");
  assert.equal(new Set(records.map(([, id]) => id)).size, 14);
  const sourceSpecificIds = new Set([
    "media.operation.transcription-submission", "media.operation.transcript-version-read",
    "media.operation.caption-draft-write", "media.operation.caption-version-write",
    "media.operation.caption-version-read",
  ]);
  const sourceSpecificFields = [
    "operationId", "consumerActor", "authority", "inputSemantics", "effect", "outputSemantics",
    "authorization", "error", "finality", "version", "transport", "idempotency", "cancellation",
    "actionRefs", "observedBindings", "scopeStatus",
  ];
  for (const [, id, body] of records) {
    const fields = sourceSpecificIds.has(id) ? sourceSpecificFields : requiredFields;
    for (const field of fields) assert.match(body, new RegExp(`^    ${field}:`, "mu"), `${id} missing ${field}`);
  }

  assert.match(registry, /^  uiProductActions:\n    count: 146$/mu);
  assert.match(registry, /14 source actions have exact proposed operation refs; remaining 132 lack direct canonical bindings/u);
  assert.match(registry, /media\.action\.request-transcription: media\.operation\.transcription-submission/u);
  assert.match(registry, /^  httpOperations:\n    count: 27$/mu);
  assert.match(registry, /all 27 exact OpenAPI operationIds accounted for; exact route-to-logical-operation links remain unresolved/u);
  assert.match(registry, /^  grpcRpcs:\n    count: 43$/mu);
  assert.match(registry, /all 43 identities accounted for; 17 domain-operation family refs remain proposals; 26 identities are unresolved including transport-only\/provider-admin roles/u);
  assert.match(registry, /^  cliSimulationCommands:\n    planDenominator: 11\n    currentFixtureRegistryRecords: 11$/mu);
  assert.match(registry, /^      count: 12$/mu);
  assert.match(registry, /^  sdkMethods:\n    registryRecords: 32$/mu);
  assert.match(registry, /^  agentToolHandlers:\n    count: 4$/mu);
  assert.match(registry, /^  lifecycleEventNames:\n    count: 15$/mu);
  assert.match(registry, /^ownerReview: pending-owner-review$/mu);
});

test("active G-05 mirrors match current proposal counts without implying acceptance", () => {
  const acceptance = readFileSync(resolve(root, ".product-experience/acceptance.yaml"), "utf8");
  const gap = readFileSync(resolve(root, ".product-experience/gaps.yaml"), "utf8");
  const closureMatrix = readFileSync(resolve(root, ".product-experience/mandatory-surface-closure-matrix.yaml"), "utf8");
  const dashboard = readFileSync(resolve(root, ".product-experience/closure-dashboard.yaml"), "utf8");
  const decisionLog = readFileSync(resolve(root, ".product-experience/decision-log.md"), "utf8");

  assert.match(acceptance, /14 of 146 UI actions have exact proposed operation refs, zero are ambiguous, and 132 remain unresolved/u);
  assert.match(acceptance, /17 proposed family refs and 26 unresolved identities/u);
  assert.match(gap, /14 exact proposed\s+operation refs and 132 unresolved; none is ambiguous/u);
  assert.match(gap, /PDP1 proposes 17 family links and\s+leaves 26 unresolved/u);
  assert.match(gap, /Resolve the 132 unmatched UI action links; bind the 27 HTTP IDs and 26\s+gRPC identities/u);
  assert.match(closureMatrix, /14 exact proposed operation refs, zero ambiguous links, and 132 unresolved/u);
  assert.match(closureMatrix, /17 proposed family refs and 26 unresolved identities/u);
  assert.match(dashboard, /^observationDate: '2026-10-08'$/mu);
  assert.match(dashboard, /- id: domain-objects\n      target: all-applicable\n      observed: 38/u);
  assert.match(dashboard, /- id: logical-operations\n      target: all-applicable\n      observed: 14/u);
  assert.match(dashboard, /- id: templates\n      target: all-applicable\n      observed: 13/u);
  assert.match(dashboard, /- id: layouts\n      target: all-applicable\n      observed: 11/u);
  assert.match(decisionLog, /2026-10-08 source-status update:[\s\S]*?Fourteen of 146 UI actions[\s\S]*?17 proposed\s+family refs and 26 unresolved identities/u);
  assert.match(acceptance, /These source links remain proposals; no operation semantics, mappings, runtime reachability, or wire behavior are accepted/u);
});

test("PDP1 event inventory preserves lifecycle and local-client populations without inventing contracts", () => {
  const events = readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/events.yaml"), "utf8");
  const evidence = readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/evidence.yaml"), "utf8");
  const provenance = readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/provenance.yaml"), "utf8");
  const operations = readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/operations.yaml"), "utf8");
  const runtimeSource = readFileSync(resolve(root, "launcher/src/main/java/com/ghatana/media/launcher/MediaRuntime.java"), "utf8");
  const clientSource = readFileSync(resolve(root, "libs/audio-video-client/src/index.ts"), "utf8");
  const clientRegistry = readFileSync(resolve(root, ".product-experience/pdp-3-product-experience/events/event-registry.yaml"), "utf8");
  const lifecycleTypes = [
    "media.upload.started", "media.artifact.completed", "media.job.accepted", "media.job.cancelled",
    "media.job.cancel_requested", "media.stream.opened", "media.stream.closed", "media.job.completed", "media.job.failed",
  ];
  assert.match(events, /^    publisherCallSites: 7\n    concreteEventTypes: 9$/mu);
  assert.match(events, /classification: source-observed-implementation-inventory; not-canonical-taxonomy/u);
  for (const eventType of lifecycleTypes) assert.ok(events.includes(`eventType: ${eventType}`), `missing lifecycle type ${eventType}`);
  assert.equal([...runtimeSource.matchAll(/publishLifecycle\(/gu)].length - 1, 7, "runtime must retain seven call sites plus the method declaration");
  assert.match(runtimeSource, /"media\.job\." \+ terminal\.status\(\)\.name\(\)\.toLowerCase/u);
  assert.match(runtimeSource, /JobStatus\.COMPLETED/u);
  assert.match(runtimeSource, /JobStatus\.FAILED/u);
  assert.match(events, /MediaRuntime#publishLifecycle constructs dynamic media\.job\.<status>/u);
  assert.match(events, /canonicalTaxonomy: unresolved/u);

  const clientNames = [...clientRegistry.matchAll(/^    eventName: "([^"]+)"$/gmu)].map(([, name]) => name);
  assert.equal(clientNames.length, 15);
  assert.equal(new Set(clientNames).size, 15);
  for (const name of clientNames) {
    assert.ok(events.includes(`"${name}"`), `missing distinct client notification ${name}`);
    assert.ok(clientSource.includes(`'${name}'`), `client source no longer emits ${name}`);
  }
  assert.match(events, /^    count: 15$/mu);
  assert.match(events, /delivery: local-client-listener-bus; durable-Event-Plane-publication-not-established/u);
  assert.match(events, /relationToLifecyclePublisher: separate-population; not-equivalent/u);
  assert.match(operations, /15 separate local client-listener notifications[\s\S]*7 runtime publisher call sites\/9 concrete event types; populations are not equivalent/u);

  assert.match(events, /orderingGuarantee: unresolved/u);
  assert.match(events, /replayRetentionOrdering: unresolved/u);
  assert.match(events, /durable-deduplication-guarantee: unresolved/u);
  assert.match(provenance, /orderingAndClockAuthority: unresolved/u);
  assert.match(provenance, /durable-deduplication-unverified/u);
  const eventTypesFrom = (text, sectionStart, sectionEnd) => {
    const start = text.indexOf(sectionStart);
    assert.notEqual(start, -1, `missing section ${sectionStart}`);
    const end = sectionEnd ? text.indexOf(sectionEnd, start) : text.length;
    assert.notEqual(end, -1, `missing section boundary ${sectionEnd}`);
    return [...text.slice(start, end).matchAll(/^\s*- (?:eventType: (media\.[^\s]+)|\{eventType: (media\.[^,}]+),)/gmu)]
      .map(([, blockType, inlineType]) => blockType ?? inlineType);
  };
  const evidenceEventTypes = eventTypesFrom(evidence, "  eventBindings:\n", "evidenceClasses:");
  const provenanceEventTypes = eventTypesFrom(provenance, "  eventBindings:\n");
  const proposalEventTypes = eventTypesFrom(events, "    evidenceProvenanceProposals:\n", "  clientNotificationInventory:");
  assert.deepEqual(evidenceEventTypes, lifecycleTypes, "evidence proposals must cover each observed lifecycle type exactly once, in source inventory order");
  assert.deepEqual(provenanceEventTypes, lifecycleTypes, "provenance proposals must cover each observed lifecycle type exactly once, in source inventory order");
  assert.deepEqual(proposalEventTypes, lifecycleTypes, "event-level proposals must cover each observed lifecycle type exactly once");
  assert.equal(new Set(evidenceEventTypes).size, 9);
  assert.equal(new Set(provenanceEventTypes).size, 9);
  assert.equal(new Set(proposalEventTypes).size, 9);
  const expectedSourceRefs = [
    ["media.upload.started", "MediaRuntime.java#L264-L268", "UploadSession", "session.uploadId", "literal-1"],
    ["media.artifact.completed", "MediaRuntime.java#L300-L306", "MediaArtifact", "artifact.artifactId", "literal-1"],
    ["media.job.accepted", "MediaRuntime.java#L382-L388", "ProcessingJob", "accepted.jobId", "accepted.version"],
    ["media.job.cancelled", "MediaRuntime.java#L448-L484", "ProcessingJob", "current.jobId", "stored.version"],
    ["media.job.cancel_requested", "MediaRuntime.java#L448-L484", "ProcessingJob", "current.jobId", "stored.version"],
    ["media.stream.opened", "MediaRuntime.java#L510-L514", "StreamSession", "sessionId", "session.version"],
    ["media.stream.closed", "MediaRuntime.java#L650-L656", "StreamSession", "sessionId", "closed.version"],
    ["media.job.completed", "MediaRuntime.java#L1189-L1196", "ProcessingJob", "value.jobId", "terminal.version"],
    ["media.job.failed", "MediaRuntime.java#L1189-L1196", "ProcessingJob", "value.jobId", "terminal.version"],
  ];
  const proposalStart = events.indexOf("    evidenceProvenanceProposals:\n");
  const proposalEnd = events.indexOf("  clientNotificationInventory:\n", proposalStart);
  const proposalSection = events.slice(proposalStart, proposalEnd);
  for (const [type, sourceRef, domainRecord, aggregateIdentity, aggregateVersion] of expectedSourceRefs) {
    const rowStart = proposalSection.indexOf(`eventType: ${type}`);
    assert.notEqual(rowStart, -1, `missing event proposal ${type}`);
    const nextRow = proposalSection.indexOf("\n        - eventType:", rowStart + 1);
    const row = proposalSection.slice(rowStart, nextRow === -1 ? undefined : nextRow);
    assert.ok(row.includes(sourceRef), `${type} proposal lacks its exact runtime call-site`);
    assert.ok(row.includes(aggregateIdentity), `${type} proposal lacks aggregate identity mapping`);
    assert.ok(row.includes(aggregateVersion), `${type} proposal lacks aggregate version mapping`);
    assert.ok(row.includes("evidenceStatus:"), `${type} proposal lacks evidence status`);
    const evidenceRow = evidence.slice(evidence.indexOf(`eventType: ${type}`));
    assert.ok(evidenceRow.slice(0, evidenceRow.indexOf("\n") < 0 ? undefined : evidenceRow.indexOf("\n")).includes(sourceRef));
    assert.ok(evidenceRow.includes(domainRecord), `${type} evidence candidate must link the source-domain record`);
    const provenanceRow = provenance.slice(provenance.indexOf(`eventType: ${type}`));
    assert.ok(provenanceRow.slice(0, provenanceRow.indexOf("\n") < 0 ? undefined : provenanceRow.indexOf("\n")).includes(sourceRef));
    assert.ok(provenanceRow.includes(domainRecord), `${type} provenance candidate must link the source-domain record`);
  }
  for (const type of lifecycleTypes) {
    for (const [registry, label] of [[events, "events"], [evidence, "evidence"], [provenance, "provenance"]]) {
      assert.ok(registry.includes(type), `${label} missing ${type}`);
      assert.match(registry, /source-observation-candidate-only|source-observation-only|source observation, not committed evidence/u, `${label} must classify ${type} as candidate evidence`);
      assert.match(registry, /pending-owner-review/u, `${label} must keep policy semantics pending`);
    }
  }
  assert.match(events, /authoritative-finality-evidence, durable-delivery-receipt, committed-event-evidence/u);
  assert.match(evidence, /authoritative-finality, durable-delivery-receipt, committed-event-record/u);
  assert.match(provenance, /canonical-domain-identity, immutable-version-identity/u);
  assert.match(provenance, /eventIdentity: \{observed: "media:<eventType>:<aggregateId>:<aggregateVersion>"/u);
  assert.match(events, /semanticPiiRedactionAndEventSpecificMinimization: unresolved/u);
  assert.match(events, /compatibility-schema-and-evolution-policy: unresolved/u);
  assert.match(events, /outbox-retry-replay-and-recovery-contract: not-established/u);
  assert.match(events, /CrossModalEvent\.event_type[\s\S]*message-content-examples-not-lifecycle-publication/u);
  assert.match(events, /test-payload-strings-not-production-publication/u);
});

test("PDP1-005 registries preserve observed facts, proposal boundaries, and owner gates", () => {
  const registryRoot = resolve(root, ".product-experience/pdp-1-domain-data");
  const readRegistry = (name) => readFileSync(resolve(registryRoot, name), "utf8");
  const versioning = readRegistry("versioning.yaml");
  const privacy = readRegistry("privacy.yaml");
  const offlineSync = readRegistry("offline-sync.yaml");
  const interoperability = readRegistry("interoperability.yaml");
  const authority = readRegistry("authority.yaml");
  const decisions = readRegistry("decisions.yaml");
  const domainModel = readRegistry("DOMAIN-MODEL.md");

  for (const [name, content] of Object.entries({ versioning, privacy, offlineSync, interoperability, authority, decisions })) {
    assert.match(content, /^schemaVersion: media\.pdp-1\./mu, `${name} must be a PDP-1 registry`);
  }

  assert.match(versioning, /sourceRefs:.*launcher\/src\/main\/java\/com\/ghatana\/media\/launcher\/MediaRuntime\.java/u);
  assert.match(versioning, /sourceRefs:.*modules\/infrastructure\/persistence\/src\/main\/resources\/db\/migration\/V1__init_schema\.sql/u);
  assert.match(versioning, /source-artifact-immutability[\s\S]*?status: unresolved;/u);
  assert.match(versioning, /derived-artifact-identity[\s\S]*?status: unresolved;/u);
  assert.match(versioning, /checksum-and-sourceArtifactIds-fields; neither-proves-immutable-source-bytes-canonical-version-identity-or-complete-ancestry/u);
  assert.match(versioning, /run-and-attempt-history[\s\S]*?do-not-claim-durable-attempt-history/u);
  assert.match(versioning, /job-version-and-lease-fencing-do-not-establish-durable-attempt-history/u);
  assert.match(versioning, /startup-handler-marks-recoverable-persisted-nonterminal-jobs-OUTCOME_UNKNOWN-without-failure-code-or-completion-timestamp; this-is-not-outcome-reconciliation/u);
  assert.match(versioning, /cancellation-uncertainty-is-represented-but-resolution-and-finality-semantics-remain-unaccepted/u);
  assert.match(versioning, /canonical-version-reference-and-consumer-contract-pending/u);

  assert.match(privacy, /consentModel:\n  status: proposal-only;/u);
  assert.match(privacy, /atomic-revocation-propagation-to-in-flight-jobs-stream-frames-caches-and-delegated-provider-work/u);
  assert.match(privacy, /bounded-purge-cycle-accepts-a-clock-instant-and-returns-deletion-counts/u);
  assert.match(privacy, /complete-inventory-of-primary-replica-backup-cache-export-and-provider-held-copies/u);
  assert.match(privacy, /deletion-from-provider-systems-or-proof-of-provider-side-erasure/u);
  assert.match(authority, /purge-counts-or-runtime-readiness-are-not-proof/u);

  assert.match(offlineSync, /durableLocalQueue: not-established/u);
  assert.match(offlineSync, /safeReplay: not-established/u);
  assert.match(offlineSync, /conflictAndConcurrentEditPolicy: pending-owner-definition/u);
  assert.match(offlineSync, /providerOutcomeReconciliation: not-established/u);
  assert.match(offlineSync, /jobVersionIsNotArtifactVersionOrAttemptHistory: true/u);

  assert.match(interoperability, /job-version-does-not-establish-durable-attempt-history-or-artifact-version-identity/u);
  assert.match(interoperability, /cross-product/u);
  assert.match(versioning, /cross-boundary-references[\s\S]*?canonical-version-reference-and-consumer-contract-pending/u);

  assert.match(authority, /^proposalStatus: proposal-only;/mu);
  assert.match(authority, /deployed-identity-and-delegation-provider-binding-not-established/u);
  assert.match(authority, /storage-and-provider-owners-own-deletion-mechanics-and-evidence/u);
  assert.match(decisions, /Media-domain-owner-definition-of-version-key-lineage-and-cross-product-reference/u);
  assert.match(decisions, /independent-P0-010-acceptance/u);
  assert.match(decisions, /offline-sync-and-runtime-owners-define-conflict-authority/u);

  assert.match(domainModel, /An unaccepted PDP-0 lifecycle proposal separates authored specifications,[\s\S]*?proposed artifact versions/u);
  assert.match(domainModel, /does not establish canonical artifact-version identity/u);
});

test("PDP1 state and transition extraction remains proposal-only and preserves unresolved source conflicts", () => {
  const states = readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/states.yaml"), "utf8");
  const transitions = readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/transitions.yaml"), "utf8");
  const source = readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/state-models.yaml"), "utf8");
  const domainModel = readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/DOMAIN-MODEL.md"), "utf8");

  assert.match(states, /^authorityStatus: proposal-only; owner-review-pending; P0-010-independent-acceptance-pending$/mu);
  assert.match(states, /^  sourceMachineRecords: 11\n  extractedMachineRecords: 11\n  sourceStateRecords: 75\n  extractedStateRecords: 75$/mu);
  assert.equal([...states.matchAll(/^  - machineId: /gmu)].length, 11);
  assert.equal([...source.matchAll(/^- modelId: /gmu)].length, 11);
  assert.match(states, /machineId: media-rights-and-consent[\s\S]*?stateIds: \[\]\n    stateCount: 0/u);

  for (const id of ["RETRY_PENDING", "RETRYING", "CANCEL_REQUESTED", "CANCELLING", "OUTCOME_UNKNOWN", "RECONCILING", "PARTIALLY_SUCCEEDED"]) {
    assert.ok(states.includes(id), `missing unresolved state spelling ${id}`);
  }
  for (const conflictId of [
    "state-conflict.retry-pending-vs-retrying",
    "state-conflict.cancel-requested-vs-cancelling",
    "state-conflict.unknown-reconciling-partial-outcomes",
  ]) assert.ok(states.includes(conflictId), `missing conflict record ${conflictId}`);
  assert.match(states, /mappingDisposition: unresolved/u);
  assert.match(states, /lossy-implementation-observed/u);
  assert.match(states, /^    proposals: \[\]$/mu);
  assert.match(states, /values: \[CREATED, QUEUED, PROCESSING, RETRY_PENDING, OUTCOME_UNKNOWN, RECONCILING, COMPLETED, FAILED, CANCELLED, RETRYING\]/u);
  assert.match(states, /values: \[QUEUED, RUNNING, RETRY_PENDING, OUTCOME_UNKNOWN, RECONCILING, COMPLETED, PARTIALLY_SUCCEEDED, FAILED, CANCELLED\]/u);
  assert.match(states, /values: \[ACCEPTED, QUEUED, RUNNING, SUCCEEDED, FAILED, CANCELLED\]/u);
  assert.match(states, /no matching job-lifecycle state enum was found in the four inspected active Media service proto files/u);
  assert.match(states, /^  projectionRule: React, TypeScript, OpenAPI, protobuf, Java, and runtime projections do not independently define product state$/mu);

  assert.match(transitions, /^authorityStatus: proposal-only; owner-review-pending; P0-010-independent-acceptance-pending$/mu);
  assert.match(transitions, /^  sourceMachineRecords: 11\n  transitionRecords: 49$/mu);
  assert.equal([...transitions.matchAll(/^  - id: [^\n]+\/T\d+$/gmu)].length, 49);
  assert.match(transitions, /media\.operation\.job-lifecycle/u);
  assert.match(transitions, /operationBinding: proposed-unresolved/u);
  assert.match(transitions, /eventTriggers: pending-PDP1-004/u);
  assert.match(transitions, /permissions: pending-owner-contracts/u);
  assert.match(transitions, /executionEffects: pending-runtime-and-platform-owner-contracts/u);
  assert.match(transitions, /id: media-job\/T03\n    sourceMachineId: media-job\n    sourceTransitionIndex: 3\n    from: \[RETRY_PENDING\]\n    to: \[RUNNING, CANCELLED, FAILED, OUTCOME_UNKNOWN\]/u);
  assert.match(transitions, /id: media-attempt\/T05\n    sourceMachineId: media-attempt\n    sourceTransitionIndex: 5\n    from: \[CANCEL_REQUESTED\]\n    to: \[CANCEL_CONFIRMED, SUCCEEDED, FAILED, OUTCOME_UNKNOWN, SUPERSEDED\]/u);
  assert.match(domainModel, /PDP1-003 state\/transition extraction verification/u);
  assert.match(domainModel.replace(/\s+/gu, " "), /it does not verify runtime behavior, select a canonical projection, accept meanings, or establish phase completion/u);
});

test("PDP-1 negative state cases encode owner-approved non-equivalences without claiming runtime proof", () => {
  const adjudication = readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/state-adjudication.yaml"), "utf8");
  assert.match(adjudication, /^  status: canonical-policy-tests; does-not-verify-runtime-or-provider-behavior$/mu);
  for (const [caseId, forbidden] of [
    ["state-identity.same-spelling-different-machine", "infer-state-equivalence"],
    ["ingress.ACCEPTED-is-not-job.QUEUED", "assert-durable-queue-eligibility"],
    ["retry.RETRY_PENDING-is-not-attempt-execution", "assert-new-attempt-claimed-or-dispatched"],
    ["cancellation.CANCEL_REQUESTED-is-not-CANCELLED", "assert-job-cancellation-finality"],
    ["finality.OUTCOME_UNKNOWN-is-not-RUNNING", "normalize-to-RUNNING-or-authorize-replay"],
    ["finality.PARTIALLY_SUCCEEDED-requires-closed-sub-effects", "assert-terminal-partial-success"],
    ["delivery.COMPLETED-is-not-ACKNOWLEDGED", "assert-recipient-delivery-acknowledgment"],
  ]) {
    const escaped = caseId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(adjudication, new RegExp(`- id: ${escaped}[\\s\\S]*?mustNot: ${forbidden}`, "u"));
  }
});

test("PDP-0 YAML source preserves corrected indentation and symbol-scoped OCR disposition (text checks only)", () => {
  const capabilities = readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/capabilities.yaml"), "utf8");
  const requirements = readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/requirements.yaml"), "utf8");
  const ocr = readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/ocr-ownership.yaml"), "utf8");
  assert.match(capabilities, /^families:\n- id: media\.project\n  scopeStatus: TARGET$/mu);
  assert.match(requirements, /^requirements:\n- id: MEDIA-REQ-CAP-PROJECT\n  scopeStatus: TARGET$/mu);

  for (const [recordId, method, excludedMethods] of [
    ["media.ocr.vision-model-engine", "VisionModelEngine.extractText", [
      "VisionModelEngine.detectObjects",
      "VisionModelEngine.classify",
      "VisionModelEngine.detectFaces",
    ]],
    ["media.ocr.vision-detector-contract", "VisionDetector.extractText", [
      "VisionDetector.detectObjects",
      "VisionDetector.classify",
      "VisionDetector.detectFaces",
    ]],
  ]) {
    const start = ocr.indexOf(`  - id: ${recordId}\n`);
    assert.notEqual(start, -1, `missing OCR classification ${recordId}`);
    const tail = ocr.slice(start);
    const nextRecord = tail.slice(1).search(/^  - id: /mu);
    const record = nextRecord < 0 ? tail : tail.slice(0, nextRecord + 1);
    assert.match(record, /^    scope: symbol$/mu);
    assert.ok(record.includes(`    symbol: ${method}\n`));
    assert.match(record, /outside this OCR disposition and remain governed by their owning vision definitions/u);
    for (const excludedMethod of excludedMethods) assert.ok(record.includes(`      - ${excludedMethod}\n`));
  }
});

test("scope-status validation never infers compatibility from nearby wording", () => {
  const path = ".product-experience/pdp-0-product-truth/capabilities.yaml";
  const missing = "- id: media.compatibility\n  description: compatibility is supported\n";
  assert.throws(() => validateScopeStatuses(missing, path), /missing explicit scopeStatus/u);

  const explicitTarget = "- id: media.compatibility\n  scopeStatus: TARGET\n  description: compatibility is supported\n";
  assert.equal(validateScopeStatuses(explicitTarget, path), explicitTarget);
});

test("nested journey records each require exactly one allowed scopeStatus", () => {
  const path = ".product-experience/pdp-0-product-truth/journey-catalog.yaml";
  const validJourney = "journeys:\n  - id: J-01\n    scopeStatus: TARGET\n    title: Example\n";
  assert.equal(validateScopeStatuses(validJourney, path), validJourney);

  const missingJourney = "journeys:\n  - id: J-01\n    title: Example\n";
  assert.throws(() => validateScopeStatuses(missingJourney, path), /missing explicit scopeStatus.*J-01/u);

  const duplicateJourney = `${validJourney.trimEnd()}\n    scopeStatus: TARGET\n`;
  assert.throws(() => validateScopeStatuses(duplicateJourney, path), /duplicate scopeStatus.*J-01/u);

  const invalidJourney = validJourney.replace("TARGET", "SUPPORTED");
  assert.throws(() => validateScopeStatuses(invalidJourney, path), /invalid scopeStatus SUPPORTED.*J-01/u);
  assert.throws(() => validateScopeStatuses(validJourney, path, undefined, 30), /found 1 records; expected 30/u);
});

test("Explorer index exposes source paths without workstation identity", () => {
  const index = JSON.parse(readFileSync(resolve(root, "apps/media-experience-explorer/specification-artifacts.json"), "utf8"));
  assert.equal(index.filter((artifact) => artifact.phase === "PDP-3" && artifact.path.includes("/screen-contracts/")).length, 48);
  assert.ok(index.some((artifact) => artifact.path === ".product-experience/source-manifest.yaml"));
  assert.equal(index.some((artifact) => artifact.path.startsWith("/")), false);
});

test("generated Explorer index covers every current source-manifest artifact exactly once", () => {
  const manifest = readFileSync(resolve(root, ".product-experience/source-manifest.yaml"), "utf8");
  const index = JSON.parse(readFileSync(resolve(root, "apps/media-experience-explorer/specification-artifacts.json"), "utf8"));
  const gaps = readFileSync(resolve(root, ".product-experience/gaps.yaml"), "utf8");
  const sourceRecords = [...manifest.matchAll(/^  - artifactId: ([^\s]+)\n(?:.*\n){0,20}?    owningPhase: ([^\n]+)\n    path: ([^\n]+)$/gmu)]
    .map(([, artifactId, phase, path]) => ({ artifactId, phase: phase.trim(), path: path.trim() }));
  const indexedSourceRecords = index.filter((artifact) => artifact.path !== ".product-experience/source-manifest.yaml");
  const byPath = new Map(indexedSourceRecords.map((artifact) => [artifact.path, artifact]));

  assert.equal(byPath.size, indexedSourceRecords.length, "each canonical source path must occur once");
  assert.deepEqual([...byPath.keys()].sort(), sourceRecords.map(({ path }) => path).sort(), "index paths must exactly match generated source-manifest paths");
  assert.equal(index.length, sourceRecords.length + 1, "Explorer index must include each source artifact plus its manifest projection");
  assert.ok(gaps.includes(`${sourceRecords.length} source-derived records plus the manifest projection (${index.length} total)`),
    "active Explorer gap mirrors must report the current source and index denominators");
  for (const record of sourceRecords) {
    assert.deepEqual(
      { artifactId: byPath.get(record.path)?.artifactId, phase: byPath.get(record.path)?.phase },
      { artifactId: record.artifactId, phase: record.phase },
      `${record.path} must retain its canonical identity and owner phase in Explorer navigation`,
    );
  }

  const sourcePaths = [];
  const visit = (directory) => {
    for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (path !== ".product-experience/source-manifest.yaml" && path !== ".product-experience/artifact-identities.yaml") sourcePaths.push(path);
    }
  };
  visit(".product-experience");
  assert.deepEqual(sourceRecords.map(({ path }) => path).sort(), sourcePaths.sort(), "manifest inventory must expose every active source file");
});

test("HTTP route, SDK, and interface projections retain canonical ownership", () => {
  const result = spawnSync(process.execPath, ["scripts/check-media-contract-parity.mjs"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /Media contract parity: NON-GREEN/u);
  assert.match(output, /"openapiRoutes":27,"runtimeRoutes":27,"httpRegistryRoutes":27/u);
  assert.match(output, /semantic binding: UNRESOLVED/u);
  assert.match(output, /source findings audited: 46 \(44 dispositioned; 2 unresolved\)/u);
  assert.match(output, /source-dispositioned findings: 44/u);
  assert.match(output, /historical source findings: 51 \(49 dispositioned; 2 unresolved; 5 retired routes\)/u);
});

test("screen composition records retain Shared-boundary design metadata", () => {
  const result = spawnSync(process.execPath, ["scripts/check-media-design-conformance.mjs"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /Media design conformance BLOCKED/u);
  assert.match(output, /\d+ unexplained findings across \d+ root causes/u);
  assert.match(output, /design-governance gate shared-artifact-binding remains EXTERNAL_PENDING/u);
  assert.match(output, /design-governance gate conformance-and-specialist-review remains INDEPENDENT_PENDING/u);
  assert.match(output, /design-governance gate concrete-component-bindings remains SOURCE_INCOMPLETE/u);
});

test("PDP2-002 GUI pattern registry covers every required category without inventing destructive semantics", () => {
  const guiRoot = resolve(root, ".product-experience/pdp-2-design-interface-system/gui");
  const catalog = readFileSync(resolve(guiRoot, "patterns/catalog.yaml"), "utf8");
  const templates = readFileSync(resolve(guiRoot, "templates/catalog.yaml"), "utf8");
  const requiredPatternIds = [
    "media.gui.pattern.project-browser",
    "media.gui.pattern.upload-and-verification",
    "media.gui.pattern.job-status-and-recovery",
    "media.gui.pattern.review-approval",
    "media.gui.pattern.source-picker",
    "media.gui.pattern.transcript-and-playback",
    "media.gui.pattern.caption-editor",
    "media.gui.pattern.version-comparison",
    "media.gui.pattern.provenance-and-lineage",
    "media.gui.pattern.rights-and-consent-review",
    "media.gui.pattern.rendering",
    "media.gui.pattern.safe-confirmation-and-unknown-outcome",
    "media.gui.pattern.intent-launcher",
    "media.gui.pattern.activity-attention",
    "media.gui.pattern.destructive-lifecycle-action",
  ];
  const listedPatternIds = [...catalog.matchAll(/^  - id: (media\.gui\.pattern\.[a-z0-9-]+)$/gmu)].map((match) => match[1]);
  assert.equal(new Set(listedPatternIds).size, listedPatternIds.length, "pattern IDs must be unique");
  for (const id of requiredPatternIds) assert.ok(listedPatternIds.includes(id), `missing required pattern ${id}`);
  const templateIds = new Set([...templates.matchAll(/^  - id: (media\.gui\.template\.[a-z0-9-]+)$/gmu)].map((match) => match[1]));

  for (const id of [
    "activity-attention",
    "review-approval",
    "rendering",
    "destructive-lifecycle-action",
  ]) {
    const proposal = readFileSync(resolve(guiRoot, "patterns", `${id}.yaml`), "utf8");
    assert.match(proposal, /^schemaVersion: media\.gui-pattern\.v1$/mu, id);
    assert.match(proposal, /^id: media\.gui\.pattern\./mu, id);
    assert.match(proposal, /^sourceRefs:/mu, id);
    assert.ok(catalog.includes(`sourceRef: .product-experience/pdp-2-design-interface-system/gui/patterns/${id}.yaml#media.gui.pattern.${id}`), id);
  }

  for (const id of [
    "media.gui.pattern.activity-attention",
    "media.gui.pattern.review-approval",
    "media.gui.pattern.rendering",
    "media.gui.pattern.destructive-lifecycle-action",
  ]) assert.ok(templates.includes(id), `no template references ${id}`);

  const reviewOutputs = readFileSync(resolve(root, ".product-experience/pdp-3-product-experience/screen-contracts/review-outputs.yaml"), "utf8");
  const prepareRender = readFileSync(resolve(root, ".product-experience/pdp-3-product-experience/screen-contracts/prepare-render.yaml"), "utf8");
  const reviewActivity = readFileSync(resolve(root, ".product-experience/pdp-3-product-experience/screen-contracts/review-activity.yaml"), "utf8");
  assert.ok(reviewOutputs.includes("media.gui.pattern.review-approval"));
  assert.ok(prepareRender.includes("media.gui.pattern.rendering"));
  assert.ok(reviewActivity.includes("media.gui.pattern.activity-attention"));
  for (const [screen, content] of [["review-outputs", reviewOutputs], ["prepare-render", prepareRender], ["review-activity", reviewActivity]]) {
    const templateRef = content.match(/^  templateRef: (\S+)$/mu)?.[1];
    assert.ok(templateRef && templateIds.has(templateRef), `${screen} templateRef must resolve in the PDP-2 GUI template catalog`);
  }

  const destructive = readFileSync(resolve(guiRoot, "patterns/destructive-lifecycle-action.yaml"), "utf8");
  assert.match(destructive, /No supported artifact-deletion action or operation is established/u);
  assert.match(destructive, /media\.action\.remove-storyboard-scene is a scene-editing action/u);
  assert.match(destructive, /media\.action\.revoke-authorized-consent/u);
  assert.match(destructive, /^status: proposal; operation semantics, owner bindings, accessibility, and implementation pending$/mu);
});

test("PDP2-004/005 interface registries are complete proposals with owner and runtime boundaries explicit", () => {
  const designRoot = resolve(root, ".product-experience/pdp-2-design-interface-system");
  const apiNames = [
    "conventions", "errors", "auth", "identifiers", "pagination", "filtering-sorting", "idempotency",
    "concurrency", "async-operations", "cancellation", "retry-timeout-unknown-outcome", "correlation",
    "compatibility", "versioning",
  ];
  const apiFiles = new Map(apiNames.map((name) => [name, readFileSync(resolve(designRoot, `api/${name}.yaml`), "utf8")]));
  const apiConventions = apiFiles.get("conventions");
  assert.match(apiConventions, /scopeStatus: proposal-only/u);
  assert.match(apiConventions, /OpenAPI is a transport\/schema projection of approved rules and operation bindings/u);
  assert.match(apiConventions, /not an independent source of product semantics/u);
  assert.match(apiFiles.get("async-operations"), /this proposal establishes no durable storage or retention guarantee/u);
  assert.match(apiFiles.get("idempotency"), /state the implemented retention only after runtime binding/u);

  // Keep the API convention index closed over the actual protocol files, while
  // preserving the proposal boundary until operation owners accept bindings.
  const related = apiConventions.match(/^relatedConventions: \[(.*)\]$/mu)?.[1]
    .split(", ").map((name) => name.replace(/\.yaml$/u, ""));
  assert.deepEqual(related, apiNames.slice(1), "API convention index must resolve every convention exactly once");
  for (const [name, content] of apiFiles) {
    assert.match(content, /^owner: [^\n]+$/mu, `${name} must identify its semantic owner`);
    assert.match(content, /^scopeStatus: proposal(?:-only)?(?:;|$)/mu, `${name} must remain visibly proposed`);
    assert.match(content, /^acceptance: \{criteria: \[[^\]]+\], status: pending[^}]*\}$/mu, `${name} must retain pending owner acceptance`);
    for (const ref of content.matchAll(/^sourceRefs: \[([^\]]*)\]$/gmu)) {
      for (const item of ref[1].split(", ")) {
        if (item.startsWith(".product-experience/pdp-2-design-interface-system/api/")) {
          const target = item.slice(".product-experience/pdp-2-design-interface-system/api/".length).replace(/\.yaml$/u, "");
          assert.ok(apiFiles.has(target), `${name} references missing API convention ${target}`);
        }
      }
    }
  }

  const cli = readFileSync(resolve(designRoot, "cli/conventions.yaml"), "utf8");
  const sdk = readFileSync(resolve(designRoot, "sdk/conventions.yaml"), "utf8");
  const events = readFileSync(resolve(designRoot, "events/conventions.yaml"), "utf8");
  const agentTools = readFileSync(resolve(designRoot, "agent-tools/conventions.yaml"), "utf8");
  assert.match(cli, /production-runtime-cli-not-connected/u);
  assert.match(cli, /process exit status reports the CLI invocation\/observation result; domain state and effect finality are separate/u);
  assert.match(sdk, /canonical mapping is unresolved/u);
  assert.match(events, /runtimeLifecyclePublishers:[\s\S]*?count: 9[\s\S]*?clientLocalNotifications:[\s\S]*?count: 15/u);
  assert.match(events, /not Event Plane publication or runtime lifecycle event taxonomy/u);
  assert.match(events, /scopeStatus: proposal; conventions below are design constraints, not an accepted event contract/u);
  assert.match(events, /exactly-once-or-at-least-once-delivery/u);

  const requiredToolFields = [
    "canonicalToolId", "inputSchema", "resultSchema", "authorityAndDelegation", "idempotency",
    "timeout", "cancellation", "unknownOutcome", "evidence", "safeFailure",
  ];
  const inventory = agentTools.split("observedHandlerInventory:")[1]?.split("\nadmissionGates:")[0];
  assert.ok(inventory, "missing observed handler inventory");
  const toolRecords = inventory.split(/\n    - canonicalToolId: /u).slice(1);
  assert.equal(toolRecords.length, 4, "expected four observed handlers, not admitted tools");
  for (const field of requiredToolFields) assert.match(agentTools, new RegExp(`^    ${field}:$`, "mu"), `missing per-tool field ${field}`);
  for (const record of toolRecords) {
    for (const field of requiredToolFields.slice(1)) assert.ok(record.includes(`      ${field}:`), `observed handler missing ${field}`);
  }
  assert.match(agentTools, /After dispatch, a timeout or cancellation race returns outcome-unknown/u);
  assert.match(agentTools, /no tool is admitted, callable, or authorized by this convention/u);
});
