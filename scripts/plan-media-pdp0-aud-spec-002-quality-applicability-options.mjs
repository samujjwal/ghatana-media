#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {buildAudSpec002QualityApplicabilityOptions} from './lib/media-pdp0-aud-spec-002-quality-applicability-options.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = 'docs/implementation/observations/pdp0-semantic-audit-slices';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = ref => fs.readFileSync(path.join(root, ref));
const refs = {
  capabilities: '.product-experience/pdp-0-product-truth/capabilities.yaml',
  quality: '.product-experience/pdp-0-product-truth/quality-policy.yaml',
  pxd225: 'docs/implementation/verification/pdp-38/p0-quality-current-source-review-pxd225.json',
  v6Manifest: `${folder}/AUD-SPEC-002-source-amendment-v6-freeze-manifest.v1.json`,
  v6Capabilities: `${folder}/AUD-SPEC-002-capabilities-file-postimage.v6.yaml`,
};
const immutable = (ref, content) => {
  const full = path.join(root, ref); fs.mkdirSync(path.dirname(full), {recursive:true});
  if (fs.existsSync(full)) { if (!fs.readFileSync(full).equals(content)) throw new Error(`refusing to overwrite source-bound quality option artifact: ${ref}`); return; }
  const fd = fs.openSync(full, 'wx', 0o600); try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};

export function prepareOptions() {
  const built = buildAudSpec002QualityApplicabilityOptions({capabilityBytes:read(refs.capabilities), qualityPolicyBytes:read(refs.quality), pxd225Bytes:read(refs.pxd225),
    v6ManifestBytes:read(refs.v6Manifest), v6CapabilityPostimageBytes:read(refs.v6Capabilities)});
  const Ajv2020 = createRequire(path.resolve(root, '../ghatana-tools/package.json'))('ajv/dist/2020');
  const validate = new Ajv2020({strict:true}).compile(built.schema);
  if (!validate(built.options)) throw new Error(`quality-applicability options fail schema: ${JSON.stringify(validate.errors)}`);
  const recordBytes = Buffer.from(`${JSON.stringify(built.options,null,2)}\n`);
  const schemaBytes = Buffer.from(`${JSON.stringify(built.schema,null,2)}\n`);
  const manifest = {schemaVersion:'media.pdp0.aud-spec-002-quality-applicability-options-freeze.v1', status:'SOURCE_BOUND_OPTIONS_PENDING_ROOT_CHOICE',
    recordRef:`${folder}/AUD-SPEC-002-quality-applicability-options.v1.json`, recordSha256:sha(recordBytes), schemaRef:`${folder}/AUD-SPEC-002-quality-applicability-options.v1.schema.json`, schemaSha256:sha(schemaBytes),
    sourcePins:built.pins, criteria:{dimensions:built.dimensions.map(row=>row.id),metrics:built.metrics.map(row=>row.id)}, decisionsSelected:0,
    qualityMeaningDecisionRef:null, canonicalQualitySourceChanged:false, measurement:'NOT_EVALUATED', qualification:'NOT_EVALUATED'};
  const manifestBytes=Buffer.from(`${JSON.stringify(manifest,null,2)}\n`);
  return {recordBytes,schemaBytes,manifest,manifestBytes};
}
export function writeOptions({check=false}={}) {
  const out=prepareOptions(); const artifacts=new Map([
    [`${folder}/AUD-SPEC-002-quality-applicability-options.v1.json`,out.recordBytes],
    [`${folder}/AUD-SPEC-002-quality-applicability-options.v1.schema.json`,out.schemaBytes],
    [`${folder}/AUD-SPEC-002-quality-applicability-options-freeze.v1.json`,out.manifestBytes],
  ]);
  if(check) { for(const [ref,content] of artifacts) if(!fs.existsSync(path.join(root,ref))||!read(ref).equals(content)) throw new Error(`quality option artifact changed: ${ref}`); }
  else for(const [ref,content] of artifacts) immutable(ref,content);
  return out.manifest;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  try { process.stdout.write(`${JSON.stringify(writeOptions({check:process.argv.includes('--check')}),null,2)}\n`); }
  catch(error) { console.error(error.message); process.exitCode=1; }
}
