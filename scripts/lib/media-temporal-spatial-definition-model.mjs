// Executable PDP-1 definition oracle. This does not adapt or qualify legacy wire fields.
const I64_MIN=-(1n<<63n), I64_MAX=(1n<<63n)-1n;
export const conversionContract = Object.freeze({
 version:'media.definition.temporal-spatial-conversion.v1',
 clockKinds:Object.freeze(['media','simulation','story']),
 tickBits:64,timeBaseBits:64,sampleRateBits:32,sampleCountBits:64,imageDimensionBits:32,
 rounding:Object.freeze(['exact','floor','ceil','nearest-ties-even']),
 pixelConvention:'pixel-boundary; top-left; right-down',
 pixelCenterConvention:'pixel-center-index; top-left; right-down; normalized=(index+1/2)/dimension',
 units:Object.freeze(['m','cm','mm','km','s','ms','us','ns']),
 qualification:'NOT_EVALUATED',
});
const gcd=(a,b)=>{a=a<0n?-a:a;while(b){[a,b]=[b,a%b];}return a;};
export function rational(n,d=1n){
 if(typeof n!=='bigint'||typeof d!=='bigint'||d===0n)throw new Error('RATIONAL_INTEGER_AND_NONZERO_DENOMINATOR_REQUIRED');
 if(d<0n){n=-n;d=-d;}const g=gcd(n,d);return {n:n/g,d:d/g};
}
const mul=(a,b)=>rational(a.n*b.n,a.d*b.d);
const sub=(a,b)=>rational(a.n*b.d-b.n*a.d,a.d*b.d);
const boundedInteger=(n,min,max)=>{if(typeof n!=='bigint'||n<min||n>max)throw new Error('INTEGER_RANGE_OR_EXACT_REPRESENTATION');return n;};
function timeBase(base){boundedInteger(base?.numerator,1n,I64_MAX);boundedInteger(base?.denominator,1n,I64_MAX);return rational(base.numerator,base.denominator);}
function clock(value){
 if(!conversionContract.clockKinds.includes(value?.clockKind)||typeof value.clockId!=='string'||!value.clockId||typeof value.streamId!=='string'||!value.streamId)throw new Error('EXPLICIT_MEDIA_CLOCK_AND_STREAM_REQUIRED');
 boundedInteger(value.ticks,I64_MIN,I64_MAX);return timeBase(value.timeBase);
}
function rounded(value,mode){
 if(!conversionContract.rounding.includes(mode))throw new Error('EXPLICIT_ROUNDING_REQUIRED');
 const q=value.n/value.d,r=value.n%value.d;
 if(r===0n)return q;
 if(mode==='exact')throw new Error('INEXACT_CONVERSION');
 if(mode==='floor')return q-(r<0n?1n:0n);
 if(mode==='ceil')return q+(r>0n?1n:0n);
 const abs=r<0n?-r:r,sign=r<0n?-1n:1n;
 return abs*2n<value.d?q:abs*2n>value.d?q+sign:q%2n===0n?q:q+sign;
}
export function convertMediaTime(source,target){
 const from=clock(source);
 if(source.clockKind!==target?.clockKind||source.clockId!==target.clockId||source.streamId!==target.streamId)throw new Error('CLOCK_ALIGNMENT_REQUIRED');
 const to=timeBase(target.timeBase), exactTicks=rational(source.ticks*from.n*to.d,from.d*to.n);
 const ticks=boundedInteger(rounded(exactTicks,target.rounding),I64_MIN,I64_MAX);
 const discardedTicks=sub(exactTicks,rational(ticks));
 return {timestamp:{clockKind:source.clockKind,clockId:source.clockId,streamId:source.streamId,ticks,timeBase:{...target.timeBase}},
  loss:{lossless:discardedTicks.n===0n,rounding:target.rounding,discardedTicks,discardedSeconds:mul(discardedTicks,to)},
  provenance:{model:'media.definition.time-conversion.v1',sourceClock:source.clockId,sourceStream:source.streamId,sourceTimeBase:{...source.timeBase},targetTimeBase:{...target.timeBase},qualification:'NOT_EVALUATED'}};
}
export function timeToSample(source,{sampleRate,sampleCount,rounding}){
 boundedInteger(sampleRate,1n,(1n<<32n)-1n);boundedInteger(sampleCount,0n,I64_MAX);
 const converted=convertMediaTime(source,{clockKind:source.clockKind,clockId:source.clockId,streamId:source.streamId,timeBase:{numerator:1n,denominator:sampleRate},rounding});
 if(converted.timestamp.ticks<0n||converted.timestamp.ticks>sampleCount)throw new Error('SAMPLE_BOUNDARY_OUTSIDE_STREAM');
 return {...converted,sampleIndex:converted.timestamp.ticks,endpoint:'half-open-boundary; sampleCount is end, not a sample'};
}
function imageContext(context){
 if(context?.origin!=='top-left'||context.axes!=='right-down'||typeof context.imageVersionId!=='string'||!context.imageVersionId)throw new Error('IMAGE_VERSION_OR_COORDINATE_CONVENTION_REQUIRED');
 boundedInteger(context.width,1n,(1n<<32n)-1n);boundedInteger(context.height,1n,(1n<<32n)-1n);
}
function fractionInRange(v,max){const r=rational(v?.n,v?.d);if(r.n<0n||r.n>max*r.d)throw new Error('COORDINATE_OUTSIDE_IMAGE');return r;}
export function normalizePixelBoundary({x,y},context){
 imageContext(context);const px=fractionInRange(x,context.width),py=fractionInRange(y,context.height);
 return {x:rational(px.n,px.d*context.width),y:rational(py.n,py.d*context.height),imageVersionId:context.imageVersionId,referenceWidth:context.width,referenceHeight:context.height,convention:'pixel-boundary; top-left; right-down',qualification:'NOT_EVALUATED'};
}
export function denormalizePixelBoundary(position,context){
 imageContext(context);if(position.convention!=='pixel-boundary; top-left; right-down')throw new Error('COORDINATE_CONVENTION_REQUIRED');
 if(position.imageVersionId!==context.imageVersionId||position.referenceWidth!==context.width||position.referenceHeight!==context.height)throw new Error('STALE_IMAGE_VERSION');
 return {x:mul(fractionInRange(position.x,1n),rational(context.width)),y:mul(fractionInRange(position.y,1n),rational(context.height))};
}
export function normalizePixelCenter({x,y},context){
 imageContext(context);
 const px=fractionInRange(x,context.width-1n),py=fractionInRange(y,context.height-1n);
 return {x:rational(2n*px.n+px.d,2n*px.d*context.width),y:rational(2n*py.n+py.d,2n*py.d*context.height),imageVersionId:context.imageVersionId,referenceWidth:context.width,referenceHeight:context.height,convention:conversionContract.pixelCenterConvention,qualification:'NOT_EVALUATED'};
}
export function denormalizePixelCenter(position,context){
 imageContext(context);
 if(position?.convention!==conversionContract.pixelCenterConvention)throw new Error('COORDINATE_CONVENTION_REQUIRED');
 if(position.imageVersionId!==context.imageVersionId||position.referenceWidth!==context.width||position.referenceHeight!==context.height)throw new Error('STALE_IMAGE_VERSION');
 const x=sub(mul(fractionInRange(position.x,1n),rational(context.width)),rational(1n,2n));
 const y=sub(mul(fractionInRange(position.y,1n),rational(context.height)),rational(1n,2n));
 return {x:fractionInRange(x,context.width-1n),y:fractionInRange(y,context.height-1n)};
}
const units={m:['length',1n,1n],cm:['length',1n,100n],mm:['length',1n,1000n],km:['length',1000n,1n],s:['time',1n,1n],ms:['time',1n,1000n],us:['time',1n,1000000n],ns:['time',1n,1000000000n]};
export function convertPhysicalQuantity(value,fromUnit,toUnit){
 if(!Object.hasOwn(units,fromUnit)||!Object.hasOwn(units,toUnit))throw new Error('UNSUPPORTED_UNIT');
 const from=units[fromUnit],to=units[toUnit];if(from[0]!==to[0])throw new Error('INCOMPATIBLE_DIMENSION');
 return {value:mul(rational(value?.n,value?.d),rational(from[1]*to[2],from[2]*to[1])),unit:toUnit,dimension:to[0],lossless:true,qualification:'NOT_EVALUATED'};
}
