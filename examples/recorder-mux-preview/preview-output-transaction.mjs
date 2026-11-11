#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

function codedError(code, message, ...causes) {
  const error = causes.length > 0 ? new Error(message, { cause: causes[0] }) : new Error(message);
  error.code = code;
  return error;
}

function errorWithCleanupErrors(primaryError, cleanupErrors) {
  if (primaryError instanceof Error) {
    try {
      primaryError.cleanupErrors = cleanupErrors;
      if (primaryError.cleanupErrors === cleanupErrors) return primaryError;
    } catch {
      // Preserve the original failure as cause when the error cannot hold diagnostics.
    }
  }
  const error = codedError(
    "PREVIEW_TRANSACTION_FAILED",
    "preview operation failed and rollback cleanup also failed",
    primaryError,
  );
  error.cleanupErrors = cleanupErrors;
  return error;
}

function lockPathFor(output) {
  return join(dirname(output), `.${basename(output)}.render-lock`);
}

function stagePrefixFor(output) {
  return `.${basename(output)}.stage-`;
}

async function inspectDestination(output) {
  try {
    const info = await lstat(output);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw codedError("OUTPUT_EXISTS", "output path must be a new or empty directory; existing files are preserved");
    }
    const entries = await readdir(output);
    if (entries.length !== 0) {
      throw codedError("OUTPUT_EXISTS", "output directory must be empty; local preview never overwrites prior files");
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function destinationExists(output) {
  try {
    await lstat(output);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Reserve one local render destination, build into a private sibling directory,
 * and expose the complete file bundle with one same-filesystem directory rename.
 * A crash intentionally leaves the sidecar lock as a fence for operator review.
 */
export async function withPreviewOutputTransaction(outputDir, produce) {
  if (typeof produce !== "function") throw new TypeError("preview producer must be a function");
  const output = resolve(outputDir);
  const parent = dirname(output);
  const leaf = basename(output);
  if (!leaf || output === parent) throw codedError("OUTPUT_INVALID", "output path must name a directory below its parent");
  await mkdir(parent, { recursive: true });

  const lockPath = lockPathFor(output);
  let lockHandle;
  try {
    lockHandle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw codedError("RENDER_IN_PROGRESS", `render destination is fenced by ${lockPath}; inspect its owner before removing a stale lock`, error);
    }
    throw codedError("PREVIEW_FAILED", `could not reserve render destination: ${error?.message ?? error}`, error);
  }

  let lockIdentity;
  const lockRecord = {
    version: 1,
    outputDir: output,
    processId: process.pid,
    invocationId: randomUUID(),
    startedAt: new Date().toISOString(),
  };
  let stage;
  let committed = false;
  let removedEmptyDestination = false;
  let result;
  let hasPrimaryError = false;
  let primaryError;
  const cleanupErrors = [];

  try {
    lockIdentity = await lockHandle.stat();
    await lockHandle.writeFile(`${JSON.stringify(lockRecord, null, 2)}\n`, "utf8");
    await lockHandle.sync();
    removedEmptyDestination = await inspectDestination(output);
    stage = await mkdtemp(join(parent, `${stagePrefixFor(output)}${lockRecord.invocationId}-`));
    result = await produce(stage);
    if ((await readdir(stage)).length === 0) {
      throw codedError("PREVIEW_FAILED", "preview producer returned without creating a complete output bundle");
    }

    if (removedEmptyDestination) await rmdir(output);
    else if (await destinationExists(output)) {
      throw codedError("OUTPUT_EXISTS", "output path appeared while the preview was being prepared; staged files were discarded");
    }

    try {
      await rename(stage, output);
      stage = undefined;
      committed = true;
    } catch (error) {
      if (removedEmptyDestination && !(await destinationExists(output))) {
        try {
          await mkdir(output);
        } catch (restoreError) {
          cleanupErrors.push(codedError("OUTPUT_RESTORE_FAILED", `could not restore the original empty output directory: ${restoreError?.message ?? restoreError}`, restoreError));
        }
      }
      throw codedError("PREVIEW_COMMIT_FAILED", `could not atomically publish the complete preview directory: ${error?.message ?? error}`, error);
    }
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
  }

  if (stage) {
    try {
      await rm(stage, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(codedError("PREVIEW_STAGE_CLEANUP_FAILED", `could not remove preview staging directory ${stage}: ${error?.message ?? error}`, error));
    }
  }

  try {
    await lockHandle.close();
  } catch (error) {
    cleanupErrors.push(codedError("RENDER_LOCK_CLOSE_FAILED", `could not close render lock ${lockPath}: ${error?.message ?? error}`, error));
  }

  try {
    const currentLock = await lstat(lockPath);
    if (!lockIdentity || currentLock.dev !== lockIdentity.dev || currentLock.ino !== lockIdentity.ino) {
      throw codedError("RENDER_LOCK_OWNERSHIP_LOST", `render lock ${lockPath} changed owner; it was preserved`);
    }
    await unlink(lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      cleanupErrors.push(error?.code === "RENDER_LOCK_OWNERSHIP_LOST"
        ? error
        : codedError("RENDER_LOCK_CLEANUP_FAILED", `could not remove render lock ${lockPath}: ${error?.message ?? error}`, error));
    }
  }

  if (hasPrimaryError) {
    if (cleanupErrors.length) throw errorWithCleanupErrors(primaryError, cleanupErrors);
    throw primaryError;
  }
  if (cleanupErrors.length) {
    const error = codedError(
      committed ? "RENDER_COMMITTED_LOCK_CLEANUP_FAILED" : "RENDER_LOCK_CLEANUP_FAILED",
      committed
        ? `preview committed at ${output}, but render-lock cleanup failed; inspect the destination and lock before retrying`
        : `render-lock cleanup failed; inspect ${lockPath} before retrying`,
      new AggregateError(cleanupErrors),
    );
    error.outputDir = committed ? output : undefined;
    throw error;
  }

  return { ...result, outputDir: output };
}
