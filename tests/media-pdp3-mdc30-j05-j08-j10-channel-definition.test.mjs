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

  assert.match(evidence.get("J-05").sourceGroundedInputs, /exact-artifactId-and-versionId/u);
  assert.match(evidence.get("J-05").blockedSemantics.join(" "), /selected frame\/region/u);
  assert.match(evidence.get("J-05").blockedSemantics.join(" "), /same-job terminal/u);

  assert.match(evidence.get("J-08").sourceGroundedInputs, /nonempty-unique-metricRefs/u);
  assert.match(evidence.get("J-08").blockedSemantics.join(" "), /original-versus-candidate/u);
  assert.match(evidence.get("J-08").blockedSemantics.join(" "), /matched measured result/u);
  assert.match(evidence.get("J-08").unknownAndDenied, /preview/u);

  assert.match(evidence.get("J-10").sourceGroundedInputs, /exact-immutable-source-version/u);
  assert.match(evidence.get("J-10").blockedSemantics.join(" "), /each selected condition/u);
  assert.match(evidence.get("J-10").unknownAndDenied, /AI unavailability/u);

  // These source-backed inputs and envelopes are deliberately partial. Keep
  // each package's missing result join explicit so a capability envelope or
  // generic owner receipt cannot be promoted to terminal journey evidence.
  assert.match(evidence.get("J-05").sourceGroundedResult, /capability-result-envelope/u);
  assert.match(evidence.get("J-05").blockedSemantics.join(" "), /no same-job terminal analysis observation identity/u);
  assert.match(evidence.get("J-08").sourceGroundedResult, /typed-quality-observation/u);
  assert.match(evidence.get("J-08").blockedSemantics.join(" "), /no original-versus-candidate version pair, evaluation algorithm context/u);
  assert.match(evidence.get("J-08").blockedSemantics.join(" "), /cannot satisfy terminalSuccess/u);
  assert.match(evidence.get("J-10").sourceGroundedResult, /capability-result-envelope/u);
  assert.match(evidence.get("J-10").blockedSemantics.join(" "), /does not bind each selected condition/u);
  assert.match(evidence.get("J-10").blockedSemantics.join(" "), /does not make it a required action/u);
});
