import fs from 'node:fs';
import { buildMediaBuildContractBridge, validateMediaBuildContractBridge, MEDIA_BUILD_CONTRACT_BRIDGE_PATH } from './lib/media-build-contract-bridge.mjs';

const bridge = buildMediaBuildContractBridge();
const errors = validateMediaBuildContractBridge(bridge, bridge);
if (errors.length) throw new Error(errors.join('\n'));
fs.writeFileSync(MEDIA_BUILD_CONTRACT_BRIDGE_PATH, `${JSON.stringify(bridge, null, 2)}\n`);
console.log(`Wrote ${MEDIA_BUILD_CONTRACT_BRIDGE_PATH} (${bridge.census.identityCount} identities, ${bridge.census.edgeCount} edges)`);
