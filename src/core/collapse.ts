import {clone,emptyDocument,id} from './model';
import {assertMappedStereo,axialAtoms} from './stereochemistry';
import {polymerMembers} from './polymers';
import type {Atom,Bond,ChemicalDocument,DocumentReference,StereoBondOrdering} from './types';

export interface SubstructureCollapse{wrapperId:string;atomIds:string[];internalBondIds:string[];boundaryBondIds:string[]}
function fail(message:string):never{throw new Error(message);}
/** Move a connected chemical subgraph into an explicitly editable abbreviation.
 * The editor transaction owns the draft; failure never modifies the live store. */
export function collapseSubstructureInPlace(doc:ChemicalDocument,atomIds:readonly string[],label:string):SubstructureCollapse{
  if(!Array.isArray(atomIds)||!atomIds.length||new Set(atomIds).size!==atomIds.length||atomIds.some(a=>!Object.hasOwn(doc.graph.atoms,a)))fail('收起选区必须包含无重复的有效原子');
  if(typeof label!=='string'||!label.trim()||label.trim().length>500||/[\x00-\x1f]/.test(label))fail('缩写名称必须是 1–500 个有效字符');
  const selected=new Set(atomIds),before=clone(doc),allBonds=Object.values(doc.graph.bonds),internal=allBonds.filter(b=>b.atoms.every(a=>selected.has(a))),boundary=allBonds.filter(b=>b.atoms.filter(a=>selected.has(a)).length===1);
  const visited=new Set([atomIds[0]]),queue=[atomIds[0]];while(queue.length){const a=queue.pop()!;for(const b of internal)if(b.atoms.includes(a))for(const next of b.atoms)if(!visited.has(next)){visited.add(next);queue.push(next);}}
  if(visited.size!==selected.size)fail('请选择一个连通片段后收起；不连通结构不能合并成同一个缩写');
  if(boundary.some(b=>b.order!==1))fail('收起边界目前须为单键；请选入整个双键或芳香环');
  const outside=boundary.map(b=>b.atoms.find(a=>!selected.has(a))!);if(new Set(outside).size!==outside.length)fail('同一外部原子连接选区多个端点，收起会产生重复键，已拒绝');
  for(const b of boundary)if(doc.graph.atoms[b.atoms.find(a=>selected.has(a))!].attachment)fail('模板连接点不能作为收起边界的内部锚点');
  for(const atom of Object.values(doc.graph.atoms)){
    if(atom.geometry?.type==='axial'&&(selected.has(atom.id)||[...axialAtoms(doc,atom.id,atom.geometry.bondOrdering)??[]].some(a=>selected.has(a))))fail('轴立体跨片段收起尚未接入，请保留完整轴结构');
    if(atom.multiAttachment?.some(a=>selected.has(a))&&(!selected.has(atom.id)||atom.multiAttachment.some(a=>!selected.has(a))))fail('多中心连接跨越收起边界，不能自动重写为单个节点');
    if(selected.has(atom.id)&&atom.enhancedStereo&&atom.enhancedStereo.type!=='Absolute'&&Object.values(doc.graph.atoms).some(a=>!selected.has(a.id)&&a.enhancedStereo?.type===atom.enhancedStereo!.type&&a.enhancedStereo.group===atom.enhancedStereo!.group))fail('增强立体组跨越选区，请选入完整分组');
  }
  const objects=Object.values(doc.depiction.objects??{}),straddles=(members:readonly string[])=>members.some(a=>selected.has(a))&&!atomIds.every(a=>members.includes(a));
  for(const object of objects){
    if(straddles(object.atomIds))fail('收起选区跨越页面或显示分组边界，请选择同一范围内的片段');
    if(object.tag==='bracketedgroup'&&straddles(polymerMembers(doc,object.id)))fail('收起选区跨越聚合物成员边界，请保留其明确边界');
    if(Object.values(object.references).flat().some(ref=>ref.kind==='molecule'&&straddles(ref.atomIds)))fail('独立文档对象的分子引用只覆盖部分选区，收起会扩大其范围');
  }
  for(const step of Object.values(doc.graph.reactions??{})){
    if(step.atomMappings?.some(m=>m.atoms.some(pair=>pair.some(a=>selected.has(a)))))fail('反应单原子映射引用选区，不能将其猜测成缩写节点');
    for(const role of ['reactants','products','arrows','above','below','pluses']as const)for(const ref of step[role])if(ref.kind==='molecule'&&straddles(ref.atomIds))fail('收起选区跨越反应参与者范围');
  }
  const internalIds=new Set(internal.map(b=>b.id));
  for(const [bondId,d]of Object.entries(doc.depiction.bonds))if(d.crossings?.some(other=>internalIds.has(other)!==internalIds.has(bondId)))fail('所选化学键与外部交叉描绘互相引用，请先清除跨片段交叉提示');
  const child=emptyDocument(label.trim()),wrapperId=id('a'),bondMap=new Map(internal.map(b=>[b.id,b.id])),atomMap=new Map(atomIds.map(a=>[a,a]));
  for(const atomId of atomIds){child.graph.atoms[atomId]=clone(doc.graph.atoms[atomId]);child.depiction.positions[atomId]=clone(doc.depiction.positions[atomId]);delete child.graph.atoms[atomId].cipLabel;}
  for(const b of internal){child.graph.bonds[b.id]=clone(b);delete child.graph.bonds[b.id].cipLabel;if(doc.depiction.bonds[b.id])child.depiction.bonds[b.id]=clone(doc.depiction.bonds[b.id]);}
  const connections:{bondId:string;fragment:number;atomId:string}[]=[],attachmentOrder:string[]=[];
  for(const b of boundary){
    const anchor=b.atoms.find(a=>selected.has(a))!,outer=b.atoms.find(a=>!selected.has(a))!,portId=id('a'),portBondId=id('b');
    child.graph.atoms[portId]={id:portId,element:'*',attachment:'external',charge:0,hydrogens:{mode:'fixed',count:0}};child.depiction.positions[portId]=clone(doc.depiction.positions[outer]);
    const edge:Bond={...clone(b),id:portBondId,atoms:b.atoms.map(a=>selected.has(a)?a:portId)as [string,string]};delete edge.cipLabel;child.graph.bonds[portBondId]=edge;
    if(doc.depiction.bonds[b.id])child.depiction.bonds[portBondId]={...clone(doc.depiction.bonds[b.id]),from:doc.depiction.bonds[b.id].from===outer?portId:anchor};
    bondMap.set(b.id,portBondId);atomMap.set(outer,portId);connections.push({bondId:b.id,fragment:0,atomId:portId});attachmentOrder.push(portId);
  }
  attachmentOrder.push(...atomIds.filter(a=>child.graph.atoms[a].attachment==='external'));
  const ordering=(refs:StereoBondOrdering)=>refs.map(b=>b===null?null:bondMap.get(b)??fail('内部立体键引用无法保留'))as StereoBondOrdering;
  for(const atom of Object.values(child.graph.atoms)){if(atom.geometry)atom.geometry.bondOrdering=ordering(atom.geometry.bondOrdering);if(atom.substructure)atom.substructure.connections.forEach(p=>p.bondId=bondMap.get(p.bondId)??fail('下层缩写端口无法映射'));}
  for(const b of Object.values(child.graph.bonds))if(b.circularOrdering)b.circularOrdering=ordering(b.circularOrdering);
  for(const d of Object.values(child.depiction.bonds)){if(d.crossings)d.crossings=d.crossings.map(b=>bondMap.get(b)??fail('内部交叉描绘引用外部化学键'));}
  const anchors=[...new Set(boundary.map(b=>b.atoms.find(a=>selected.has(a))!))],center=anchors.length?anchors:atomIds;
  const position=center.reduce((p,a)=>({x:p.x+doc.depiction.positions[a].x/center.length,y:p.y+doc.depiction.positions[a].y/center.length}),{x:0,y:0});
  const wrapper:Atom={id:wrapperId,element:'*',charge:0,hydrogens:{mode:'auto'},substructure:{kind:'abbreviation',label:label.trim(),fragments:[{document:child,attachmentOrder}],connections}};
  const replace=(ids:string[])=>[...new Set(ids.flatMap(a=>selected.has(a)?[wrapperId]:[a]))];
  const ref=(r:DocumentReference,key?:string):DocumentReference[]=>{
    if(r.kind==='molecule')return [{...r,atomIds:replace(r.atomIds)}];
    if(r.kind==='atom'&&selected.has(r.id)||r.kind==='bond'&&internalIds.has(r.id)){if(key==='BracketedObjectIDs')return [{kind:'atom',id:wrapperId}];fail('独立文档对象引用了选区内的单个原子或键，不能自动改为缩写引用');}return [r];
  };
  for(const object of objects){object.atomIds=replace(object.atomIds);for(const [key,refs]of Object.entries(object.references)){
    if(object.tag==='crossingbond'&&key==='InnerAtomID')object.references[key]=refs.map(r=>r.kind==='atom'&&selected.has(r.id)?{kind:'atom',id:wrapperId}:r);
    else{const values=refs.flatMap(r=>ref(r,key));object.references[key]=values.filter((r,i)=>values.findIndex(v=>JSON.stringify(v)===JSON.stringify(r))===i);}
  }}
  for(const step of Object.values(doc.graph.reactions??{}))for(const role of ['reactants','products','arrows','above','below','pluses']as const)step[role]=step[role].flatMap(r=>ref(r));
  for(const b of boundary){const d=doc.depiction.bonds[b.id];if(d){d.from=selected.has(d.from)?wrapperId:d.from;if(d.labelOffsets){d.labelOffsets[b.atoms.findIndex(a=>selected.has(a))]=0;if(!d.labelOffsets.some(Boolean))delete d.labelOffsets;}}b.atoms=b.atoms.map(a=>selected.has(a)?wrapperId:a)as [string,string];}
  for(const a of atomIds){delete doc.graph.atoms[a];delete doc.depiction.positions[a];}for(const b of internal){delete doc.graph.bonds[b.id];delete doc.depiction.bonds[b.id];}
  doc.graph.atoms[wrapperId]=wrapper;doc.depiction.positions[wrapperId]=position;
  assertMappedStereo(before,child,new Map(atomIds.map(a=>[a,a])),bondMap);
  assertMappedStereo(before,doc,new Map(Object.keys(before.graph.atoms).filter(a=>!selected.has(a)).map(a=>[a,a])),new Map(allBonds.filter(b=>!internalIds.has(b.id)).map(b=>[b.id,b.id])));
  return {wrapperId,atomIds:[...atomIds],internalBondIds:internal.map(b=>b.id),boundaryBondIds:boundary.map(b=>b.id)};
}
