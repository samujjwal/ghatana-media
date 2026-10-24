import {writeQualityExtensionSourceCandidateV2} from './lib/media-pdp0-quality-extension-source-candidate-v2.mjs';

try {
  const manifest = writeQualityExtensionSourceCandidateV2({check: process.argv.includes('--check')});
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
