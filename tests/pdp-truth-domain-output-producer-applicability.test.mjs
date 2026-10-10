import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const read = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const { validateMediaJobReadProjection } = await import("../scripts/pdp-truth-domain-job-read-model.mjs");
const goalsPath = ".product-experience/pdp-0-product-truth/goals-jtbd.yaml";
const capPath = ".product-experience/pdp-0-product-truth/capabilities.yaml";
const measureId = "media.business.trustworthy-versioned-outputs.measure";
const candidate = "APPLICABLE_OUTPUT_PRODUCER_CANDIDATE";
const excluded = "NOT_APPLICABLE_READ_ONLY_OR_NO_OUTPUT_OPERATION";

test("trustworthy-output applicability follows output-producer role and preserves incomplete candidates", () => {
  const goals = read(goalsPath);
  const capabilities = read(capPath).capabilities;
  const contract = goals.successMeasureContracts.records.find(({ id }) => id === measureId);
  const crosswalk = goals.successMeasureContracts.ownerCapabilityApplicabilityCrosswalk;
  const dispositions = new Map(crosswalk.records.map(({ capabilityRef, measureApplicability }) => [capabilityRef, measureApplicability[measureId]]));
  const producerRefs = [...dispositions].filter(([, row]) => row.disposition === candidate).map(([id]) => id).sort();
  const metricRefs = [...contract.capabilityRefs].sort();

  assert.equal(capabilities.length, 462);
  assert.equal(producerRefs.length, 430);
  assert.deepEqual(metricRefs, producerRefs, "metric candidate set is exactly the output-producer disposition set");
  assert.equal(contract.ownerApplicabilityDefinition.sourceCandidateCount, producerRefs.length);
  assert.equal(crosswalk.applicableCandidateCounts[measureId], producerRefs.length);
  assert.ok(contract.capabilityRefs.every((id) => capabilities.find((capability) => capability.id === id).outputArtifactTypes.length > 0), "P0 candidate denominator is grounded in declared output artifact semantics");

  for (const id of [
    "media.project.create",
    "media.project.version",
    "media.project.source-asset.attach",
    "media.deliver.package",
    "media.deliver.subtitles",
    "media.artifact.upload.resume",
    "media.job.submit",
    "media.job.submit",
    "media.job.retry",
    "media.artifact.import",
    "media.artifact.derive",
    "media.artifact.output.register",
    "media.stream.frame.submit",
    "media.stream.live-processing.integrate",
    "media.stream.recording.integrate",
    "media.stream.caption.live",
    "media.stream.transport.hls",
    "media.rights.attestation.record",
    "media.speech.transcription.file",
    "media.vision.detect",
    "media.simulation.output.rgb",
    "media.quality.image.image.assess-noise",
  ]) {
    const row = dispositions.get(id);
    assert.equal(row.disposition, candidate, `${id} is a producer, including when its result identity contract is incomplete`);
    assert.equal(row.capabilityIntentId, id);
    if (!new Set(["media.job.retry", "media.stream.frame.submit", "media.rights.attestation.record"]).has(id)) {
      assert.match(row.reason, /P0 capability intent .* explicitly included in this measure's owner-defined capabilityRefs population/u);
    } else {
      assert.match(row.reason, /P0 capability intent .* explicitly included in this measure's owner-defined capabilityRefs population/u);
    }
    assert.ok(row.sourceRefs.some((ref) => ref === `${capPath}#capabilities/@id=${id}`));
  }

  for (const id of [
    "media.project.inspect",
    "media.project.search",
    "media.artifact.inspect",
    "media.artifact.search",
    "media.artifact.list",
    "media.artifact.source-reference.resolve",
    "media.job.outputs.inspect",
    "media.provenance.source-lineage.inspect",
    "media.provenance.execution-lineage.inspect",
    "media.job.view-status",
    "media.job.list",
    "media.job.cancel",
    "media.profile.validate",
    "media.capability.discover",
    "media.health.readiness.inspect",
    "media.rights.permitted-use.evaluate",
    "media.stream.session.open",
  ]) {
    const row = dispositions.get(id);
    assert.equal(row.disposition, excluded, `${id} observes or controls state without producing Media content`);
    assert.equal(row.capabilityIntentId, id);
    assert.match(row.reason, /P0 capability intent .* is not included in this measure's owner-defined capabilityRefs population/u);
    assert.ok(row.sourceRefs.some((ref) => ref === `${capPath}#capabilities/@id=${id}`));
  }

  const projected = crosswalk.measureApplicabilityRecords.records.filter(({ measureRef }) => measureRef === measureId);
  assert.equal(projected.length, 462);
  for (const { capabilityRef, disposition, reason, capabilityIntentId } of projected) {
    const sourceRow = dispositions.get(capabilityRef);
    assert.equal(disposition, sourceRow.disposition);
    assert.equal(reason, sourceRow.reason);
    assert.equal(capabilityIntentId, capabilityRef);
  }
  assert.match(contract.baseline, /^NOT_EVALUATED;/u);
  assert.equal(contract.qualification, "NOT_EVALUATED");
});
