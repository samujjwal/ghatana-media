import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {pdp0PhaseScopedSourcePins} from './report-media-pdp-readiness.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const outRef='docs/implementation/observations/media-pdp0-parent-case-resolution-candidates/media-pdp0-root-selected-source-integration-r9-r07-currentness-diagnostic-correction.v1.json';
const read=ref=>fs.readFileSync(path.resolve(root,ref));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=ref=>JSON.parse(read(ref));
const encode=value=>Buffer.from(`${JSON.stringify(value,null,2)}\n`);

export function buildR9R07CurrentnessDiagnosticCorrection(){
  const statusRef='docs/implementation/pdp-0-phase-dev-status.json';
  const statusBytes=read(statusRef),status=JSON.parse(statusBytes.toString('utf8'));
  const sourcePins=Object.entries(status.sourceShaSet);
  const sectionPins=pdp0PhaseScopedSourcePins();
  const fileRows=sourcePins.filter(([ref])=>!ref.includes('#')).map(([ref,expectedSha256])=>{
    let observedSha256=null;try{observedSha256=sha(read(ref));}catch{}
    return {sourceKind:'WHOLE_FILE',ref,expectedSha256,observedSha256,status:observedSha256===null?'MISSING_FILE':observedSha256===expectedSha256?'CURRENT':'STALE'};
  });
  const selectorRows=sourcePins.filter(([ref])=>ref.includes('#')).map(([ref,expectedSha256])=>{
    const observedSha256=sectionPins[ref]??null;
    return {sourceKind:'SECTION_OR_PROJECTION_SELECTOR',ref,expectedSha256,observedSha256,status:observedSha256===null?'UNRESOLVED_SELECTOR':observedSha256===expectedSha256?'CURRENT':'STALE'};
  });
  const count=(rows,state)=>rows.filter(row=>row.status===state).length;
  const hRef='docs/implementation/observations/media-pdp0-parent-case-resolution-candidates/media-pdp0-root-selected-source-integration-r9-r07.independent-peer.actual-h-r07-full.json';
  const hBytes=read(hRef),h=JSON.parse(hBytes.toString('utf8'));
  const staleSection=selectorRows.filter(row=>row.status==='STALE');
  const observation={schemaVersion:'media.pdp0.root-selected-source-integration-r9-r07.currentness-diagnostic-correction.v1',
    artifactId:'MEDIA-PDP0-R9-R07-CURRENTNESS-DIAGNOSTIC-TYPED-SOURCE-COUNTS-2026-10-23',
    observationKind:'READ_ONLY_TYPED_RECONCILIATION_OF_EXISTING_PDP0_SOURCE_PIN_DIAGNOSTIC',
    sourceBaseline:{phaseStatusRef:statusRef,phaseStatusSha256:sha(statusBytes),phaseStatus:status.status,hReviewRef:hRef,hReviewSha256:sha(hBytes),hReviewStatus:h.reviewStatus},
    priorDiagnostic:{reportedStaleLiveSourcePins:h.campaign.pdp0PhaseStatus.staleLiveSourcePins,reportedMissingLiveSourcePins:h.campaign.pdp0PhaseStatus.missingLiveSourcePins,
      treatment:'PRESERVED_AS_HISTORICAL_REVIEW_FIELDS; the 21 count is section/projection selectors, not missing files.'},
    typedSourceKindCounts:{wholeFilePins:{total:fileRows.length,current:count(fileRows,'CURRENT'),stale:count(fileRows,'STALE'),missingFiles:count(fileRows,'MISSING_FILE')},
      sectionOrProjectionSelectors:{total:selectorRows.length,current:count(selectorRows,'CURRENT'),stale:count(selectorRows,'STALE'),unresolvedSelectors:count(selectorRows,'UNRESOLVED_SELECTOR')},
      aggregate:{references:sourcePins.length,current:count(fileRows,'CURRENT')+count(selectorRows,'CURRENT'),stale:count(fileRows,'STALE')+count(selectorRows,'STALE'),missingFiles:count(fileRows,'MISSING_FILE'),unresolvedSelectors:count(selectorRows,'UNRESOLVED_SELECTOR')}},
    staleWholeFileRefs:fileRows.filter(row=>row.status==='STALE'),staleSectionOrProjectionRefs:staleSection,
    filePins:fileRows,sectionOrProjectionPins:selectorRows,
    correction:{classification:'20_CURRENT_SECTION_OR_PROJECTION_SELECTORS_AND_1_STALE_PXD225_SELECTOR; ZERO_MISSING_FILES',staleSelectorRef:staleSection[0]?.ref??null,
      discoveryBarrier:'FAIL',canonicalApply:'NONE',phaseStatusEffect:'NONE',authorityEffect:'NONE',doesNotReopenOrAmendTheIndependentPeerReview:true},
    campaignDenominator:h.campaign.denominator,
  };
  return observation;
}

const result=buildR9R07CurrentnessDiagnosticCorrection();
const bytes=encode(result),target=path.resolve(root,outRef);
if(fs.existsSync(target)){if(!fs.readFileSync(target).equals(bytes))throw new Error(`refusing to replace immutable diagnostic correction: ${outRef}`);}
else fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});
console.log(JSON.stringify({ref:outRef,sha256:sha(bytes),typedSourceKindCounts:result.typedSourceKindCounts,canonicalApply:'NONE'},null,2));
