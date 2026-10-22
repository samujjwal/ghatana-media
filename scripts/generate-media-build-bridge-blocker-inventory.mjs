#!/usr/bin/env node
import fs from 'node:fs';
import { deriveMediaBridgeBlockerInventory } from './lib/media-build-bridge-blocker-inventory.mjs';
const source='docs/implementation/MEDIA-BUILD-CONTRACT-BRIDGE.v1.json';
const output='docs/implementation/MEDIA-BUILD-BRIDGE-BLOCKER-INVENTORY.v1.json';
const bridge=JSON.parse(fs.readFileSync(source,'utf8'));
const generated=deriveMediaBridgeBlockerInventory(bridge);
const bytes=JSON.stringify(generated,null,2)+'\n';
if(process.argv.includes('--check')){
 if(!fs.existsSync(output)||fs.readFileSync(output,'utf8')!==bytes)throw new Error('BUILD_BRIDGE_BLOCKER_INVENTORY_STALE');
} else fs.writeFileSync(output,bytes);
console.log(JSON.stringify({status:generated.status,census:generated.census,checkOnly:process.argv.includes('--check')},null,2));
