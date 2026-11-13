#!/usr/bin/env node
// Report provider qualification status. Probes are optional and read-only (GET health). Without independent
// evidence (none is accepted from this CLI) every provider is NOT_ADMITTED or UNKNOWN. Exit 0 unless --require-admitted.
//   SCANNER_URL / DI_URL / STT_URL (optional) -> reachability probe
import { STATUS, evaluateQualification, loadRequirements } from './qualification-gate.mjs';

async function probe(url, path = '') {
  if (!url) return { reachable: false };
  try {
    const r = await fetch(new URL(path, url), { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return { reachable: false };
    const body = await r.json().catch(() => ({}));
    return { reachable: true, identity: body.engineVersion ?? body.version, devOnly: body.productionEligible !== true };
  } catch { return { reachable: false }; }
}
const requirements = loadRequirements();
const probes = {
  'security-scanner': await probe(process.env.SCANNER_URL, '/v1/health'),
  'document-intelligence': await probe(process.env.DI_URL, '/healthz'),
  'stt:en': await probe(process.env.STT_URL, '/healthz'),
  'stt:ne': await probe(process.env.STT_URL, '/healthz'),
};
const report = Object.keys(requirements).map((provider) => evaluateQualification({ provider, requirements, probe: probes[provider], evidence: [] }));
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), report }, null, 2));
if (process.argv.includes('--require-admitted') && report.some((r) => r.status !== STATUS.ADMITTED)) process.exit(1);
