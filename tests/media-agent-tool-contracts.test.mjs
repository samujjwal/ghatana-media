import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const registryPath = ".product-experience/pdp-3-product-experience/agent-tools/tool-registry.yaml";
const conventionsPath = ".product-experience/pdp-2-design-interface-system/agent-tools/conventions.yaml";
const handlerRoot = "libs/common/src/main/java/com/ghatana/audio/video/tools";
const factoryPath = `${handlerRoot}/AudioVideoToolHandlerFactory.java`;
const factorySource = readFileSync(factoryPath, "utf8");
const registryText = () => readFileSync(registryPath, "utf8");

const definitions = [
  {
    id: "av.speech-to-text",
    handler: "SpeechToTextToolHandler",
    factoryId: "TOOL_ID_STT",
    source: "SpeechToTextToolHandler.java",
    fields: ["audioSource", "audioSource.mediaArtifactId", "audioSource.audioBytes", "mediaArtifactId"],
    markers: ["src.containsKey(\"mediaArtifactId\")", "src.containsKey(\"audioBytes\")", "input.containsKey(\"mediaArtifactId\")", "delegate.handle(envelope, contract)"],
    error: "STT processing error: ",
  },
  {
    id: "av.text-to-speech",
    handler: "TextToSpeechToolHandler",
    factoryId: "TOOL_ID_TTS",
    source: "TextToSpeechToolHandler.java",
    fields: ["text", "voiceId", "speakingRate", "audioEncoding", "storeAsArtifact"],
    markers: ["requireString(input, \"text\")", "input.getOrDefault(\"voiceId\", \"en-US-default\")", "toDouble(input.getOrDefault(\"speakingRate\", 1.0))", "input.getOrDefault(\"audioEncoding\", \"MP3\")", "Boolean.TRUE.equals(input.get(\"storeAsArtifact\"))", "delegate.handle(envelope, contract)"],
    error: "TTS processing error: ",
  },
  {
    id: "av.vision-analysis",
    handler: "VisionAnalysisToolHandler",
    factoryId: "TOOL_ID_VISION",
    source: "VisionAnalysisToolHandler.java",
    fields: ["mediaSource", "mediaSource.mediaArtifactId", "mediaSource.imageBytes", "mediaArtifactId", "analysisTypes", "maxResults"],
    markers: ["srcMap.containsKey(\"mediaArtifactId\")", "srcMap.containsKey(\"imageBytes\")", "input.containsKey(\"mediaArtifactId\")", "List.of(\"OBJECT_DETECTION\")", "toInt(input.getOrDefault(\"maxResults\", 10))", "delegate.handle(envelope, contract)"],
    error: "Vision analysis error: ",
  },
  {
    id: "av.multimodal-inference",
    handler: "MultimodalInferenceToolHandler",
    factoryId: "TOOL_ID_MULTIMODAL",
    source: "MultimodalInferenceToolHandler.java",
    fields: ["mediaArtifactId", "inferenceMode", "enableTranscription", "enableVisionAnalysis"],
    markers: ["requireString(input, \"mediaArtifactId\")", "input.getOrDefault(\"inferenceMode\", \"SUMMARY\")", "!Boolean.FALSE.equals(input.get(\"enableTranscription\"))", "!Boolean.FALSE.equals(input.get(\"enableVisionAnalysis\"))", "delegate.handle(envelope, contract)"],
    error: "Multimodal inference error: ",
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
  if (!text.includes("operationBinding: UNRESOLVED")) errors.push("PDP-1 operation binding must remain unresolved");
  if (!text.includes("asynchronousFailure: A delegate Promise is returned unchanged")) errors.push("delegate Promise failure semantics must remain explicit");
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
    for (const field of definition.fields) {
      if (!block.includes(`name: ${field},`)) errors.push(`${definition.id}: missing observed field binding ${field}`);
    }
    for (const marker of definition.markers) {
      if (!source.includes(marker)) errors.push(`${definition.id}: handler source drift at ${marker}`);
    }
    for (const marker of ["Objects.requireNonNull(envelope", "Objects.requireNonNull(contract", "ToolExecutionResult.failed(", "Promise<ToolExecutionResult>", "log.debug(", "envelope.tenantId()"] ) {
      if (!source.includes(marker)) errors.push(`${definition.id}: expected observed safety/result marker missing: ${marker}`);
    }
    if (source.indexOf("Objects.requireNonNull(contract") > source.indexOf("try {")) errors.push(`${definition.id}: null contract check moved inside try; direct-throw classification changed`);
    if (!block.includes("nullArgumentBehavior: Both checks occur before the handler try block and throw directly; no local ToolExecutionResult is returned.")) errors.push(`${definition.id}: direct null-argument behavior missing`);
    if (!block.includes("delegateInputForwarding: When configured, delegate.handle receives the original envelope and contract unchanged.")) errors.push(`${definition.id}: original delegate input forwarding missing`);
    if (!source.includes(definition.error)) errors.push(`${definition.id}: caught-error semantics drift`);
    if (!block.includes("finality: {value: null, status: not-established-by-handler-or-delegate-contract}")) errors.push(`${definition.id}: result finality must remain unresolved`);
    if (!block.includes("schemaVersion: {value: null, status: not-declared-by-handler-or-delegate-contract}")) errors.push(`${definition.id}: result schema version must remain undeclared`);
    if (!block.includes("authority: {value: null, status: no-principal-resource-policy-or-delegation-enforcement-shown}")) errors.push(`${definition.id}: authority must remain unresolved`);
    if (!block.includes("availability: {value: null, status: unresolved-delegate-and-runtime-binding}")) errors.push(`${definition.id}: runtime availability must remain unresolved`);
    if (!block.includes("executionAdmitted: false")) errors.push(`${definition.id}: execution admission must remain false`);
    if (!block.includes("operationBinding: {value: null, status: unresolved-owner-and-operation-mapping}")) errors.push(`${definition.id}: operation binding must remain unresolved`);
  }
  return errors;
}

const sources = Object.fromEntries(definitions.map((item) => [item.source, readFileSync(`${handlerRoot}/${item.source}`, "utf8")]));

test("tool registry records the exact four handler-observed contracts without implying admission", () => {
  assert.deepEqual(checkRegistry(registryText(), sources), []);
});

test("tool registry rejects missing, extra, or duplicate handler entries and missing observed fields", () => {
  const registry = registryText();
  const first = getBlock(registry, definitions[0].id);
  assert.ok(first);
  assert.match(checkRegistry(registry.replace("name: audioSource.audioBytes,", "name: audioSource.bytes,"), sources).join("\n"), /missing observed field binding audioSource\.audioBytes/u);
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
  }
});

test("registry distinguishes direct null-argument throws from caught local failures and records unchanged delegate forwarding", () => {
  for (const definition of definitions) {
    const source = sources[definition.source];
    assert.ok(source.indexOf("Objects.requireNonNull(envelope") < source.indexOf("try {"), `${definition.id}: envelope null check must remain before try`);
    assert.ok(source.indexOf("Objects.requireNonNull(contract") < source.indexOf("try {"), `${definition.id}: contract null check must remain before try`);
    assert.ok(source.includes("return delegate.handle(envelope, contract)"), `${definition.id}: delegate must receive original envelope and contract`);
    const block = getBlock(registryText(), definition.id);
    assert.match(block, /nullArgumentBehavior: Both checks occur before the handler try block and throw directly/u);
    assert.match(block, /delegateInputForwarding: When configured, delegate\.handle receives the original envelope and contract unchanged/u);
  }
});

test("registry rejects accidental runtime, operation, authority, or finality promotion", () => {
  const registry = registryText();
  assert.match(checkRegistry(registry.replace("executionAdmitted: false", "executionAdmitted: true"), sources).join("\n"), /must not admit execution/u);
  assert.match(checkRegistry(registry.replace("operationBinding: UNRESOLVED", "operationBinding: media\.operation\.transcribe"), sources).join("\n"), /operation binding must remain unresolved/u);
  assert.match(checkRegistry(registry.replace("finality: {value: null, status: not-established-by-handler-or-delegate-contract}", "finality: final"), sources).join("\n"), /result finality must remain unresolved/u);
  assert.match(checkRegistry(registry.replace("availability: {value: null, status: unresolved-delegate-and-runtime-binding}", "availability: available"), sources).join("\n"), /runtime availability must remain unresolved/u);
  assert.match(checkRegistry(registry.replace("authority: {value: null, status: no-principal-resource-policy-or-delegation-enforcement-shown}", "authority: authorized"), sources).join("\n"), /authority must remain unresolved/u);
});

test("runtime source observation does not turn Tools build resolution into Shared owner acceptance", () => {
  const conventions = readFileSync(conventionsPath, "utf8");
  assert.match(conventions, /status: source-observation-only; owner-and-public-export-binding-pending/u);
  assert.match(conventions, /Current composite build compiles the handler APIs from the Ghatana Tools runtime\/java\/tool-contracts and runtime\/java\/tool-runtime sources\./u);
  assert.match(conventions, /No matching ToolExecutionEnvelope, ToolExecutionResult, ToolContract, or ToolHandler source\/export was found in the inspected Shared/u);
  assert.match(conventions, /does not establish Shared acceptance or execution admission\./u);
});
