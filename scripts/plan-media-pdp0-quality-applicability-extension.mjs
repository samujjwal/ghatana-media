import {writeQualityApplicabilityExtensionCandidate} from './lib/media-pdp0-quality-applicability-extension-candidate.mjs';

try {
  process.stdout.write(`${JSON.stringify(writeQualityApplicabilityExtensionCandidate({check:process.argv.includes('--check')}), null, 2)}\n`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
