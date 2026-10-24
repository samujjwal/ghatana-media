import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {prepareMediaPdp0RootSelectedSourceIntegrationR9R02ApplicationPlan} from './lib/media-pdp0-root-selected-source-integration-r9-r02-application-plan.mjs';

export function runR9R02ApplicationPlanCli(args=process.argv.slice(2)){
  const {plan,refs}=prepareMediaPdp0RootSelectedSourceIntegrationR9R02ApplicationPlan();
  process.stdout.write(`${JSON.stringify({plan,refs},null,args.includes('--compact')?0:2)}\n`);
  return {plan,refs};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){try{runR9R02ApplicationPlanCli();}catch(error){console.error(error.message);process.exitCode=1;}}
