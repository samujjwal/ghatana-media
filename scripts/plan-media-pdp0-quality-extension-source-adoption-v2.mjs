import {planQualityExtensionSourceAdoptionV2} from './lib/media-pdp0-quality-extension-source-adoption-v2.mjs';
import {planQualityExtensionProvenanceV3} from './lib/media-pdp0-quality-extension-provenance-plan-v3.mjs';

try {
  const provenance = planQualityExtensionProvenanceV3();
  if (provenance.plan.planDisposition !== 'CURRENT_PROVENANCE_EVIDENCE_VALIDATED' || provenance.plan.blockers.length) {
    throw new Error(`quality implementation provenance is not current: ${provenance.plan.blockers.join(',') || provenance.plan.planDisposition}`);
  }
  const result = planQualityExtensionSourceAdoptionV2();
  process.stdout.write(`${JSON.stringify({schemaVersion:'media.pdp0.quality-extension-source-adoption-planning-envelope.v1',
    provenancePlan:provenance.plan,adoptionPlan:result.plan}, null, 2)}\n`);
  if (result.plan.blockers.length) process.exitCode = 2;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
