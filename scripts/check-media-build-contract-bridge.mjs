import fs from 'node:fs';
import { buildMediaBuildContractBridge, validateMediaBuildContractBridge, MEDIA_BUILD_CONTRACT_BRIDGE_PATH } from './lib/media-build-contract-bridge.mjs';

const expected = buildMediaBuildContractBridge();
const errors = [];
if (!fs.existsSync(MEDIA_BUILD_CONTRACT_BRIDGE_PATH)) errors.push(`missing ${MEDIA_BUILD_CONTRACT_BRIDGE_PATH}`);
else {
  const actualText = fs.readFileSync(MEDIA_BUILD_CONTRACT_BRIDGE_PATH, 'utf8');
  let actual;
  try { actual = JSON.parse(actualText); }
  catch (error) { errors.push(`invalid JSON: ${error.message}`); }
  if (actual) {
    errors.push(...validateMediaBuildContractBridge(actual, expected));
    if (actualText !== `${JSON.stringify(expected, null, 2)}\n`) errors.push('bridge projection is not deterministic/current; regenerate it');
  }
}
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`PASS ${MEDIA_BUILD_CONTRACT_BRIDGE_PATH} is deterministic/current (${expected.census.identityCount} identities, ${expected.census.edgeCount} edges)`);
