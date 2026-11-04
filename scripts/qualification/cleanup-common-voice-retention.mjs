#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';

import {
  cleanupExpiredCommonVoiceMetadataRuns,
  cleanupExpiredCommonVoiceRuns,
} from './common-voice-ephemeral-run.mjs';

function parseArgs(args) {
  const roots = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag !== '--audio-root' && flag !== '--metadata-root') {
      throw new Error('expected --audio-root and --metadata-root');
    }
    if (roots.has(flag) || index + 1 >= args.length) {
      throw new Error('each root flag must appear once with an absolute path');
    }
    const value = args[index + 1];
    if (value.startsWith('--') || !isAbsolute(value)) {
      throw new Error('each root flag must appear once with an absolute path');
    }
    roots.set(flag, value);
    index += 1;
  }
  if (!roots.has('--audio-root') || !roots.has('--metadata-root')) {
    throw new Error('expected --audio-root and --metadata-root');
  }
  return Object.freeze({ audioRoot: roots.get('--audio-root'), metadataRoot: roots.get('--metadata-root') });
}

export async function cleanupCommonVoiceRetention(args) {
  const { audioRoot, metadataRoot } = parseArgs(args);
  // Validate the root pair before either tree can be mutated.
  const metadata = await cleanupExpiredCommonVoiceMetadataRuns(metadataRoot, audioRoot);
  const audio = await cleanupExpiredCommonVoiceRuns(audioRoot);
  return Object.freeze({
    audio: Object.freeze({ removed: audio.removed, retained: audio.retained }),
    metadata: Object.freeze({ removed: metadata.removed, retained: metadata.retained }),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const counts = await cleanupCommonVoiceRetention(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(counts)}\n`);
  } catch {
    process.stderr.write('Common Voice retention cleanup failed.\n');
    process.exitCode = 1;
  }
}
