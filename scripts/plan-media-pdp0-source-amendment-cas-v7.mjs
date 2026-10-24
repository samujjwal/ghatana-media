#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {prepareMediaPdp0SourceAmendmentV7CasPlan,createV7SourceOwnerDecisionSchema,createV7ApplyAuthorizationSchema,createV7CasPlanSchema,v7SourceAmendmentRefs} from './lib/media-pdp0-source-amendment-v7-plan.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
const immutable=(ref,bytes)=>{
  const filename=path.join(ROOT,ref);fs.mkdirSync(path.dirname(filename),{recursive:true});
  if(fs.existsSync(filename)){if(!fs.readFileSync(filename).equals(bytes))throw new Error(`refusing to overwrite frozen schema bytes: ${ref}`);return;}
  const fd=fs.openSync(filename,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  const dir=fs.openSync(path.dirname(filename),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
};

export function writeV7CasSchemasCreateOnly(){
  const reviewed=prepareMediaPdp0SourceAmendmentV7CasPlan();
  const bind=(schema)=>Buffer.from(`${JSON.stringify(schema,null,2)}\n`);
  const ownerSchema=createV7SourceOwnerDecisionSchema({sourceBindings:reviewed.candidate.sourceBindings,
    targetPostimages:Object.fromEntries(reviewed.targets.map(row=>[row.targetRef,row.expectedPostimageSha256])),
    manifestSha256:hash(fs.readFileSync(path.join(ROOT,v7SourceAmendmentRefs.manifest))),
    peerSha256:hash(fs.readFileSync(path.join(ROOT,v7SourceAmendmentRefs.peer)))});
  const rows=reviewed.targets;
  const planSchema=createV7CasPlanSchema();
  planSchema.properties.targets.items.properties.targetRef.enum=rows.map(row=>row.targetRef);
  const schemas=[
    [v7SourceAmendmentRefs.decisionSchema,bind(ownerSchema)],
    [v7SourceAmendmentRefs.applyAuthorizationSchema,bind(createV7ApplyAuthorizationSchema())],
    [v7SourceAmendmentRefs.planSchema,bind(planSchema)],
  ];
  for(const[ref,bytes]of schemas)immutable(ref,bytes);
  return schemas.map(([ref,bytes])=>({ref,sha256:hash(bytes)}));
}

export function runV7CasPlanCli(args=process.argv.slice(2)){
  const unknown=args.filter(arg=>!['--write-schemas','--compact'].includes(arg));
  if(unknown.length)throw new Error(`unsupported option(s): ${unknown.join(', ')}`);
  const reviewed=prepareMediaPdp0SourceAmendmentV7CasPlan();
  if(args.includes('--write-schemas'))writeV7CasSchemasCreateOnly();
  const plan=reviewed.plan;
  process.stdout.write(`${JSON.stringify(plan,null,args.includes('--compact')?0:2)}\n`);
  return plan;
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  try{runV7CasPlanCli();}catch(error){console.error(error.message);process.exitCode=1;}
}
