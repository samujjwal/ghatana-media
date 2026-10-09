import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import test from "node:test";

const domainObjectsPath = ".product-experience/pdp-1-domain-data/domain-objects.yaml";
const relationshipsPath = ".product-experience/pdp-1-domain-data/relationships.yaml";
const reconciliationPath = ".product-experience/pdp-1-domain-data/canonical-reconciliation.yaml";
const domainModelPath = ".product-experience/pdp-0-product-truth/domain-model.yaml";

function idsIn(text, indent = "  ") {
  return [...text.matchAll(new RegExp(`^${indent}- id: ([^\\n]+)$`, "gmu"))].map((match) => match[1]);
}

function blockForId(text, id) {
  const marker = `  - id: ${id}`;
  const start = text.indexOf(marker);
  if (start < 0) return "";
  const next = text.indexOf("\n  - id: ", start + marker.length);
  return text.slice(start, next < 0 ? undefined : next);
}

test("PDP-1 canonical references resolve only to catalogued domain objects", () => {
  const domainObjects = readFileSync(domainObjectsPath, "utf8");
  const relationships = readFileSync(relationshipsPath, "utf8");
  const reconciliation = readFileSync(reconciliationPath, "utf8");
  const objectIds = idsIn(domainObjects);

  assert.equal(new Set(objectIds).size, objectIds.length, "domain object IDs must be unique");
  assert.equal(objectIds.length, 39, "the audited domain-object denominator changed; review the identity crosswalk");

  for (const match of reconciliation.matchAll(/^    canonicalRef: ([^\n]+)$/gmu)) {
    assert.ok(objectIds.includes(match[1]), `canonical reconciliation ref ${match[1]} has no domain-object record`);
  }

  for (const match of relationships.matchAll(/^    (?:from|to): (.+)$/gmu)) {
    for (const endpoint of match[1].match(/media\.domain\.[a-z0-9-]+/gu) ?? []) {
      assert.ok(objectIds.includes(endpoint), `relationship endpoint ${endpoint} has no domain-object record`);
    }
  }
});

test("PDP-1 overview reports exact registry count and separates bounded definitions from observed materialization", () => {
  const domainObjects = readFileSync(domainObjectsPath, "utf8");
  const overview = readFileSync(".product-experience/pdp-1-domain-data/DOMAIN-MODEL.md", "utf8");
  const objectIds = idsIn(domainObjects);

  assert.equal(objectIds.length, 39);
  assert.match(overview, /39 domain-object records, 13 value-object/u);
  assert.match(overview, /bounded canonical caption\/transcript version definitions/u);
  assert.match(overview, /local simulation projection\nremains synthetic, not an observed runtime or persistence record/u);
  assert.match(overview, /Legacy transcription UUIDs and provider result IDs do not establish\nthat identity/u);
  assert.match(overview, /no producer, native Lifecycle receipt or full phase acceptance is admitted/u);
});

test("PDP-1 object source references resolve to files and PDP-0 anchors resolve to named records", () => {
  const domainObjects = readFileSync(domainObjectsPath, "utf8");
  const domainModel = readFileSync(domainModelPath, "utf8");
  const domainModelIds = new Set([...domainModel.matchAll(/^  - id: ([^\n]+)$/gmu)].map((match) => match[1]));

  for (const match of domainObjects.matchAll(/^    sourceRefs: \[([^\]]*)\]$/gmu)) {
    for (const rawRef of match[1].split(",")) {
      const ref = rawRef.trim();
      const [path, anchor] = ref.split("#", 2);
      assert.ok(existsSync(path), `source path ${path} exists`);
      assert.ok(statSync(path).isFile(), `source ref ${path} identifies a file`);
      readFileSync(path);
      if (path === domainModelPath && anchor) {
        assert.ok(domainModelIds.has(anchor), `PDP-0 mapping anchor ${anchor} is not a named domain-model record`);
      }
    }
  }
});

test("caption version has bounded immutable domain semantics while the simulation shape remains synthetic", () => {
  const domainObjects = readFileSync(domainObjectsPath, "utf8");
  const fixtureModel = readFileSync("libs/media-experience-simulation/src/model.ts", "utf8");
  const fixtureData = readFileSync("libs/media-experience-simulation/src/fixtures.ts", "utf8");
  const captionVersion = blockForId(domainObjects, "media.domain.caption-version");

  assert.ok(captionVersion, "canonical reconciliation has a matching caption-version catalog target");
  assert.match(captionVersion, /kind: immutable-derived-content-version/u);
  assert.match(captionVersion, /identity: tenantId-plus-sourceArtifactId-plus-sourceArtifactVersionId-plus-opaque-captionVersionId; identity-is-not-a-content-digest/u);
  assert.match(captionVersion, /lineage: exact-source-artifact-version-and-typed-parent-ref-\(TRANSCRIPT_VERSION-or-CAPTION_VERSION\)/u);
  assert.match(captionVersion, /legacy-media\.domain\.transcription-UUID-and-fixture-parentVersionId-are-not-equivalent/u);
  assert.match(captionVersion, /lifecycle: append-only-immutable-after-registration/u);
  assert.match(captionVersion, /registrationBoundary: registration-receipt-and-version-creation-do-not-mean-reviewed-approved-delivered-or-published/u);
  assert.match(captionVersion, /scopeStatus: canonical-owner-semantics-bounded-under-PXD-058; observed-fixture-shape-remains-synthetic; runtime-NOT_ADMITTED/u);
  assert.match(captionVersion, /observedProjection: libs\/media-experience-simulation\/src\/model\.ts#CaptionVersionRecord-and-fixtures; fixture-record-uses-untyped-parentVersionId-and-sourceArtifactVersion-only/u);
  assert.match(fixtureModel, /export interface CaptionVersionRecord[\s\S]*?readonly versionId: string;[\s\S]*?readonly sourceArtifactVersion: string;[\s\S]*?readonly parentVersionId: string;/u);
  assert.match(fixtureData, /captionHistory: \[[\s\S]*?versionId: "caption-v0"[\s\S]*?parentVersionId: "transcript-v1"/u);
  assert.doesNotMatch(fixtureModel, /readonly parentVersionKind:/u, "the synthetic fixture must not be mistaken for the typed canonical parent contract");
});

test("artifact, job, and lease identities preserve the source-specific keys without promoting them", () => {
  const domainObjects = readFileSync(domainObjectsPath, "utf8");
  const typeScript = readFileSync("libs/audio-video-types/src/contracts.ts", "utf8");
  const runtime = readFileSync("runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaRuntimeContracts.java", "utf8");
  const artifactSchema = readFileSync("providers/aws-postgresql/src/main/resources/db/media-runtime/V001__media_runtime_state.sql", "utf8");
  const jobStore = readFileSync("providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/PostgresqlMediaJobStore.java", "utf8");
  const artifact = blockForId(domainObjects, "media.domain.artifact");
  const artifactVersion = blockForId(domainObjects, "media.domain.artifact-version");
  const job = blockForId(domainObjects, "media.domain.processing-job");
  const lease = blockForId(domainObjects, "media.domain.job-lease");

  assert.match(artifact, /identity: bounded-canonical-key-\(tenantId,artifactId\); Java-store-and-PostgreSQL-use-that-pair; TypeScript-and-OpenAPI-observations-retain-tenantId-and-artifactId; caller-scope-also-requires-owning-principal/u);
  assert.match(artifactVersion, /identity: bounded-owner-key-\(tenantId,artifactId,versionId\); versionId-is-a-stable-opaque-immutable-version-identity-separate-from-content-digest/u);
  assert.match(artifactVersion, /separate-runtime-record-and-wire-versionId-not-observed; runtime-NOT_ADMITTED/u);
  assert.match(blockForId(domainObjects, "media.domain.upload-session"), /identity: bounded-canonical-key-\(tenantId,uploadId\); owner-scope-adds-principalId; client-request-key-is-separately-scoped-by-\(tenantId,principalId,idempotencyKey\)/u);
  assert.match(job, /identity: Java-store-key-tenantId-plus-jobId; TypeScript-tenantId-and-id-fields; SQL-primary-key-\(tenant_id,job_id\); cross-interface-canonical-key-unbound/u);
  assert.match(lease, /identity: Java-record-tenantId-plus-jobId-plus-ownerId-plus-fencingToken; PostgreSQL-lease-columns-on-job-row; no-standalone-lease-id/u);
  assert.match(typeScript, /id: IdentifierSchema,[\s\S]*?tenantId: IdentifierSchema,[\s\S]*?checksumSha256/u);
  assert.match(artifactSchema, /PRIMARY KEY \(tenant_id, artifact_id\)[\s\S]*?UNIQUE \(tenant_id, sha256, size_bytes\)/u);
  assert.match(runtime, /public record JobLease\([\s\S]*?String tenantId,[\s\S]*?String jobId,[\s\S]*?String ownerId,[\s\S]*?long fencingToken/u);
  assert.match(jobStore, /UPDATE media_processing_jobs SET lease_owner=\?,lease_token=\?,lease_expires_at=\?/u);
  assert.doesNotMatch(artifact, /bytes-bound-by-digest-and-version/u);
  assert.doesNotMatch(lease, /identity: lease-id-and-fencing-token/u);
});

test("PDP-1 observes the current Media runtime job enum without accepting a canonical mapping", () => {
  const runtime = readFileSync("runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaRuntimeContracts.java", "utf8");
  const stateInventory = readFileSync(".product-experience/pdp-1-domain-data/states.yaml", "utf8");
  const adjudication = readFileSync(".product-experience/pdp-1-domain-data/state-adjudication.yaml", "utf8");
  const reconciliation = readFileSync(".product-experience/pdp-1-domain-data/canonical-reconciliation.yaml", "utf8");
  const runtimeEnum = runtime.match(/public enum JobStatus \{([^}]+)\}/u)?.[1];
  assert.ok(runtimeEnum, "current runtime JobStatus enum must remain discoverable");
  const runtimeValues = runtimeEnum.split(",").map((value) => value.trim());
  const stateRecord = stateInventory.match(/      - source: runtime-contracts\/src\/main\/java\/com\/ghatana\/media\/runtime\/MediaRuntimeContracts\.java#JobStatus\n        values: \[([^\]]+)\]([\s\S]*?)(?=\n      - source:|\n  [^ ]|\n[^ ])/u);
  assert.ok(stateRecord, "PDP-1 state inventory must pin the current runtime enum");
  assert.deepEqual(stateRecord[1].split(",").map((value) => value.trim()), runtimeValues);
  assert.match(stateRecord[2], /canonical job-state mapping/u);
  assert.match(adjudication, /current-runtime-enum-observed; per-state canonical and wire mapping unresolved/u);
  assert.match(adjudication, /ACCEPTED is not evidence of durable job queueing/u);
  assert.match(reconciliation, /Java tenantId\+jobId and JobStatus \[ACCEPTED, RUNNING, OUTCOME_UNKNOWN, COMPLETED, FAILED, CANCELLED\]/u);
  assert.match(reconciliation, /status check includes OUTCOME_UNKNOWN/u);
  const sqlMigration = readFileSync("providers/aws-postgresql/src/main/resources/db/media-runtime/V007__media_job_unknown_outcome.sql", "utf8");
  assert.match(sqlMigration, /'OUTCOME_UNKNOWN'/u);
});
