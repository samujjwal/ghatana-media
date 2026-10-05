import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MEDIA_TTS_AUTHORITY_PATHS,
  validateMediaTtsRuntimeAuthority,
} from "../lib/media-tts-runtime-authority.mjs";

function write(root, relativePath, content) {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "media-tts-authority-"));
  write(root, MEDIA_TTS_AUTHORITY_PATHS.config, [
    "record TtsConfig(boolean allowSyntheticFallback) {}",
    "private boolean allowSyntheticFallback;",
    "Builder allowSyntheticFallback(boolean value) { return this; }",
    "maxConcurrentRequests must be >= 1",
    "sampleRate must be >= 8000",
  ].join("\n"));
  write(root, MEDIA_TTS_AUTHORITY_PATHS.factory, [
    "if (!config.allowSyntheticFallback()) {}",
    "synthetic fallback is disabled",
    "EngineStatus.State.DEGRADED",
    "Synthetic TTS fallback does not support voice cloning",
    "Synthetic TTS fallback does not provide profile persistence",
    "libraryState.markUnhealthy",
  ].join("\n"));
  write(root, MEDIA_TTS_AUTHORITY_PATHS.library, [
    "ownedTtsEngine",
    "borrowedTtsEngine",
    "borrowedView(TtsEngine.class, ownedTtsEngine)",
    "method.getName().equals(\"close\")",
    "closeOwned(ownedTtsEngine",
  ].join("\n"));
  write(root, MEDIA_TTS_AUTHORITY_PATHS.serverBase, [
    "serviceImpl instanceof AutoCloseable",
    "serviceResourceClosed.compareAndSet(false, true)",
    "closeServiceResource()",
    "closed.set(true)",
  ].join("\n"));
  write(root, MEDIA_TTS_AUTHORITY_PATHS.productionService, [
    "implements AutoCloseable",
    "MEDIA_TTS_ALLOW_SYNTHETIC_FALLBACK",
    ".allowSyntheticFallback(allowSyntheticFallback)",
    "library.getTtsEngine().warmup()",
    "ownedLibrary.close()",
  ].join("\n"));
  write(root, MEDIA_TTS_AUTHORITY_PATHS.server, [
    "new ProductionTtsGrpcService",
    "startAndAwaitShutdown()",
    "catch (InterruptedException exception)",
    "catch (IOException exception)",
  ].join("\n"));
  return root;
}

test("accepts fail-closed production and explicit degraded fallback authority", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.deepEqual(validateMediaTtsRuntimeAuthority({ root }).errors, []);
});

test("rejects implicit fallback and fabricated profile behavior", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, MEDIA_TTS_AUTHORITY_PATHS.config, [
    fs.readFileSync(path.join(root, MEDIA_TTS_AUTHORITY_PATHS.config), "utf8"),
    "private boolean allowSyntheticFallback = true;",
  ].join("\n"));
  write(root, MEDIA_TTS_AUTHORITY_PATHS.factory, [
    fs.readFileSync(path.join(root, MEDIA_TTS_AUTHORITY_PATHS.factory), "utf8"),
    "class FallbackTtsEngine {}",
    "new TtsProfile(profileId, displayName, null, null, null)",
  ].join("\n"));

  const { errors } = validateMediaTtsRuntimeAuthority({ root });
  assert.ok(errors.some((error) => error.includes("default synthetic fallback to false")));
  assert.ok(errors.some((error) => error.includes("FallbackTtsEngine")));
  assert.ok(errors.some((error) => error.includes("fabricated fallback behavior")));
});

test("rejects production hard-coded fallback and legacy server composition", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, MEDIA_TTS_AUTHORITY_PATHS.productionService, [
    fs.readFileSync(path.join(root, MEDIA_TTS_AUTHORITY_PATHS.productionService), "utf8"),
    ".allowSyntheticFallback(true)",
  ].join("\n"));
  write(root, MEDIA_TTS_AUTHORITY_PATHS.server,
    "new TtsGrpcService(new SimpleMeterRegistry())\n");

  const { errors } = validateMediaTtsRuntimeAuthority({ root });
  assert.ok(errors.some((error) => error.includes("hard-code synthetic fallback")));
  assert.ok(errors.some((error) => error.includes("fail-closed production TTS composition")));
});

test("rejects any other Media production source that hard-codes fallback", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(
    root,
    "services/media/modules/example/src/main/java/com/ghatana/media/example/Unsafe.java",
    "builder.allowSyntheticFallback(true);\n",
  );

  const { errors } = validateMediaTtsRuntimeAuthority({ root });
  assert.ok(errors.some((error) => error.includes("production source hard-codes")));
});
