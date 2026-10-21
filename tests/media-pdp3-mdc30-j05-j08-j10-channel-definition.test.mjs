import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const toolsRequire = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = toolsRequire("yaml");
const p3 = ".product-experience/pdp-3-product-experience/journey-contracts";
const contracts = new Map([
  ["J-05", `${p3}/analyze-image-video-geometry-and-tracks.yaml`],
  ["J-08", `${p3}/repair-video-with-measured-quality.yaml`],
  ["J-10", `${p3}/generate-from-references-and-review-continuity.yaml`],
]);
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));

test("MDC30 C05/C08/C10 keep channel definitions source-bounded and fail closed", () => {
  const evidence = new Map([...contracts].map(([id, path]) => [id, readYaml(path).channelDefinitionEvidence]));

  for (const [id, contract] of evidence) {
    assert.equal(contract.status, "SOURCE_GROUNDED_PARTIAL; TRANSPORT_UNBOUND; RUNTIME_NOT_ADMITTED", id);
    assert.ok(contract.sourceRefs.length > 0, `${id} names its P1/P2 authority`);
    for (const ref of contract.sourceRefs) {
      const sourcePath = ref.split("#", 1)[0];
      assert.ok(existsSync(resolve(root, sourcePath)), `${id} source exists: ${sourcePath}`);
    }
    assert.ok(contract.blockedSemantics.length > 0, `${id} records unsupported joins`);
    assert.match(contract.unknownAndDenied, /UNKNOWN|denied|abstention/u);
  }

  assert.match(evidence.get("J-05").sourceGroundedInputs, /exact image-or-video artifactId\/versionId/iu);
  assert.match(evidence.get("J-05").sourceGroundedInputs, /frameSelectors/u);
  assert.match(evidence.get("J-05").sourceGroundedInputs, /regionSelectors/u);
  assert.match(evidence.get("J-05").sourceGroundedResult, /temporalScope, spatialScope/u);
  assert.match(evidence.get("J-05").blockedSemantics.join(" "), /typed inline observations, not a durable observation object/u);
  assert.equal(
    evidence.get("J-05").sourceObservationBinding.schemaRef,
    ".product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/outputPayloadSchemas/@id=media.typed-output.typed-visual-analysis-result-with-applicability-and-uncertainty",
  );
  assert.match(evidence.get("J-05").unknownAndDenied, /NOT_REPORTED\/UNKNOWN provenance/u);
  assert.match(evidence.get("J-05").unknownAndDenied, /submission or transport acknowledgement/u);

  assert.match(evidence.get("J-08").sourceGroundedInputs, /nonempty unique metricRefs/u);
  assert.match(evidence.get("J-08").sourceGroundedResult, /original\/candidate versions/u);
  assert.match(evidence.get("J-08").sourceGroundedResult, /one ordered metricResults row per requested metric/u);
  assert.match(evidence.get("J-08").blockedSemantics.join(" "), /exact original and candidate subjects/u);
  assert.match(evidence.get("J-08").blockedSemantics.join(" "), /no channel transport/u);
  assert.match(evidence.get("J-08").unknownAndDenied, /preview/u);

  assert.match(evidence.get("J-10").sourceGroundedInputs, /exact image artifactId\/versionId/u);
  assert.match(evidence.get("J-10").sourceGroundedInputs, /output width\/height, rational frameRate/u);
  assert.match(evidence.get("J-10").sourceGroundedResult, /jobId/u);
  assert.match(evidence.get("J-10").sourceGroundedResult, /does not provide the candidate artifactId\/versionId/u);
  assert.match(evidence.get("J-10").blockedSemantics.join(" "), /same-version join/u);
  assert.match(evidence.get("J-10").unknownAndDenied, /AI unavailability/u);
  assert.match(evidence.get("J-10").unknownAndDenied, /no retry or fallback is inferred/u);

  // These source-backed inputs and envelopes are deliberately partial. Keep
  // each package's missing result join explicit so a capability envelope or
  // generic owner receipt cannot be promoted to terminal journey evidence.
  assert.match(evidence.get("J-05").sourceGroundedResult, /Capability envelope/u);
  assert.match(evidence.get("J-05").blockedSemantics.join(" "), /not a durable observation object, lifecycle/u);
  assert.match(evidence.get("J-08").sourceGroundedResult, /P1 v2 candidate-metric-pair/u);
  assert.match(evidence.get("J-08").sourceGroundedResult, /both side statuses\/currentness/u);
  assert.match(evidence.get("J-08").blockedSemantics.join(" "), /does not derive delta, direction, threshold, pass\/fail, aggregate, rank, winner, improvement, or qualification/u);
  assert.match(evidence.get("J-10").sourceGroundedResult, /Generation envelope/u);
  assert.match(evidence.get("J-10").blockedSemantics.join(" "), /not each mapped to explicit request fields/u);
  assert.match(evidence.get("J-10").blockedSemantics.join(" "), /Assessment is not proof that each generation condition was met/u);
});
