const ALLOWED_DISPOSITIONS = new Set([
  "SOURCE_DERIVED_TRANSFORMATION",
  "ESTIMATED_OR_RECONSTRUCTED",
  "ESTIMATED_OR_INFERRED_OBSERVATION",
  "NO_RECONSTRUCTION_OR_INFERENCE",
  "UNRESOLVED_EXACT_OUTPUT_SEMANTICS",
]);
const EPISTEMIC_ROLES = new Set([
  "OWNER_STATE_OR_REFERENCE",
  "CALLER_PLAN_NOT_STATE",
  "POLICY_DECISION_RECORD_NOT_GRANT",
  "READINESS_OBSERVATION_NOT_ADMISSION",
  "VERSIONED_DEFINITION_NOT_EXECUTION",
  "DEFINITION_NOT_MEDIA_CONTENT",
  "OWNER_RECORDED_CHANGE_NOT_MEDIA_CONTENT",
  "MEASUREMENT_RECORD_NOT_TRANSFORMED_MEDIA",
]);
const INTENT_AUTHORED_ANIMATION_DEFINITIONS = new Set([
  "media.animation.2d", "media.animation.vector", "media.animation.3d", "media.animation.keyframe",
  "media.animation.interpolation-easing", "media.animation.procedural", "media.animation.path",
  "media.animation.skeletal", "media.animation.inverse-kinematics", "media.animation.constraint",
  "media.animation.morph-target", "media.animation.camera", "media.animation.material", "media.animation.light",
  "media.animation.particle", "media.animation.drive.physics", "media.animation.drive.audio",
  "media.animation.drive.speech", "media.animation.drive.pose", "media.animation.facial-expression",
  "media.animation.gaze", "media.animation.lip", "media.animation.motion.retarget", "media.animation.character",
]);

function resolveSelector(documents, selector) {
  const separator = selector.indexOf("#");
  if (separator < 0) return undefined;
  const file = selector.slice(0, separator);
  const path = selector.slice(separator + 1);
  let value = documents[file];
  if (!value || !path) return undefined;
  for (const segment of path.split("/")) {
    if (!segment) return undefined;
    const idMatch = /^@(id|machineId|capabilityRef)=([^/]+)$/u.exec(segment);
    if (idMatch) {
      if (!Array.isArray(value)) return undefined;
      value = value.find((row) => row?.[idMatch[1]] === idMatch[2]);
    } else {
      value = value?.[segment];
    }
    if (value === undefined) return undefined;
  }
  return value;
}

function sourceTypes(source) {
  if (source?.artifactType) return [source.artifactType];
  const schema = source?.schema ?? source;
  const found = new Set();
  const visit = (node, propertyPath = []) => {
    if (!node || typeof node !== "object") return;
    if (propertyPath.at(-1) === "artifactType" && typeof node.const === "string") found.add(node.const);
    for (const key of ["oneOf", "anyOf", "allOf"]) for (const child of node[key] ?? []) visit(child, propertyPath);
    for (const [key, child] of Object.entries(node.properties ?? {})) visit(child, [...propertyPath, key]);
    if (node.items) visit(node.items, [...propertyPath, "*"]);
  };
  visit(schema);
  return [...found];
}

function selectorValues(schema, selector) {
  const match = /^\$\.(.+)$/u.exec(selector);
  if (!match) return [];
  let path = match[1].split(".").flatMap((segment) => {
    const array = /^(.*)\[\*\]$/u.exec(segment);
    return array ? [array[1], "*"] : [segment];
  });
  const root = schema?.schema ?? schema;
  // A selector names an output array row, while an exact outputPayloadSchemas
  // record describes that row directly. Drop only this documented envelope
  // prefix when the exact schema has no outputs property.
  if (!root?.properties?.outputs && path[0] === "outputs" && path[1] === "*") path = path.slice(2);
  if (path.some((segment) => !/^[A-Za-z][A-Za-z0-9]*$/u.test(segment) && segment !== "*")) return [];
  const values = new Set();
  const collect = (node) => {
    if (!node || typeof node !== "object") return;
    if (Object.hasOwn(node, "const")) values.add(node.const);
    for (const entry of node.enum ?? []) values.add(entry);
    for (const key of ["oneOf", "anyOf", "allOf"]) for (const child of node[key] ?? []) collect(child);
  };
  const visit = (node, offset = 0) => {
    if (!node || typeof node !== "object") return;
    if (offset === path.length) {
      collect(node);
      return;
    }
    const segment = path[offset];
    if (segment === "*") {
      if (node.items) visit(node.items, offset + 1);
      for (const key of ["oneOf", "anyOf", "allOf"]) for (const child of node[key] ?? []) visit(child, offset);
      return;
    }
    const child = node.properties?.[segment];
    if (child) visit(child, offset + 1);
    for (const key of ["oneOf", "anyOf", "allOf"]) for (const alternative of node[key] ?? []) visit(alternative, offset);
  };
  visit(root);
  return [...values];
}

function expect(condition, code, context, issues) {
  if (!condition) issues.push({ code, context });
}

export function validateLeafTrustReconstructionSources({ capabilities, review, operations, requirements }) {
  const issues = [];
  const documents = {
    ".product-experience/pdp-0-product-truth/capabilities.yaml": capabilities,
    ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml": review,
    ".product-experience/pdp-0-product-truth/requirements.yaml": requirements,
    ".product-experience/pdp-1-domain-data/operations.yaml": operations,
  };
  const cohort = review?.ownerTrustReconstructionDispositions;
  const policy = requirements?.ownerDefinedLeafTrustReconstructionPolicy;
  const leafRows = review?.ownerCapabilityLeafAdjudication?.records ?? [];
  const capabilityRows = capabilities?.capabilities ?? [];
  const leafByCapability = new Map(leafRows.map((row) => [row.capabilityRef, row]));
  const capabilityById = new Map(capabilityRows.map((row) => [row.id, row]));

  expect(cohort?.id === "media.pdp0.owner-trust-reconstruction-dispositions.v1", "cohort-id", "cohort", issues);
  expect(cohort?.policyRef === ".product-experience/pdp-0-product-truth/requirements.yaml#ownerDefinedLeafTrustReconstructionPolicy", "policy-ref", "cohort", issues);
  expect(cohort?.population?.capabilityCount === capabilityRows.length, "population-count", "cohort", issues);
  expect(cohort?.records?.length === capabilityRows.length, "record-count", "cohort", issues);
  expect(policy?.id === "media.requirement.leaf-trust-reconstruction-policy.v1", "policy-id", "policy", issues);
  expect(policy?.runtimeAdmission === "NOT_ADMITTED" && policy?.qualification === "NOT_EVALUATED" && policy?.acceptanceEffect === "none", "policy-boundaries", "policy", issues);

  const rows = cohort?.records ?? [];
  const ids = new Set();
  const joined = new Set();
  for (const row of rows) {
    const label = row?.capabilityRef ?? row?.id ?? "<missing>";
    expect(typeof row?.id === "string" && row.id.startsWith("media.capability-trust-reconstruction.") && row.id.endsWith(".v1"), "stable-id", label, issues);
    expect(!ids.has(row?.id), "duplicate-id", label, issues);
    ids.add(row?.id);
    expect(!joined.has(row?.capabilityRef), "duplicate-capability", label, issues);
    joined.add(row?.capabilityRef);
    expect(capabilityById.has(row?.capabilityRef), "unknown-capability", label, issues);

    const capabilityRef = row?.sourceRefs?.find((ref) => ref.startsWith(".product-experience/pdp-0-product-truth/capabilities.yaml#"));
    expect(capabilityRef === `.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=${row?.capabilityRef}`, "exact-capability-source", label, issues);
    const capability = capabilityRef && resolveSelector(documents, capabilityRef);
    expect(capability?.id === row?.capabilityRef, "capability-selector-resolves", label, issues);

    const adjudicationRef = row?.sourceRefs?.find((ref) => ref.startsWith(".product-experience/pdp-0-product-truth/capability-leaf-review.yaml#ownerCapabilityLeafAdjudication/records/"));
    const adjudication = adjudicationRef && resolveSelector(documents, adjudicationRef);
    const expectedAdjudicationRef = leafByCapability.get(row?.capabilityRef)?.id;
    expect(typeof expectedAdjudicationRef === "string" && adjudicationRef === `.product-experience/pdp-0-product-truth/capability-leaf-review.yaml#ownerCapabilityLeafAdjudication/records/@id=${expectedAdjudicationRef}`, "exact-adjudication-source", label, issues);
    expect(adjudication?.capabilityRef === row?.capabilityRef, "adjudication-selector-resolves", label, issues);
    expect(JSON.stringify(row?.exactTypedInputs) === JSON.stringify(adjudication?.exactTypedInputs), "exact-input-population", label, issues);
    expect(JSON.stringify(row?.exactTypedOutputs) === JSON.stringify(adjudication?.exactTypedOutputs), "exact-output-population", label, issues);

    const operationRef = row?.sourceRefs?.find((ref) => ref.startsWith(".product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/records/"));
    const operation = operationRef && resolveSelector(documents, operationRef);
    expect(operationRef === adjudication?.operationContractRef, "exact-operation-ref", label, issues);
    expect(operation?.id != null, "operation-selector-resolves", label, issues);
    expect(row?.sourceRefs?.includes(cohort?.policyRef), "policy-source-ref", label, issues);

    expect(row?.definitionStatus === "OWNER_DEFINED_DEFINITION_ONLY", "definition-status", label, issues);
    expect(row?.runtimeAdmission === "NOT_ADMITTED", "runtime-admission", label, issues);
    expect(row?.qualification === "NOT_EVALUATED", "qualification", label, issues);
    expect(row?.acceptanceEffect === "none", "acceptance-effect", label, issues);
    expect(typeof row?.unknownPolicy === "string" && /UNKNOWN|ABSTAINED/u.test(row.unknownPolicy), "unknown-policy", label, issues);
    expect(Array.isArray(row?.exactTypedInputs) && row.exactTypedInputs.length > 0, "inputs-present", label, issues);
    expect(Array.isArray(row?.exactTypedOutputs) && row.exactTypedOutputs.length > 0, "outputs-present", label, issues);
    expect(Array.isArray(row?.outputBranches) && row.outputBranches.length > 0, "branches-present", label, issues);

    const branchOutputs = new Set();
    const familyProfile = operation?.familyProfileRef
      ? resolveSelector(documents, `.product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/families/@id=${operation.familyProfileRef}`)
      : undefined;
    const exactOutputSchemaRefs = new Set((familyProfile?.outputTypeRefs ?? []).map((typeRef) => {
      const typeId = typeof typeRef === "string" ? typeRef.split("/").at(-1) : undefined;
      return typeId ? `.product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/outputPayloadSchemas/@id=${typeId}` : undefined;
    }).filter(Boolean));
    const exactOwnerLeafOutputSchemaRef = operation?.ownerLeafWireContractRef
      ? `.product-experience/pdp-1-domain-data/operations.yaml#ownerLeafWireContracts/records/@id=${operation.ownerLeafWireContractRef}/resultSchema`
      : undefined;
    const exactOwnerLeafOutputSchema = exactOwnerLeafOutputSchemaRef
      ? resolveSelector(documents, exactOwnerLeafOutputSchemaRef) : undefined;
    for (const branch of row?.outputBranches ?? []) {
      expect(row.exactTypedOutputs.includes(branch.outputArtifactType), "branch-is-typed-output", `${label}:${branch.outputArtifactType}`, issues);
      expect(!branchOutputs.has(branch.outputArtifactType), "duplicate-output-branch", `${label}:${branch.outputArtifactType}`, issues);
      branchOutputs.add(branch.outputArtifactType);
      const branchSchema = resolveSelector(documents, branch.sourceSchemaRef);
      expect(branchSchema !== undefined, "branch-schema-resolves", `${label}:${branch.sourceSchemaRef}`, issues);
      expect(exactOutputSchemaRefs.has(branch.sourceSchemaRef) || branch.sourceSchemaRef === exactOwnerLeafOutputSchemaRef, "branch-schema-is-exact-operation-output", `${label}:${branch.sourceSchemaRef}`, issues);
      const schemaArtifactTypes = sourceTypes(branchSchema);
      expect(schemaArtifactTypes.includes(branch.outputArtifactType), "branch-schema-artifact-type", `${label}:${branch.outputArtifactType}`, issues);
      if (exactOwnerLeafOutputSchemaRef) {
        expect(operation?.ownerLeafWireContractRef === resolveSelector(documents, operationRef)?.ownerLeafWireContractRef, "exact-owner-leaf-wire-binding", label, issues);
        expect(sourceTypes(exactOwnerLeafOutputSchema).includes(branch.outputArtifactType), "owner-leaf-operation-output-type", `${label}:${branch.outputArtifactType}`, issues);
      }
      const exactOperationResultKind = branch.exactOperationResultKindRef
        ? resolveSelector(documents, branch.exactOperationResultKindRef) : undefined;
      if (branch.exactOperationResultKindRef) {
        expect(exactOperationResultKind === branch.expectedResultKind, "exact-operation-result-kind", `${label}:${branch.expectedResultKind}`, issues);
        const operationSchemaResultKind = resolveSelector(documents, branch.operationResultSchemaKindRef);
        expect(operationSchemaResultKind === branch.expectedResultKind, "operation-schema-result-kind", `${label}:${branch.expectedResultKind}`, issues);
        expect(branch.branchSelector === "$.outputs[*].payload.resultKind", "exact-result-kind-selector", label, issues);
        expect(selectorValues(branchSchema, branch.branchSelector).includes(branch.expectedResultKind), "result-kind-is-schema-branch", `${label}:${branch.expectedResultKind}`, issues);
      }
      const requestSchema = branch.requestSchemaRef && resolveSelector(documents, branch.requestSchemaRef);
      if (branch.requestSchemaRef) expect(requestSchema !== undefined, "request-schema-resolves", `${label}:${branch.requestSchemaRef}`, issues);
      expect(typeof branch.missingOrUnknown === "string" && /UNKNOWN/u.test(branch.missingOrUnknown), "branch-unknown-outcome", `${label}:${branch.outputArtifactType}`, issues);
      expect(Array.isArray(branch.outcomes) && branch.outcomes.length > 0, "outcomes-present", `${label}:${branch.outputArtifactType}`, issues);
      const conditions = new Set();
      const requestConditions = new Set();
      for (const outcome of branch.outcomes ?? []) {
        expect(ALLOWED_DISPOSITIONS.has(outcome.disposition), "known-disposition", `${label}:${outcome.when}`, issues);
        expect(typeof outcome.meaning === "string" && outcome.meaning.length >= 80, "material-meaning", `${label}:${outcome.when}`, issues);
        if (outcome.disposition === "NO_RECONSTRUCTION_OR_INFERENCE") {
          expect(EPISTEMIC_ROLES.has(outcome.epistemicRole), "epistemic-role", `${label}:${outcome.when}`, issues);
          if (outcome.epistemicRole === "CALLER_PLAN_NOT_STATE") expect(/not a state observation and not an applied effect/u.test(outcome.meaning), "plan-not-state", `${label}:${outcome.when}`, issues);
          if (outcome.epistemicRole === "POLICY_DECISION_RECORD_NOT_GRANT") expect(/not a grant/u.test(outcome.meaning), "decision-not-grant", `${label}:${outcome.when}`, issues);
          if (outcome.epistemicRole === "READINESS_OBSERVATION_NOT_ADMISSION") expect(/not provider qualification, admission/u.test(outcome.meaning), "readiness-not-admission", `${label}:${outcome.when}`, issues);
          if (outcome.epistemicRole === "VERSIONED_DEFINITION_NOT_EXECUTION") expect(/not an executed render/u.test(outcome.meaning), "definition-not-execution", `${label}:${outcome.when}`, issues);
          if (outcome.epistemicRole === "OWNER_RECORDED_CHANGE_NOT_MEDIA_CONTENT") expect(/does not itself establish that a media artifact was transformed/u.test(outcome.meaning), "recorded-change-not-content", `${label}:${outcome.when}`, issues);
          if (outcome.epistemicRole === "MEASUREMENT_RECORD_NOT_TRANSFORMED_MEDIA") expect(/measurement record only/u.test(outcome.meaning) && /not mastered audio/u.test(outcome.meaning) && /does not itself modify or produce the measured source audio/u.test(outcome.meaning), "measurement-not-audio-transform", `${label}:${outcome.when}`, issues);
          if (outcome.epistemicRole === "DEFINITION_NOT_MEDIA_CONTENT") expect(/not a rendered frame, clip, or other media-content derivative/u.test(outcome.meaning), "definition-not-media-content", `${label}:${outcome.when}`, issues);
        }
        if (INTENT_AUTHORED_ANIMATION_DEFINITIONS.has(row?.capabilityRef)) {
          expect(outcome.disposition === "NO_RECONSTRUCTION_OR_INFERENCE", "animation-definition-not-media-transform", `${label}:${outcome.when}`, issues);
          expect(outcome.epistemicRole === "DEFINITION_NOT_MEDIA_CONTENT", "animation-definition-role", `${label}:${outcome.when}`, issues);
          expect(!operation?.requestSchema?.required?.includes("input2") && operation?.requestSchema?.properties?.input2?.properties?.payload !== undefined, "animation-input2-is-optional", `${label}:${outcome.when}`, issues);
          expect(/request schema permits source-free intent because input2 is optional/u.test(outcome.meaning), "animation-source-free-request", `${label}:${outcome.when}`, issues);
          expect(/any supplied rig, scene, or media references are dependencies only; they do not prove that the output preserves, derives from, or recovers referenced media/u.test(outcome.meaning), "animation-reference-not-proof", `${label}:${outcome.when}`, issues);
          expect(/exact source artifact\/version to an output result/u.test(outcome.meaning), "animation-linkage-unknown-without-join", `${label}:${outcome.when}`, issues);
        }
        if (row?.capabilityRef === "media.animation.motion-capture.extract") {
          expect(outcome.disposition === "ESTIMATED_OR_INFERRED_OBSERVATION", "motion-capture-is-estimate", `${label}:${outcome.when}`, issues);
          expect(/pose estimate is not ground truth/u.test(outcome.meaning), "motion-capture-not-ground-truth", `${label}:${outcome.when}`, issues);
        }
        if (row?.capabilityRef === "media.stream.caption.live") {
          expect(outcome.disposition === "NO_RECONSTRUCTION_OR_INFERENCE" && outcome.epistemicRole === "OWNER_STATE_OR_REFERENCE", "live-caption-session-not-content", `${label}:${outcome.when}`, issues);
          expect(/reports only an ordered stream-session observation or a terminal session-state reference/u.test(outcome.meaning), "live-caption-session-scope", `${label}:${outcome.when}`, issues);
          expect(/contains no live-caption text, transcript segments, subtitle cues, or derived caption artifact/u.test(outcome.meaning), "live-caption-payload-absent", `${label}:${outcome.when}`, issues);
          expect(/does not establish that caption content was produced or delivered/u.test(outcome.meaning), "live-caption-no-production-claim", `${label}:${outcome.when}`, issues);
          expect(/A separate exact operation must bind any caption content/u.test(outcome.meaning), "live-caption-content-needs-operation", `${label}:${outcome.when}`, issues);
        }
        if (row?.capabilityRef === "media.master.audio.phase-noise-floor-analyze") {
          expect(outcome.disposition === "NO_RECONSTRUCTION_OR_INFERENCE", "phase-noise-output-is-measurement", `${label}:${outcome.when}`, issues);
          expect(outcome.epistemicRole === "MEASUREMENT_RECORD_NOT_TRANSFORMED_MEDIA", "phase-noise-measurement-role", `${label}:${outcome.when}`, issues);
          expect(/measurement record only/u.test(outcome.meaning) && /not mastered audio/u.test(outcome.meaning), "phase-noise-is-not-mastered-audio", `${label}:${outcome.when}`, issues);
          expect(/does not itself modify or produce the measured source audio/u.test(outcome.meaning), "phase-noise-does-not-transform-source", `${label}:${outcome.when}`, issues);
        }
        const conditionKey = `${outcome.when}\u0000${outcome.requestWhen ?? ""}`;
        expect(typeof outcome.when === "string" && !conditions.has(conditionKey), "unique-outcome-condition", `${label}:${outcome.when}`, issues);
        conditions.add(conditionKey);
        let observedValues;
        const typed = /^\$\.outputs\[\*\]\.artifactType=(.+)$/u.exec(outcome.when);
        const payloadKind = /^\$\.outputs\[\*\]\.payload\.kind=(.+)$/u.exec(outcome.when);
        const payloadField = /^\$\.outputs\[\*\]\.payload\.([A-Za-z][A-Za-z0-9]*)=(.+)$/u.exec(outcome.when);
        if (typed) observedValues = schemaArtifactTypes;
        else if (payloadKind) observedValues = selectorValues(branchSchema, "$.outputs[*].payload.kind");
        else if (payloadField) observedValues = selectorValues(branchSchema, `$.outputs[*].payload.${payloadField[1]}`);
        else if (branch.branchSelector) observedValues = selectorValues(branchSchema, branch.branchSelector);
        else observedValues = [];
        expect(observedValues.includes(typed?.[1] ?? payloadKind?.[1] ?? payloadField?.[2] ?? outcome.when), "outcome-is-schema-branch", `${label}:${outcome.when}`, issues);
        if (outcome.requestWhen) {
          expect(requestSchema !== undefined, "request-condition-requires-schema", `${label}:${outcome.requestWhen}`, issues);
          const requestMatch = /^(.+)=([^=]+)$/u.exec(outcome.requestWhen);
          const requestValues = requestMatch ? selectorValues(requestSchema, requestMatch[1]) : [];
          expect(requestValues.includes(requestMatch?.[2]), "request-condition-is-schema-branch", `${label}:${outcome.requestWhen}`, issues);
          requestConditions.add(outcome.requestWhen);
        }
      }
      if (branch.branchSelector) {
        const values = selectorValues(branchSchema, branch.branchSelector);
        expect(values.length > 0, "branch-selector-resolves", `${label}:${branch.branchSelector}`, issues);
        if (branch.exactOperationResultKindRef) {
          expect(conditions.size === 1 && conditions.has(`$.outputs[*].payload.resultKind=${branch.expectedResultKind}\u0000`), "exact-operation-branch-classified", `${label}:${branch.expectedResultKind}`, issues);
        } else {
          expect(conditions.size === values.length, "all-schema-branches-classified", `${label}:${branch.branchSelector}`, issues);
        }
      }
      if (branch.requestSchemaRef && branch.requestSelector) {
        const values = selectorValues(requestSchema, branch.requestSelector);
        expect(values.length > 0, "request-branch-selector-resolves", `${label}:${branch.requestSelector}`, issues);
        expect(requestConditions.size === values.length, "all-request-schema-branches-classified", `${label}:${branch.requestSelector}`, issues);
      }
    }
    expect(branchOutputs.size === row?.exactTypedOutputs?.length, "all-typed-outputs-classified", label, issues);
  }
  for (const id of capabilityById.keys()) expect(joined.has(id), "missing-capability", id, issues);
  return { valid: issues.length === 0, capabilityCount: capabilityRows.length, recordCount: rows.length, issues };
}
