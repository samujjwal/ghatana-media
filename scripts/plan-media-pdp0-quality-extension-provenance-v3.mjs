import {planQualityExtensionProvenanceV3} from './lib/media-pdp0-quality-extension-provenance-plan-v3.mjs';

try {
  const {plan} = planQualityExtensionProvenanceV3();
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  if (plan.blockers.length) process.exitCode = 2;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
