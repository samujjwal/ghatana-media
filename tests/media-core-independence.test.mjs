import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const read=p=>readFileSync(resolve(root,p),'utf8');
const core=['runtime-contracts','launcher','modules','providers','audio-video-observability','libs/common','libs/java/common','libs/audio-video-client','libs/audio-video-types'];
const skipped=new Set(['node_modules','build','dist','target','.gradle','.git','.next','generated']);
const privateSource=new Set(['.java','.kt','.ts','.tsx']);
function scan(dir,files=[]){
  if(!existsSync(dir))return files;
  for(const item of readdirSync(dir,{withFileTypes:true})){
    if(skipped.has(item.name))continue;
    const path=join(dir,item.name);
    if(item.isDirectory()) {
      if(item.name==='test'||item.name==='tests'||item.name==='testFixtures'||item.name==='__tests__')continue;
      scan(path,files);
    }else if(item.isFile()&&(privateSource.has(extname(item.name))||item.name==='build.gradle.kts'))files.push(path);
  }
  return files;
}

test('Media core builds and sources have no Data Cloud or DI hard dependency',()=>{
  const prohibited=/com\.ghatana\.datacloud(?:\.|\b)|:services:data-cloud:|@ghatana\/data-cloud\b|@ghatana\/document-intelligence-client\b|:services:document-intelligence:/u;
  const violations=[];
  for(const path of core.flatMap(p=>scan(resolve(root,p)))) {
    const text=readFileSync(path,'utf8');
    if(prohibited.test(text))violations.push(path.slice(root.length+1));
  }
  assert.deepEqual(violations,[],
    'core must never depend on optional Data Cloud/Document Intelligence source');
});

test('Data Cloud compile references are isolated in optional integration modules',()=>{
  const bridge=read('adapters/data-cloud-media/build.gradle.kts');
  assert.match(bridge,/:services:data-cloud:delivery:api/u);
  assert.match(bridge,/:services:data-cloud:planes:shared-spi/u);
  const rootBuild=read('build.gradle.kts');
  assert.match(rootBuild,/FOCUSED/u);
  assert.match(rootBuild,/the canonical Ghatana source project is available only in FULL/u);
});

test('generic OCR accepted owner and Media scene semantics are not silently rewritten',()=>{
  const decision=read('docs/migration/decisions/MDI-001-document-intelligence-ownership.md');
  assert.match(decision,/Document Intelligence owns generic parsing/u);
  const product=read('.product-experience/pdp-0-product-truth/ocr-ownership.yaml');
  assert.match(product,/status: EXTERNAL_BLOCKER/u);
  const compat=read('modules/vision/vision-service/src/main/java/com/ghatana/audio/video/vision/ocr/OcrService.java');
  assert.match(compat,/throw new NotAdmittedException/u);
  const admission=read('libs/audio-video-client/src/authorized-scene-text.ts');
  assert.match(admission,/verifyCurrentSource/u);
  assert.match(admission,/croppedFrameSha256/u);
  assert.match(admission,/originalFrameSha256/u);
  assert.doesNotMatch(admission,/from ["']@ghatana\/document-intelligence-client/u);
});

test('documented optional Data Cloud metadata is never Media job finality',()=>{
  const coordinator=read('adapters/data-cloud-media/src/main/java/com/ghatana/audio/video/multimodal/datacloud/MediaObservationPublicationCoordinator.java');
  assert.match(coordinator,/Outcome\.OUTCOME_UNKNOWN/u);
  assert.match(coordinator,/sourceAuthority\.verify/u);
  const decision=read('docs/architecture/MEDIA-OCR-DATACLOUD-DEPENDENCY-DECISION-2026-10-30.md');
  assert.match(decision,/Data Cloud disabled\/unreachable/u);
  assert.match(decision,/DI disabled\/unreachable/u);
  assert.match(decision,/MDI-001 remains the accepted/u);
});
