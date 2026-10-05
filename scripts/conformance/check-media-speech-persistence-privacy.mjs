#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const stt = read('modules/speech/stt-service/src/main/java/com/ghatana/stt/service/PersistentSttService.java');
const tts = read('modules/speech/tts-service/src/main/java/com/ghatana/tts/service/PersistentTtsService.java');
const errors = [];

for (const token of [
  'generateOpaqueFileName()',
  'return "tts_" + UUID.randomUUID() + ".wav"',
  '"failureType", failureType',
  'entity.setFailureReason("TTS_" + failureType)',
  'voiceSelected',
]) if (!tts.includes(token)) errors.push(`PersistentTtsService missing privacy token ${token}`);

for (const forbidden of [
  'generateFileName(text',
  'text.substring(0, 30)',
  'entity.setFailureReason(errorMessage)',
  'Map.of("error", e.getMessage()',
  'TTS synthesis failed: {}',
]) if (tts.includes(forbidden)) errors.push(`PersistentTtsService retains sensitive token ${forbidden}`);

for (const token of [
  '"failureType", failureType',
  '"STT_" + failureType',
  'Audio file persisted: id={}, sizeBytes={}',
  'STT request failed failureType={}',
]) if (!stt.includes(token)) errors.push(`PersistentSttService missing privacy token ${token}`);

for (const forbidden of [
  'Audio file persisted: id={}, file={}',
  'Map.of("error", e.getMessage()',
  'updateAudioFileStatus(tenantId, audioFile.getId(),\n                            AudioFileEntity.ProcessingStatus.FAILED, e.getMessage())',
  'STT request failed: {}',
]) if (stt.includes(forbidden)) errors.push(`PersistentSttService retains sensitive token ${forbidden}`);

for (const [service, source] of [['stt', stt], ['tts', tts]]) {
  for (const forbidden of ['LOG.error("[tenant={}] TTS synthesis failed: {}", tenantId, e.getMessage(), e)',
                           'LOG.error("[tenant={} requestId={}] STT request failed: {}", tenantId, requestId, e.getMessage(), e)']) {
    if (source.includes(forbidden)) errors.push(`${service} retains raw exception stack/message logging`);
  }
}

if (errors.length) {
  console.error(`Media speech persistence privacy failed with ${errors.length} violation(s):`);
  errors.forEach(error => console.error(`- ${error}`));
  process.exit(1);
}
console.log('Persistent STT/TTS telemetry and storage metadata do not derive filenames from source text or persist/log raw provider exception messages; failure evidence remains type-based and content-free.');
