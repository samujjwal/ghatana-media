import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const operationsPath = ".product-experience/pdp-1-domain-data/operations.yaml";
const parityPath = ".product-experience/interface-parity/operation-parity.yaml";
const canonicalCliPath = ".product-experience/pdp-3-product-experience/cli-command-registry.yaml";
const fixtureCliPath = ".product-experience/pdp-3-product-experience/cli/command-registry.yaml";
const cliSourcePath = "libs/media-experience-simulation/src/cli.ts";
const uiSourcePath = "libs/audio-video-ui/src/screens/TranscriptCaptionScreen.tsx";
const modelSourcePath = "libs/media-experience-simulation/src/model.ts";
const actionRegistryPath = ".product-experience/pdp-3-product-experience/action-registry.yaml";
const reducerSourcePath = "libs/media-experience-simulation/src/index.ts";
const sdkSourcePath = "libs/audio-video-client/src/operations.ts";

const read = (path) => readFileSync(path, "utf8");
const operationIds = ["media.operation.caption-version-write", "media.operation.caption-version-read"];
const bindings = [
  {
    operation: operationIds[0],
    action: "media.action.save-caption-version",
    actionType: "DOMAIN_COMMAND",
    cliId: "media.cli.caption.save-version",
    fixtureId: "media.fixture-cli.caption-save-version",
    command: "caption save-version",
    actionResult: 'actionResult("media.cli.caption.save-version", {\n      type: "media.action.save-caption-version",',
    inputMarkers: ["--draft-version", "--purpose", "state.captionDraft.versionId", 'parsed.options["--purpose"]!.length > 240', 'typeof value.purpose === "string"'],
    uiMarker: 'actionPort.invoke("media.action.save-caption-version", purpose ? { purpose } : {});',
    effectMarkers: ["registeredCaptionVersions: [...state.registeredCaptionVersions, versionId]", "captionHistory: [...state.captionHistory, registeredVersion]"],
    finalityMarkers: ["A new caption version is saved; it has not been delivered or published."],
    actionContractMarkers: ["effect: append-a-new-immutable-caption-version-with-exact-parent-and-required-registration-provenance-metadata; no-provenance-export", "finality: internal-version-registration-only; no-delivery-or-publication"],
    authorityMarkers: ["state.access.registerDerivedVersion", "rights-and-retention-rechecked"],
    idempotencyMarker: "no-idempotency-key-or-deduplication; each repeated permitted fixture action appends a distinct generated version",
    errorCodes: ["VERSION_REGISTRATION_NOT_ALLOWED", "SOURCE_NOT_READY", "CAPTION_DRAFT_EMPTY", "CAPTION_VERSION_CONFLICT", "CAPTION_ALIGNMENT_REQUIRED"],
  },
  {
    operation: operationIds[1],
    action: "media.action.compare-caption-versions",
    actionType: "DOMAIN_QUERY",
    cliId: "media.cli.caption.compare-versions",
    fixtureId: "media.fixture-cli.caption-compare-versions",
    command: "caption compare-versions",
    actionResult: 'actionResult("media.cli.caption.compare-versions", {\n      type: "media.action.compare-caption-versions",',
    inputMarkers: ["--left-version", "--right-version", 'readonly leftVersionId: string', 'readonly rightVersionId: string'],
    uiMarker: 'actionPort.invoke("media.action.compare-caption-versions", {',
    effectMarkers: ["const sameSource = left.sourceArtifactVersion === right.sourceArtifactVersion", "return result(state, [], sameSource"],
    finalityMarkers: ["The selected caption versions share the same source recording version.", "The selected caption versions use different source recording versions; differences may not be comparable."],
    actionContractMarkers: ["effect: show-text-timing-provenance-and-source-version-differences-without-changing-either-version", "finality: read-only"],
    authorityMarkers: ["state.access.readSource", "left.versionId === right.versionId"],
    idempotencyMarker: "read-only-fixture-repeat-does-not-mutate-versions; no-transport-or-production-retry-guarantee-established",
    errorCodes: ["SOURCE_READ_NOT_ALLOWED", "CAPTION_VERSIONS_NOT_COMPARABLE"],
  },
];

const blockById = (text, indent, id, idField = "id") => {
  const starts = [...text.matchAll(new RegExp(`^${indent}- ${idField}: ([^\\n]+)\\n`, "gmu"))];
  const index = starts.findIndex((match) => match[1] === id);
  if (index < 0) return null;
  const from = starts[index].index + starts[index][0].length;
  const to = starts[index + 1]?.index ?? text.length;
  return text.slice(from, to);
};

function validate({ operations, parity, canonicalCli, cliSource, uiSource, modelSource, reducerSource, actionRegistry, sdkSource }) {
  const errors = [];
  for (const item of bindings) {
    const operation = blockById(operations, "  ", item.operation);
    const cli = blockById(canonicalCli, "  ", item.cliId);
    if (!operation) errors.push(`missing canonical operation ${item.operation}`);
    if (!cli) errors.push(`missing canonical CLI identity ${item.cliId}`);
    if (operation && !operation.includes(`actionRefs: [${item.action}]`)) errors.push(`${item.operation}: exact actionRef missing`);
    if (operation && !operation.includes(`family: [${item.actionType === "DOMAIN_COMMAND" ? "save-caption-version" : "compare-caption-versions"}]`)) errors.push(`${item.operation}: command/query identity is not exact`);
    if (operation && !operation.includes(`identity: ${item.action}`)) errors.push(`${item.operation}: UI action identity missing`);
    if (operation && !operation.includes(`identity: ${item.cliId}`)) errors.push(`${item.operation}: source-observed CLI identity missing`);
    if (operation && !operation.includes(`identity: ${item.fixtureId}`)) errors.push(`${item.operation}: unbound fixture registry identity must remain visible`);
    if (operation && !operation.includes("SDK: {value: null, status: no-dedicated-source-method; remains-unresolved}")) errors.push(`${item.operation}: SDK identity must remain unresolved`);
    if (operation && !operation.includes("HTTP: unresolved") || operation && !operation.includes("gRPC: unresolved")) errors.push(`${item.operation}: unsupported transport binding promoted`);
    if (operation && !operation.includes("canonicalAcceptance: pending-media-owner-and-runtime-conformance-review")) errors.push(`${item.operation}: local observations must not mark external operation acceptance complete`);
    if (operation && !operation.includes("scopeStatus: proposal-only")) errors.push(`${item.operation}: proposal-only status must remain explicit`);
    if (operation && !operation.includes(item.idempotencyMarker)) errors.push(`${item.operation}: source-supported idempotency limits must remain explicit`);
    if (operation && !operation.includes("authorization: unresolved")) errors.push(`${item.operation}: production authority must remain unresolved`);
    if (cli && !cli.includes(`actionRef: ${item.action}`)) errors.push(`${item.cliId}: CLI actionRef mismatch`);
    if (cli && !cli.includes(`operationRef: ${item.operation}`)) errors.push(`${item.cliId}: CLI operationRef mismatch`);
    if (cli && !cli.includes("production-cli-runtime-not-connected")) errors.push(`${item.cliId}: production CLI scope must remain explicit`);
    const actionBlock = blockById(actionRegistry, "", item.action);
    if (!actionBlock) errors.push(`${item.operation}: source action record missing`);
    else for (const marker of item.actionContractMarkers) if (!actionBlock.includes(marker)) errors.push(`${item.operation}: action semantics drift at ${marker}`);
    const typedActionBlock = blockById(parity, "  ", item.action, "identity");
    if (!typedActionBlock) errors.push(`${item.operation}: typed UI action disposition missing`);
    else if (!typedActionBlock.includes(`type: ${item.actionType}`)) errors.push(`${item.operation}: typed UI action no longer classifies as ${item.actionType}`);
    if (!cliSource.includes(item.actionResult)) errors.push(`${item.operation}: parser does not emit exact CLI identity/action pair`);
    if (!uiSource.includes(item.uiMarker)) errors.push(`${item.operation}: UI source does not dispatch exact action identity`);
    for (const marker of item.inputMarkers) {
      if (!cliSource.includes(marker) && !modelSource.includes(marker) && !reducerSource.includes(marker)) errors.push(`${item.operation}: input/version source drift at ${marker}`);
    }
    if (operation) for (const code of item.errorCodes) if (!operation.includes(code)) errors.push(`${item.operation}: observed error ${code} missing`);
    if (reducerSource.includes("media.effect.caption-version-registered")) {
      for (const code of item.errorCodes) if (!reducerSource.includes(`"${code}"`)) errors.push(`${item.operation}: fixture handler source drift at ${code}`);
    }
    for (const marker of item.effectMarkers) if (!reducerSource.includes(marker)) errors.push(`${item.operation}: fixture effect source drift at ${marker}`);
    for (const marker of item.finalityMarkers) if (!reducerSource.includes(marker)) errors.push(`${item.operation}: fixture finality source drift at ${marker}`);
    for (const marker of item.authorityMarkers) if (!reducerSource.includes(marker) && !actionRegistry.includes(marker)) errors.push(`${item.operation}: authority/precondition source drift at ${marker}`);
  }
  if (!parity.includes("denominator: 146") || !parity.includes("operationBindingCounts: {mappedProposal: 14, ambiguous: 0, unresolved: 132}")) errors.push("UI action denominator/count must remain 14/146 exact refs proposed and 132 without exact refs; six owner-approved intent associations are a separate overlay");
  if (!parity.includes("registryPopulation: 12") || !parity.includes("operationBindingCounts: {mappedProposal: 2, unresolved: 0}")) errors.push("caption-version CLI slice must remain 2/2 mapped within the 12-record registry");
  if (!parity.includes("semanticOperationBinding: unresolved-for-all-11-fixture-identities")) errors.push("fixture CLI namespace must remain unbound");
  if (!sdkSource.includes("export class MediaOperationClient") || /(?:saveCaptionVersion|compareCaptionVersions|caption\.save-version|caption\.compare-versions)/u.test(sdkSource)) errors.push("SDK must not claim a caption-version method without source evidence");
  return errors;
}

const base = {
  operations: read(operationsPath),
  parity: read(parityPath),
  canonicalCli: read(canonicalCliPath),
  cliSource: read(cliSourcePath),
  uiSource: read(uiSourcePath),
  modelSource: read(modelSourcePath),
  reducerSource: read(reducerSourcePath),
  actionRegistry: read(actionRegistryPath),
  sdkSource: read(sdkSourcePath),
};

test("caption save and compare operations bind only exact source-supported UI and CLI identities", () => {
  assert.deepEqual(validate(base), []);
});

test("source parity rejects missing operation, wrong CLI crosswalk, and missing required version input", () => {
  assert.match(validate({ ...base, operations: base.operations.replace("id: media.operation.caption-version-write", "id: media.operation.caption-version-write-stale") }).join("\n"), /missing canonical operation media\.operation\.caption-version-write/u);
  assert.match(validate({ ...base, canonicalCli: base.canonicalCli.replace("operationRef: media.operation.caption-version-write", "operationRef: media.operation.synthesis") }).join("\n"), /media\.cli\.caption\.save-version: CLI operationRef mismatch/u);
  assert.match(validate({ ...base, modelSource: base.modelSource.replace("readonly rightVersionId: string", "readonly rightRef: string") }).join("\n"), /input\/version source drift at readonly rightVersionId: string/u);
});

test("source parity rejects mismatched command/action dispatch and stale error semantics", () => {
  const mismatchedDispatch = bindings[0].actionResult.replace("media.action.save-caption-version", "media.action.correct-caption");
  assert.match(validate({ ...base, cliSource: base.cliSource.replace(bindings[0].actionResult, mismatchedDispatch) }).join("\n"), /parser does not emit exact CLI identity\/action pair/u);
  assert.match(validate({ ...base, operations: base.operations.replaceAll("CAPTION_VERSIONS_NOT_COMPARABLE", "CAPTION_VERSION_MISSING") }).join("\n"), /observed error CAPTION_VERSIONS_NOT_COMPARABLE missing/u);
  assert.match(validate({ ...base, parity: base.parity.replace("type: DOMAIN_QUERY\n    sourceRecord: .product-experience/pdp-3-product-experience/action-registry.yaml#actions[media.action.compare-caption-versions]", "type: DOMAIN_COMMAND\n    sourceRecord: .product-experience/pdp-3-product-experience/action-registry.yaml#actions[media.action.compare-caption-versions]") }).join("\n"), /typed UI action no longer classifies as DOMAIN_QUERY/u);
});

test("source parity rejects fixture-namespace and unsupported SDK/transport promotion", () => {
  assert.match(validate({ ...base, parity: base.parity.replace("semanticOperationBinding: unresolved-for-all-11-fixture-identities", "semanticOperationBinding: proposed") }).join("\n"), /fixture CLI namespace must remain unbound/u);
  assert.match(validate({ ...base, operations: base.operations.replace("SDK: {value: null, status: no-dedicated-source-method; remains-unresolved}", "SDK: media.sdk.saveCaptionVersion") }).join("\n"), /SDK identity must remain unresolved/u);
  assert.match(validate({ ...base, operations: base.operations.replace("pending-media-owner-and-runtime-conformance-review", "accepted") }).join("\n"), /must not mark external operation acceptance complete/u);
  assert.match(validate({ ...base, operations: base.operations.replace("no-idempotency-key-or-deduplication", "idempotent-with-production-deduplication") }).join("\n"), /source-supported idempotency limits must remain explicit/u);
  assert.match(validate({ ...base, sdkSource: `${base.sdkSource}\npublic saveCaptionVersion() {}` }).join("\n"), /SDK must not claim a caption-version method/u);
});
