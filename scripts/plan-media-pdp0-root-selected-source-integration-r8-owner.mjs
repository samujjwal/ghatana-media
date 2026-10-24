#!/usr/bin/env node
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {prepareMediaPdp0RootSelectedSourceIntegrationR8OwnerPlan} from './lib/media-pdp0-root-selected-source-integration-r8-owner-plan.mjs';

export function runR8OwnerPlanCli(args=process.argv.slice(2)){
  const unknown=args.filter(arg=>!['--compact'].includes(arg));
  if(unknown.length)throw new Error(`unsupported option(s): ${unknown.join(', ')}`);
  const result=prepareMediaPdp0RootSelectedSourceIntegrationR8OwnerPlan();
  process.stdout.write(`${JSON.stringify({plan:result.plan,sourceOwnerDecisionSchemaRef:result.refs.schema,planRef:result.refs.plan},null,args.includes('--compact')?0:2)}\n`);
  return result;
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){try{runR8OwnerPlanCli();}catch(error){console.error(error.message);process.exitCode=1;}}
