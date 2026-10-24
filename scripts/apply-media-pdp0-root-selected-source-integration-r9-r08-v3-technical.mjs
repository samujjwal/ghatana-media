import {
  commitValidatedPdp0RootSelectedSourceIntegrationR9R08V3Technical,
  inspectMediaPdp0RootSelectedSourceIntegrationR9R08V3TechnicalReadiness,
} from './lib/media-pdp0-review-successor-cas.mjs';

const readiness=inspectMediaPdp0RootSelectedSourceIntegrationR9R08V3TechnicalReadiness();
if(readiness.blocked){
  process.stderr.write(`${JSON.stringify({state:'BLOCKED_NO_SOURCE_EFFECT',...readiness},null,2)}\n`);
  process.exitCode=2;
}else{
  const result=commitValidatedPdp0RootSelectedSourceIntegrationR9R08V3Technical();
  process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
}
