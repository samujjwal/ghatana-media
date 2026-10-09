import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const parse = createRequire(new URL("../../ghatana-tools/package.json", import.meta.url))("yaml").parse;

const registryPath = ".product-experience/pdp-3-product-experience/agent-tools/tool-registry.yaml";
const conventionsPath = ".product-experience/pdp-2-design-interface-system/agent-tools/conventions.yaml";
const handlerRoot = "libs/common/src/main/java/com/ghatana/audio/video/tools";
const factoryPath = `${handlerRoot}/AudioVideoToolHandlerFactory.java`;
const factorySource = readFileSync(factoryPath, "utf8");
const registryText = () => readFileSync(registryPath, "utf8");

const definitions = [
  {
    id: "av.speech-to-text",
    operation: "media.operation.transcription-submission",
    family: "media.operation.transcription",
    handler: "SpeechToTextToolHandler",
    factoryId: "TOOL_ID_STT",
    source: "SpeechToTextToolHandler.java",
    fields: ["audioSource", "languageCode", "enableDiarization", "model"],
    markers: ["AgentToolInput.checked(envelope, contract, TOOL_ID", "AgentToolInput.languageTag", "INVALID_ENABLE_DIARIZATION", "INVALID_MODEL", "AgentToolInput.dispatch(delegate, envelope, contract)"],
    error: "STT processing error: ",
    unavailable: "Audio-Video STT provider unavailable for " + '" + audioSource + ": no speech-to-text service delegate configured"',
  },
  {
    id: "av.text-to-speech",
    operation: "media.operation.capability.media-speech-synthesis-text-to-speech",
    family: "media.operation.synthesis",
    handler: "TextToSpeechToolHandler",
    factoryId: "TOOL_ID_TTS",
    source: "TextToSpeechToolHandler.java",
    fields: ["text", "voiceId", "speakingRate", "pitch", "audioEncoding", "storeAsArtifact"],
    markers: ["AgentToolInput.checked(envelope, contract, TOOL_ID", "AgentToolInput.requiredString(input, \"text\", 10_000)", "AgentToolInput.boundedRate", "INVALID_PITCH", "OGG_OPUS", "AgentToolInput.dispatch(delegate, envelope, contract)"],
    error: "TTS processing error: ",
    unavailable: "Audio-Video TTS provider unavailable: no text-to-speech service delegate configured",
  },
  {
    id: "av.vision-analysis",
    operation: "media.operation.capability.media-vision-detect",
    family: "media.operation.vision-analysis",
    handler: "VisionAnalysisToolHandler",
    factoryId: "TOOL_ID_VISION",
    source: "VisionAnalysisToolHandler.java",
    fields: ["mediaSource", "analysisTypes", "maxResults", "confidenceThreshold", "customModelId"],
    markers: ["AgentToolInput.checked(envelope, contract, TOOL_ID", "INVALID_ANALYSIS_TYPES", "AgentToolInput.boundedInt", "INVALID_CONFIDENCE_THRESHOLD", "CUSTOM_MODEL", "AgentToolInput.dispatch(delegate, envelope, contract)"],
    error: "Vision analysis error: ",
    unavailable: "Audio-Video Vision provider unavailable: no vision analysis service delegate configured",
  },
  {
    id: "av.multimodal-inference",
    operation: "media.operation.capability.media-multimodal-analyze-cross-modal",
    family: "media.operation.multimodal-analysis",
    handler: "MultimodalInferenceToolHandler",
    factoryId: "TOOL_ID_MULTIMODAL",
    source: "MultimodalInferenceToolHandler.java",
    fields: ["mediaArtifactId", "inferenceMode", "samplingRateMs", "enableTranscription", "enableVisionAnalysis", "languageCode"],
    markers: ["AgentToolInput.checked(envelope, contract, TOOL_ID", "FRAME_BY_FRAME", "INVALID_SAMPLING_RATE", "AgentToolInput.languageTag", "NO_MODALITY_SELECTED", "AgentToolInput.dispatch(delegate, envelope, contract)"],
    error: "Multimodal inference error: ",
    unavailable: "Audio-Video Multimodal provider unavailable: no multimodal inference service delegate configured",
  },
];

const getBlock = (text, id) => {
  const starts = [...text.matchAll(/^  - id: ([^\n]+)\n/gmu)];
  const index = starts.findIndex((match) => match[1] === id);
  if (index < 0) return null;
  const from = starts[index].index + starts[index][0].length;
  const to = starts[index + 1]?.index ?? text.length;
  return text.slice(from, to);
};

function checkRegistry(text, sources) {
  const errors = [];
  const observedIds = [...text.matchAll(/^  - id: ([^\n]+)$/gmu)].map((match) => match[1]);
  const expectedIds = definitions.map((item) => item.id);
  for (const id of expectedIds) if (!observedIds.includes(id)) errors.push(`missing tool entry: ${id}`);
  for (const id of observedIds) if (!expectedIds.includes(id)) errors.push(`unsupported tool entry: ${id}`);
  for (const id of new Set(observedIds.filter((item, index) => observedIds.indexOf(item) !== index))) errors.push(`duplicate tool entry: ${id}`);
  if (text.includes("executionAdmitted: true")) errors.push("tool registry must not admit execution");
  if (!text.includes("schemaVersion: NOT_DECLARED_BY_HANDLER")) errors.push("handler schema version must remain explicitly undeclared");
  if (!text.includes("operationBinding: Media operation candidates must remain distinct from handler/runtime parity; exact operation IDs below are definition-only candidates, not proof of handler/API equivalence or Shared runtime binding.")) errors.push("Media operation candidates must remain distinct from handler/runtime parity");
  if (!text.includes("asynchronousFailure: The adapter preserves delegate rejection and synchronous throw, and rejects null promises, mismatched invocationId results, and malformed successful payloads on the promise error channel. The DefaultToolExecutor boundary maps effectful post-dispatch ambiguity to non-final OUTCOME_UNKNOWN")) errors.push("delegate ambiguity and output-validation error semantics must remain explicit");
  if (!text.includes("Successful delegate outputs receive bounded Draft 2020-12 validation against the outputSchema supplied by the matching ToolContract")) errors.push("registered-contract output validation must remain source-bounded");
  if (!text.includes("An empty schema remains unresolved and passes through")) errors.push("empty/unbound result schemas must remain unresolved");
  if (!text.includes("localFailedResultArguments: ToolExecutionResult.failed receives invocationId for both its first and third arguments")) errors.push("local failed-result identity/time argument behavior must remain explicit");

  for (const definition of definitions) {
    const block = getBlock(text, definition.id);
    const source = sources[definition.source];
    if (!block) continue;
    if (!source) {
      errors.push(`${definition.id}: missing handler source ${definition.source}`);
      continue;
    }
    if (!block.includes(`handler: ${definition.handler}`)) errors.push(`${definition.id}: handler class mismatch`);
    if (!block.includes(`handlerSource: ${handlerRoot}/${definition.source}`)) errors.push(`${definition.id}: exact handler source reference missing`);
    if (!source.includes(`TOOL_ID = "${definition.id}"`)) errors.push(`${definition.id}: handler TOOL_ID drift`);
    if (!new RegExp(`${definition.factoryId} = ${definition.handler}\\.TOOL_ID`, "u").test(factorySource)
      || !factorySource.includes(`${definition.factoryId},`) || !new RegExp(`case ${definition.factoryId}\\s+-> new ${definition.handler}\\(\\)`, "u").test(factorySource)
      || !new RegExp(`${definition.factoryId},\\s+${definition.handler}\\.class`, "u").test(factorySource)
      || !factorySource.includes(`new ${definition.handler}()`)) errors.push(`${definition.id}: handler factory registration drift`);
    const observedInputFields = [...block.matchAll(/^        - \{name: ([^,]+),/gmu)].map((match) => match[1]);
    for (const field of definition.fields) {
      if (!observedInputFields.includes(field)) errors.push(`${definition.id}: missing observed field binding ${field}`);
    }
    for (const field of observedInputFields) {
      if (!definition.fields.includes(field)) errors.push(`${definition.id}: unsupported observed field binding ${field}`);
    }
    if (!block.includes("sourceType: Map<String,Object> from ToolExecutionEnvelope.input()")) errors.push(`${definition.id}: input source type observation missing`);
    if (!block.includes("javaType: Promise<ToolExecutionResult>")) errors.push(`${definition.id}: observed result type missing`);
    const successObservation = definition.id === "av.multimodal-inference"
      ? "success: Successful delegate output is checked structurally against the supplied ToolContract outputSchema; component, partial-result, provenance, and output admission semantics remain unresolved."
      : "success: Successful delegate output is checked structurally against the supplied ToolContract outputSchema; field semantics, provenance, evidence, and output admission remain unresolved.";
    if (!block.includes(successObservation)) errors.push(`${definition.id}: delegate result opacity observation missing`);
    if (!block.includes("schemaVersion: {value: null, status: not-declared-by-handler-or-delegate-contract}")) errors.push(`${definition.id}: result schema version must remain undeclared`);
    if (!block.includes("finality: Tools result enum carries non-final unknown/cancellation-requested states; handler does not validate operation-specific output finality.")) errors.push(`${definition.id}: result finality capability and limit must be accurate`);
    for (const marker of definition.markers) {
      if (!source.includes(marker)) errors.push(`${definition.id}: handler source drift at ${marker}`);
    }
    for (const marker of ["Objects.requireNonNull(envelope", "Objects.requireNonNull(contract", "ToolExecutionResult.failed(", "Promise<ToolExecutionResult>", "log.debug(", "envelope.tenantId()"] ) {
      if (!source.includes(marker)) errors.push(`${definition.id}: expected observed safety/result marker missing: ${marker}`);
    }
    if (source.indexOf("Objects.requireNonNull(contract") > source.indexOf("try {")) errors.push(`${definition.id}: null contract check moved inside try; direct-throw classification changed`);
    if (!block.includes("nullArgumentBehavior: Both checks occur before the handler try block and throw directly; no local ToolExecutionResult is returned.")) errors.push(`${definition.id}: direct null-argument behavior missing`);
    if (!block.includes("delegateInputForwarding: After local envelope/contract and input validation, delegate.handle receives the original envelope and contract unchanged through AgentToolInput.dispatch.")) errors.push(`${definition.id}: original delegate input forwarding missing`);
    if (!source.includes(definition.error)) errors.push(`${definition.id}: caught-error semantics drift`);
    if (!source.includes(definition.unavailable)) errors.push(`${definition.id}: no-delegate failure semantics drift`);
    if (!source.includes("return Promise.of(ToolExecutionResult.failed(")) errors.push(`${definition.id}: local failure must be returned as a resolved Promise`);
    if (!source.includes("envelope.invocationId(),\n                    end,\n                    Duration.between(start, end)")) errors.push(`${definition.id}: local failed-result identity/time arguments drift`);
    if (!source.includes("return AgentToolInput.dispatch(delegate, envelope, contract);")) errors.push(`${definition.id}: delegate ambiguity must remain on the promise error channel`);
    if (!block.includes("finality: Tools result enum carries non-final unknown/cancellation-requested states; handler does not validate operation-specific output finality.")) errors.push(`${definition.id}: result finality capability and limit must be accurate`);
    if (!block.includes("schemaVersion: {value: null, status: not-declared-by-handler-or-delegate-contract}")) errors.push(`${definition.id}: result schema version must remain undeclared`);
    if (!block.includes("authority: {value: null, status: no-principal-resource-policy-or-delegation-enforcement-shown}")) errors.push(`${definition.id}: authority must remain unresolved`);
    if (!block.includes("availability: {value: null, status: unresolved-delegate-and-runtime-binding}")) errors.push(`${definition.id}: runtime availability must remain unresolved`);
    if (!block.includes("executionAdmitted: false")) errors.push(`${definition.id}: execution admission must remain false`);
    if (!block.includes(`operationBinding: {value: ${definition.operation}, status: owner-defined-operation-candidate; adapter-mapping-and-runtime-pending}`)) errors.push(`${definition.id}: exact owner operation candidate missing`);
    if (!block.includes(`media.agent-tool-contract.${definition.id.slice(3)}.v1`)) errors.push(`${definition.id}: versioned Media definition contract reference missing`);
  }
  return errors;
}

const sources = Object.fromEntries(definitions.map((item) => [item.source, readFileSync(`${handlerRoot}/${item.source}`, "utf8")]));

test("tool registry records the exact four handler-observed contracts without implying admission", () => {
  assert.deepEqual(checkRegistry(registryText(), sources), []);
});

test("all four entries inventory validated inputs while retaining output and operation admission gates", () => {
  const registry = registryText();
  assert.equal([...registry.matchAll(/^  - id: /gmu)].length, 4);
  for (const definition of definitions) {
    const block = getBlock(registry, definition.id);
    const observedInputs = [...block.matchAll(/^        - \{name: ([^,]+),/gmu)].map((match) => match[1]);
    assert.deepEqual(observedInputs, definition.fields, `${definition.id}: exact observed input inventory`);
    assert.match(block, /sourceType: Map<String,Object> from ToolExecutionEnvelope\.input\(\)/u);
    assert.match(block, /javaType: Promise<ToolExecutionResult>/u);
    assert.ok(block.includes(definition.id === "av.multimodal-inference"
      ? "success: Successful delegate output is checked structurally against the supplied ToolContract outputSchema; component, partial-result, provenance, and output admission semantics remain unresolved."
      : "success: Successful delegate output is checked structurally against the supplied ToolContract outputSchema; field semantics, provenance, evidence, and output admission remain unresolved."));
    assert.match(block, /schemaVersion: \{value: null, status: not-declared-by-handler-or-delegate-contract\}/u);
    assert.match(block, /finality: Tools result enum carries non-final unknown\/cancellation-requested states; handler does not validate operation-specific output finality\./u);
    assert.match(block, /operationBinding: \{value: media\.operation\.[a-z.-]+, status: owner-defined-operation-candidate; adapter-mapping-and-runtime-pending\}/u);
    assert.match(block, /executionAdmitted: false/u);
  }
});

test("tool registry rejects missing, extra, or duplicate handler entries and missing observed fields", () => {
  const registry = registryText();
  const first = getBlock(registry, definitions[0].id);
  assert.ok(first);
  assert.match(checkRegistry(registry.replace("name: languageCode,", "name: audioSource.bytes,"), sources).join("\n"), /missing observed field binding languageCode/u);
  assert.match(checkRegistry(registry.replace("name: languageCode,", "name: languageCode,\n        - {name: inventedField, type: Object, presence: unknown}"), sources).join("\n"), /unsupported observed field binding inventedField/u);
  assert.match(checkRegistry(registry.replace("  - id: av.vision-analysis", "  - id: av.unsupported\n    canonicalId: av.unsupported\n  - id: av.vision-analysis"), sources).join("\n"), /unsupported tool entry/u);
  assert.match(checkRegistry(registry.replace("  - id: av.vision-analysis", "  - id: av.speech-to-text\n    canonicalId: av.speech-to-text\n  - id: av.vision-analysis"), sources).join("\n"), /duplicate tool entry/u);
  assert.match(checkRegistry(registry.replace("  - id: av.vision-analysis", "  - id: av.text-to-speech\n    canonicalId: av.text-to-speech\n  - id: av.vision-analysis"), sources).join("\n"), /duplicate tool entry/u);
});

test("each handler input/error source drift is rejected independently", () => {
  for (const definition of definitions) {
    const drifted = { ...sources, [definition.source]: sources[definition.source].replace(definition.error, "Changed handler failure: ") };
    assert.match(checkRegistry(registryText(), drifted).join("\n"), new RegExp(`${definition.id}: caught-error semantics drift`, "u"));
    const missingInputMarker = { ...sources, [definition.source]: sources[definition.source].replace(definition.markers[0], "changedInputExpression") };
    assert.match(checkRegistry(registryText(), missingInputMarker).join("\n"), new RegExp(`${definition.id}: handler source drift`, "u"));
    const changedUnavailable = { ...sources, [definition.source]: sources[definition.source].replace(definition.unavailable, "Provider temporarily unavailable") };
    assert.match(checkRegistry(registryText(), changedUnavailable).join("\n"), new RegExp(`${definition.id}: no-delegate failure semantics drift`, "u"));
  }
});

test("registry distinguishes pre-dispatch local failures from ambiguous post-dispatch outcomes", () => {
  for (const definition of definitions) {
    const source = sources[definition.source];
    assert.ok(source.indexOf("Objects.requireNonNull(envelope") < source.indexOf("try {"), `${definition.id}: envelope null check must remain before try`);
    assert.ok(source.indexOf("Objects.requireNonNull(contract") < source.indexOf("try {"), `${definition.id}: contract null check must remain before try`);
    assert.ok(source.includes("return AgentToolInput.dispatch(delegate, envelope, contract)"), `${definition.id}: delegate dispatch must retain ambiguous outcomes`);
    const block = getBlock(registryText(), definition.id);
    assert.match(block, /nullArgumentBehavior: Both checks occur before the handler try block and throw directly/u);
    assert.match(block, /delegateInputForwarding: After local envelope\/contract and input validation, delegate\.handle receives the original envelope and contract unchanged through AgentToolInput\.dispatch/u);
  }
});

test("registry rejects accidental runtime, operation, authority, or finality promotion", () => {
  const registry = registryText();
  assert.match(checkRegistry(registry.replace("executionAdmitted: false", "executionAdmitted: true"), sources).join("\n"), /must not admit execution/u);
  assert.match(checkRegistry(registry.replace("operationBinding: Media operation candidates must remain distinct from handler/runtime parity; exact operation IDs below are definition-only candidates, not proof of handler/API equivalence or Shared runtime binding.", "operationBinding: accepted"), sources).join("\n"), /Media operation candidates must remain distinct/u);
  assert.match(checkRegistry(registry.replace("finality: Tools result enum carries non-final unknown/cancellation-requested states; handler does not validate operation-specific output finality.", "finality: final"), sources).join("\n"), /result finality capability and limit must be accurate/u);
  assert.match(checkRegistry(registry.replace("availability: {value: null, status: unresolved-delegate-and-runtime-binding}", "availability: available"), sources).join("\n"), /runtime availability must remain unresolved/u);
  assert.match(checkRegistry(registry.replace("authority: {value: null, status: no-principal-resource-policy-or-delegation-enforcement-shown}", "authority: authorized"), sources).join("\n"), /authority must remain unresolved/u);
});

test("runtime source observation does not turn Tools build resolution into Shared owner acceptance", () => {
  const conventions = readFileSync(conventionsPath, "utf8").replace(/\s+/gu, " ");
  assert.match(conventions, /status: source-observation-only; owner-and-public-export-binding-pending/u);
  assert.match(conventions, /Current composite build compiles the handler APIs from the Ghatana Tools runtime\/java\/tool-contracts and runtime\/java\/tool-runtime sources\./u);
  assert.match(conventions, /No matching ToolExecutionEnvelope, ToolExecutionResult, ToolContract, or ToolHandler source\/export was found in the inspected Shared/u);
  assert.match(conventions, /does not establish Shared acceptance or execution admission\./u);
});

test("owner-selected operation families remain definition-only until handler bindings and admission are proved", () => {
  const conventions = readFileSync(conventionsPath, "utf8");
  assert.match(conventions, /status: OWNER_POLICY_ACCEPTED; CONTRACT_AND_EXECUTION_ADMISSION_PENDING/u);
  for (const [id, family, operation] of [
    ["av.speech-to-text", "media.operation.transcription", "media.operation.transcription-submission"],
    ["av.text-to-speech", "media.operation.synthesis", "media.operation.capability.media-speech-synthesis-text-to-speech"],
    ["av.vision-analysis", "media.operation.vision-analysis", "media.operation.capability.media-vision-detect"],
    ["av.multimodal-inference", "media.operation.multimodal-analysis", "media.operation.capability.media-multimodal-analyze-cross-modal"],
  ]) {
    const ownerSelection = conventions.match(new RegExp(
      `    - toolId: ${id}\\s+canonicalOperationFamily: ${family}\\s+[\\s\\S]*?executionAdmitted: false`, "u"));
    assert.ok(ownerSelection, `${id}: selected family must remain definition-only with execution admission false`);
    const registryEntry = getBlock(registryText(), id);
    assert.ok(registryEntry, `${id}: registry entry is present`);
    assert.match(registryEntry, /executionAdmitted: false/u);
    assert.match(registryEntry, new RegExp(`operationBinding: \\{value: ${operation.replaceAll(".", "\\.")}, status: owner-defined-operation-candidate; adapter-mapping-and-runtime-pending\\}`, "u"));
  }
});


test("adapter input validation and generic unknown outcome support do not admit Media tool execution", () => {
  const validator = readFileSync(`${handlerRoot}/AgentToolInput.java`, "utf8");
  assert.match(validator, /UNKNOWN_INPUT_FIELD/u);
  assert.match(validator, /TOOL_ID_MISMATCH/u);
  assert.match(validator, /TOOL_VERSION_MISMATCH/u);
  assert.match(validator, /TOOL_ACTION_CLASS_MISMATCH/u);
  const conventions = readFileSync(conventionsPath, "utf8");
  assert.match(conventions, /executionAdmitted: false/u);
  assert.match(conventions, /Ghatana Tools ToolExecutionResult now supports non-final OUTCOME_UNKNOWN/u);
  const registry = registryText();
  assert.match(registry, /executionAdmitted: false/u);
  assert.match(registry, /DefaultToolExecutor boundary maps effectful post-dispatch ambiguity to non-final OUTCOME_UNKNOWN/u);
});

test("bounded Media planning is a closed definition, not dynamic agent or dispatch authority", () => {
  const document = parse(readFileSync(conventionsPath, "utf8"));
  const planning = document.mediaOwnedToolDefinitionContracts.boundedPlanningSemantics;
  assert.equal(planning.id, "media.agent-tool-bounded-planning.v1");
  assert.equal(planning.scopeStatus, "MEDIA_OWNER_DEFINITION_ONLY; planner/runtime binding and execution admission pending");
  assert.equal(planning.acceptanceEffect, "none");
  assert.equal(planning.decisionRef, "PXD-PENDING-PDP38-EXPERIENCE");
  assert.equal(planning.planEnvelopeSchema.additionalProperties, false);
  assert.deepEqual(planning.planEnvelopeSchema.required, ["planId", "planVersion", "members", "budget", "authorityContextRef"]);
  assert.equal(planning.planEnvelopeSchema.properties.members.maxItems, 16);
  assert.equal(planning.planEnvelopeSchema.properties.members.items, planning.allowedMemberSchema);
  assert.equal(planning.allowedMemberSchema.additionalProperties, false);
  assert.deepEqual(planning.allowedMemberSchema.required, [
    "actionRef", "actionDefinitionRef", "operationRefs", "operationContractRefs", "purposeRef", "resourceBindings", "preconditionRefs", "expectedResultDisposition",
  ]);
  assert.equal(planning.allowedMemberSchema.properties.operationRefs.minItems, 1);
  assert.equal(planning.allowedMemberSchema.properties.operationRefs.maxItems, 8);
  assert.equal(planning.allowedMemberSchema.properties.operationRefs.uniqueItems, true);
  assert.equal(planning.allowedMemberSchema.properties.operationContractRefs.minItems, 1);
  assert.equal(planning.allowedMemberSchema.properties.actionDefinitionRef.pattern,
    "^\\.product-experience/pdp-3-product-experience/action-registry\\.yaml#actions/@id=media\\.action\\.[a-z0-9.-]+$");
  assert.deepEqual(planning.planEnvelopeSchema.properties.budget.required,
    ["budgetRef", "policyVersionRef", "maxPlanningSteps", "maxToolInvocations", "maxReasoningTokens", "deadline"]);
  assert.equal(planning.planEnvelopeSchema.properties.budget.properties.maxPlanningSteps.maximum, 16);
  assert.equal(planning.planEnvelopeSchema.properties.budget.properties.maxToolInvocations.maximum, 16);
  assert.equal(planning.planEnvelopeSchema.properties.budget.properties.maxReasoningTokens.maximum, 100000);
  assert.deepEqual(planning.allowedMemberSchema.properties.expectedResultDisposition.enum,
    ["SUCCEEDED", "ACCEPTED", "OUTCOME_UNKNOWN", "FAILED", "CANCELLED"]);
  const rules = planning.rules.join(" ");
  assert.match(rules, /cannot add a tool, operation, resource, purpose, authority, or delegation edge/u);
  assert.match(rules, /Observation, inspection, search, and status-resolution members are read-only/u);
  assert.match(rules, /does not create an agent graph, recursive planner, dynamic tool authority, or implicit tool invocation/u);
  assert.match(rules, /unresolved effects stop the plan and prohibit blind retry/u);
  assert.match(planning.prohibitedInference.join(" "), /not evidence of an admitted agent runtime/u);

  const weakened = structuredClone(planning);
  weakened.planEnvelopeSchema.additionalProperties = true;
  weakened.rules = weakened.rules.filter((rule) => !rule.includes("cannot add a tool, operation"));
  assert.notDeepEqual(weakened.planEnvelopeSchema, planning.planEnvelopeSchema);
  assert.notDeepEqual(weakened.rules, planning.rules);
});
