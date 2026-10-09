import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const parse = createRequire(new URL("../../ghatana-tools/package.json", import.meta.url))("yaml").parse;
const stringify = createRequire(new URL("../../ghatana-tools/package.json", import.meta.url))("yaml").stringify;
const experienceRoot = ".product-experience/pdp-3-product-experience";
const operationsPath = ".product-experience/pdp-1-domain-data/operations.yaml";
const identitiesPath = ".product-experience/pdp-1-domain-data/domain-objects.yaml";
const journeyFiles = [
  "analyze-image-video-geometry-and-tracks.yaml",
  "animate-3d-scenes-and-characters.yaml",
  "animate-vector-or-procedural-scenes.yaml",
  "authorized-text-to-speech-to-approved-audio.yaml",
  "check-which-processing-options-are-eligible.yaml",
  "clean-noisy-interview-audio.yaml",
  "compose-and-render-reviewed-media.yaml",
  "continue-safely-when-processing-is-unavailable.yaml",
  "create-review-and-deliver-from-a-brief.yaml",
  "delete-or-revoke-media-with-visible-lifecycle.yaml",
  "deliver-export-with-destination-acknowledgement.yaml",
  "edit-tracked-media-region-with-undo.yaml",
  "explore-domain-simulation-and-review-measurements.yaml",
  "export-spatial-media-with-format-loss-reporting.yaml",
  "first-use-and-project-creation.yaml",
  "generate-from-references-and-review-continuity.yaml",
  "inspect-quality-and-optimize-within-bounds.yaml",
  "live-session-loss-consent-change-and-bounded-recovery.yaml",
  "long-running-job-observation-and-recovery.yaml",
  "mix-and-master-music-and-effects.yaml",
  "refine-simulation-passes-with-semantic-validation.yaml",
  "repair-video-with-measured-quality.yaml",
  "return-bounded-results-to-integrating-products.yaml",
  "return-grounded-typed-consumer-results.yaml",
  "review-exact-version-and-recheck-changes.yaml",
  "run-cli-batch-and-review-verified-outputs.yaml",
  "transcribe-and-correct-captions.yaml",
  "translate-and-dub-existing-video.yaml",
  "upload-import-and-verify-artifact.yaml",
  "work-locally-and-reconcile-after-reconnect.yaml",
];

const readYaml = (path) => parse(readFileSync(path, "utf8"));
const oracle = readYaml(`${experienceRoot}/step-definition-oracles.yaml`);
const operations = readYaml(operationsPath);
const identities = readYaml(identitiesPath);
const localEffects = readYaml(`${experienceRoot}/local-step-effect-contracts.yaml`);
const identityByObject = new Map(identities.ownerTypedIdentityContracts.records.map((row) => [row.objectRef, row]));
const operationCollections = [
  ["ownerDefinedOperationContracts/records", operations.ownerDefinedOperationContracts?.records],
  ["individualOperationContracts/records", operations.individualOperationContracts?.records],
  ["capabilityOperationContracts/records", operations.capabilityOperationContracts?.records],
  ["operations", operations.operations],
];
const operationById = new Map();
for (const [collection, rows] of operationCollections) {
  for (const row of rows ?? []) if (row?.id) operationById.set(row.id, { row, collection });
}
const localBySourceRef = new Map(localEffects.records.map((row) => [row.sourceRef, row]));
const oracleBySourceRef = new Map(oracle.journeys.flatMap((journey) => journey.steps.map((step) => [step.sourceRef, { journey, step }])));
const outputTypeByArtifactType = new Map((identities.ownerOutputArtifactTypeCrosswalk?.records ?? [])
  .map((row) => [row.artifactType, row.domainObjectRefs ?? []]));

function walkSchema(value, path, output = []) {
  if (!value || typeof value !== "object") return output;
  if (value.type === "CanonicalObjectReference" && Array.isArray(value.allowedObjectRefs)) {
    output.push({ fieldSelector: path, allowedObjectRefs: value.allowedObjectRefs, versionRule: value.versionRule ?? null });
  }
  if (value.requiredArtifactVersionRefs === true) {
    output.push({ fieldSelector: `${path}/requiredArtifactVersionRefs`, allowedObjectRefs: value.objectRefs ?? [], versionRule: "requiredArtifactVersionRefs=true" });
  }
  for (const [key, child] of Object.entries(value)) walkSchema(child, `${path}/${key}`, output);
  return output;
}

function walkResultVersions(value, path, inheritedArtifactType = null, output = []) {
  if (!value || typeof value !== "object") return output;
  const artifactType = value.properties?.artifactType?.const ?? inheritedArtifactType;
  const payload = value.properties?.payload;
  if (artifactType && payload?.properties) {
    for (const [fieldName, fieldSchema] of Object.entries(payload.properties)) {
      if (fieldSchema?.format !== "opaque-version-id") continue;
      output.push({
        fieldName,
        artifactType,
        boundObjectRefs: outputTypeByArtifactType.get(artifactType) ?? [],
        fieldSelector: `${path}/properties/payload/properties/${fieldName}`,
      });
    }
  }
  for (const [key, child] of Object.entries(value)) {
    walkResultVersions(child, `${path}/${key}`, artifactType, output);
  }
  return output;
}

const semanticObjectByField = new Map([
  ["sourceArtifactVersionId", ["media.domain.artifact-version"]],
  ["artifactVersionId", ["media.domain.artifact-version"]],
  ["transcriptVersionId", ["media.domain.transcript-version"]],
  ["captionVersionId", ["media.domain.caption-version"]],
  ["leftCaptionVersionId", ["media.domain.caption-version"]],
  ["rightCaptionVersionId", ["media.domain.caption-version"]],
  ["projectRevisionId", ["media.domain.project-revision"]],
  ["revisionId", ["media.domain.project-revision"]],
  ["originalSourceArtifactVersionId", ["media.domain.artifact-version"]],
]);

function collectSemanticVersionFields(value, path, output = []) {
  if (!value || typeof value !== "object") return output;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}/${key}`;
    if (/requiredFields$/iu.test(key) && Array.isArray(child)) {
      child.forEach((fieldName, index) => {
        let boundObjectRefs = semanticObjectByField.get(fieldName);
        if (fieldName === "parentVersionId") boundObjectRefs = (value.parentVersionKindValues ?? []).flatMap((kind) => kind === "TRANSCRIPT_VERSION"
          ? ["media.domain.transcript-version"]
          : kind === "CAPTION_VERSION" ? ["media.domain.caption-version"] : []);
        if (typeof fieldName === "string" && boundObjectRefs) {
          output.push({
            fieldName,
            boundObjectRefs,
            fieldSelector: `${childPath}/${index}`,
            semanticBranch: childPath.split("/").slice(-2, -1)[0] ?? null,
          });
        }
      });
    } else if (child && typeof child === "object") {
      collectSemanticVersionFields(child, childPath, output);
    }
  }
  return output;
}

function collectResultSemanticVersionFields(outputSemantics, path) {
  const names = outputSemantics?.successFields ?? outputSemantics?.requiredFields ?? [];
  return names.flatMap((fieldName, index) => {
    let boundObjectRefs = semanticObjectByField.get(fieldName);
    if (fieldName === "parentVersionId") boundObjectRefs = ["media.domain.transcript-version", "media.domain.caption-version"];
    return boundObjectRefs ? [{
      fieldName,
      boundObjectRefs,
      fieldSelector: `${path}/${outputSemantics?.successFields ? "successFields" : "requiredFields"}/${index}`,
      semanticDisposition: "EXACT_OWNER_RESULT_FIELD; IDENTITY_FIELD_TYPE_FROM_CANONICAL_OBJECT_CONTRACT",
    }] : [];
  });
}

function operationSchemaBinding(operationRef) {
  const entry = operationById.get(operationRef);
  if (!entry) return { operationRef, contractRef: null, requestSchemaRef: null, requestReferenceFields: [], disposition: "EXACT_OPERATION_CONTRACT_NOT_RESOLVED" };
  const { row, collection } = entry;
  const requestSchema = row.requestSchema ?? row.ownerWireSchema?.requestSchema ?? row.inputSchema ?? null;
  const resultSchema = row.resultSchema ?? row.ownerWireSchema?.resultSchema ?? null;
  const schemaPath = row.requestSchema
    ? "requestSchema"
    : row.ownerWireSchema?.requestSchema
      ? "ownerWireSchema/requestSchema"
      : row.inputSchema
        ? "inputSchema"
        : null;
  return {
    operationRef,
    contractRef: `${operationsPath}#${collection}/@id=${operationRef}`,
    requestSchemaRef: schemaPath ? `${operationsPath}#${collection}/@id=${operationRef}/${schemaPath}` : null,
    requestReferenceFields: requestSchema ? walkSchema(requestSchema, "") : [],
    requestSemanticFields: row.inputSemantics
      ? collectSemanticVersionFields(row.inputSemantics, `${operationsPath}#${collection}/@id=${operationRef}/inputSemantics`)
      : (row.requestSchema?.required ?? row.ownerWireSchema?.requestSchema?.required ?? [])
        .map((name, index) => ({ name, index }))
        .filter(({ name }) => semanticObjectByField.has(name))
        .map(({ name, index }) => ({
          fieldName: name,
          boundObjectRefs: semanticObjectByField.get(name),
          fieldSelector: `${operationsPath}#${collection}/@id=${operationRef}/${row.requestSchema ? "requestSchema/required" : "ownerWireSchema/requestSchema/required"}/${index}`,
          semanticBranch: null,
        })),
    resultVersionFields: [
      ...(resultSchema
        ? walkResultVersions(resultSchema, `${operationsPath}#${collection}/@id=${operationRef}/${row.ownerWireSchema?.resultSchema ? "ownerWireSchema/resultSchema" : "resultSchema"}`)
        : []),
      ...(row.outputSemantics
        ? collectResultSemanticVersionFields(row.outputSemantics, `${operationsPath}#${collection}/@id=${operationRef}/outputSemantics`)
        : []),
    ],
    resultSemanticsRef: row.outputSemantics ? `${operationsPath}#${collection}/@id=${operationRef}/outputSemantics` : null,
    affectedObjectRefs: [...new Set([
      ...(row.domainObjectRefs ?? []),
      ...(row.affectedObjects?.exactBindings ?? []),
      ...(row.affectedObjects?.referencedObjects ?? []),
    ])],
    disposition: requestSchema ? "OWNER_REQUEST_SCHEMA_RESOLVED"
      : row.inputSemantics ? "OWNER_REQUEST_SEMANTICS_RESOLVED" : "OWNER_REQUEST_SCHEMA_NOT_PRESENT",
  };
}

const records = [];
for (const filename of journeyFiles) {
  const path = `${experienceRoot}/journey-contracts/${filename}`;
  const journeyContract = readYaml(path);
  const journeyRef = journeyContract.journeyId;
  for (const [index, step] of journeyContract.steps.entries()) {
    const sourceRef = `${path}#/steps/${index}`;
    const oracleJoin = oracleBySourceRef.get(sourceRef);
    if (!oracleJoin) throw new Error(`No exact oracle binding for ${sourceRef}`);
    const { step: oracleStep } = oracleJoin;
    const operationRefs = [...new Set([
      ...(oracleStep.canonicalBindings?.primaryOperationRefs ?? []),
      ...(oracleStep.canonicalBindings?.operationRefs ?? []),
      ...(oracleStep.canonicalBindings?.supportingObservationOperationRefs ?? []),
    ])];
    const operationBindings = operationRefs.map(operationSchemaBinding);
    const objectBindings = (step.objectRefs ?? []).map((objectRef) => {
      const identity = identityByObject.get(objectRef);
      if (!identity) return { objectRef, identityContractRef: null, identityTupleFields: [], versionTupleFields: [], disposition: "IDENTITY_CONTRACT_NOT_RESOLVED" };
      const tuple = identity.canonicalIdentityTuple ?? [];
      const versionTupleFields = tuple.filter((field) => /(?:version|revision)/iu.test(field));
      return {
        objectRef,
        identityContractRef: `${identitiesPath}#ownerTypedIdentityContracts/records/@id=${identity.id}`,
        identityTupleFields: tuple,
        identityTupleComponentsRef: `${identitiesPath}#ownerTypedIdentityContracts/records/@id=${identity.id}/identityComponents`,
        versionTupleFields,
        disposition: versionTupleFields.length ? "EXACT_VERSION_IDENTITY_TUPLE_REQUIRED" : "IDENTITY_HAS_NO_VERSION_COMPONENT",
      };
    });
    const versionedObjects = objectBindings.filter((binding) => binding.versionTupleFields.length > 0).map((binding) => binding.objectRef);
    const versionFieldBindings = versionedObjects.map((objectRef) => {
      const fields = operationBindings.flatMap((operation) => [
        ...operation.requestReferenceFields
        .filter((field) => field.allowedObjectRefs.includes(objectRef))
        .map((field) => ({
          direction: "REQUEST",
          operationRef: operation.operationRef,
          requestSchemaRef: operation.requestSchemaRef,
          fieldSelector: `${operation.requestSchemaRef}${field.fieldSelector}`,
          versionRule: field.versionRule,
          requiredVersionBinding: "P3_OWNER_REQUIRES_COMPLETE_CANONICAL_VERSION_IDENTITY_TUPLE_FOR_THIS_OBJECT",
        })),
        ...operation.requestSemanticFields
          .filter((field) => field.boundObjectRefs.includes(objectRef))
          .map((field) => ({
            direction: "REQUEST",
            operationRef: operation.operationRef,
            requestSchemaRef: operation.requestSchemaRef,
            fieldSelector: field.fieldSelector,
            fieldName: field.fieldName,
            boundObjectRefs: field.boundObjectRefs,
            semanticBranch: field.semanticBranch,
            versionRule: "P1 inputSemantics names an exact version or parent field; this Media binding joins it to the exact object identity tuple.",
            requiredVersionBinding: "P3_OWNER_REQUIRES_COMPLETE_CANONICAL_VERSION_IDENTITY_TUPLE_FOR_THIS_OBJECT",
          })),
        ...operation.resultVersionFields
          .filter((field) => field.boundObjectRefs?.includes(objectRef))
          .map((field) => ({
            direction: "OWNER_RESULT",
            operationRef: operation.operationRef,
            requestSchemaRef: operation.requestSchemaRef,
            resultSchemaRef: operation.resultSemanticsRef,
            fieldSelector: field.fieldSelector,
            fieldName: field.fieldName,
            artifactType: field.artifactType ?? null,
            boundObjectRefs: field.boundObjectRefs,
            semanticDisposition: field.semanticDisposition ?? null,
            versionRule: "P1 result schema exposes this owner-issued version field; it is not a runtime receipt.",
            requiredVersionBinding: "OWNER_ISSUED_VERSION_IDENTITY; NOT_A_RUNTIME_RECEIPT",
          })),
      ]);
      let coverageDisposition;
      if (fields.length) {
        coverageDisposition = "EXACT_VERSION_REQUEST_OR_RESULT_FIELD_BOUND";
      } else if (journeyRef === "J-29" && objectRef === "media.domain.consent-reference") {
        coverageDisposition = "CANONICAL_CONSENT_REVISION_TUPLE_REQUIRED; SESSION_AND_RIGHTS_READ_SOURCES_DO_NOT_EXPOSE_A_TYPED_CONSENT_REVISION_JOIN; MISSING_OR_STALE_JOIN_IS_UNKNOWN";
      } else if (journeyRef === "J-02" && index + 1 === 2 && objectRef === "media.domain.artifact-version") {
        coverageDisposition = "NOT_APPLICABLE_BEFORE_OWNER_ISSUED_ARTIFACT_VERSION; BEGIN_UPLOAD_RETURNS_UPLOAD_SESSION_ONLY; IDENTITY_BINDS_AT_COMPLETE_UPLOAD_STEP";
      } else if (journeyRef === "J-03" && index + 1 === 8 && objectRef === "media.domain.artifact-version") {
        coverageDisposition = "ARTIFACT_VERSION_IS_TRANSITIVE_THROUGH_EXACT_CAPTION_VERSION_IDENTITY; COMPARISON_RESULT_HAS_NO_DIRECT_TYPED_SOURCE_VERSION_FIELD; DO_NOT_INFER_SOURCE_VERSION";
      } else {
        coverageDisposition = "VERSIONED_OBJECT_HAS_NO_SOURCE_BOUND_REQUEST_OR_RESULT_VERSION_FIELD; KEEP_VERSION_OBSERVATION_UNKNOWN";
      }
      return {
        id: `media.step-version-object-binding.${journeyRef.toLowerCase()}-${String(index + 1).padStart(2, "0")}.${objectRef.replace(/^media\.domain\./u, "").replace(/[^a-z0-9]+/giu, "-")}.v1`,
        objectRef,
        fields,
        coverageDisposition,
        exactVersionTupleRequirement: objectBindings.find((binding) => binding.objectRef === objectRef)?.versionTupleFields ?? [],
        transitiveVersionJoins: journeyRef === "J-03" && index + 1 === 8 && objectRef === "media.domain.artifact-version"
          ? [{
            id: "media.step-version-transitive-join.j-03-08.caption-source.v1",
            operationRef: "media.operation.caption-version-read",
            operationContractRef: `${operationsPath}#operations/@id=media.operation.caption-version-read`,
            selectorBranchRef: `${operationsPath}#operations/@id=media.operation.caption-version-read/inputSemantics/selectorBranches/EXACT_PAIR`,
            exactInputFieldNames: ["leftCaptionVersionId", "rightCaptionVersionId"],
            resultFieldSelectors: [
              `${operationsPath}#operations/@id=media.operation.caption-version-read/outputSemantics/EXACT_PAIR/requiredFields/0`,
              `${operationsPath}#operations/@id=media.operation.caption-version-read/outputSemantics/EXACT_PAIR/requiredFields/1`,
            ],
            captionVersionIdentityRef: `${identitiesPath}#ownerTypedIdentityContracts/records/@id=media.identity-contract.caption-version`,
            sourceArtifactVersionTupleField: "sourceArtifactVersionId",
            joinRule: "Both exact-caption-version references must resolve complete canonical caption-version tuples and their sourceArtifactVersionId values must equal the requested exact artifact-version tuple; matching labels, text, or sourceIdentityComparison alone cannot establish this join.",
            absentOrMismatchedDisposition: "UNKNOWN",
            sourceResultLimitation: "P1 output semantics name left/right caption-version references but do not type their nested identity payload; no current runtime join is claimed.",
            runtimeAdmission: "NOT_ADMITTED",
          }]
          : [],
        canonicalVersionIdentityRequirement: (() => {
          const identity = identityByObject.get(objectRef);
          if (!identity) return null;
          return {
            identityContractRef: `${identitiesPath}#ownerTypedIdentityContracts/records/@id=${identity.id}`,
            identityComponentsRef: `${identitiesPath}#ownerTypedIdentityContracts/records/@id=${identity.id}/identityComponents`,
            exactTupleFields: identity.canonicalIdentityTuple,
            tupleComparison: "ALL_IDENTITY_COMPONENTS_MUST_MATCH_THE_SAME_EXACT_OWNER_ISSUED_VERSION; NO_LATEST_ALIAS_OR_CROSS_TENANT_JOIN",
            trustedContextFields: identity.identityComponents
              .filter(({ origin }) => origin === "TRUSTED_HOST_CONTEXT")
              .map(({ field }) => field),
            missingOrStaleDisposition: "UNKNOWN",
            foreignTenantOrMixedVersionDisposition: "UNKNOWN",
          };
        })(),
        sourceBoundaryRefs: journeyRef === "J-29" && objectRef === "media.domain.consent-reference"
          ? [
            ".product-experience/pdp-1-domain-data/domain-objects.yaml#ownerTypedIdentityContracts/records/@id=media.identity-contract.consent-reference",
            ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.consent-record-inspect.v1",
            ".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.rights-decision.v1",
          ]
          : journeyRef === "J-03" && index + 1 === 8 && objectRef === "media.domain.artifact-version"
            ? [
              ".product-experience/pdp-1-domain-data/domain-objects.yaml#ownerTypedIdentityContracts/records/@id=media.identity-contract.caption-version",
              ".product-experience/pdp-1-domain-data/operations.yaml#operations/@id=media.operation.caption-version-read/outputSemantics/EXACT_PAIR",
            ]
            : [],
        deferredVersionBinding: journeyRef === "J-02" && index + 1 === 2 && objectRef === "media.domain.artifact-version"
          ? (() => {
            const laterSourceRef = `${path}#/steps/2`;
            const laterOracle = oracleBySourceRef.get(laterSourceRef)?.step;
            const laterOperationRef = laterOracle?.canonicalBindings?.primaryOperationRefs?.find((id) => id === "media.operation-slice.complete-upload");
            const laterOperation = laterOperationRef ? operationSchemaBinding(laterOperationRef) : null;
            const resultField = laterOperation?.resultVersionFields.find((field) => field.boundObjectRefs.includes(objectRef));
            return {
              targetStepRef: laterSourceRef,
              targetStepSemanticDefinitionId: laterOracle?.id ?? null,
              operationRef: laterOperationRef ?? null,
              operationContractRef: laterOperation?.contractRef ?? null,
              ownerResultFieldSelector: resultField?.fieldSelector ?? null,
              ownerIssuedIdentity: "artifactId + versionId; version is first issued by exact upload-completion result",
              runtimeAdmission: "NOT_ADMITTED",
            };
          })()
          : null,
        logicalVersionJoin: journeyRef === "J-29" && objectRef === "media.domain.consent-reference"
          ? {
            id: `media.step-version-logical-join.${journeyRef.toLowerCase()}-${String(index + 1).padStart(2, "0")}.consent-reference.v1`,
            canonicalTuple: ["tenantId", "consentId", "consentRevisionId"],
            consentRevisionField: "consentRevisionId",
            requiredObservation: "A current authority-issued consent reference must echo the complete exact tuple and bind the decision to the same requested subject, purpose, scope, and policy revision.",
            candidateObservationOperationRef: "media.operation.consent-record-inspect.v1",
            candidateObservationContractRef: ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.consent-record-inspect.v1",
            candidateFieldLimitation: "The current inspect result exposes numeric version but does not define it as the opaque consentRevisionId; integer version is not coerced or substituted.",
            missingOrMismatchedTuple: "UNKNOWN; deny consequential continuation until exact consentRevisionId is returned and correlated.",
            runtimeAdmission: "NOT_ADMITTED",
          }
          : journeyRef === "J-03" && index + 1 === 8 && objectRef === "media.domain.artifact-version"
            ? {
              id: "media.step-version-logical-join.j-03-08.caption-source.v1",
              canonicalTuple: ["tenantId", "artifactId", "versionId"],
              supportingJoinId: "media.step-version-transitive-join.j-03-08.caption-source.v1",
              joinRule: "Resolve both exact caption-version refs to full caption-version identity tuples; join each sourceArtifactVersionId to the one requested artifact-version tuple. Both source versions must equal; sourceIdentityComparison text alone is insufficient.",
              missingOrMismatchedTuple: "UNKNOWN",
              transportLimitation: "Current owner output names caption-version references without a typed nested identity payload, so the logical tuple join is required but cannot claim transport parity.",
              runtimeAdmission: "NOT_ADMITTED",
            }
            : null,
        applicabilityContract: journeyRef === "J-02" && index + 1 === 2 && objectRef === "media.domain.artifact-version"
          ? {
            id: "media.step-version-applicability.j-02-02.artifact-version.v1",
            disposition: "NOT_YET_ISSUED_AT_THIS_STEP",
            sourceOperationRef: "media.operation-slice.begin-upload",
            sourceContractRef: ".product-experience/pdp-1-domain-data/operations.yaml#individualOperationContracts/records/@id=media.operation-slice.begin-upload",
            exactDeferredOperationRef: "media.operation-slice.complete-upload",
            exactDeferredResultRef: `${operationsPath}#individualOperationContracts/records/@id=media.operation-slice.complete-upload/ownerWireSchema/resultSchema`,
            rule: "Bind only the upload-session identity at begin-upload. The artifact/version tuple becomes applicable only after the exact completion result issues artifactId and versionId; do not invent a pre-completion version.",
            runtimeAdmission: "NOT_ADMITTED",
          }
          : null,
        runtimeObservationDisposition: fields.length ? "DEFINITION_FIELD_ONLY; runtime NOT_ADMITTED" : "UNKNOWN_UNTIL_EXACT_SOURCE_JOIN_IS_AVAILABLE",
        acceptanceEffect: "none",
      };
    });
    const localEffect = localBySourceRef.get(sourceRef);
    const localCandidateVersionFields = localEffect?.inputContract?.mutation?.candidateSchemaRef
      ? [{
        direction: "LOCAL_SELECTION",
        fieldName: "versionRef",
        operationRef: null,
        requestSchemaRef: `${experienceRoot}/local-step-effect-contracts.yaml#records/@id=${localEffect.id}/inputContract/mutation/candidateSchemaRef`,
        fieldSelector: ".product-experience/pdp-2-design-interface-system/component-value-types.yaml#/$defs/ExactArtifactVersionRef",
        candidateSchemaRef: localEffect.inputContract.mutation.candidateSchemaRef,
        versionRule: "The exact Media-owned local candidate schema resolves versionRef to the full artifact version identity tuple; selection is local draft state only.",
        boundObjectRefs: localEffect.canonicalDomainObjectRefs ?? [],
        requiredVersionBinding: "LOCAL_EXACT_ARTIFACT_VERSION_IDENTITY_SELECTION; NO_DOMAIN_DISPATCH",
      }]
      : [];
    if (localCandidateVersionFields.length) {
      for (const binding of versionFieldBindings) {
        if (binding.objectRef === "media.domain.artifact-version") binding.fields.push(...localCandidateVersionFields);
      }
    }
    const versionDisposition = localEffect
      ? "LOCAL_DRAFT_REVISION_CAS; NOT_CANONICAL_PRODUCT_VERSION"
      : objectBindings.some((binding) => binding.disposition === "IDENTITY_CONTRACT_NOT_RESOLVED")
        ? "CANONICAL_OBJECT_IDENTITY_CONTRACT_NOT_RESOLVED"
        : versionedObjects.length
          ? "EXACT_CANONICAL_VERSION_TUPLE_REQUIRED"
          : (step.objectRefs ?? []).length
            ? "EXACT_STABLE_OBJECT_TUPLE; NO_VERSION_COMPONENT_IN_IDENTITY_SOURCE"
            : "NO_CANONICAL_OBJECT_VERSION_TUPLE_IN_STEP_SOURCE";
    records.push({
      id: `media.step-version-binding.${journeyRef.toLowerCase()}-${String(index + 1).padStart(2, "0")}.v1`,
      journeyRef,
      ordinal: index + 1,
      stepRef: sourceRef,
      stepSemanticDefinitionId: oracleStep.id,
      actionRef: step.actionRef ?? null,
      operationBindings,
      objectBindings,
      versionFieldBindings,
      localDraftRevisionContractRef: localEffect
        ? `${experienceRoot}/local-step-effect-contracts.yaml#records/@id=${localEffect.id}/localRevisionRule`
        : null,
      versionDisposition,
      versionBindingRule: "For a canonical object whose P1 identity tuple contains version/revision fields, every tuple field is required from the exact immutable version applicable to this step. Missing, stale, foreign-tenant, mismatched, or substituted-latest identity is UNKNOWN; it cannot authorize a consequential effect.",
      runtimeAdmission: "NOT_ADMITTED",
      decisionRef: ".product-experience/decision-log.md#PXD-119",
      acceptanceEffect: "none",
    });
  }
}

const document = {
  schemaVersion: "media.pdp-3-step-version-binding-contracts.v1",
  status: "MEDIA_OWNER_DEFINITION_ONLY; object/version request bindings and runtime evidence remain distinct",
  sourceRefs: [
    `${experienceRoot}/step-definition-oracles.yaml`,
    `${experienceRoot}/local-step-effect-contracts.yaml`,
    identitiesPath,
    operationsPath,
  ],
  recordCount: records.length,
  records,
};
writeFileSync(`${experienceRoot}/step-version-binding-contracts.yaml`, stringify(document, { lineWidth: 120, aliasDuplicateObjects: false }));
console.log(JSON.stringify({
  records: records.length,
  dispositions: Object.fromEntries([...new Set(records.map(({ versionDisposition }) => versionDisposition))]
    .map((disposition) => [disposition, records.filter((record) => record.versionDisposition === disposition).length])),
  exactVersionRows: records.filter((record) => record.versionDisposition === "EXACT_CANONICAL_VERSION_TUPLE_REQUIRED").length,
  versionedObjectWithoutVersionRequestField: records.flatMap((record) => record.versionFieldBindings
    .filter(({ fields }) => fields.length === 0).map(({ objectRef }) => `${record.id}:${objectRef}`)),
}, null, 2));
