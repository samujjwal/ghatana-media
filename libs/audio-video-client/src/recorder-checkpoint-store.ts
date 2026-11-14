import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type {
  CaptureAdapterEligibility,
  CaptureRequest,
  CapturedFrame,
} from "./capture-adapters.js";
import {
  executeScenario,
  selectSceneCaptureWork,
  type OrchestrationResult,
  type ScenarioExecutionRecord,
  type SceneAttemptRecord,
  type SceneRun,
} from "./recorder-orchestrator.js";

const MAX_CHECKPOINT_BYTES = 2_000_000;
const MAX_CHECKPOINT_ATTEMPTS = 1024;
const MAX_SOURCE_BYTES = 16_777_216;
const CHECKPOINT_SOURCE_KINDS = new Set([
  "BROWSER", "DESKTOP", "MOBILE", "TERMINAL", "HTTP_API", "GRPC_API", "CAMERA", "MEDIA_FILE",
]);

function isBoundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 384
    && value.trim() === value;
}

export interface RecorderCheckpoint {
  readonly schemaVersion: 1;
  readonly scenarioId: string;
  readonly revision: string;
  readonly planIdentity: string;
  readonly attempts: readonly SceneAttemptRecord[];
  readonly sceneRuns: readonly SceneRun[];
  readonly updatedAtEpochMillis: number;
}

export class RecorderCheckpointError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RecorderCheckpointError";
  }
}

export class FileRecorderCheckpointStore {
  public constructor(private readonly path: string) {
    if (!path || path.trim() !== path) throw new RecorderCheckpointError("checkpoint path is required");
  }


  public async withExclusiveWriter<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    let lock;
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new RecorderCheckpointError("checkpoint writer lock exists; reconcile owner state before removing it");
      }
      throw error;
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, acquiredAtEpochMillis: Date.now() }));
      await lock.sync();
      return await operation();
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }

  public async read(): Promise<RecorderCheckpoint | null> {
    let bytes: string;
    try {
      bytes = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (Buffer.byteLength(bytes, "utf8") > MAX_CHECKPOINT_BYTES) {
      throw new RecorderCheckpointError("checkpoint exceeds size bound");
    }
    let value: unknown;
    try { value = JSON.parse(bytes); }
    catch { throw new RecorderCheckpointError("checkpoint is invalid JSON"); }
    if (!isCheckpoint(value)) throw new RecorderCheckpointError("checkpoint has invalid shape");
    return value;
  }

  public async writeSourceBytes(bytes: Uint8Array): Promise<string> {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_SOURCE_BYTES) {
      throw new RecorderCheckpointError(`source frame must contain 1..${MAX_SOURCE_BYTES} bytes`);
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    const sourceDirectory = `${this.path}.sources`;
    const destination = `${sourceDirectory}/${digest}.bin`;
    await mkdir(sourceDirectory, { recursive: true });
    try {
      await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(destination);
      if (createHash("sha256").update(existing).digest("hex") !== digest) {
        throw new RecorderCheckpointError("stored source frame failed its digest check");
      }
    }
    return digest;
  }

  public async readSourceBytes(digest: string): Promise<Uint8Array> {
    if (!/^[0-9a-f]{64}$/u.test(digest)) throw new RecorderCheckpointError("source digest is invalid");
    const bytes = await readFile(`${this.path}.sources/${digest}.bin`);
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_SOURCE_BYTES
      || createHash("sha256").update(bytes).digest("hex") !== digest) {
      throw new RecorderCheckpointError("stored source frame failed its digest check");
    }
    return new Uint8Array(bytes);
  }

  public async write(checkpoint: RecorderCheckpoint): Promise<void> {
    if (!isCheckpoint(checkpoint)) throw new RecorderCheckpointError("checkpoint has invalid shape");
    const body = JSON.stringify(checkpoint);
    if (Buffer.byteLength(body, "utf8") > MAX_CHECKPOINT_BYTES) {
      throw new RecorderCheckpointError("checkpoint exceeds size bound");
    }
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, this.path);
    } catch (error) {
      const { rm } = await import("node:fs/promises");
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

function isCheckpoint(value: unknown): value is RecorderCheckpoint {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<RecorderCheckpoint>;
  const sceneIds = new Set<string>();
  const validSceneRuns = Array.isArray(record.sceneRuns) && record.sceneRuns.length <= 256
    && record.sceneRuns.every((run) => {
      if (!isSceneRun(run) || sceneIds.has(run.sceneId)) return false;
      sceneIds.add(run.sceneId);
      return true;
    });
  return record.schemaVersion === 1 && typeof record.scenarioId === "string"
    && typeof record.revision === "string" && typeof record.planIdentity === "string"
    && isBoundedText(record.scenarioId) && isBoundedText(record.revision)
    && record.planIdentity.length > 0 && record.planIdentity.length <= 1_048_576
    && Number.isSafeInteger(record.updatedAtEpochMillis) && (record.updatedAtEpochMillis as number) >= 0
    && Array.isArray(record.attempts) && validSceneRuns
    && record.attempts.length <= MAX_CHECKPOINT_ATTEMPTS && record.attempts.every((attempt) => {
      if (!attempt || typeof attempt !== "object") return false;
      const item = attempt as SceneAttemptRecord;
      if (!isBoundedText(item.sceneId) || !isBoundedText(item.lineageId)
        || !isBoundedText(item.sourceRevision) || !Number.isSafeInteger(item.attemptedAtEpochMillis)
        || item.attemptedAtEpochMillis < 0 || !Number.isSafeInteger(item.capturedBytes)
        || item.capturedBytes < 0 || item.capturedBytes > MAX_SOURCE_BYTES) return false;
      if (item.outcome === "CAPTURED") {
        return typeof item.sourceDigest === "string" && /^[0-9a-f]{64}$/u.test(item.sourceDigest)
          && item.capturedBytes > 0;
      }
      return (item.outcome === "NOT_ADMITTED" || item.outcome === "OUTCOME_UNKNOWN")
        && item.sourceDigest === null && item.capturedBytes === 0;
    });
}

function isSceneRun(value: unknown): value is SceneRun {
  if (!value || typeof value !== "object") return false;
  const run = value as SceneRun;
  const source = run.capturePlan;
  return isBoundedText(run.sceneId) && isBoundedText(run.sourceRevision)
    && isBoundedText(run.lineageId) && Number.isSafeInteger(run.durationMillis)
    && run.durationMillis >= 1 && run.durationMillis <= 3_600_000
    && !!source && typeof source === "object" && CHECKPOINT_SOURCE_KINDS.has(source.kind)
    && isBoundedText(source.sourceIdentity) && isBoundedText(source.purposeRef)
    && isBoundedText(source.exactRightsScope) && isBoundedText(source.sourceVersionRef)
    && isBoundedText(source.secretsRef) && isBoundedText(source.frameClockRef)
    && Array.isArray(run.actorBindings) && run.actorBindings.length <= 64
    && run.actorBindings.every((actor) => !!actor && typeof actor === "object"
      && isBoundedText(actor.actorId) && isBoundedText(actor.role))
    && Array.isArray(run.narration) && run.narration.length <= 256
    && run.narration.every((cue) => !!cue && typeof cue === "object"
      && Number.isSafeInteger(cue.atMillis) && cue.atMillis >= 0 && cue.atMillis <= run.durationMillis
      && isBoundedText(cue.trackRef))
    && Array.isArray(run.captionRefs) && run.captionRefs.length <= 256
    && run.captionRefs.every(isBoundedText);
}

export interface ScenarioResumeResult {
  readonly checkpoint: RecorderCheckpoint;
  readonly reusedSceneIds: readonly string[];
  readonly reconciliationRequiredSceneIds: readonly string[];
}

async function resumeScenarioLocked(
  plan: OrchestrationResult,
  store: FileRecorderCheckpointStore,
  eligibility: CaptureAdapterEligibility,
  adapter: { capture(request: CaptureRequest): Promise<CapturedFrame> },
): Promise<ScenarioResumeResult> {
  const prior = await store.read();
  if (prior && prior.scenarioId !== plan.scenarioId) {
    throw new RecorderCheckpointError("checkpoint belongs to a different scenario");
  }
  const attempts: SceneAttemptRecord[] = [...(prior?.attempts ?? [])];
  const previousPlan: OrchestrationResult | null = prior ? {
    scenarioId: prior.scenarioId,
    revision: prior.revision,
    planIdentity: prior.planIdentity,
    sceneRuns: prior.sceneRuns,
    dryRunOnly: true,
  } : null;
  const selection = selectSceneCaptureWork(previousPlan ?? plan, plan, attempts);
  const verifiedReuse = new Set(selection.reuse);
  const localSourceReconciliation = new Set<string>();
  // A digest-shaped checkpoint claim is not enough to reuse a captured scene.
  // Missing/corrupt bytes require reconciliation; never redispatch capture.
  for (const sceneId of selection.reuse) {
    const captured = [...attempts].reverse().find((attempt) => attempt.sceneId === sceneId
      && attempt.outcome === "CAPTURED");
    if (!captured?.sourceDigest) continue;
    let valid = false;
    try {
      const bytes = await store.readSourceBytes(captured.sourceDigest);
      valid = bytes.byteLength === captured.capturedBytes;
    } catch {
      valid = false;
    }
    if (!valid) {
      verifiedReuse.delete(sceneId);
      localSourceReconciliation.add(sceneId);
    }
  }
  const persist = () => store.write({
    schemaVersion: 1,
    scenarioId: plan.scenarioId,
    revision: plan.revision,
    planIdentity: plan.planIdentity,
    attempts,
    sceneRuns: plan.sceneRuns,
    updatedAtEpochMillis: Date.now(),
  });
  for (const sceneId of selection.recapture) {
    if (attempts.length + 2 > MAX_CHECKPOINT_ATTEMPTS) {
      throw new RecorderCheckpointError("checkpoint attempt history reached its bound");
    }
    const run = plan.sceneRuns.find((candidate) => candidate.sceneId === sceneId)!;
    attempts.push({
      sceneId,
      lineageId: run.lineageId,
      sourceRevision: run.sourceRevision,
      outcome: "OUTCOME_UNKNOWN",
      sourceDigest: null,
      capturedBytes: 0,
      attemptedAtEpochMillis: Date.now(),
    });
    await persist();
    const execution: ScenarioExecutionRecord = await executeScenario(plan, eligibility, adapter, {
      sceneIds: [sceneId],
      onCaptured: async (_run, frame) => { await store.writeSourceBytes(frame.bytes); },
    });
    const nextAttempt = execution.attempts[0]!;
    attempts.push(nextAttempt);
    await persist();
  }
  await persist();
  const checkpoint = (await store.read())!;
  const finalSelection = selectSceneCaptureWork(plan, plan, checkpoint.attempts);
  return {
    checkpoint,
    reusedSceneIds: [...verifiedReuse],
    reconciliationRequiredSceneIds: [...new Set([
      ...finalSelection.reconcile,
      ...localSourceReconciliation,
    ])],
  };
}


export function resumeScenarioFromCheckpoint(
  plan: OrchestrationResult,
  store: FileRecorderCheckpointStore,
  eligibility: CaptureAdapterEligibility,
  adapter: { capture(request: CaptureRequest): Promise<CapturedFrame> },
): Promise<ScenarioResumeResult> {
  return store.withExclusiveWriter(() => resumeScenarioLocked(plan, store, eligibility, adapter));
}
