/** Validation only: source promotion changes serialization order. Match atoms
 * by attributes, page/group membership, coordinates and topology, then compare
 * the complete model projection with both graphs in the same identity order. */
export function equivalentDocuments(sdk,actual,expected){
 const aa=Object.values(actual.graph.atoms),ea=Object.values(expected.graph.atoms),ab=Object.values(actual.graph.bonds),eb=Object.values(expected.graph.bonds);
 if(aa.length!==ea.length||ab.length!==eb.length)return false;
 const memberships=doc=>{const map=new Map(Object.keys(doc.graph.atoms).map(id=>[id,[]]));Object.values(doc.depiction.objects??{}).forEach((o,i)=>o.atomIds.forEach(id=>map.get(id)?.push(i)));return map;},am=memberships(actual),em=memberships(expected);
 const key=(a,m)=>JSON.stringify([a.element,a.charge,a.isotope,a.radical,a.hydrogens,a.query,a.geometry?.type,a.substructure?.label,a.substructure?.kind,a.namedFragment,a.attachment,a.residueId,a.atomMap,a.cipLabel,m]);
 const pools=new Map();for(const a of ea){const k=key(a,em.get(a.id)),pool=pools.get(k)??[];pool.push(a.id);pools.set(k,pool);}
 const candidates=new Map();for(const a of aa){const p=actual.depiction.positions[a.id];candidates.set(a.id,(pools.get(key(a,am.get(a.id)))??[]).filter(id=>{const q=expected.depiction.positions[id];return Math.abs(p.x-q.x)<1e-6&&Math.abs(p.y-q.y)<1e-6;}));if(!candidates.get(a.id).length)return false;}
 const pair=(a,b)=>[a,b].sort().join('|'),edgeMap=new Map(eb.map(b=>[pair(...b.atoms),b])),neighbors=new Map(aa.map(a=>[a.id,[]]));for(const b of ab)for(const id of b.atoms)neighbors.get(id).push(b);
 const assigned=new Map(),used=new Set();for(const [id,options]of candidates)if(options.length===1){if(used.has(options[0]))return false;assigned.set(id,options[0]);used.add(options[0]);}
 const normalize=value=>JSON.stringify(value,(_k,v)=>typeof v==='number'?Math.round(v*1e6)/1e6:v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
 const verify=()=>{
  const bonds=ab.map(b=>edgeMap.get(pair(...b.atoms.map(id=>assigned.get(id))))?.id);if(bonds.some(id=>!id))return false;
  return normalize(sdk.documentProjection(actual))===normalize(sdk.documentProjection(expected,aa.map(a=>assigned.get(a.id)),bonds));
 };
 const remaining=aa.filter(a=>!assigned.has(a.id)).sort((a,b)=>candidates.get(a.id).length-candidates.get(b.id).length);let attempts=0;
 const search=index=>{if(index===remaining.length)return verify();if(++attempts>200000)throw Error('Document correspondence search exceeded validation limit');const id=remaining[index].id;
  for(const candidate of candidates.get(id)){if(used.has(candidate))continue;const compatible=neighbors.get(id).every(b=>{const other=b.atoms.find(a=>a!==id),mapped=assigned.get(other);return !mapped||edgeMap.get(pair(candidate,mapped))?.order===b.order;});if(!compatible)continue;assigned.set(id,candidate);used.add(candidate);if(search(index+1))return true;assigned.delete(id);used.delete(candidate);}return false;
 };
 return search(0);
}
