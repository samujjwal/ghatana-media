import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const parse = require("yaml").parse;
const quality = parse(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/quality-policy.yaml"), "utf8"));
const leaves = parse(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml"), "utf8")).ownerCapabilityLeafAdjudication.records;
const operations = parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/operations.yaml"), "utf8")).capabilityOperationContracts;
const domainObjects = parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/domain-objects.yaml"), "utf8"));
const crosswalk = quality.ownerQualityApplicabilityCrosswalk;
const inputByRef = new Map(operations.inputPayloadSchemas.map((row) => [`.product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/inputPayloadSchemas/${row.id}`, row]));
const outputByRef = new Map(operations.outputPayloadSchemas.map((row) => [`.product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/outputPayloadSchemas/${row.id}`, row]));
const inputById = new Map(operations.inputPayloadSchemas.map((row) => [row.id, row]));
const outputById = new Map(operations.outputPayloadSchemas.map((row) => [row.id, row]));
const modalitiesByType = new Map(crosswalk.modalityEvidenceRegistry.map((row) => [row.artifactType, row.modalities]));
const rolesByType = new Map(crosswalk.modalityEvidenceRegistry.map((row) => [row.artifactType, row.subjectRole]));
const rows = new Map(crosswalk.records.map((row) => [row.capabilityRef, row]));

test("quality crosswalk covers every leaf against all six dimensions and 16 metrics", () => {
  assert.equal(crosswalk.id, "media.quality.applicability-crosswalk.v1");
  assert.equal(crosswalk.records.length, 462);
  assert.equal(rows.size, 462);
  assert.equal(crosswalk.population.dimensionDispositions, 462 * 6);
  assert.equal(crosswalk.population.metricDispositions, 462 * 16);
  assert.deepEqual(new Set(rows.keys()), new Set(leaves.map((row) => row.capabilityRef)));
  assert.equal(quality.qualityDimensions.length, 6);
  assert.equal(quality.metricDefinitions.length, 16);
  const matrixRef = ".product-experience/pdp-0-product-truth/quality-policy.yaml#ownerQualityApplicabilityCrosswalk.records";
  for (const dimension of quality.qualityDimensions) {
    const current = dimension.ownerCurrentApplicability;
    assert.equal(current.sourceStatus, "COMPLETE_DEFINITION_ONLY");
    assert.equal(current.capabilityRefState, "OWNER_DEFINED_CURRENT_COMPLETE_DEFINITION_ONLY");
    assert.equal(current.matrixRef, matrixRef);
    assert.deepEqual(new Set(current.capabilityRefs), new Set(crosswalk.records.filter((row) => row.dimensionApplicability[dimension.id] === "APPLICABLE").map((row) => row.capabilityRef)));
    assert.equal(current.populationCount, 462);
    assert.equal(current.measurementState, "NOT_EVALUATED");
    assert.deepEqual(dimension.capabilityRefs, [], "historical empty projection is preserved");
  }
  for (const metric of quality.metricDefinitions) {
    const current = metric.ownerCurrentApplicability;
    assert.equal(current.sourceStatus, "COMPLETE_DEFINITION_ONLY");
    assert.equal(current.capabilityRefState, "OWNER_DEFINED_CURRENT_COMPLETE_DEFINITION_ONLY");
    assert.equal(current.matrixRef, matrixRef);
    assert.deepEqual(new Set(current.capabilityRefs), new Set(crosswalk.records.filter((row) => row.metricApplicability[metric.id].status === "APPLICABLE").map((row) => row.capabilityRef)));
    assert.equal(current.populationCount, 462);
    assert.equal(current.qualificationState, "NOT_EVALUATED");
    assert.deepEqual(metric.capabilityRefs, [], "historical empty projection is preserved");
  }
  for (const leaf of leaves) {
    const row = rows.get(leaf.capabilityRef);
    assert.equal(row.id, `media.quality-applicability.${leaf.capabilityRef.replaceAll(".", "-")}`);
    assert.equal(row.operationContractRef, leaf.operationContractRef);
    assert.equal(row.typedInputSchemaIds.length, leaf.exactTypedInputs.length);
    assert.equal(row.typedOutputSchemaIds.length, leaf.exactTypedOutputs.length);
    for (const id of row.typedInputSchemaIds) assert.ok(operations.inputPayloadSchemas.some((schema) => schema.id === id), `resolves exact input schema ${id}`);
    for (const id of row.typedOutputSchemaIds) assert.ok(operations.outputPayloadSchemas.some((schema) => schema.id === id), `resolves exact output schema ${id}`);
    const sourceInputTypes = row.typedInputSchemaIds.map((id) => inputById.get(id).artifactType);
    const sourceOutputTypes = row.typedOutputSchemaIds.map((id) => outputById.get(id).artifactType);
    const sourceModalities = new Set([...sourceInputTypes, ...sourceOutputTypes].filter(type=>["MEDIA_SUBJECT","MEDIA_SUBJECT_REFERENCE"].includes(rolesByType.get(type))).flatMap((type) => modalitiesByType.get(type) ?? []));
    assert.deepEqual(new Set(row.applicableModalities), sourceModalities, `${leaf.capabilityRef} modality derives from exact typed schema`);
    const outputSubjectTypes=sourceOutputTypes.filter(type=>["MEDIA_SUBJECT","MEDIA_SUBJECT_REFERENCE"].includes(rolesByType.get(type)));
    const outputModalities = new Set(outputSubjectTypes.flatMap((type) => modalitiesByType.get(type) ?? []));
    const intentTypes = new Set(crosswalk.ownerApplicabilityRules.typedIntentEvidenceRefs.map((ref) => ref.split("/").at(-1).replace("media.typed-input.", "")));
    const intentSubjects=sourceInputTypes.filter(type=>intentTypes.has(type));
    const intentModalities=new Set(intentSubjects.flatMap(type=>modalitiesByType.get(type)??[]));
    const hasSimulationInput = sourceInputTypes.some((type) => ["domain-model-and-initial-conditions", "simulation-state-and-execution-output"].includes(type));
    const hasMediaRunObservation = row.outputDomainObjectRefs.includes("media.domain.media-run")
      && sourceOutputTypes.some((type) => ["qualified-simulation-observation-or-output", "typed-simulation-pass-with-produced-versus-estimated-provenance"].includes(type));
    const hasDomain = hasSimulationInput && hasMediaRunObservation;
    const hasDeliveryOutput = sourceOutputTypes.includes("delivery-package-or-explicit-delivery-outcome");
    assert.equal(row.dimensionApplicability["QUALITY-DIM-STRUCTURAL-VALIDITY"], sourceModalities.size ? "APPLICABLE" : "NOT_APPLICABLE");
    assert.equal(row.dimensionApplicability["QUALITY-DIM-PERCEPTUAL"], sourceModalities.size ? "APPLICABLE" : "NOT_APPLICABLE");
    assert.equal(row.dimensionApplicability["QUALITY-DIM-INTENT-FIDELITY"], [...intentModalities].some(m=>outputModalities.has(m)) ? "APPLICABLE" : "NOT_APPLICABLE");
    assert.equal(row.dimensionApplicability["QUALITY-DIM-DOMAIN-SCIENTIFIC"], hasDomain ? "APPLICABLE" : "NOT_APPLICABLE");
    const rightsScope = sourceModalities.size > 0 || row.authorityRefs.some((ref) => ["identity-and-tenant-context", "operation-specific-policy-and-rights", "artifact-read-or-write-permission-as-applicable", "governed-egress-or-publishing-authority-when-applicable"].includes(ref));
    assert.equal(row.dimensionApplicability["QUALITY-DIM-RIGHTS-SAFETY"], rightsScope ? "APPLICABLE" : "NOT_APPLICABLE");
    assert.equal(row.dimensionApplicability["QUALITY-DIM-DELIVERY-COMPATIBILITY"], outputModalities.size || hasDeliveryOutput ? "APPLICABLE" : "NOT_APPLICABLE");
    assert.deepEqual(row.authorityRefs, leaf.authorityRefs);
    assert.deepEqual(Object.keys(row.dimensionApplicability).sort(), quality.qualityDimensions.map((x) => x.id).sort());
    assert.deepEqual(Object.keys(row.metricApplicability).sort(), quality.metricDefinitions.map((x) => x.id).sort());
    for (const disposition of Object.values(row.dimensionApplicability)) assert.ok(["APPLICABLE", "NOT_APPLICABLE"].includes(disposition));
    for (const disposition of Object.values(row.metricApplicability)) {
      assert.ok(["APPLICABLE", "NOT_APPLICABLE"].includes(disposition.status));
      assert.equal(disposition.measurementState, "NOT_EVALUATED");
      assert.equal(disposition.qualificationState, "NOT_EVALUATED");
      assert.ok(disposition.reasonCode);
    }
    for(const [metricRef,rule]of Object.entries(crosswalk.metricModalityRules)){
      const metric=row.metricApplicability[metricRef];
      const allowedInputTypes=rule.direction==="OUTPUT"?[]:sourceInputTypes.filter(type=>["MEDIA_SUBJECT","MEDIA_SUBJECT_REFERENCE"].includes(rolesByType.get(type))&&(modalitiesByType.get(type)??[]).some(m=>rule.modalities.includes(m)));
      const allowedOutputTypes=sourceOutputTypes.filter(type=>["MEDIA_SUBJECT","MEDIA_SUBJECT_REFERENCE"].includes(rolesByType.get(type))&&(modalitiesByType.get(type)??[]).some(m=>rule.modalities.includes(m)));
      const modalities=new Set([...allowedInputTypes,...allowedOutputTypes].flatMap(type=>(modalitiesByType.get(type)??[]).filter(m=>rule.modalities.includes(m))));
      const hasSubject=rule.modalities.every(m=>modalities.has(m));
      const referenceTypes=rule.referenceTypes??[];
      const refTypes=sourceInputTypes.filter(type=>referenceTypes.includes(type));
      const hasRefs=!referenceTypes.length||refTypes.length>0;
      const outputDomainOk=!rule.requiresOutputDomainObjectRef||row.outputDomainObjectRefs.includes(rule.requiresOutputDomainObjectRef);
      const expected=hasSubject&&hasRefs&&outputDomainOk?"APPLICABLE":"NOT_APPLICABLE";
      assert.equal(metric.status,expected,`${leaf.capabilityRef} / ${metricRef}`);
      assert.deepEqual(metric.subjectInputSchemaIds,row.typedInputSchemaIds.map(id=>inputById.get(id)).filter(schema=>allowedInputTypes.includes(schema.artifactType)).map(schema=>schema.id));
      assert.deepEqual(metric.subjectOutputSchemaIds,row.typedOutputSchemaIds.map(id=>outputById.get(id)).filter(schema=>allowedOutputTypes.includes(schema.artifactType)).map(schema=>schema.id));
      assert.deepEqual(metric.requiredReferenceSchemaIds,row.typedInputSchemaIds.map(id=>inputById.get(id)).filter(schema=>refTypes.includes(schema.artifactType)).map(schema=>schema.id));
      if(rule.condition)assert.deepEqual(metric.conditionalPredicates,[rule.condition]);
    }
  }
  const simulationRows = crosswalk.records.filter((row) => row.capabilityRef.startsWith("media.simulation."));
  assert.equal(simulationRows.length, 33, "all simulation operations and pass outputs have a source-exact quality disposition");
  for (const row of simulationRows) {
    assert.ok(row.outputDomainObjectRefs.includes("media.domain.media-run"), `${row.capabilityRef} maps its observation to MediaRun`);
    assert.equal(row.outputDomainObjectRefs.includes("media.domain.simulation-world"), false, `${row.capabilityRef} does not invent a SimulationWorld output`);
    assert.equal(row.dimensionApplicability["QUALITY-DIM-DOMAIN-SCIENTIFIC"], "APPLICABLE", `${row.capabilityRef} is eligible for domain-scientific assessment only with its typed model/state input and MediaRun output`);
  }
});

test("modality-specific applicability follows exact typed subjects and AV sync requires both modalities", () => {
  for (const row of rows.values()) {
    for(const metric of Object.values(row.metricApplicability))assert.ok(metric.subjectInputSchemaIds&&metric.subjectOutputSchemaIds&&metric.requiredReferenceSchemaIds&&metric.conditionalPredicates);
  }
  const image = rows.get("media.generate.image.text-to-image");
  assert.ok(image, "the concrete image-output fixture remains in the canonical leaf population");
  assert.equal(image.metricApplicability["QUALITY-METRIC-IMAGE-DEFECTS"].status, "APPLICABLE");
  assert.equal(image.metricApplicability["QUALITY-METRIC-AUDIO-DEFECTS"].status, "NOT_APPLICABLE");
  const simulation = leaves.find((leaf) => leaf.domainObjectRefs.includes("media.domain.simulation-world"));
  assert.ok(simulation);
  assert.equal(rows.get(simulation.capabilityRef).dimensionApplicability["QUALITY-DIM-DOMAIN-SCIENTIFIC"], "APPLICABLE");
  assert.equal(simulation.outputDomainObjectRefs.includes("media.domain.simulation-world"), false);
  const nonsimulation = leaves.find((leaf) => !leaf.domainObjectRefs.includes("media.domain.simulation-world"));
  assert.equal(rows.get(nonsimulation.capabilityRef).dimensionApplicability["QUALITY-DIM-DOMAIN-SCIENTIFIC"], "NOT_APPLICABLE");
});

test("intents, analysis/transcript evidence and conditional references cannot masquerade as produced media signals",()=>{
  const registry=new Map(crosswalk.modalityEvidenceRegistry.map(row=>[row.artifactType,row]));
  const intent=registry.get("text-or-audio-intent");
  const transcript=registry.get("transcript-or-speech-analysis-artifact-with-timing-and-uncertainty");
  const audioOutput=registry.get("candidate-audio-artifact-with-execution-provenance");
  const audioMetric=crosswalk.metricModalityRules["QUALITY-METRIC-AUDIO-NATURALNESS"];
  assert.equal(intent.subjectRole,"INTENT_TARGET");
  assert.equal(transcript.subjectRole,"TRANSCRIPT_EVIDENCE");
  assert.equal(audioMetric.direction,"OUTPUT");
  assert.ok(!["MEDIA_SUBJECT","MEDIA_SUBJECT_REFERENCE"].includes(intent.subjectRole));
  assert.ok(!["MEDIA_SUBJECT","MEDIA_SUBJECT_REFERENCE"].includes(transcript.subjectRole));
  assert.deepEqual(audioOutput.modalities,["audio"]);
  const audioOnlyInputLeaf=rows.get("media.speech.transcription.stream");
  assert.ok(audioOnlyInputLeaf, "the concrete speech-transcription analysis fixture remains in the canonical leaf population");
  assert.ok(audioOnlyInputLeaf.typedInputSchemaIds.some(id=>id.includes("audio-artifact-or-live-stream")));
  assert.ok(audioOnlyInputLeaf.typedOutputSchemaIds.some(id=>id.includes("transcript-or-speech-analysis")));
  assert.equal(audioOnlyInputLeaf.dimensionApplicability["QUALITY-DIM-INTENT-FIDELITY"],"NOT_APPLICABLE");
  assert.equal(audioOnlyInputLeaf.metricApplicability["QUALITY-METRIC-AUDIO-NATURALNESS"].status,"NOT_APPLICABLE");
  assert.equal(audioOnlyInputLeaf.metricApplicability["QUALITY-METRIC-AUDIO-SPEAKER-SIMILARITY"].status,"NOT_APPLICABLE");
  assert.deepEqual(audioOnlyInputLeaf.metricApplicability["QUALITY-METRIC-AUDIO-NATURALNESS"].subjectOutputSchemaIds,[]);
  assert.deepEqual(audioOnlyInputLeaf.metricApplicability["QUALITY-METRIC-AUDIO-SPEAKER-SIMILARITY"].subjectOutputSchemaIds,[]);
  const conditional=crosswalk.metricModalityRules["QUALITY-METRIC-AUDIO-SPEAKER-SIMILARITY"];
  assert.equal(conditional.direction,"OUTPUT");
  assert.ok(conditional.referenceTypes.includes("authorized-audio-artifactId-and-immutable-version"));
  assert.match(conditional.condition,/authorized identity reference/);
});

test("identity and domain applicability keep required authority and qualification gates explicit", () => {
  const identityMetric = "QUALITY-METRIC-IMAGE-IDENTITY";
  const identityRows = [...rows.values()].filter((row) => row.metricApplicability[identityMetric].status === "APPLICABLE");
  assert.ok(identityRows.length > 0);
  assert.match(crosswalk.dispositionSemantics.conditionalRequirements.join(" "), /IMAGE-IDENTITY.*authorized identity comparison/);
  assert.match(crosswalk.status, /metric-measurements-NOT_EVALUATED/);
  assert.match(crosswalk.status, /execution-qualification-NOT_EVALUATED/);
  assert.equal(domainObjects.ownerTypedIdentityContracts.records.length, 38);
  for (const type of crosswalk.modalityEvidenceRegistry) {
    const source = type.sourceTypeRef;
    assert.ok(operations.inputPayloadSchemas.some((schema) => `${crosswalk.schemaCollectionRefs.inputs}/${schema.id}` === source) || operations.outputPayloadSchemas.some((schema) => `${crosswalk.schemaCollectionRefs.outputs}/${schema.id}` === source), `resolves modality type ${source}`);
  }
});
