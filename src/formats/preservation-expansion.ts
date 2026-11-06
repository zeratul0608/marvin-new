import type {AtomSubstructure,ChemicalDocument,DocumentReference} from '../core/types';
import {clone,fingerprint} from '../core/model';
import {expandSubstructureInPlace} from '../core/expansion';
import {promotedId} from '../core/expansion-identities';
import {readCdxml} from './xml';
import {scopeElements} from './xml-scope';
import {allocateIds,guardXmlReferences} from './preservation-topology';
import {xmlReferenceAttributes} from './preservation-properties';
import {bindXmlDocument,patchXmlDocument} from './xml-document-write';
import {fail} from './shared';

function refuse(message:string):never{return fail(`无法保留缩写展开的来源信息：${message}`,'PRESERVATION_UNSUPPORTED');}
function desiredAtomCounts(doc:ChemicalDocument):Map<string,number>{
  const counts=new Map<string,number>();
  const visit=(current:ChemicalDocument,depth=0)=>{if(depth>=16)refuse('内部片段超过 16 层');for(const atom of Object.values(current.graph.atoms)){counts.set(atom.id,(counts.get(atom.id)??0)+1);for(const fragment of atom.substructure?.fragments??[])visit(fragment.document,depth+1);}};
  visit(doc);return counts;
}
function desiredPresent(atoms:ReadonlyMap<string,number>,id:string):boolean{
  const count=atoms.get(id)??0;if(count>1)refuse('目标内部片段使用了歧义重复局部 ID，不能确定原生对象的去向');return count===1;
}
function descendantPresent(after:ReadonlyMap<string,number>,wrapper:string,group:AtomSubstructure,occupiedParent:ReadonlySet<string>):boolean{
  const occupied=new Set(occupiedParent),queue=[{wrapper,group,depth:0}];let visited=0;
  // Match the breadth-first identity decisions made by recursive expansion.
  // Only identifiers are simulated here, avoiding another full document clone.
  while(queue.length){
    const next=queue.shift()!;if(next.depth>=16||++visited>2000)return false;
    if(next.group.kind!=='abbreviation'||next.group.fragments.length!==1)continue;
    const ports=new Set(next.group.connections.map(p=>p.atomId)),retained=Object.values(next.group.fragments[0].document.graph.atoms).filter(a=>!ports.has(a.id)),promoted:{id:string;group:AtomSubstructure|undefined}[]=[];
    for(const atom of retained){const id=promotedId('a',next.wrapper,atom.id,occupied);if(occupied.has(id))return false;occupied.add(id);promoted.push({id,group:atom.substructure});}
    occupied.delete(next.wrapper);
    const matches=promoted.filter(a=>after.has(a.id));if(matches.length){for(const atom of matches)desiredPresent(after,atom.id);return true;}
    for(const atom of promoted)if(atom.group)queue.push({wrapper:atom.id,group:atom.group,depth:next.depth+1});
  }
  return false;
}
/** Restore stable model IDs from bindings established through the original parse.
 * Native IDs/paths in user JSON never authorize a source element relocation. */
export function rebindStableIds(parsed:ChemicalDocument,like:ChemicalDocument,atoms:string[],bonds:string[]):ChemicalDocument{
  const atomMap=new Map(Object.keys(parsed.graph.atoms).map((id,i)=>[id,atoms[i]])),bondMap=new Map(Object.keys(parsed.graph.bonds).map((id,i)=>[id,bonds[i]]));
  if(atoms.some(id=>!id)||bonds.some(id=>!id)||atoms.length!==atomMap.size||bonds.length!==bondMap.size)refuse('展开后化学对象身份无法完整绑定');
  const drawingMap=new Map(Object.keys(parsed.depiction.objects??{}).map((id,i)=>[id,Object.keys(like.depiction.objects??{})[i]])),stepMap=new Map(Object.keys(parsed.graph.reactions??{}).map((id,i)=>[id,Object.keys(like.graph.reactions??{})[i]]));
  if(drawingMap.size!==Object.keys(like.depiction.objects??{}).length||stepMap.size!==Object.keys(like.graph.reactions??{}).length)refuse('展开意外改变了独立文档对象');
  const ref=(r:DocumentReference):DocumentReference=>r.kind==='molecule'?{...r,atomIds:r.atomIds.map(id=>atomMap.get(id)!)}:{kind:r.kind,id:(r.kind==='atom'?atomMap:r.kind==='bond'?bondMap:drawingMap).get(r.id)!};
  const result=clone(parsed);delete result.source;
  result.graph.atoms=Object.fromEntries(Object.values(parsed.graph.atoms).map(a=>{const id=atomMap.get(a.id)!,atom={...clone(a),id};if(atom.geometry)atom.geometry.bondOrdering=atom.geometry.bondOrdering.map(b=>b===null?null:bondMap.get(b)!)as typeof atom.geometry.bondOrdering;if(atom.multiAttachment)atom.multiAttachment=atom.multiAttachment.map(id=>atomMap.get(id)!);
    if(atom.substructure){const original=like.graph.atoms[id]?.substructure;if(!original)refuse('下层缩写的来源身份丢失');atom.substructure=clone(original);}return [id,atom];}));
  result.graph.bonds=Object.fromEntries(Object.values(parsed.graph.bonds).map(b=>{const id=bondMap.get(b.id)!,bond={...clone(b),id,atoms:b.atoms.map(a=>atomMap.get(a)!)as [string,string]};if(bond.circularOrdering)bond.circularOrdering=bond.circularOrdering.map(b=>b===null?null:bondMap.get(b)!)as typeof bond.circularOrdering;return [id,bond];}));
  result.depiction.positions=Object.fromEntries(Object.entries(parsed.depiction.positions).map(([id,p])=>[atomMap.get(id)!,p]));
  result.depiction.bonds=Object.fromEntries(Object.entries(parsed.depiction.bonds).map(([id,d])=>[bondMap.get(id)!,{...clone(d),from:atomMap.get(d.from)!,...(d.crossings?{crossings:d.crossings.map(id=>bondMap.get(id)!)}:{})}]));
  if(parsed.depiction.objects)result.depiction.objects=Object.fromEntries(Object.values(parsed.depiction.objects).map(o=>{const id=drawingMap.get(o.id)!,object={...clone(o),id,atomIds:o.atomIds.map(a=>atomMap.get(a)!),children:o.children.map(c=>drawingMap.get(c)!),references:Object.fromEntries(Object.entries(o.references).map(([key,refs])=>[key,refs.map(ref)]))};if(object.parentId)object.parentId=drawingMap.get(object.parentId)!;return [id,object];}));
  if(parsed.graph.reactions)result.graph.reactions=Object.fromEntries(Object.values(parsed.graph.reactions).map(step=>{const id=stepMap.get(step.id)!,value=clone(step);value.id=id;value.schemeId=like.graph.reactions![id].schemeId;for(const role of ['reactants','products','arrows','above','below','pluses']as const)value[role]=value[role].map(ref);value.atomMappings?.forEach(m=>m.atoms=m.atoms.map(pair=>pair.map(a=>atomMap.get(a)!)as [string,string]));return [id,value];}));
  return result;
}

/** Promote one source subtree, then let the ordinary preservation writer apply
 * subsequent chemical/coordinate edits against the newly parsed source. */
export function prepareExpandedSource(doc:ChemicalDocument,before:ChemicalDocument,original:ChemicalDocument,xml:Document):ChemicalDocument|undefined{
  const desiredAtoms=desiredAtomCounts(doc);
  // A wrapper retained inside another contraction was moved, not expanded.
  // Conversely, promoted atoms may already live inside a newly named wrapper.
  const candidate=(current:ChemicalDocument)=>{const occupied=new Set(Object.keys(current.graph.atoms));return Object.values(current.graph.atoms).find(a=>a.substructure&&!desiredPresent(desiredAtoms,a.id)&&descendantPresent(desiredAtoms,a.id,a.substructure,occupied));};
  if(!candidate(before))return;
  const nodes=scopeElements(xml,'n'),bonds=scopeElements(xml,'b');
  const binding=bindXmlDocument(xml,before,original),nodeMap=new Map(Object.keys(before.graph.atoms).map((id,i)=>[id,nodes[i]])),bondMap=new Map(Object.keys(before.graph.bonds).map((id,i)=>[id,bonds[i]])),expanded=clone(before),next=allocateIds([...xml.getElementsByTagName('*')].map(e=>e.getAttribute('id')??'')),affected=new Set<string>(),removed=new Set<Element>();
  let count=0;
  for(let wrapper=candidate(expanded);wrapper;wrapper=candidate(expanded)){
  if(++count>2000)refuse('展开超过 2000 个缩写');
  const native=nodeMap.get(wrapper.id)!,fragment=[...native.children].find(el=>el.localName==='fragment');if(!fragment)refuse('内部来源片段不存在');
  const child=wrapper.substructure!.fragments[0].document,sourceNodes=scopeElements(fragment,'n'),sourceBonds=scopeElements(fragment,'b'),childNodes=new Map(Object.keys(child.graph.atoms).map((id,i)=>[id,sourceNodes[i]])),childBonds=new Map(Object.keys(child.graph.bonds).map((id,i)=>[id,sourceBonds[i]]));
  const occupiedBefore=new Set(Object.keys(expanded.graph.atoms)),mapping=expandSubstructureInPlace(expanded,wrapper.id)[0],nativeIds=new Map<string,string>();
  if(mapping.removedPorts.some(id=>desiredPresent(desiredAtoms,promotedId('a',wrapper.id,id,occupiedBefore))))refuse('来源端口在内部改绑后又被展开，尚不能完整恢复其来源属性；请保留 JSON 或使用明确的重建导出');
  const roots=[...mapping.atomIds.map(id=>childNodes.get([...mapping.atomMap].find(([,value])=>value===id)![0])!),...Object.keys(child.graph.bonds).filter(id=>!wrapper.substructure!.connections.some(p=>mapping.bondMap.get(id)===p.bondId)).map(id=>childBonds.get(id)!)];
  const elements=roots.flatMap(el=>[el,...el.getElementsByTagName('*')]);
  for(const el of elements)if(el.hasAttribute('id')){const id=el.getAttribute('id')!;if(nativeIds.has(id))refuse('内部来源对象使用了歧义重复 ID');nativeIds.set(id,next());affected.add(id);}
  for(const portId of mapping.removedPorts){const port=childNodes.get(portId)!,outside=nodeMap.get(mapping.atomMap.get(portId)!)!;nativeIds.set(port.getAttribute('id')!,outside.getAttribute('id')!);affected.add(port.getAttribute('id')!);}
  for(const [id,mapped]of mapping.bondMap)if(bondMap.has(mapped)){const edge=childBonds.get(id)!;nativeIds.set(edge.getAttribute('id')!,bondMap.get(mapped)!.getAttribute('id')!);affected.add(edge.getAttribute('id')!);}
  for(const el of elements)for(const a of [...el.attributes]){
    if(a.name==='id')el.setAttribute('id',nativeIds.get(a.value)!);
    else if(xmlReferenceAttributes.has(a.name))el.setAttribute(a.name,a.value.trim().split(/\s+/).map(id=>id==='0'?'0':nativeIds.get(id)??refuse(`内部引用 ${a.name} 缺少唯一映射`)).join(' '));
  }
  for(const [old,id]of mapping.atomMap)if(mapping.atomIds.includes(id))nodeMap.set(id,childNodes.get(old)!);
  for(const [old,id]of mapping.bondMap)if(!bondMap.has(id))bondMap.set(id,childBonds.get(old)!);
  const parent=native.parentElement!;for(const root of roots)parent.append(root);
  affected.add(native.getAttribute('id')!);removed.add(native);native.remove();nodeMap.delete(wrapper.id);
  for(const port of wrapper.substructure!.connections){const edge=bondMap.get(port.bondId)!,b=expanded.graph.bonds[port.bondId];edge.setAttribute('B',nodeMap.get(b.atoms[0])!.getAttribute('id')!);edge.setAttribute('E',nodeMap.get(b.atoms[1])!.getAttribute('id')!);}
  }
  patchXmlDocument(xml,expanded,before,binding,nodeMap,bondMap,next);
  guardXmlReferences(xml,affected,removed,new Set([...binding.objects.values(),...binding.steps.values()]));
  const raw=new XMLSerializer().serializeToString(xml),parsed=readCdxml(raw).document;
  const nodeIds=new Map([...nodeMap].map(([id,el])=>[el,id])),bondIds=new Map([...bondMap].map(([id,el])=>[el,id]));
  const baseline=rebindStableIds(parsed,expanded,scopeElements(xml,'n').map(el=>nodeIds.get(el)!),scopeElements(xml,'b').map(el=>bondIds.get(el)!));
  return {...doc,source:{...doc.source!,raw,fingerprint:fingerprint(baseline)}};
}
