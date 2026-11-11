import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { withPreviewOutputTransaction } from "./preview-output-transaction.mjs";

async function tempDir() {
  return mkdtemp(join(os.tmpdir(), "media-preview-transaction-test-"));
}

async function assertMissing(path) {
  await assert.rejects(stat(path), { code: "ENOENT" });
}

function runFenceContender(output) {
  const moduleUrl = new URL("./preview-output-transaction.mjs", import.meta.url).href;
  const contender = [
    `import { withPreviewOutputTransaction } from ${JSON.stringify(moduleUrl)};`,
    "try {",
    "  await withPreviewOutputTransaction(process.argv.at(-1), async () => { throw new Error('fenced producer ran'); });",
    "  process.exitCode = 5;",
    "} catch (error) {",
    "  process.stdout.write(error.code ?? 'NO_TYPED_CODE');",
    "  process.exitCode = error.code === 'RENDER_IN_PROGRESS' ? 0 : 6;",
    "}",
  ].join("\n");
  return spawnSync(process.execPath, ["--input-type=module", "-e", contender, output], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

test("a failed render rolls back the entire staged bundle and releases its fence", async () => {
  const parent = await tempDir();
  const output = join(parent, "preview");
  const expectedFailure = new Error("injected failure after media and manifest were staged");
  try {
    await assert.rejects(withPreviewOutputTransaction(output, async (stage) => {
      await writeFile(join(stage, "local-preview.mp4"), "partial-media", { flag: "wx" });
      await writeFile(join(stage, "preview-manifest.json"), "partial-manifest", { flag: "wx" });
      throw expectedFailure;
    }), (error) => error === expectedFailure);

    await assertMissing(output);
    assert.deepEqual(await readdir(parent), [], "neither the reservation nor private stage survives a completed rollback");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a producer that throws a falsy value rejects and rolls back instead of resolving as a render", async () => {
  const parent = await tempDir();
  const thrownValues = [undefined, null, false, 0, -0, 0n, NaN, ""];
  try {
    for (const [index, thrownValue] of thrownValues.entries()) {
      const output = join(parent, `preview-${index}`);
      let rejected = false;
      let observed;
      try {
        await withPreviewOutputTransaction(output, async () => { throw thrownValue; });
      } catch (error) {
        rejected = true;
        observed = error;
      }

      assert.equal(rejected, true, `throw ${String(thrownValue)} must not resolve as a successful render`);
      assert.ok(Object.is(observed, thrownValue), `throw ${String(thrownValue)} must preserve its rejection value`);
      await assertMissing(output);
      assert.deepEqual(await readdir(parent), [], "no output, sidecar lock, or private stage survives rollback");
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a non-Error producer failure survives rollback cleanup errors as the exact cause", async () => {
  const parent = await tempDir();
  const output = join(parent, "preview");
  const lockPath = join(parent, `.${basename(output)}.render-lock`);
  try {
    let observed;
    try {
      await withPreviewOutputTransaction(output, async () => {
        await unlink(lockPath);
        await writeFile(lockPath, "replacement-owner\n", { flag: "wx" });
        throw null;
      });
    } catch (error) {
      observed = error;
    }

    assert.ok(observed instanceof Error);
    assert.equal(observed.code, "PREVIEW_TRANSACTION_FAILED");
    assert.equal(observed.cause, null);
    assert.equal(observed.cleanupErrors.length, 1);
    assert.equal(observed.cleanupErrors[0].code, "RENDER_LOCK_OWNERSHIP_LOST");
    await assertMissing(output);
    assert.equal(await readFile(lockPath, "utf8"), "replacement-owner\n", "cleanup must preserve the replacement lock owner");
    assert.deepEqual((await readdir(parent)).sort(), [".preview.render-lock"]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("cleanup failures do not mask a frozen primary Error", async () => {
  const parent = await tempDir();
  const output = join(parent, "preview");
  const lockPath = join(parent, `.${basename(output)}.render-lock`);
  const expectedFailure = Object.freeze(new Error("frozen producer failure"));
  try {
    let observed;
    try {
      await withPreviewOutputTransaction(output, async () => {
        await unlink(lockPath);
        await writeFile(lockPath, "replacement-owner\n", { flag: "wx" });
        throw expectedFailure;
      });
    } catch (error) {
      observed = error;
    }

    assert.ok(observed instanceof Error);
    assert.equal(observed.code, "PREVIEW_TRANSACTION_FAILED");
    assert.equal(observed.cause, expectedFailure);
    assert.equal(observed.cleanupErrors.length, 1);
    assert.equal(observed.cleanupErrors[0].code, "RENDER_LOCK_OWNERSHIP_LOST");
    await assertMissing(output);
    assert.equal(await readFile(lockPath, "utf8"), "replacement-owner\n", "cleanup must preserve the replacement lock owner");
    assert.deepEqual((await readdir(parent)).sort(), [".preview.render-lock"]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the destination fence rejects another process until one complete bundle commits", async () => {
  const parent = await tempDir();
  const output = join(parent, "preview");
  let releaseProducer;
  let producerEntered;
  const entered = new Promise((resolve) => { producerEntered = resolve; });
  const blocked = new Promise((resolve) => { releaseProducer = resolve; });
  const producer = withPreviewOutputTransaction(output, async (stage) => {
    await writeFile(join(stage, "local-preview.mp4"), "complete-media", { flag: "wx" });
    producerEntered();
    await blocked;
    await writeFile(join(stage, "preview-manifest.json"), "complete-manifest", { flag: "wx" });
    return { kind: "LOCAL_PREVIEW_ONLY" };
  });
  try {
    await entered;
    const child = runFenceContender(output);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "RENDER_IN_PROGRESS");

    releaseProducer();
    const result = await producer;
    assert.equal(result.kind, "LOCAL_PREVIEW_ONLY");
    assert.equal(result.outputDir, output);
    assert.deepEqual((await readdir(output)).sort(), ["local-preview.mp4", "preview-manifest.json"]);
    assert.equal(await readFile(join(output, "local-preview.mp4"), "utf8"), "complete-media");
    assert.equal(await readFile(join(output, "preview-manifest.json"), "utf8"), "complete-manifest");
    assert.deepEqual(await readdir(parent), ["preview"], "only the complete bundle remains after commit and lock release");
  } finally {
    releaseProducer();
    await producer.catch(() => {});
    await rm(parent, { recursive: true, force: true });
  }
});

test("a stale fence survives a later process and can be removed only after owner review", async () => {
  const parent = await tempDir();
  const output = join(parent, "preview");
  const lockPath = join(parent, `.${basename(output)}.render-lock`);
  try {
    await writeFile(lockPath, `${JSON.stringify({ version: 1, outputDir: output, processId: -1, invocationId: "stale-fixture" })}\n`, { flag: "wx" });
    const restarted = runFenceContender(output);
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.equal(restarted.stdout, "RENDER_IN_PROGRESS");
    assert.equal((await readFile(lockPath, "utf8")).includes("stale-fixture"), true);
    await assertMissing(output);

    await rm(lockPath);
    const result = await withPreviewOutputTransaction(output, async (stage) => {
      await writeFile(join(stage, "manifest.json"), "complete", { flag: "wx" });
      return { kind: "LOCAL_PREVIEW_ONLY" };
    });
    assert.equal(result.outputDir, output);
    assert.deepEqual(await readdir(output), ["manifest.json"]);
    assert.deepEqual(await readdir(parent), ["preview"]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a hard-stopped staged render leaves its fence and private stage for the next process", async () => {
  const parent = await tempDir();
  const output = join(parent, "preview");
  const lockPath = join(parent, `.${basename(output)}.render-lock`);
  const moduleUrl = new URL("./preview-output-transaction.mjs", import.meta.url).href;
  const renderer = [
    `import { withPreviewOutputTransaction } from ${JSON.stringify(moduleUrl)};`,
    `import { writeFile } from "node:fs/promises";`,
    "await withPreviewOutputTransaction(process.argv.at(-1), async (stage) => {",
    "  await writeFile(`${stage}/local-preview.mp4`, 'staged-partial-media', { flag: 'wx' });",
    "  process.stdout.write('STAGED\\n');",
    "  await new Promise(() => {});",
    "});",
  ].join("\n");
  let child;
  try {
    child = spawn(process.execPath, ["--input-type=module", "-e", renderer, output], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffered = "";
    const staged = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("renderer did not stage output before timeout")), 5_000);
      child.stdout.on("data", (chunk) => {
        buffered += chunk.toString("utf8");
        if (buffered.includes("STAGED\n")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        if (!buffered.includes("STAGED\n")) {
          clearTimeout(timeout);
          reject(new Error(`renderer exited before staging (code=${code}, signal=${signal})`));
        }
      });
    });
    await staged;
    assert.equal(child.exitCode, null, "the producer must still be active after staging its partial bundle");
    assert.equal(child.kill("SIGKILL"), true, "the operating system must accept the hard-stop signal");
    const [exitCode, signal] = await once(child, "exit");
    assert.equal(exitCode, null);
    assert.equal(signal, "SIGKILL");

    const lockText = await readFile(lockPath, "utf8");
    const lock = JSON.parse(lockText);
    assert.equal(lock.outputDir, output);
    assert.equal(lock.processId, child.pid);
    const stagePrefix = `.${basename(output)}.stage-${lock.invocationId}-`;
    const stagedDirs = (await readdir(parent)).filter((entry) => entry.startsWith(stagePrefix));
    assert.equal(stagedDirs.length, 1, "hard stop must leave exactly the render's private stage for review");
    const stageDir = join(parent, stagedDirs[0]);
    assert.deepEqual(await readdir(stageDir), ["local-preview.mp4"]);
    assert.equal(await readFile(join(stageDir, "local-preview.mp4"), "utf8"), "staged-partial-media");
    await assertMissing(output);

    const retry = runFenceContender(output);
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(retry.stdout, "RENDER_IN_PROGRESS");
    assert.equal(await readFile(lockPath, "utf8"), lockText, "a later process must not rewrite or remove the abandoned fence");
    assert.equal(await readFile(join(stageDir, "local-preview.mp4"), "utf8"), "staged-partial-media");
    await assertMissing(output);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit").catch(() => {});
    }
    await rm(parent, { recursive: true, force: true });
  }
});

test("existing content and symlink destinations are never replaced", async () => {
  const parent = await tempDir();
  const existing = join(parent, "existing");
  const target = join(parent, "target");
  const symlinkPath = join(parent, "link");
  try {
    const sentinel = join(existing, "keep.txt");
    await Promise.all([
      mkdir(existing),
      symlink(existing, symlinkPath, "dir"),
    ]);
    await writeFile(sentinel, "preserve", { flag: "wx" });
    for (const output of [existing, symlinkPath]) {
      await assert.rejects(
        withPreviewOutputTransaction(output, async () => { throw new Error("existing destination producer ran"); }),
        (error) => error.code === "OUTPUT_EXISTS",
      );
    }
    assert.equal(await readFile(sentinel, "utf8"), "preserve");
    assert.deepEqual(await readdir(parent), ["existing", "link"]);

    const result = await withPreviewOutputTransaction(target, async (stage) => {
      await writeFile(join(stage, "manifest.json"), "complete", { flag: "wx" });
      return { kind: "LOCAL_PREVIEW_ONLY" };
    });
    assert.equal(result.outputDir, target);
    assert.deepEqual(await readdir(target), ["manifest.json"]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
