import { readFile, writeFile } from 'node:fs/promises';
const fullPath = 'docs/implementation/verification/pdp-38/migration-capability-reviewed.json';
const partialPath = 'docs/implementation/verification/pdp-38/migration-capability-partial-review.json';
const [full, partial] = await Promise.all([
  readFile(fullPath, 'utf8').then(JSON.parse), readFile(partialPath, 'utf8').then(JSON.parse),
]);
if (full.sourceBaselineSha256 !== partial.sourceBaselineSha256) throw new Error('migration review fragments use different pinned baselines');
const byId = new Map(full.records.map((record) => [record.claimId, record]));
for (const record of partial.records) {
  if (!byId.has(record.claimId)) throw new Error(`partial review claim is not in the full capability cohort: ${record.claimId}`);
  byId.set(record.claimId, record);
}
full.records = full.records.map(({ claimId }) => byId.get(claimId));
await writeFile(fullPath, `${JSON.stringify(full, null, 2)}\n`);
console.log(`Merged ${partial.records.length} current partial-cohort reviews into ${full.records.length} capability claim records.`);
