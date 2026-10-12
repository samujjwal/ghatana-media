import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {conversionContract,rational,convertMediaTime,timeToSample,constantRateFrameBoundaryToMediaTime,normalizePixelBoundary,denormalizePixelBoundary,normalizePixelCenter,denormalizePixelCenter,convertPhysicalQuantity,validateSpatialTransformDeclaration,providerSignalsShareDeclaredScope} from '../scripts/lib/media-temporal-spatial-definition-model.mjs';
const parse=createRequire(new URL('../../ghatana-tools/package.json',import.meta.url))('yaml').parse;
const findRecord=(value,key)=>{if(value&&typeof value==='object'){if(Object.hasOwn(value,key))return value[key];for(const child of Object.values(value)){const found=findRecord(child,key);if(found!==undefined)return found;}}return undefined;};
const source=(ticks,timeBase={numerator:1n,denominator:90000n})=>({clockKind:'media',clockId:'source-pts-v1',streamId:'artifact-v1-video-0',originRef:'stream-origin-v1',ticks,timeBase});
const target=(timeBase,rounding='exact')=>({...source(0n),timeBase,rounding});
test('executable conversion limits bind to the exact owner profile, with no wire or scientific admission',()=>{
 const definition=parse(fs.readFileSync('.product-experience/pdp-1-domain-data/value-objects.yaml','utf8')).canonicalConversionDefinitions;
 assert.deepEqual(definition.machineContract,conversionContract);
 assert.deepEqual(definition.records.map(r=>r.id),['media.value.rational-media-time','media.value.sample-boundary-index','media.value.frame-boundary-index','media.value.image-pixel-boundary','media.value.dimensioned-scalar','media.value.image-pixel-center']);
 assert.equal(definition.proofBoundary.scientificQualification,'NOT_EVALUATED');
 assert.equal(definition.proofBoundary.runtimeAdapterAdmission,'NOT_EVALUATED');
});
test('rational media time converts exactly without long-duration floating point drift',()=>{
 for(const ticks of [0n,90000n,90000n*60n*60n*24n*365n*1000n,-90000n]){
  const ms=convertMediaTime(source(ticks),target({numerator:1n,denominator:1000n}));
  assert.equal(ms.timestamp.ticks,ticks/90n);assert.equal(ms.loss.lossless,true);
  assert.equal(convertMediaTime(ms.timestamp,target(source(0n).timeBase)).timestamp.ticks,ticks);
 }
});
test('29.97 rational frame boundaries preserve exact 30000/1001 cadence',()=>{
 const frame=source(1000000n,{numerator:1001n,denominator:30000n});
 assert.equal(convertMediaTime(frame,target({numerator:1n,denominator:90000n})).timestamp.ticks,3003000000n);
});
test('constant-rate frame boundaries use exact rational cadence and explicit origin; VFR uses source PTS',()=>{
 const base={clockKind:'media',clockId:'clock-v1',streamId:'video-v1',originRef:'timeline-origin-v1',cadenceKind:'CONSTANT_RATE',frameCount:30000n,frameRate:{numerator:30000n,denominator:1001n}};
 const at=constantRateFrameBoundaryToMediaTime({...base,frameIndex:24000n});
 assert.equal(at.ticks,24000n);assert.deepEqual(at.timeBase,{numerator:1001n,denominator:30000n});assert.equal(at.originRef,'timeline-origin-v1');
 assert.equal(constantRateFrameBoundaryToMediaTime({...base,frameIndex:base.frameCount}).endpoint,'half-open-end-boundary');
 assert.throws(()=>constantRateFrameBoundaryToMediaTime({...base,frameIndex:30001n}),/OUTSIDE/);
 assert.throws(()=>constantRateFrameBoundaryToMediaTime({...base,frameRate:{numerator:29.97,denominator:1n}}),/EXACT/);
 assert.throws(()=>constantRateFrameBoundaryToMediaTime({...base,cadenceKind:'VARIABLE_RATE'}),/CONSTANT_RATE/);
 const vfrPts=source(1801n,{numerator:1n,denominator:90000n});
 assert.equal(convertMediaTime(vfrPts,target(vfrPts.timeBase)).timestamp.ticks,1801n,'VFR position remains its explicit source PTS');
});
test('24000/1001 cadence is never silently reinterpreted as an equal 24 fps frame count',()=>{
 const frame=source(1n,{numerator:1001n,denominator:24000n});
 assert.throws(()=>convertMediaTime(frame,target({numerator:1n,denominator:24n})),/INEXACT/);
 const rounded=convertMediaTime(frame,target({numerator:1n,denominator:24n},'floor'));
 assert.equal(rounded.timestamp.ticks,1n);
 assert.deepEqual(rounded.loss.discardedSeconds,rational(1n,24000n));
 const thousand=source(1000n,frame.timeBase);
 assert.equal(convertMediaTime(thousand,target({numerator:1n,denominator:24n})).timestamp.ticks,1001n);
});
test('inexact conversion requires a selected rounding method and reports exact signed loss',()=>{
 const one=source(1n,{numerator:1n,denominator:3n});
 assert.throws(()=>convertMediaTime(one,target({numerator:1n,denominator:1000n})),/INEXACT/);
 const floor=convertMediaTime(one,target({numerator:1n,denominator:1000n},'floor'));
 assert.equal(floor.timestamp.ticks,333n);assert.deepEqual(floor.loss.discardedSeconds,rational(1n,3000n));assert.equal(floor.loss.lossless,false);
 const negative=convertMediaTime(source(-1n,one.timeBase),target({numerator:1n,denominator:1000n},'floor'));
 assert.equal(negative.timestamp.ticks,-334n);assert.deepEqual(negative.loss.discardedSeconds,rational(1n,1500n));
 for(const [n,expected] of [[1n,0n],[3n,2n],[-1n,0n],[-3n,-2n]])assert.equal(convertMediaTime(source(n,{numerator:1n,denominator:2n}),target({numerator:1n,denominator:1n},'nearest-ties-even')).timestamp.ticks,expected);
 assert.throws(()=>convertMediaTime(one,({...target({numerator:1n,denominator:1000n}),rounding:undefined})),/ROUNDING/);
});
test('unknown clocks, implicit legacy fps/seconds and integer overflow fail closed',()=>{
 const a=source(1n);
 for(const mutant of [{...a,clockKind:'wall-clock'},{...a,clockId:''},{...a,originRef:''},{...a,ticks:1},{...a,timeBase:{numerator:0n,denominator:1n}},{...a,timeBase:{numerator:1n,denominator:0n}}])assert.throws(()=>convertMediaTime(mutant,target(a.timeBase)));
 assert.throws(()=>convertMediaTime(a,{...target(a.timeBase),clockId:'other'}),/ALIGNMENT/);
 assert.throws(()=>convertMediaTime(a,{...target(a.timeBase),streamId:'other'}),/ALIGNMENT/);
 assert.throws(()=>convertMediaTime(a,{...target(a.timeBase),originRef:'other-origin'}),/ALIGNMENT/);
 assert.throws(()=>convertMediaTime(source((1n<<63n)-1n,{numerator:1n,denominator:1n}),target({numerator:1n,denominator:1000n})),/RANGE/);
 for(const tick of [-(1n<<63n),(1n<<63n)-1n])assert.equal(convertMediaTime(source(tick),target(a.timeBase)).timestamp.ticks,tick);
 for(const tick of [-(1n<<63n)-1n,1n<<63n])assert.throws(()=>convertMediaTime(source(tick),target(a.timeBase)),/RANGE/);
});
test('sample conversion distinguishes an end boundary from a valid sample and retains priming separation',()=>{
 const s=source(1n,{numerator:1n,denominator:1n});const r=timeToSample(s,{sampleRate:48000n,sampleCount:48000n,rounding:'exact'});
 assert.equal(r.sampleIndex,48000n);assert.match(r.endpoint,/end, not a sample/);
 assert.throws(()=>timeToSample(s,{sampleRate:48000n,sampleCount:47999n,rounding:'exact'}),/OUTSIDE/);
 assert.throws(()=>timeToSample(source(-1n,s.timeBase),{sampleRate:48000n,sampleCount:48000n,rounding:'exact'}),/OUTSIDE/);
 assert.throws(()=>timeToSample(s,{sampleRate:48000,sampleCount:48000n,rounding:'exact'}),/EXACT/);
 const maxRate=(1n<<32n)-1n;
 assert.equal(timeToSample(s,{sampleRate:maxRate,sampleCount:maxRate,rounding:'exact'}).sampleIndex,maxRate);
 assert.throws(()=>timeToSample(s,{sampleRate:1n<<32n,sampleCount:1n<<32n,rounding:'exact'}),/RANGE/);
 assert.throws(()=>timeToSample(s,{sampleRate:48000n,sampleCount:1n<<63n,rounding:'exact'}),/RANGE/);
});
test('pixel boundary conversions round trip exactly and reject stale, ambiguous or out-of-bounds geometry',()=>{
 const c={imageVersionId:'image-v1',width:1920n,height:1080n,origin:'top-left',axes:'right-down'};
 for(const p of [{x:rational(0n),y:rational(0n)},{x:rational(1920n),y:rational(1080n)},{x:rational(1n,2n),y:rational(99n,7n)}])assert.deepEqual(denormalizePixelBoundary(normalizePixelBoundary(p,c),c),p);
 const p={x:rational(1n),y:rational(1n)};
 assert.throws(()=>normalizePixelBoundary(p,{...c,origin:'bottom-left'}),/CONVENTION/);
 assert.throws(()=>normalizePixelBoundary({...p,x:rational(1921n)},c),/OUTSIDE/);
 assert.throws(()=>denormalizePixelBoundary({...normalizePixelBoundary(p,c),imageVersionId:'image-v2'},c),/STALE/);
 assert.throws(()=>denormalizePixelBoundary(normalizePixelBoundary(p,c),{...c,width:3840n}),/STALE/);
 assert.throws(()=>denormalizePixelBoundary({...normalizePixelBoundary(p,c),convention:'pixel-center; bottom-left'},c),/CONVENTION/);
 assert.throws(()=>denormalizePixelBoundary({...normalizePixelBoundary(p,c),convention:undefined},c),/CONVENTION/);
 const large={...c,width:(1n<<32n)-1n};
 assert.deepEqual(denormalizePixelBoundary(normalizePixelBoundary({x:rational(large.width),y:rational(1n)},large),large),{x:rational(large.width),y:rational(1n)});
 assert.throws(()=>normalizePixelBoundary(p,{...c,width:1n<<32n}),/RANGE/);
});
test('physical unit conversion preserves dimension and exact decimal ratios without scientific qualification',()=>{
 assert.deepEqual(convertPhysicalQuantity(rational(1n),'m','mm').value,rational(1000n));
 assert.deepEqual(convertPhysicalQuantity(convertPhysicalQuantity(rational(17n,3n),'cm','km').value,'km','cm').value,rational(17n,3n));
 assert.equal(convertPhysicalQuantity(rational(1n),'m','cm').qualification,'NOT_EVALUATED');
 assert.throws(()=>convertPhysicalQuantity(rational(1n),'m','s'),/DIMENSION/);
 assert.throws(()=>convertPhysicalQuantity(rational(1n),'degrees','radians'),/UNSUPPORTED/);
 for(const unit of ['toString','constructor','__proto__'])assert.throws(()=>convertPhysicalQuantity(rational(1n),unit,unit),/UNSUPPORTED/);
});
test('pixel centers retain their exact half-pixel offset and cannot be silently exchanged with boundaries',()=>{
 const c={imageVersionId:'image-v1',width:1920n,height:1080n,origin:'top-left',axes:'right-down'};
 const first={x:rational(0n),y:rational(0n)},last={x:rational(1919n),y:rational(1079n)};
 const normalized=normalizePixelCenter(first,c);
 assert.deepEqual(normalized.x,rational(1n,3840n));assert.deepEqual(normalized.y,rational(1n,2160n));
 for(const p of [first,last,{x:rational(1n,2n),y:rational(99n,7n)}])assert.deepEqual(denormalizePixelCenter(normalizePixelCenter(p,c),c),p);
 assert.deepEqual(normalizePixelCenter(first,{...c,width:1n,height:1n}).x,rational(1n,2n));
 assert.throws(()=>normalizePixelCenter({...first,x:rational(-1n,2n)},c),/OUTSIDE/);
 assert.throws(()=>normalizePixelCenter({...first,x:rational(1920n)},c),/OUTSIDE/);
 for(const x of [rational(0n),rational(1n)])assert.throws(()=>denormalizePixelCenter({...normalized,x},c),/OUTSIDE/);
 assert.throws(()=>denormalizePixelBoundary(normalized,c),/CONVENTION/);
 assert.throws(()=>denormalizePixelCenter(normalizePixelBoundary(first,c),c),/CONVENTION/);
 assert.throws(()=>denormalizePixelCenter(normalized,{...c,imageVersionId:'image-v2'}),/STALE/);
 assert.throws(()=>denormalizePixelCenter(normalized,{...c,width:3840n}),/STALE/);
 assert.throws(()=>normalizePixelCenter(first,{...c,origin:'bottom-left'}),/CONVENTION/);
 const max={...c,width:(1n<<32n)-1n};
 const maxPoint={x:rational(max.width-1n),y:rational(1n)};
 assert.deepEqual(denormalizePixelCenter(normalizePixelCenter(maxPoint,max),max),maxPoint);
 assert.equal(normalized.qualification,'NOT_EVALUATED');
});

test('spatial transform declarations require registered explicit frames and never apply a 3D conversion',()=>{
 const definitions=parse(fs.readFileSync('.product-experience/pdp-1-domain-data/value-objects.yaml','utf8'));
 const contract=definitions.spatialTransformDeclarationContract;
 assert.equal(contract.status,'MEDIA_OWNER_DEFINED_DECLARATION_VALIDATION_ONLY; spatial-conversion-algorithm-unselected');
 assert.deepEqual(contract.requiredFrameFields,['frameRef','frameVersionRef','handedness','axisDirections.x','axisDirections.y','axisDirections.z','positionUnitRef','orientationUnitRef']);
 assert.equal(contract.scientificQualification,'NOT_EVALUATED');
 const sourceFrame={frameRef:'fixture:camera',frameVersionRef:'fixture:camera:v1',handedness:'RIGHT_HANDED',axisDirections:{x:'+X',y:'+Y',z:'+Z'},positionUnitRef:'fixture:meter',orientationUnitRef:'fixture:radian'};
 const targetFrame={frameRef:'fixture:world',frameVersionRef:'fixture:world:v2',handedness:'LEFT_HANDED',axisDirections:{x:'+X',y:'+Z',z:'+Y'},positionUnitRef:'fixture:millimeter',orientationUnitRef:'fixture:degree'};
 const declaration={transformPlanRef:'fixture:camera-to-world:v1',sourceFrame,targetFrame,orderedOperations:['fixture:explicit-axis-map','fixture:scale-length'],mappingRef:'fixture:mapping:v1',lossDisposition:'UNVERIFIED'};
 const registries={
  frames:{[sourceFrame.frameVersionRef]:sourceFrame,[targetFrame.frameVersionRef]:targetFrame},
  transformPlans:{[declaration.transformPlanRef]:{sourceFrameRef:sourceFrame.frameVersionRef,targetFrameRef:targetFrame.frameVersionRef,orderedOperations:declaration.orderedOperations,mappingRef:declaration.mappingRef,lossDisposition:declaration.lossDisposition}},
  lossDispositions:findRecord(parse(fs.readFileSync('.product-experience/pdp-0-product-truth/time-units-fidelity.yaml','utf8')),'conversionDisposition').lossClasses,
 };
 assert.deepEqual(registries.lossDispositions,['EXACT','TOLERANCE_BOUNDED','LOSSY','NON_INVERTIBLE','UNSUPPORTED','UNVERIFIED']);
 const checked=validateSpatialTransformDeclaration(declaration,registries);
 assert.equal(checked.status,'DECLARED_NOT_APPLIED');
 assert.equal(checked.qualification,'NOT_EVALUATED');
 assert.equal(Object.hasOwn(checked,'coordinates'),false,'declaration validation produces no transformed coordinates');
 assert.throws(()=>validateSpatialTransformDeclaration({...declaration,unreviewedDefault:'world-origin'},registries),/SPATIAL_TRANSFORM_FIELDS_NOT_CLOSED/);
 assert.throws(()=>validateSpatialTransformDeclaration({...declaration,sourceFrame:{...sourceFrame,axisDirections:{...sourceFrame.axisDirections,origin:'upper-left'}}},registries),/SPATIAL_AXIS_DIRECTIONS_NOT_CLOSED/);
 assert.throws(()=>validateSpatialTransformDeclaration({...declaration,sourceFrame:{...sourceFrame,unreviewedCalibration:'camera-v2'}},registries),/SPATIAL_FRAME_FIELDS_NOT_CLOSED/);
 assert.throws(()=>validateSpatialTransformDeclaration(declaration,{...registries,frames:{[sourceFrame.frameVersionRef]:sourceFrame}}),/UNKNOWN_SPATIAL_FRAME_VERSION/);
 assert.throws(()=>validateSpatialTransformDeclaration({...declaration,sourceFrame:{...sourceFrame,handedness:'UNKNOWN'}},registries),/SPATIAL_HANDEDNESS_REQUIRED/);
 assert.throws(()=>validateSpatialTransformDeclaration({...declaration,targetFrame:{...targetFrame,axisDirections:{x:'+X',y:'-Z',z:'+Y'}}},registries),/SPATIAL_HANDEDNESS_AXIS_PARITY_MISMATCH/);
 assert.throws(()=>validateSpatialTransformDeclaration({...declaration,sourceFrame:{...sourceFrame,axisDirections:{x:'+X',y:'-X',z:'+Y'}}},registries),/SPATIAL_AXIS_BASIS_MUST_BE_ORTHOGONAL/);
 assert.throws(()=>validateSpatialTransformDeclaration({...declaration,targetFrame:{...targetFrame,positionUnitRef:'fixture:unknown-unit'}},registries),/SPATIAL_FRAME_DESCRIPTOR_MISMATCH/);
 assert.throws(()=>validateSpatialTransformDeclaration({...declaration,orderedOperations:['fixture:scale-length','fixture:explicit-axis-map']},registries),/SPATIAL_TRANSFORM_PLAN_MISMATCH/);
 assert.throws(()=>validateSpatialTransformDeclaration({...declaration,orderedOperations:[]},registries),/SPATIAL_TRANSFORM_ORDER_REQUIRED/);
 assert.throws(()=>validateSpatialTransformDeclaration({...declaration,mappingRef:''},registries),/SPATIAL_TRANSFORM_PLAN_AND_MAPPING_REQUIRED/);
 assert.throws(()=>validateSpatialTransformDeclaration({...declaration,lossDisposition:'MAGIC'},registries),/UNKNOWN_SPATIAL_TRANSFORM_LOSS_DISPOSITION/);
});

test('provider confidence and similarity compare only inside the exact declared measurement scope',()=>{
 const definitions=parse(fs.readFileSync('.product-experience/pdp-1-domain-data/value-objects.yaml','utf8'));
 const contract=definitions.providerSignalContract;
 assert.deepEqual(contract.scopeIdentity,['providerRef','metricRef','metricVersionRef','methodRef','methodVersionRef','unitRef']);
 assert.equal(contract.comparability.interpretation,'Matching scope permits only same-scope comparison; it does not establish calibration, correctness, probability, ranking equivalence or scientific validity.');
 const signal={signalKind:'CONFIDENCE',providerRef:'provider:a',metricRef:'metric:object-score',metricVersionRef:'metric:v2',methodRef:'model:detector',methodVersionRef:'model:v4',unitRef:'unit:ratio',value:0.7};
 assert.equal(providerSignalsShareDeclaredScope(signal,{...signal,value:0.2}),true);
 for(const key of ['providerRef','metricRef','metricVersionRef','methodRef','methodVersionRef','unitRef'])assert.equal(providerSignalsShareDeclaredScope(signal,{...signal,[key]:`${signal[key]}:other`}),false,key);
 assert.equal(providerSignalsShareDeclaredScope(signal,{...signal,signalKind:'SIMILARITY'}),false);
 assert.throws(()=>providerSignalsShareDeclaredScope(signal,{...signal,metricVersionRef:undefined}),/SCOPED_PROVIDER_SIGNAL_REQUIRED/);
 assert.throws(()=>providerSignalsShareDeclaredScope(signal,{...signal,value:Infinity}),/SCOPED_PROVIDER_SIGNAL_REQUIRED/);
});
