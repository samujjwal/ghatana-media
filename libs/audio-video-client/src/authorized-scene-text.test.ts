import { describe, expect, it, vi } from 'vitest';
import { recognizeAuthorizedMediaSceneText, type MediaSceneTextAccess,
  type MediaSceneTextSourceAuthority } from './authorized-scene-text.js';
import type { SceneTextSourceFrame, SceneTextObservation } from './scene-text-adapter.js';

const frame: SceneTextSourceFrame = {
  sourceArtifactId:'artifact-1',sourceVersion:'v3',frameId:'frame-7',
  timestampUs:123456,mediaType:'image/png',bytes:new Uint8Array([1,2,3]),
};
const originalSha='a'.repeat(64);
const cropHash = async()=>Array.from(new Uint8Array(
  await crypto.subtle.digest('SHA-256',frame.bytes.buffer)),b=>b.toString(16).padStart(2,'0')).join('');
const admission=async():Promise<MediaSceneTextAccess>=>({
  tenantId:'tenant-1',principalId:'principal-1',purposeRef:'caption',
  originalFrameSha256:originalSha,croppedFrameSha256:await cropHash(),
});
const allowed = ():MediaSceneTextSourceAuthority=>({
  verifyCurrentSource:vi.fn(async()=>({
    status:'ADMITTED' as const,sourceVersion:'v3',
    originalFrameSha256:originalSha,decisionRef:'decision-1',
  })),
});
const row:SceneTextObservation={
  sourceArtifactId:'artifact-1',sourceVersion:'v3',frameId:'frame-7',
  timestampUs:123456,protocolVersion:'document-intelligence.v1',
  workerCapabilityVersion:'document-intelligence-worker.v1',
  provider:{providerRef:'p',providerVersion:'1',modelRef:'m',modelVersion:'1'},
  pageNumber:1,wireOrdinal:0,blockId:'block-1',lineId:'line-1',
  text:'EXIT',confidence:0.9,boundingRegion:{x:0.1,y:0.2,width:0.3,height:0.1},
};
const recognizer=()=>({recognizeFrame:vi.fn(async()=>[row])});

describe('Media source-authorized scene-text OCR port (fixture only)',()=>{
  it('returns source and rights-bound observation with exact source version',async()=>{
    const p=recognizer();
    const result=await recognizeAuthorizedMediaSceneText(allowed(),p,'op-1',frame,await admission());
    expect(result).toMatchObject([{sourceVersion:'v3',tenantId:'tenant-1',
      rightsDecisionRef:'decision-1',originalFrameSha256:originalSha,text:'EXIT'}]);
    expect(p.recognizeFrame).toHaveBeenCalledOnce();
  });
  it('denies before calling any OCR engine on current consent revocation',async()=>{
    const p=recognizer();
    const source={verifyCurrentSource:vi.fn(async()=>({status:'DENIED' as const}))};
    await expect(recognizeAuthorizedMediaSceneText(source,p,'op-1',frame,await admission()))
      .rejects.toMatchObject({code:'SOURCE_DENIED'});
    expect(p.recognizeFrame).not.toHaveBeenCalled();
  });
  it('denies modified cropped bytes before source readback or external effects',async()=>{
    const source=allowed();const p=recognizer();
    await expect(recognizeAuthorizedMediaSceneText(source,p,'op-1',
      {...frame,bytes:new Uint8Array([1,2,4])},await admission()))
      .rejects.toMatchObject({code:'SOURCE_DIGEST_MISMATCH'});
    expect(source.verifyCurrentSource).not.toHaveBeenCalled();
    expect(p.recognizeFrame).not.toHaveBeenCalled();
  });
  it('rejects stale source revision without dispatch',async()=>{
    const p=recognizer(),src={
      verifyCurrentSource:vi.fn(async()=>({status:'ADMITTED' as const,sourceVersion:'v2',
        originalFrameSha256:originalSha,decisionRef:'decision-1'})),
    };
    await expect(recognizeAuthorizedMediaSceneText(src,p,'op-1',frame,await admission()))
      .rejects.toMatchObject({code:'SOURCE_VERSION_MISMATCH'});
    expect(p.recognizeFrame).not.toHaveBeenCalled();
  });
  it('rejects forged downstream source identity even when provider returns a result',async()=>{
    const p={recognizeFrame:vi.fn(async()=>[{...row,sourceVersion:'v8'}])};
    await expect(recognizeAuthorizedMediaSceneText(allowed(),p,'op-1',frame,await admission()))
      .rejects.toMatchObject({code:'RECOGNIZER_RESULT_INVALID'});
  });
  it('rejects unconfigured authority rather than defaulting to an OCR provider',async()=>{
    await expect(recognizeAuthorizedMediaSceneText(null as unknown as MediaSceneTextSourceAuthority,
      recognizer(),'op-1',frame,await admission()))
      .rejects.toMatchObject({code:'INVALID_SOURCE'});
  });
});
