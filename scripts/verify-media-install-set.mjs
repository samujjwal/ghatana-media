#!/usr/bin/env node
// Source-free consumer check: node scripts/verify-media-install-set.mjs <install-set-dir>
// Reads only the manifest and the artifacts it names (no Media source). Exit 1 on any refusal.
import { verifyInstallSet } from './lib/media-install-set.mjs';
const dir = process.argv[2];
if (!dir) { console.error('usage: verify-media-install-set.mjs <install-set-dir>'); process.exit(2); }
const { ok, errors } = verifyInstallSet(dir);
if (ok) console.log(`PASS media install set ${dir}`);
else { for (const e of errors) console.error(`REFUSED ${e}`); process.exit(1); }
