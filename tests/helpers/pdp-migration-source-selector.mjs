/** Resolve declared YAML owner selectors without inventing array record traversal. */
export function resolvePdp3BindingSourceRef(ref, documents) {
  if(typeof ref!=='string'||!ref.includes('#'))return undefined;
  const at=ref.indexOf('#');let value=documents[ref.slice(0,at)];
  const fragment=ref.slice(at+1);
  const tokens=fragment.includes('/')?fragment.replace(/^\//u,'').split('/'):fragment.split('.');
  for(const encoded of tokens){if(!encoded)continue;const token=encoded.replaceAll('~1','/').replaceAll('~0','~');
    if(token.startsWith('@id='))value=Array.isArray(value)?value.find(row=>row.id===token.slice(4)):undefined;
    else if(Array.isArray(value))value=/^\d+$/u.test(token)?value[Number(token)]:undefined;
    else for(const part of token.split('.'))value=value?.[part];
    if(value===undefined)return undefined;
  }
  return value;
}
