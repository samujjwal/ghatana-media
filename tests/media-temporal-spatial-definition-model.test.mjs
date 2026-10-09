import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {conversionContract,rational,convertMediaTime,timeToSample,normalizePixelBoundary,denormalizePixelBoundary,normalizePixelCenter,denormalizePixelCenter,convertPhysicalQuantity} from '../scripts/lib/media-temporal-spatial-definition-model.mjs';
const parse=createRequire(new URL('../../ghatana-tools/package.json',import.meta.url))('yaml').parse;
const source=(ticks,timeBase={numerator:1n,denominator:90000n})=>({clockKind:'media',clockId:'source-pts-v1',streamId:'artifact-v1-video-0',ticks,timeBase});
const target=(timeBase,rounding='exact')=>({...source(0n),timeBase,rounding});
test('executable conversion limits bind to the exact owner profile, with no wire or scientific admission',()=>{
 const definition=parse(fs.readFileSync('.product-experience/pdp-1-domain-data/value-objects.yaml','utf8')).canonicalConversionDefinitions;
 assert.deepEqual(definition.machineContract,conversionContract);
 assert.deepEqual(definition.records.map(r=>r.id),['media.value.rational-media-time','media.value.sample-boundary-index','media.value.image-pixel-boundary','media.value.dimensioned-scalar','media.value.image-pixel-center']);
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
 for(const mutant of [{...a,clockKind:'wall-clock'},{...a,clockId:''},{...a,ticks:1},{...a,timeBase:{numerator:0n,denominator:1n}},{...a,timeBase:{numerator:1n,denominator:0n}}])assert.throws(()=>convertMediaTime(mutant,target(a.timeBase)));
 assert.throws(()=>convertMediaTime(a,{...target(a.timeBase),clockId:'other'}),/ALIGNMENT/);
 assert.throws(()=>convertMediaTime(a,{...target(a.timeBase),streamId:'other'}),/ALIGNMENT/);
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
