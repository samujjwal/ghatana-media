import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function fail(message) { throw new Error(`Invalid PDP-3 implementation handoff: ${message}`); }
export function validatePdp3ImplementationHandoff(pack, root) {
  if (pack?.schemaVersion !== 'media.pdp3-implementation-handoff.v1' || pack?.contractVersion !== '1.0.0') fail('unsupported schema or contract version');
  const uniqueIds = (items, label, expectedCount) => {
    if (!Array.isArray(items) || items.length !== expectedCount) fail(`${label} population must equal ${expectedCount}`);
    const ids = items.map(item => item?.id);
    if (ids.some(id => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) fail(`${label} IDs must be present and unique`);
    return new Set(ids);
  };
  const screenIds = uniqueIds(pack.experiences?.screens, 'screen', 47);
  const journeyIds = uniqueIds(pack.experiences?.journeys, 'journey', 30);
  if (![...screenIds].every(id => id.startsWith('media.view.')) || ![...journeyIds].every(id => /^J-\d{2}$/.test(id))) fail('screen or journey ID has an invalid source identity');
  uniqueIds(pack.applicability?.capabilities, 'capability', pack.applicability.capabilities.length);
  uniqueIds(pack.applicability?.operations, 'operation', pack.applicability.operations.length);
  const sourcePins = pack.sourcePins;
  if (!sourcePins || typeof sourcePins !== 'object' || Object.keys(sourcePins).length < 1) fail('source pins are missing');
  for (const [ref, digest] of Object.entries(sourcePins)) {
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) fail(`source pin for ${ref} is malformed`);
    if (root) {
      const absolute = path.join(root, ref);
      if (!fs.existsSync(absolute)) fail(`pinned source ${ref} is missing`);
      const actual = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
      if (actual !== digest) fail(`pinned source ${ref} is stale`);
    }
  }
  const referencedSources = [...pack.experiences.screens, ...pack.experiences.journeys, ...pack.applicability.capabilities, ...pack.applicability.operations].flatMap(item => item.sourceRefs ?? []);
  for (const ref of referencedSources) if (!Object.hasOwn(sourcePins, ref)) fail(`reference ${ref} has no source pin`);
  if (pack.admission?.runtimeAvailability !== false || pack.admission?.releaseAuthorized !== false) fail('unadmitted runtime/release flags must remain fail-closed');
  return true;
}
