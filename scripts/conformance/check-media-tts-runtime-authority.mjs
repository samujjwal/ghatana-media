#!/usr/bin/env node

/**
 * Repository-local guard for Media TTS provider, fallback, and lifecycle authority.
 * Canonical evidence remains Java/ActiveJ-owned in ghatana-shared.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateMediaTtsRuntimeAuthority } from "./lib/media-tts-runtime-authority.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const result = validateMediaTtsRuntimeAuthority({ root });

if (result.errors.length > 0) {
  console.error(`Media TTS runtime authority failed with ${result.errors.length} violation(s):`);
  result.errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

console.log("Media TTS runtime authority passed: real-model default, explicit degraded fallback, library-owned engines, and fail-closed server composition are enforced.");
