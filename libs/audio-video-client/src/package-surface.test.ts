import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * SK-08: verify the built package surface from an installed-consumer view —
 * every exports entry resolves to a real dist artifact, ESM and CJS
 * consumers both load, no source reaches outside the package for private
 * monorepo internals, and no credential or model artifact ships in source.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
  exports: Record<string, { types: string; import: string; require: string }>;
  files: string[];
  bin: Record<string, string>;
};

describe("package surface", () => {
  it("every exports entry resolves to a built dist artifact with types", () => {
    for (const [subpath, entry] of Object.entries(packageJson.exports)) {
      for (const artifact of [entry.import, entry.require, entry.types]) {
        expect(existsSync(resolve(packageRoot, artifact)), `${subpath} → ${artifact}`)
          .toBe(true);
      }
    }
    // The installed CLI bin must exist and be executable.
    for (const binPath of Object.values(packageJson.bin)) {
      expect(existsSync(resolve(packageRoot, binPath))).toBe(true);
    }
  });

  it("loads public exports for ESM and CJS consumers from the built artifacts", async () => {
    const esm = await import("@audio-video/client/operations");
    expect(typeof esm.createMediaOperationClient).toBe("function");
    const canonical = await import("@audio-video/client/canonical-operations");
    expect(typeof canonical.createMediaCanonicalClient).toBe("function");
    const capture = await import("@audio-video/client/capture-adapters");
    expect(typeof capture.captureWithAdmission).toBe("function");
    expect(typeof capture.noAdmittedCaptureAdapter.check).toBe("function");
    const camera = await import("@audio-video/client/camera-capture-adapter");
    expect(typeof camera.CameraCaptureAdapter).toBe("function");
    expect(typeof camera.CameraCaptureSession).toBe("function");
    expect(typeof camera.CameraCaptureError).toBe("function");
    const packageRootExports = await import("@audio-video/client");
    expect(typeof packageRootExports.CameraCaptureAdapter).toBe("function");
    expect(typeof packageRootExports.createBrowserCameraCaptureAdapter).toBe("function");
    expect(typeof packageRootExports.OfflineReconnectCoordinator).toBe("function");
    const recorder = await import("@audio-video/client/recorder-orchestrator");
    expect(typeof recorder.orchestrateScenario).toBe("function");
    expect(typeof recorder.recaptureScenario).toBe("function");
    const production = await import("@audio-video/client/production-plan");
    expect(typeof production.compileProductionPlan).toBe("function");
    const offlineReconnect = await import("@audio-video/client/offline-reconnect");
    expect(typeof offlineReconnect.OfflineReconnectCoordinator).toBe("function");
    const devCancellation = await import("@audio-video/client/dev-job-cancellation");
    expect(typeof devCancellation.MediaDevOnlyJobCancellationClient).toBe("function");
    // The CJS files are emitted independently and keep Node <22 consumers supported.
    const require = createRequire(resolve(packageRoot, "package.json"));
    const cjs = require("./dist-cjs/canonical-operations.js") as Record<string, unknown>;
    expect(typeof cjs.createMediaCanonicalClient).toBe("function");
    const devCancellationCjs = require("./dist-cjs/dev-job-cancellation.js") as Record<string, unknown>;
    expect(typeof devCancellationCjs.MediaDevOnlyJobCancellationClient).toBe("function");
  });

  it("no source file imports monorepo-private paths outside the package", () => {
    const srcDir = resolve(packageRoot, "src");
    const scan = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? scan(resolve(dir, entry.name))
          : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
            ? [resolve(dir, entry.name)] : []);
    const offenders: string[] = [];
    for (const file of scan(srcDir)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/from\s+["']([^"']+)["']/gu)) {
        const specifier = match[1]!;
        // Only relative imports inside the package or public @audio-video/types subpaths.
        if (specifier.startsWith(".")) {
          const target = resolve(dirname(file), specifier);
          if (!target.startsWith(srcDir)) offenders.push(`${file}: ${specifier}`);
        } else if (!specifier.startsWith("node:")
          && !/^@audio-video\/types(\/contracts|\/production)?$/u.test(specifier)) {
          offenders.push(`${file}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("ships no bearer tokens, API keys or model weights in source", () => {
    const srcDir = resolve(packageRoot, "src");
    const scan = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? scan(resolve(dir, entry.name))
          : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
            ? [resolve(dir, entry.name)] : []);
    const leaks: string[] = [];
    for (const file of scan(srcDir)) {
      const text = readFileSync(file, "utf8");
      if (/Bearer\s+[A-Za-z0-9_-]{16,}/u.test(text)
        || /-----BEGIN [A-Z ]+PRIVATE KEY-----/u.test(text)
        || /\.(bin|onnx|safetensors|gguf)["']/u.test(text)) {
        leaks.push(file);
      }
    }
    expect(leaks).toEqual([]);
  });
});
