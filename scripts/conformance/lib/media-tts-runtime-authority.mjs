import fs from "node:fs";
import path from "node:path";

const PATHS = Object.freeze({
  config: "libs/java/common/src/main/java/com/ghatana/media/config/TtsConfig.java",
  factory: "libs/java/common/src/main/java/com/ghatana/media/tts/api/TtsEngineFactory.java",
  library: "libs/java/common/src/main/java/com/ghatana/media/AudioVideoLibrary.java",
  serverBase: "libs/common/src/main/java/com/ghatana/audio/video/common/AudioVideoGrpcServerBase.java",
  productionService: "modules/speech/tts-service/src/main/java/com/ghatana/tts/grpc/ProductionTtsGrpcService.java",
  server: "modules/speech/tts-service/src/main/java/com/ghatana/tts/grpc/TtsGrpcServer.java",
});

function read(root, relativePath, errors) {
  const absolute = path.join(root, relativePath);
  if (!fs.existsSync(absolute)) {
    errors.push(`Missing Media TTS authority file: ${relativePath}`);
    return "";
  }
  return fs.readFileSync(absolute, "utf8");
}

function requireTokens(errors, label, source, tokens) {
  for (const token of tokens) {
    if (!source.includes(token)) {
      errors.push(`${label} is missing ${token}`);
    }
  }
}

export function validateMediaTtsRuntimeAuthority({ root = process.cwd() } = {}) {
  const errors = [];
  const config = read(root, PATHS.config, errors);
  const factory = read(root, PATHS.factory, errors);
  const library = read(root, PATHS.library, errors);
  const serverBase = read(root, PATHS.serverBase, errors);
  const productionService = read(root, PATHS.productionService, errors);
  const server = read(root, PATHS.server, errors);

  requireTokens(errors, "TtsConfig", config, [
    "boolean allowSyntheticFallback",
    "private boolean allowSyntheticFallback;",
    "allowSyntheticFallback(boolean value)",
    "maxConcurrentRequests must be >= 1",
    "sampleRate must be >= 8000",
  ]);
  if (/private\s+boolean\s+allowSyntheticFallback\s*=\s*true/.test(config)) {
    errors.push("TtsConfig must default synthetic fallback to false");
  }

  requireTokens(errors, "TtsEngineFactory", factory, [
    "if (!config.allowSyntheticFallback())",
    "synthetic fallback is disabled",
    "EngineStatus.State.DEGRADED",
    "Synthetic TTS fallback does not support voice cloning",
    "Synthetic TTS fallback does not provide profile persistence",
    "libraryState.markUnhealthy",
  ]);
  for (const forbidden of [
    "class FallbackTtsEngine",
    "UUID.randomUUID().toString()",
    "new TtsProfile(profileId, displayName",
    "new VoiceInfo(voiceId, voiceName",
  ]) {
    if (factory.includes(forbidden)) {
      errors.push(`TtsEngineFactory retains fabricated fallback behavior: ${forbidden}`);
    }
  }

  requireTokens(errors, "AudioVideoLibrary", library, [
    "ownedTtsEngine",
    "borrowedTtsEngine",
    "borrowedView(TtsEngine.class, ownedTtsEngine)",
    "method.getName().equals(\"close\")",
    "closeOwned(ownedTtsEngine",
  ]);

  requireTokens(errors, "AudioVideoGrpcServerBase", serverBase, [
    "serviceImpl instanceof AutoCloseable",
    "serviceResourceClosed.compareAndSet(false, true)",
    "closeServiceResource()",
    "closed.set(true)",
  ]);

  requireTokens(errors, "ProductionTtsGrpcService", productionService, [
    "MEDIA_TTS_ALLOW_SYNTHETIC_FALLBACK",
    ".allowSyntheticFallback(allowSyntheticFallback)",
    "library.getTtsEngine().warmup()",
    "implements AutoCloseable",
    "ownedLibrary.close()",
  ]);
  if (productionService.includes(".allowSyntheticFallback(true)")) {
    errors.push("ProductionTtsGrpcService must not hard-code synthetic fallback enabled");
  }

  requireTokens(errors, "TtsGrpcServer", server, [
    "new ProductionTtsGrpcService",
    "startAndAwaitShutdown()",
    "catch (InterruptedException exception)",
    "catch (IOException exception)",
  ]);
  if (server.includes("new TtsGrpcService(new SimpleMeterRegistry())")) {
    errors.push("TtsGrpcServer must use the fail-closed production TTS composition");
  }

  const mediaMainRoot = root;
  if (fs.existsSync(mediaMainRoot)) {
    for (const file of walk(mediaMainRoot)) {
      const relative = file.replaceAll("\\", "/");
      if (!relative.includes("/src/main/") || relative.includes("/examples/")) continue;
      const source = fs.readFileSync(file, "utf8");
      if (source.includes(".allowSyntheticFallback(true)")) {
        errors.push(`${path.relative(root, file).replaceAll("\\", "/")}: production source hard-codes synthetic TTS fallback`);
      }
    }
  }

  return { errors };
}

function walk(directory, results = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (["build", "dist", "node_modules", "target"].includes(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, results);
    } else if (entry.isFile() && [".java", ".kt", ".kts"].includes(path.extname(entry.name))) {
      results.push(fullPath);
    }
  }
  return results;
}

export const MEDIA_TTS_AUTHORITY_PATHS = PATHS;
