#!/usr/bin/env node
/**
 * Offline provenance checks for a future Whisper ONNX export.
 * The default mode is metadata-only. Explicit --verify-artifacts mode hashes
 * bounded, already-present local files; neither mode downloads, deserializes,
 * executes, or infers with a checkpoint, converter, or model. Hashing is not
 * rights approval, model parity, quality qualification, or provider admission.
 * Local artifact verification assumes cooperative inputs in checkpoint-parent,
 * artifact-root, and run directories owned by this user and not group/world
 * writable; ancestor and same-user concurrent path races are not race-proof.
 */
import { constants } from 'node:fs';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const catalogPath = join(root, 'config/qualification/wave2-reference-candidates.v1.json');
export const MANIFEST_SCHEMA = 'ghatana.media.whisper-onnx-export-manifest.v1';
const SHA256 = /^[a-f0-9]{64}$/u;
const EXPECTED_ID = 'stt-whisper-tiny-multilingual';
// Total cap includes both runs' encoder and decoder files. Hashing uses fixed-size
// chunks, so this is a read ceiling rather than an allocation size.
export const MAX_TOTAL_OUTPUT_BYTES = 1_073_741_824;
const HASH_CHUNK_BYTES = 1024 * 1024;

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function text(value, max = 2048) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && !/[\x00-\x1f\x7f]/u.test(value);
}
function digest(value) { return typeof value === 'string' && SHA256.test(value); }
function exactKeys(value, expected, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) fail(code);
}
function safeArgument(value) {
  return text(value, 200)
    && /^[A-Za-z0-9_.:=+-]+$/u.test(value)
    && !/(?:transcript|hypothesis|prediction|secret|credential|password|authorization|api[-_]?key|bearer|sk-[A-Za-z0-9]{12,}|AKIA[A-Z0-9]{16})/iu.test(value);
}

function sameDescriptor(left, right) {
  return left.name === right.name
    && left.version === right.version
    && left.sourceRevision === right.sourceRevision
    && left.dependencyLockSha256 === right.dependencyLockSha256
    && left.argv.length === right.argv.length
    && left.argv.every((argument, index) => argument === right.argv[index]);
}

function sameEnvironment(left, right) {
  return left.python === right.python
    && left.platform === right.platform
    && left.dependencyLockSha256 === right.dependencyLockSha256;
}

function officialCandidate(catalog) {
  const candidate = catalog?.candidates?.find(item => item.id === EXPECTED_ID);
  if (!candidate || candidate.status !== 'REVIEW_ONLY'
      || candidate.sourceType !== 'PYTORCH_CHECKPOINT_NOT_ONNX'
      || !digest(candidate.artifactSha256)
      || !candidate.upstreamUrl?.endsWith(`/${candidate.artifactSha256}/tiny.pt`)) {
    fail('OFFICIAL_CHECKPOINT_PIN_MISSING_OR_CHANGED');
  }
  const tokenizer = catalog.candidates.find(item => item.id === 'stt-whisper-multilingual-tokenizer');
  const mel = candidate.compatibleOnnxExport?.frontendAsset;
  if (!digest(tokenizer?.artifactSha256) || !digest(mel?.sha256)) fail('FRONTEND_ASSET_PINS_MISSING');
  return { candidate, tokenizer, mel };
}

function validateDescriptor(value) {
  exactKeys(value, ['name', 'version', 'sourceRevision', 'dependencyLockSha256', 'argv'], 'UNKNOWN_CONVERTER_FIELDS');
  return text(value.name, 200) && /^[A-Za-z0-9_.+-]+$/u.test(value.name)
    && text(value.version, 200) && /^[A-Za-z0-9_.+-]+$/u.test(value.version)
    && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.sourceRevision)
    && digest(value.dependencyLockSha256)
    && Array.isArray(value.argv) && value.argv.length > 0 && value.argv.length <= 128
    && value.argv.every(safeArgument);
}

/** Validate declarations only. Caller-supplied artifact paths are never opened or hashed. */
export function checkWhisperExportManifest(manifest, { catalog } = {}) {
  const { candidate, tokenizer, mel } = officialCandidate(catalog);
  exactKeys(manifest, ['schemaVersion', 'candidateId', 'status', 'admissionClaim', 'sourceCheckpoint', 'frontend', 'exportConfig', 'runs'], 'UNKNOWN_MANIFEST_FIELDS');
  exactKeys(manifest.sourceCheckpoint, ['url', 'sha256', 'format'], 'UNKNOWN_CHECKPOINT_FIELDS');
  exactKeys(manifest.frontend, ['tokenizerSha256', 'melFiltersSha256'], 'UNKNOWN_FRONTEND_FIELDS');
  exactKeys(manifest.exportConfig, ['architecture', 'opset', 'quantization', 'dynamicAxes'], 'UNKNOWN_EXPORT_CONFIG_FIELDS');
  if (manifest?.schemaVersion !== MANIFEST_SCHEMA || manifest.candidateId !== candidate.id
      || manifest.status !== 'REVIEW_ONLY' || manifest.admissionClaim !== 'NONE') {
    fail('INVALID_OR_PROMOTING_EXPORT_MANIFEST');
  }
  if (manifest.sourceCheckpoint?.url !== candidate.upstreamUrl
      || manifest.sourceCheckpoint?.sha256 !== candidate.artifactSha256
      || manifest.sourceCheckpoint?.format !== 'PYTORCH_CHECKPOINT_NOT_ONNX') {
    fail('SOURCE_CHECKPOINT_DOES_NOT_MATCH_OFFICIAL_PIN');
  }
  if (manifest.frontend?.tokenizerSha256 !== tokenizer.artifactSha256
      || manifest.frontend?.melFiltersSha256 !== mel.sha256) fail('FRONTEND_INPUT_PIN_MISMATCH');
  if (!/^[0-9]+$/u.test(manifest.exportConfig?.opset)
      || !/^[A-Za-z0-9_.+-]+$/u.test(manifest.exportConfig?.architecture)
      || !/^[A-Za-z0-9_.+-]+$/u.test(manifest.exportConfig?.quantization)
      || !Array.isArray(manifest.exportConfig?.dynamicAxes)
      || manifest.exportConfig.dynamicAxes.length === 0
      || !manifest.exportConfig.dynamicAxes.every(axis => typeof axis === 'string' && /^[A-Za-z0-9_.+-]+$/u.test(axis))) fail('INCOMPLETE_EXPORT_CONFIGURATION');
  if (!Array.isArray(manifest.runs) || manifest.runs.length !== 2) fail('TWO_RUN_DECLARATIONS_REQUIRED');
  const runIds = new Set();
  const outputsByRun = [];
  for (const run of manifest.runs) {
    exactKeys(run, ['id', 'converter', 'environment', 'artifacts'], 'UNKNOWN_EXPORT_RUN_FIELDS');
    exactKeys(run.environment, ['python', 'platform', 'dependencyLockSha256'], 'UNKNOWN_EXPORT_ENVIRONMENT_FIELDS');
    if (!/^[A-Za-z0-9_-]{1,80}$/u.test(run.id) || runIds.has(run.id) || !validateDescriptor(run.converter)
        || !/^[A-Za-z0-9_.+-]{1,100}$/u.test(run.environment?.python)
        || !/^[A-Za-z0-9_.+-]{1,200}$/u.test(run.environment?.platform)
        || run.environment?.dependencyLockSha256 !== run.converter.dependencyLockSha256
        || !Array.isArray(run.artifacts) || run.artifacts.length !== 2) {
      fail('INCOMPLETE_EXPORT_RUN_PROVENANCE');
    }
    runIds.add(run.id);
    const roles = new Set();
    const outputs = new Map();
    for (const artifact of run.artifacts) {
      exactKeys(artifact, ['role', 'path', 'sha256', 'sizeBytes'], 'UNKNOWN_EXPORTED_ARTIFACT_FIELDS');
      if (!['encoder', 'decoder'].includes(artifact.role) || roles.has(artifact.role)
          || !text(artifact.path, 512) || !digest(artifact.sha256)
          || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0) {
        fail('INVALID_EXPORTED_ARTIFACT_RECORD');
      }
      if (artifact.path !== `${run.id}/${artifact.role}.onnx`) fail('NONCANONICAL_EXPORT_ARTIFACT_PATH');
      roles.add(artifact.role);
      outputs.set(artifact.role, `${artifact.sizeBytes}:${artifact.sha256}`);
    }
    if (roles.size !== 2) fail('MISSING_ENCODER_OR_DECODER_OUTPUT');
    outputsByRun.push({ run, outputs });
  }
  const [first, second] = outputsByRun;
  if (!sameDescriptor(first.run.converter, second.run.converter)
      || !sameEnvironment(first.run.environment, second.run.environment)
      || ['encoder', 'decoder'].some(role => first.outputs.get(role) !== second.outputs.get(role))) {
    fail('DECLARED_EXPORT_RUNS_DISAGREE');
  }
  return {
    candidateId: candidate.id,
    pinnedSourceCheckpointSha256: candidate.artifactSha256,
    exportRoles: ['decoder', 'encoder'],
    verificationMode: 'DECLARATION_ONLY_NO_ARTIFACT_IO',
    artifactBytesInspected: false,
    status: 'EXPORT_METADATA_CHECKED_REVIEW_ONLY',
    declaredRunCount: 2,
    declaredOutputDigestRecordsAgree: true,
    rightsApproved: false,
    parityQualified: false,
    inferenceAdmitted: false,
  };
}

function statSignature(stat) {
  return [stat.dev, stat.ino, stat.uid, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

function checkLocalDirectory(path, code, expectedCanonical) {
  let stat;
  try { stat = lstatSync(path, { bigint: true }); } catch { fail(code); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !ownerControlled(stat)) fail(code);
  let canonical;
  try { canonical = realpathSync(path); } catch { fail(code); }
  if (expectedCanonical !== undefined && canonical !== expectedCanonical) fail(code);
  return canonical;
}

function ownerControlled(stat) {
  const mode = Number(stat.mode);
  const currentUid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : undefined;
  return (mode & 0o022) === 0 && (currentUid === undefined || stat.uid === currentUid);
}

function safeArtifactFile(stat) {
  return stat.isFile() && ownerControlled(stat);
}

function safeOpenFlags() {
  if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number') fail('SAFE_OPEN_FLAGS_UNAVAILABLE');
  return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    | (typeof constants.O_NOCTTY === 'number' ? constants.O_NOCTTY : 0);
}

function hashBoundedRegularFile(path, maxBytes, sizeMismatchCode, digestMismatchCode, expectedSize, expectedDigest) {
  const flags = safeOpenFlags();
  let fd;
  try {
    let pathStat;
    try { pathStat = lstatSync(path, { bigint: true }); } catch { fail('ARTIFACT_FILE_UNAVAILABLE'); }
    if (!safeArtifactFile(pathStat) || pathStat.isSymbolicLink()) fail('UNSAFE_ARTIFACT_FILE');
    try { fd = openSync(path, flags); }
    catch (error) {
      if (error?.code === 'ELOOP') fail('UNSAFE_ARTIFACT_FILE');
      fail('ARTIFACT_FILE_UNAVAILABLE');
    }
    const before = fstatSync(fd, { bigint: true });
    if (!safeArtifactFile(before)) fail('UNSAFE_ARTIFACT_FILE');
    if (before.size > BigInt(maxBytes)) fail('ARTIFACT_SIZE_LIMIT_EXCEEDED');
    if (expectedSize !== undefined && before.size !== BigInt(expectedSize)) fail(sizeMismatchCode);
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let total = 0n;
    while (total < before.size) {
      const wanted = Number(before.size - total > BigInt(chunk.length) ? BigInt(chunk.length) : before.size - total);
      const count = readSync(fd, chunk, 0, wanted, Number(total));
      if (count === 0) fail('ARTIFACT_CHANGED_DURING_READ');
      hash.update(chunk.subarray(0, count));
      total += BigInt(count);
    }
    const after = fstatSync(fd, { bigint: true });
    if (statSignature(before) !== statSignature(after) || total !== after.size) fail('ARTIFACT_CHANGED_DURING_READ');
    const sha256 = hash.digest('hex');
    if (expectedDigest !== undefined && sha256 !== expectedDigest) fail(digestMismatchCode);
    return { sizeBytes: Number(total), sha256 };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Hash only explicitly supplied local files, using bounded streaming reads. */
export function verifyWhisperExportArtifacts(manifest, { catalog, checkpointFile, artifactRoot } = {}) {
  const metadata = checkWhisperExportManifest(manifest, { catalog });
  if (typeof checkpointFile !== 'string' || !checkpointFile || typeof artifactRoot !== 'string' || !artifactRoot) {
    fail('INVALID_ARTIFACT_VERIFICATION_ARGUMENTS');
  }
  let declaredTotal = 0;
  for (const run of manifest.runs) {
    for (const artifact of run.artifacts) {
      if (artifact.sizeBytes > MAX_TOTAL_OUTPUT_BYTES - declaredTotal) fail('TOTAL_OUTPUT_SIZE_LIMIT_EXCEEDED');
      declaredTotal += artifact.sizeBytes;
    }
  }
  const candidate = catalog.candidates.find(item => item.id === EXPECTED_ID);
  const canonicalCheckpoint = resolve(checkpointFile);
  checkLocalDirectory(dirname(canonicalCheckpoint), 'UNSAFE_CHECKPOINT_DIRECTORY');
  const checkpoint = hashBoundedRegularFile(canonicalCheckpoint, candidate.maxBytes,
    'CHECKPOINT_SIZE_MISMATCH', 'CHECKPOINT_DIGEST_MISMATCH', undefined, candidate.artifactSha256);

  const canonicalRoot = checkLocalDirectory(resolve(artifactRoot), 'UNSAFE_ARTIFACT_ROOT');
  const outputFiles = [];
  const runProvenance = [];
  for (const run of manifest.runs) {
    const runDirectory = join(canonicalRoot, run.id);
    checkLocalDirectory(runDirectory, 'UNSAFE_ARTIFACT_DIRECTORY', runDirectory);
    const actualArtifacts = [];
    for (const artifact of run.artifacts) {
      if (isAbsolute(artifact.path) || artifact.path.split(/[\\/]/u).includes('..')) fail('NONCANONICAL_EXPORT_ARTIFACT_PATH');
      const artifactPath = resolve(canonicalRoot, artifact.path);
      const relativePath = relative(canonicalRoot, artifactPath);
      if (!relativePath || relativePath.startsWith(`..${sep}`) || relativePath === '..') fail('NONCANONICAL_EXPORT_ARTIFACT_PATH');
      const actual = hashBoundedRegularFile(artifactPath, MAX_TOTAL_OUTPUT_BYTES,
        'EXPORTED_ARTIFACT_SIZE_MISMATCH', 'EXPORTED_ARTIFACT_DIGEST_MISMATCH', artifact.sizeBytes, artifact.sha256);
      outputFiles.push(actual);
      actualArtifacts.push({ role: artifact.role, sha256: actual.sha256, sizeBytes: actual.sizeBytes });
      // Recheck directory identity after opening/reading each child to catch path replacement.
      checkLocalDirectory(runDirectory, 'ARTIFACT_DIRECTORY_CHANGED_DURING_READ', runDirectory);
    }
    runProvenance.push({
      id: run.id,
      converter: run.converter,
      environment: run.environment,
      artifacts: actualArtifacts,
    });
  }
  const totalOutputBytes = outputFiles.reduce((sum, item) => sum + item.sizeBytes, 0);
  if (totalOutputBytes !== declaredTotal) fail('EXPORTED_ARTIFACT_SIZE_MISMATCH');
  return {
    ...metadata,
    verificationMode: 'LOCAL_BOUNDED_ARTIFACT_HASHES',
    artifactBytesInspected: true,
    status: 'REVIEW_ONLY',
    checkpointVerified: true,
    checkpointSizeBytes: checkpoint.sizeBytes,
    provenance: {
      sourceCheckpoint: { sha256: checkpoint.sha256, sizeBytes: checkpoint.sizeBytes },
      frontend: {
        tokenizerSha256: manifest.frontend.tokenizerSha256,
        melFiltersSha256: manifest.frontend.melFiltersSha256,
      },
      exportConfig: manifest.exportConfig,
      runs: runProvenance,
    },
    outputArtifactCount: outputFiles.length,
    totalOutputBytes,
    totalOutputByteCap: MAX_TOTAL_OUTPUT_BYTES,
    rightsApproved: false,
    parityQualified: false,
    inferenceAdmitted: false,
  };
}

function parseJson(path) {
  const flags = safeOpenFlags();
  let fd;
  try {
    let pathStat;
    try { pathStat = lstatSync(path); } catch { fail('UNSAFE_OR_OVERSIZED_JSON'); }
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) fail('UNSAFE_OR_OVERSIZED_JSON');
    try {
      fd = openSync(path, flags);
    } catch (error) {
      if (error?.code === 'ELOOP') fail('UNSAFE_OR_OVERSIZED_JSON');
      throw error;
    }
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > 2_000_000) fail('UNSAFE_OR_OVERSIZED_JSON');
    const contents = readFileSync(fd, 'utf8');
    const after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || Buffer.byteLength(contents, 'utf8') !== after.size) {
      fail('JSON_CHANGED_DURING_READ');
    }
    return JSON.parse(contents);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
async function main() {
  const args = process.argv.slice(2);
  const verify = args.includes('--verify-artifacts');
  let manifestPath;
  let checkpointFile;
  let artifactRoot;
  if (!verify && args.length === 2 && args[0] === '--manifest' && args[1]) {
    manifestPath = args[1];
  } else if (verify && args.length === 7 && args[0] === '--verify-artifacts'
      && args[1] === '--manifest' && args[2] && args[3] === '--checkpoint-file' && args[4]
      && args[5] === '--artifact-root' && args[6]) {
    manifestPath = args[2]; checkpointFile = args[4]; artifactRoot = args[6];
  } else fail('INVALID_CHECKER_ARGUMENTS');
  const manifest = parseJson(resolve(manifestPath));
  const catalog = parseJson(catalogPath);
  const result = verify
    ? verifyWhisperExportArtifacts(manifest, { catalog, checkpointFile, artifactRoot })
    : checkWhisperExportManifest(manifest, { catalog });
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(JSON.stringify({ status: 'BLOCKED', reason: error.code || 'INVALID_MANIFEST' }));
    process.exitCode = 1;
  });
}
