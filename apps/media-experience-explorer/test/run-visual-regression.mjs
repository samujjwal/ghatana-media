import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const appDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryDirectory = resolve(appDirectory, "../..");
const viteExecutable = join(appDirectory, "node_modules/.bin/vite");
const artifactDirectory = await mkdtemp(join(tmpdir(), "media-experience-visual-regression."));

function run(command, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} exited with ${signal ?? `code ${code}`}`));
    });
  });
}

async function findAvailableLoopbackPort() {
  const listener = createServer();
  await new Promise((resolveListen, rejectListen) => {
    listener.once("error", rejectListen);
    listener.listen(0, "127.0.0.1", resolveListen);
  });
  const { port } = listener.address();
  await new Promise((resolveClose, rejectClose) => listener.close((error) => error ? rejectClose(error) : resolveClose()));
  return port;
}

async function waitForPreview(child, baseUrl) {
  const deadline = Date.now() + 20_000;
  let exit = null;
  child.once("exit", (code, signal) => { exit = { code, signal }; });

  while (Date.now() < deadline) {
    if (exit) throw new Error(`Vite preview exited before becoming ready (${exit.signal ?? exit.code})`);
    try {
      const response = await fetch(baseUrl, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // The preview server has not opened its loopback listener yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("Vite preview did not become ready within 20 seconds");
}

async function stopPreview(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 3_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

const environment = { ...process.env };
let preview;

try {
  await run("pnpm", ["--filter", "@ghatana/media-experience-explorer", "build"], {
    cwd: repositoryDirectory,
    env: environment,
  });

  const port = await findAvailableLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}/`;
  preview = spawn(viteExecutable, ["preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: appDirectory,
    env: environment,
    stdio: ["ignore", "inherit", "inherit"],
  });
  await waitForPreview(preview, baseUrl);

  const auditEnvironment = {
    ...environment,
    MEDIA_EXPLORER_URL: baseUrl,
    MEDIA_EXPLORER_ARTIFACT_DIR: artifactDirectory,
  };
  await run(process.execPath, [join(repositoryDirectory, "scripts/check-experience-browser.mjs")], {
    cwd: repositoryDirectory,
    env: auditEnvironment,
  });
  await run(process.execPath, [join(appDirectory, "test/compare-visual-references.mjs")], {
    cwd: repositoryDirectory,
    env: auditEnvironment,
  });
  process.stdout.write(`Visual regression artifacts: ${artifactDirectory}\n`);
} finally {
  if (preview) await stopPreview(preview);
}
