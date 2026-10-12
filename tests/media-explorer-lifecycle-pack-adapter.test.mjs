import assert from "node:assert/strict";
import test from "node:test";
import { consumeLifecyclePackCandidate, lifecyclePackCandidateProtocol } from "../apps/media-experience-explorer/src/lifecycle-pack-adapter.js";

const page = (items = []) => ({ items, total: items.length, offset: 0, limit: 50, nextOffset: null });
function payload(surfaceId, kind) {
  return {
    schemaVersion: lifecyclePackCandidateProtocol.envelopeVersion,
    mode: "OBSERVATION",
    readOnly: true,
    pack: {
      schemaVersion: lifecyclePackCandidateProtocol.packVersion,
      surface: { id: surfaceId, kind, admissionStatus: "PROPOSED_OWNER_ADMISSION", acceptanceDecision: null, programId: "media.test-program", boundPrograms: ["media.test-program"], unitIdentityPrefix: null, title: surfaceId },
      program: { programId: "media.test-program", title: "Test only", phases: [{ id: "PDP-0", title: "Product Truth", pdpPhase: "PDP-0" }] },
      hierarchy: { rootId: "media.composition.repository-root", parents: [], breadcrumbs: [], multiParent: false, children: page(), watchedChildren: page() },
      phases: [{ id: "PDP-0", pdpPhase: "PDP-0", title: "Product Truth", applicability: "APPLICABLE", rationale: null, declaredStatus: null, unitIdentity: null, definition: null }],
      selectedPhase: null,
      journeys: page(),
      channels: ["HEADLESS"],
      experience: null,
      sources: { requirements: null, descriptor: null, experience: null, phaseBinding: null },
      provenance: { sourceDigests: {}, lazy: true },
    },
  };
}

const consume = (selection, pack = payload(selection.surfaceId, selection.kind)) => consumeLifecyclePackCandidate({
  source: lifecyclePackCandidateProtocol.source,
  payload: pack,
  selector: { surfaceId: selection.surfaceId, programId: "media.test-program" },
});

test("negotiates and reads physical, composition, and root source candidates without changing payloads", () => {
  const selections = [
    { surfaceId: "media.physical.launcher", kind: "PHYSICAL" },
    { surfaceId: "media.composition.governed-job-execution", kind: "COMPOSITION" },
    { surfaceId: "media.composition.repository-root", kind: "REPOSITORY" },
  ];
  for (const selection of selections) {
    const candidate = payload(selection.surfaceId, selection.kind);
    const before = structuredClone(candidate);
    const result = consume(selection, candidate);
    assert.equal(result.ok, true);
    assert.equal(result.mode, "TEST_ONLY");
    assert.equal(result.nativeLifecycleStatus, "NOT_ADMITTED");
    assert.deepEqual(candidate, before);
  }
});

test("rejects unknown source, unsupported protocol, selector mismatch, and non-read-only observations", () => {
  const base = payload("media.physical.launcher", "PHYSICAL");
  assert.equal(consumeLifecyclePackCandidate({ source: "OTHER", payload: base, selector: { surfaceId: "media.physical.launcher", programId: "media.test-program" } }).reason, "UNSUPPORTED_SOURCE");
  const unknownVersion = structuredClone(base);
  unknownVersion.pack.schemaVersion = "ghatana.surface-experience-pack.v2";
  assert.equal(consume({ surfaceId: "media.physical.launcher", kind: "PHYSICAL" }, unknownVersion).reason, "UNSUPPORTED_PACK_VERSION");
  assert.equal(consumeLifecyclePackCandidate({ source: lifecyclePackCandidateProtocol.source, payload: base, selector: { surfaceId: "media.physical.other", programId: "media.test-program" } }).reason, "SELECTOR_MISMATCH");
  const writable = { ...base, readOnly: false };
  assert.equal(consume({ surfaceId: "media.physical.launcher", kind: "PHYSICAL" }, writable).reason, "READ_ONLY_OBSERVATION_REQUIRED");
});

test("rejects malformed exact-schema packs and packs that claim admission", () => {
  const malformed = payload("media.physical.launcher", "PHYSICAL");
  malformed.pack.unexpected = true;
  assert.equal(consume({ surfaceId: "media.physical.launcher", kind: "PHYSICAL" }, malformed).reason, "PACK_SCHEMA_INVALID");
  const admitted = payload("media.physical.launcher", "PHYSICAL");
  admitted.pack.surface.admissionStatus = "ADMITTED";
  admitted.pack.surface.unitIdentityPrefix = "media.physical.launcher::media.test-program";
  assert.equal(consume({ surfaceId: "media.physical.launcher", kind: "PHYSICAL" }, admitted).reason, "SOURCE_CANDIDATE_REQUIRED");
});
