import type {Atom,AtomSubstructure,ChemicalDocument,DocumentReference} from '../core/types';
import {clone,fingerprint} from '../core/model';
import {collapseSubstructureInPlace} from '../core/collapse';
import {readCdxml} from './xml';
import {scopeElements,fragmentXml} from './xml-scope';
import {allocateIds,guardXmlReferences} from './preservation-topology';
import {xmlReferenceAttributes} from './preservation-properties';
import {bindXmlDocument,patchXmlDocument} from './xml-document-write';
import {rebindStableIds} from './preservation-expansion';
import {fail} from './shared';

function refuse(message:string):never{return fail(`无法保留收起片段的来源信息：${message}`,'PRESERVATION_UNSUPPORTED');}
function renameGraph(doc:ChemicalDocument,atoms:ReadonlyMap<string,string>,bonds:ReadonlyMap<string,string>):void{
  const atom=(id:string)=>atoms.get(id)??id,bond=(id:string)=>bonds.get(id)??id;
  const ref=(r:DocumentReference):DocumentReference=>r.kind==='molecule'?{...r,atomIds:r.atomIds.map(atom)}:r.kind==='atom'?{...r,id:atom(r.id)}:r.kind==='bond'?{...r,id:bond(r.id)}:r;
  doc.graph.atoms=Object.fromEntries(Object.values(doc.graph.atoms).map(a=>{a.id=atom(a.id);if(a.geometry)a.geometry.bondOrdering=a.geometry.bondOrdering.map(b=>b===null?null:bond(b))as typeof a.geometry.bondOrdering;if(a.multiAttachment)a.multiAttachment=a.multiAttachment.map(atom);if(a.substructure)a.substructure.connections.forEach(p=>p.bondId=bond(p.bondId));return [a.id,a];}));
  doc.graph.bonds=Object.fromEntries(Object.values(doc.graph.bonds).map(b=>{b.id=bond(b.id);b.atoms=b.atoms.map(atom)as [string,string];if(b.circularOrdering)b.circularOrdering=b.circularOrdering.map(b=>b===null?null:bond(b))as typeof b.circularOrdering;return [b.id,b];}));
  doc.depiction.positions=Object.fromEntries(Object.entries(doc.depiction.positions).map(([id,p])=>[atom(id),p]));
  doc.depiction.bonds=Object.fromEntries(Object.entries(doc.depiction.bonds).map(([id,d])=>{d.from=atom(d.from);if(d.crossings)d.crossings=d.crossings.map(bond);return [bond(id),d];}));
  for(const object of Object.values(doc.depiction.objects??{})){object.atomIds=object.atomIds.map(atom);for(const key of Object.keys(object.references))object.references[key]=object.references[key].map(ref);}
  for(const step of Object.values(doc.graph.reactions??{})){for(const role of ['reactants','products','arrows','above','below','pluses']as const)step[role]=step[role].map(ref);step.atomMappings?.forEach(m=>m.atoms=m.atoms.map(pair=>pair.map(atom)as [string,string]));}
}
function wrappers(doc:ChemicalDocument):{atom:Atom;child:ChemicalDocument}[]{
  const found:{atom:Atom;child:ChemicalDocument}[]=[];
  const visit=(current:ChemicalDocument,depth=0)=>{if(depth>=16)return;for(const atom of Object.values(current.graph.atoms))if(atom.substructure){for(const fragment of atom.substructure.fragments)visit(fragment.document,depth+1);if(atom.substructure.kind==='abbreviation'&&atom.substructure.fragments.length===1)found.push({atom,child:atom.substructure.fragments[0].document});}};
  visit(doc);return found;
}
function childPortBond(group:AtomSubstructure,port:string):string{
  const edges=Object.values(group.fragments[0].document.graph.bonds).filter(b=>b.atoms.includes(port));if(edges.length!==1)refuse('绑定端口必须恰好连接一条内部键');return edges[0].id;
}

/** Rehome the trusted native n/b elements instead of recreating their labels
 * and unknown retained styling. Desired JSON supplies model identities only. */
export function prepareCollapsedSource(doc:ChemicalDocument,before:ChemicalDocument,original:ChemicalDocument,xml:Document):ChemicalDocument|undefined{
  const target=wrappers(doc).find(({atom,child})=>!before.graph.atoms[atom.id]&&Object.keys(child.graph.atoms).some(id=>!!before.graph.atoms[id]&&!doc.graph.atoms[id]));
  if(!target)return;
  const selected=Object.keys(target.child.graph.atoms).filter(id=>!!before.graph.atoms[id]);
  if(!selected.length)return;
  if(selected.some(id=>!!doc.graph.atoms[id]))refuse('内部节点和顶层节点身份重叠，不能确定收起来源');
  const desiredGroup=target.atom.substructure!,nodes=scopeElements(xml,'n'),edges=scopeElements(xml,'b'),atomElements=new Map(Object.keys(before.graph.atoms).map((id,i)=>[id,nodes[i]])),bondElements=new Map(Object.keys(before.graph.bonds).map((id,i)=>[id,edges[i]])),parents=new Set(selected.map(id=>atomElements.get(id)?.parentElement));
  if(parents.size!==1||![...parents][0]||[...parents][0]!.localName!=='fragment')refuse('收起成员必须属于同一个明确来源片段');
  const sourceParent=[...parents][0]!,binding=bindXmlDocument(xml,before,original),nativeNext=allocateIds([...xml.getElementsByTagName('*')].map(el=>el.getAttribute('id')??''));
  const simulated=clone(before),collapse=collapseSubstructureInPlace(simulated,selected,desiredGroup.label),simulatedWrapper=simulated.graph.atoms[collapse.wrapperId],simulatedGroup=simulatedWrapper.substructure!,simulatedChild=simulatedGroup.fragments[0].document;
  if(collapse.boundaryBondIds.length!==desiredGroup.connections.length||collapse.boundaryBondIds.some(id=>!desiredGroup.connections.some(p=>p.bondId===id&&p.fragment===0)))refuse('来源边界与当前缩写端口不同，无法猜测被删除或新增的边界');
  const childAtomIds=new Map<string,string>(),childBondIds=new Map<string,string>();
  for(const connection of simulatedGroup.connections){const desired=desiredGroup.connections.find(p=>p.bondId===connection.bondId)!;childAtomIds.set(connection.atomId,desired.atomId);childBondIds.set(childPortBond(simulatedGroup,connection.atomId),childPortBond(desiredGroup,desired.atomId));}
  const originalPortBonds=new Map(simulatedGroup.connections.map(p=>[p.bondId,childPortBond(simulatedGroup,p.atomId)]));
  if(new Set([...Object.keys(simulatedChild.graph.atoms).map(id=>childAtomIds.get(id)??id)]).size!==Object.keys(simulatedChild.graph.atoms).length||new Set([...Object.keys(simulatedChild.graph.bonds).map(id=>childBondIds.get(id)??id)]).size!==Object.keys(simulatedChild.graph.bonds).length)refuse('端口重编号与真实内部对象身份冲突');
  renameGraph(simulatedChild,childAtomIds,childBondIds);
  simulatedGroup.fragments[0].attachmentOrder=simulatedGroup.fragments[0].attachmentOrder.map(id=>childAtomIds.get(id)??id);
  simulatedGroup.connections.forEach(p=>p.atomId=childAtomIds.get(p.atomId)??p.atomId);
  renameGraph(simulated,new Map([[collapse.wrapperId,target.atom.id]]),new Map());
  simulatedChild.title=target.child.title;
  const create=(name:string)=>xml.createElementNS(sourceParent.namespaceURI,sourceParent.prefix?`${sourceParent.prefix}:${name}`:name),nativeWrapper=create('n'),inner=create('fragment');
  nativeWrapper.setAttribute('id',nativeNext());nativeWrapper.setAttribute('NodeType','Fragment');const position=simulated.depiction.positions[target.atom.id];nativeWrapper.setAttribute('p',`${position.x*20} ${-position.y*20}`);inner.setAttribute('id',nativeNext());nativeWrapper.append(inner);
  const movedNodes=selected.map(id=>atomElements.get(id)!),movedEdges=collapse.internalBondIds.map(id=>bondElements.get(id)!);if(movedEdges.some(el=>el.parentElement!==sourceParent))refuse('内部键不在同一来源片段');
  const movedElements=[...movedNodes,...movedEdges].flatMap(el=>[el,...el.getElementsByTagName('*')]),nativeCounts=new Map<string,number>();for(const el of xml.getElementsByTagName('*'))if(el.hasAttribute('id')&&!['font','color'].includes(el.localName))nativeCounts.set(el.getAttribute('id')!,(nativeCounts.get(el.getAttribute('id')!)??0)+1);
  for(const el of [...movedElements,...collapse.boundaryBondIds.map(id=>bondElements.get(id)!)])if(el.hasAttribute('id')&&nativeCounts.get(el.getAttribute('id')!)!==1)refuse('相关原生对象 ID 跨层重复，无法可靠重写局部引用');
  const allowed=new Set(movedElements.map(el=>el.getAttribute('id')).filter((id):id is string=>!!id)),cutNativeIds=new Map<string,string>(),childNodes=new Map<string,Element>(selected.map(id=>[id,atomElements.get(id)!])),childEdges=new Map<string,Element>(collapse.internalBondIds.map(id=>[id,bondElements.get(id)!]));
  for(const id of collapse.boundaryBondIds)allowed.add(bondElements.get(id)!.getAttribute('id')!);
  for(const el of movedElements)for(const attribute of el.attributes)if(xmlReferenceAttributes.has(attribute.name)&&attribute.value.trim().split(/\s+/).some(id=>id!=='0'&&!allowed.has(id)))refuse(`内部来源 ${attribute.name} 引用了选区外对象`);
  for(const connection of simulatedGroup.connections){
    const sourceEdge=bondElements.get(connection.bondId)!;if(sourceEdge.children.length)refuse('边界键附有独立原生对象，不能确定应归属外部键还是内部端口键');
    const sourceBond=before.graph.bonds[connection.bondId],anchor=sourceBond.atoms.find(id=>selected.includes(id))!,outside=sourceBond.atoms.find(id=>!selected.includes(id))!,port=create('n'),portEdge=sourceEdge.cloneNode(true)as Element,portBondId=childBondIds.get(originalPortBonds.get(connection.bondId)!)!;
    const p=before.depiction.positions[outside];port.setAttribute('id',nativeNext());port.setAttribute('p',`${p.x*20} ${-p.y*20}`);port.setAttribute('NodeType','ExternalConnectionPoint');
    portEdge.setAttribute('id',nativeNext());portEdge.setAttribute('B',sourceBond.atoms[0]===anchor?atomElements.get(anchor)!.getAttribute('id')!:port.getAttribute('id')!);portEdge.setAttribute('E',sourceBond.atoms[1]===anchor?atomElements.get(anchor)!.getAttribute('id')!:port.getAttribute('id')!);
    inner.append(port,portEdge);childNodes.set(connection.atomId,port);childEdges.set(portBondId,portEdge);cutNativeIds.set(sourceEdge.getAttribute('id')!,portEdge.getAttribute('id')!);
  }
  for(const el of movedElements)for(const attribute of [...el.attributes])if(xmlReferenceAttributes.has(attribute.name))el.setAttribute(attribute.name,attribute.value.trim().split(/\s+/).map(id=>cutNativeIds.get(id)??id).join(' '));
  // Keep source member ordering deterministic, before generated ports, for the
  // model/native binding and the child source's own stable-ID fingerprint.
  for(const el of [...movedNodes,...movedEdges].reverse())inner.insertBefore(el,inner.firstChild);
  if(simulatedGroup.fragments[0].attachmentOrder.length)inner.setAttribute('ConnectionOrder',simulatedGroup.fragments[0].attachmentOrder.map(id=>childNodes.get(id)?.getAttribute('id')??refuse('内部连接点缺少原生映射')).join(' '));
  if(simulatedGroup.connections.length)nativeWrapper.setAttribute('BondOrdering',simulatedGroup.connections.map(p=>bondElements.get(p.bondId)!.getAttribute('id')).join(' '));
  const text=create('t'),run=create('s');text.setAttribute('p',nativeWrapper.getAttribute('p')!);run.setAttribute('font',xml.documentElement.getAttribute('LabelFont')??[...xml.getElementsByTagName('*')].find(el=>el.localName==='font')?.getAttribute('id')??'3');run.setAttribute('size',xml.documentElement.getAttribute('LabelSize')??'10');run.setAttribute('face',xml.documentElement.getAttribute('LabelFace')??'96');run.textContent=desiredGroup.label;text.append(run);nativeWrapper.append(text);sourceParent.append(nativeWrapper);
  for(const id of selected)atomElements.delete(id);atomElements.set(target.atom.id,nativeWrapper);for(const id of collapse.internalBondIds)bondElements.delete(id);
  for(const id of collapse.boundaryBondIds){const el=bondElements.get(id)!,bond=simulated.graph.bonds[id];el.setAttribute('B',atomElements.get(bond.atoms[0])!.getAttribute('id')!);el.setAttribute('E',atomElements.get(bond.atoms[1])!.getAttribute('id')!);}
  patchXmlDocument(xml,simulated,before,binding,atomElements,bondElements,nativeNext);
  const affected=new Set([...movedElements,...collapse.boundaryBondIds.map(id=>bondElements.get(id)!)].map(el=>el.getAttribute('id')).filter((id):id is string=>!!id));
  guardXmlReferences(xml,affected,new Set(),new Set([...binding.objects.values(),...binding.steps.values(),...movedElements]));
  const childRaw=fragmentXml(xml,inner),parsedChild=readCdxml(childRaw).document,sourceNodeIds=new Map([...childNodes].map(([id,el])=>[el,id])),sourceBondIds=new Map([...childEdges].map(([id,el])=>[el,id])),childBaseline=rebindStableIds(parsedChild,simulatedChild,scopeElements(inner,'n').map(el=>sourceNodeIds.get(el)!),scopeElements(inner,'b').map(el=>sourceBondIds.get(el)!));childBaseline.title=target.child.title;
  // This is the actual native baseline, including cached AS/BS labels that the
  // collapse operation intentionally clears in the desired editable graph.
  // Retain those raw values here so the next child patch can remove them.
  const source={...parsedChild.source!,raw:childRaw,fingerprint:fingerprint(childBaseline)};childBaseline.source=source;simulatedGroup.fragments[0].document=childBaseline;
  const temporary=clone(doc),temporaryTarget=wrappers(temporary).find(({atom})=>atom.id===target.atom.id);if(!temporaryTarget)refuse('临时缩写对象丢失');temporaryTarget.child.source=clone(source);
  const raw=new XMLSerializer().serializeToString(xml),parsed=readCdxml(raw).document,nodeIds=new Map([...atomElements].map(([id,el])=>[el,id])),bondIds=new Map([...bondElements].map(([id,el])=>[el,id])),parentBaseline=rebindStableIds(parsed,simulated,scopeElements(xml,'n').map(el=>nodeIds.get(el)!),scopeElements(xml,'b').map(el=>bondIds.get(el)!));
  return {...temporary,source:{...doc.source!,raw,fingerprint:fingerprint(parentBaseline)}};
}
