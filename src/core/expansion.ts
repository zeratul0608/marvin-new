import {clone} from './model';
import {assertMappedStereo} from './stereochemistry';
import type {Bond,BondDepiction,ChemicalDocument,DocumentReference,Point,StereoBondOrdering} from './types';
import {promotedId} from './expansion-identities';
export {expandedId} from './expansion-identities';

export interface SubstructureExpansion{atomId:string;atomIds:string[];atomMap:Map<string,string>;bondMap:Map<string,string>;removedPorts:string[]}
function fail(message:string):never{throw new Error(message);}
function mergeBoundary(outer:Bond,inner:Bond,atomMap:Map<string,string>):void{
  const values=clone(inner);if(values.externalNumbers&&atomMap.get(inner.atoms[0])!==outer.atoms[0])values.externalNumbers.reverse();
  for(const key of ['reactionParticipation','sequenceConnectivity','externalNumbers','topology']as const){
    if(values[key]===undefined)continue;if(outer[key]!==undefined&&JSON.stringify(outer[key])!==JSON.stringify(values[key]))fail('内外边界键的化学注释冲突，不能自动合并');Object.assign(outer,{[key]:values[key]});
  }
}
function mapDepiction(value:BondDepiction|undefined,atoms:Map<string,string>,bonds:Map<string,string>):BondDepiction|undefined{
  if(!value)return;const result=clone(value);result.from=atoms.get(value.from)??fail('内部键描绘缺少原子映射');
  if(result.crossings)result.crossings=result.crossings.map(id=>bonds.get(id)??fail('内部交叉键映射缺失'));return result;
}
function expandOne(doc:ChemicalDocument,atomId:string):SubstructureExpansion{
  const wrapper=doc.graph.atoms[atomId],group=wrapper?.substructure;
  if(!group)fail('此节点没有可展开的内部化学图；不能凭名称推测结构');
  if(group.kind!=='abbreviation'||group.fragments.length!==1)fail('备选组尚未选择唯一结构，请先在内部编辑器确定具体片段');
  if(wrapper.queryConstraints)fail('缩写节点包含整体查询约束，不能猜测其对应的内部原子；请使用群组展开视图编辑');
  if(wrapper.charge||wrapper.isotope||wrapper.radical||wrapper.atomMap!==undefined||wrapper.residueId!==undefined||wrapper.enhancedStereo||wrapper.spatial||wrapper.connectionType&&wrapper.connectionType!=='Unspecified'||wrapper.hydrogens.mode==='fixed'&&wrapper.hydrogens.count!==0)fail('缩写节点含整体电荷、映射或生物序列等注释，尚不能可靠分配到内部原子；请继续在内部编辑器修改');
  const child=group.fragments[0].document;
  if(Object.keys(child.depiction.objects??{}).length||Object.keys(child.graph.reactions??{}).length)fail('内部片段包含独立图元或反应对象，本次展开不会丢弃这些内容；请使用内部编辑器');
  const before=clone(doc),inside=clone(child),atomMap=new Map<string,string>(),bondMap=new Map<string,string>(),bound=new Map<string,{outer:Bond;inner:Bond;outside:string;anchor:string}>();
  for(const port of group.connections){
    const outer=doc.graph.bonds[port.bondId],edges=Object.values(child.graph.bonds).filter(b=>b.atoms.includes(port.atomId));
    if(port.fragment!==0||edges.length!==1||![1,2,3].includes(outer.order as number)||outer.order!==edges[0].order)fail('本次展开需要每个绑定端口恰好连接一条内外同阶的普通单键、双键或三键');
    // The virtual port and parent label have different adjacent ligands. Their
    // explicit double-bond orderings require a dedicated two-sided merge; do
    // not discard either source constraint when replacing the boundary.
    if(outer.order===2&&(outer.circularOrdering||edges[0].circularOrdering))fail('多重边界键的显式立体排序尚不能完整合并，请使用群组展开视图编辑');
    const outside=outer.atoms.find(id=>id!==atomId)!,anchor=edges[0].atoms.find(id=>id!==port.atomId)!;
    if(child.graph.atoms[anchor].attachment)fail('两个虚拟端口之间没有明确内部原子，不能建立真实连接');
    if(bound.has(port.atomId))fail('内部端口重复绑定');bound.set(port.atomId,{outer,inner:edges[0],outside,anchor});atomMap.set(port.atomId,outside);bondMap.set(edges[0].id,outer.id);
  }
  const retained=Object.keys(child.graph.atoms).filter(id=>!bound.has(id));if(!retained.length)fail('内部片段没有可提升的原子');
  const occupiedAtoms=new Set(Object.keys(doc.graph.atoms)),occupiedBonds=new Set(Object.keys(doc.graph.bonds));
  for(const id of retained){const next=promotedId('a',atomId,id,occupiedAtoms);if(occupiedAtoms.has(next))fail('展开后的稳定原子 ID 发生冲突');atomMap.set(id,next);occupiedAtoms.add(next);}
  for(const id of Object.keys(child.graph.bonds))if(!bondMap.has(id)){const next=promotedId('b',atomId,id,occupiedBonds);if(occupiedBonds.has(next))fail('展开后的稳定键 ID 发生冲突');bondMap.set(id,next);occupiedBonds.add(next);}
  const anchors=[...new Set([...bound.values()].map(p=>p.anchor))],centerIds=anchors.length?anchors:retained;
  const center=centerIds.reduce((p,id)=>({x:p.x+child.depiction.positions[id].x/centerIds.length,y:p.y+child.depiction.positions[id].y/centerIds.length}),{x:0,y:0}),target=doc.depiction.positions[atomId];
  let cross=0,dot=0;
  for(const [portId,port]of bound){const p=child.depiction.positions[portId],q=doc.depiction.positions[port.outside],a={x:p.x-center.x,y:p.y-center.y},b={x:q.x-target.x,y:q.y-target.y};cross+=a.x*b.y-a.y*b.x;dot+=a.x*b.x+a.y*b.y;}
  const angle=bound.size&&Math.hypot(cross,dot)>1e-9?Math.atan2(cross,dot):0,c=Math.cos(angle),s=Math.sin(angle);
  const point=(p:Point):Point=>({x:target.x+(p.x-center.x)*c-(p.y-center.y)*s,y:target.y+(p.x-center.x)*s+(p.y-center.y)*c});
  const ordering=(refs:StereoBondOrdering)=>refs.map(id=>id===null?null:bondMap.get(id)??fail('内部立体键引用未映射'))as StereoBondOrdering;
  const usedGroups=new Set(Object.values(doc.graph.atoms).flatMap(a=>a.enhancedStereo?.type==='And'||a.enhancedStereo?.type==='Or'?[`${a.enhancedStereo.type}:${a.enhancedStereo.group}`]:[])),stereoGroups=new Map<string,number>();
  const incomingGroups=new Map(retained.flatMap(id=>{const stereo=child.graph.atoms[id].enhancedStereo;return stereo&&stereo.type!=='Absolute'?[[`${stereo.type}:${stereo.group}`,stereo]as const]:[];}));
  // Reserve all non-conflicting original group numbers before choosing spare
  // numbers for conflicts, so one reassignment cannot steal another group's ID.
  for(const [key,stereo]of incomingGroups)if(!usedGroups.has(key)){stereoGroups.set(key,stereo.group!);usedGroups.add(key);}
  for(const [key,stereo]of incomingGroups)if(!stereoGroups.has(key)){let number=1;while(usedGroups.has(`${stereo.type}:${number}`))number++;stereoGroups.set(key,number);usedGroups.add(`${stereo.type}:${number}`);}
  for(const id of retained){
    const atom=clone(child.graph.atoms[id]),next=atomMap.get(id)!;atom.id=next;
    if(atom.geometry)atom.geometry.bondOrdering=ordering(atom.geometry.bondOrdering);
    if(atom.multiAttachment)atom.multiAttachment=atom.multiAttachment.map(id=>atomMap.get(id)??fail('内部多中心引用未映射'));
    if(atom.substructure)atom.substructure.connections.forEach(port=>port.bondId=bondMap.get(port.bondId)??fail('下层缩写边界键未映射'));
    if(atom.enhancedStereo&&atom.enhancedStereo.type!=='Absolute'){
      const key=`${atom.enhancedStereo.type}:${atom.enhancedStereo.group}`;atom.enhancedStereo.group=stereoGroups.get(key)!;
    }
    delete atom.cipLabel;doc.graph.atoms[next]=atom;doc.depiction.positions[next]=point(child.depiction.positions[id]);
  }
  for(const bond of Object.values(child.graph.bonds))if(![...bound.values()].some(p=>p.inner.id===bond.id)){
    const result=clone(bond);result.id=bondMap.get(bond.id)!;result.atoms=bond.atoms.map(id=>atomMap.get(id)!)as [string,string];if(result.circularOrdering)result.circularOrdering=ordering(result.circularOrdering);delete result.cipLabel;
    doc.graph.bonds[result.id]=result;const d=mapDepiction(child.depiction.bonds[bond.id],atomMap,bondMap);if(d)doc.depiction.bonds[result.id]=d;
  }
  for(const port of bound.values()){
    const outer=port.outer,old=doc.depiction.bonds[outer.id],inner=mapDepiction(child.depiction.bonds[port.inner.id],atomMap,bondMap),anchor=atomMap.get(port.anchor)!;
    outer.atoms=outer.atoms.map(id=>id===atomId?anchor:id)as [string,string];mergeBoundary(outer,port.inner,atomMap);
    const d=old?{...clone(old),from:old.from===atomId?anchor:old.from}:undefined,stereo=(d:BondDepiction|undefined)=>!!d&&['wedge','hashed','wavy'].includes(d.style);
    if(stereo(d)&&stereo(inner)&&(d!.style!==inner!.style||d!.from!==inner!.from))fail('内外边界的楔线或未知立体描绘冲突，展开已取消');
    const result=stereo(inner)&&!stereo(d)?{...(d??{}),...inner!}:d??inner;
    if(result){
      const side=before.graph.bonds[outer.id].atoms.indexOf(atomId),offsets:[number,number]=old?.labelOffsets?clone(old.labelOffsets):[0,0];
      offsets[side]=child.depiction.bonds[port.inner.id]?.labelOffsets?.[port.inner.atoms.indexOf(port.anchor)]??0;
      if(offsets.some(Boolean))result.labelOffsets=offsets;else delete result.labelOffsets;
      doc.depiction.bonds[outer.id]=result;
    }
  }
  const atomIds=retained.map(id=>atomMap.get(id)!),replace=(ids:string[])=>ids.flatMap(id=>id===atomId?atomIds:[id]);
  const reference=(ref:DocumentReference,key?:string):DocumentReference[]=>{
    if(ref.kind==='molecule')return [{...ref,atomIds:replace(ref.atomIds)}];
    if(ref.kind==='atom'&&ref.id===atomId){if(key==='BracketedObjectIDs')return atomIds.map(id=>({kind:'atom',id}));fail('文档对象把缩写作为单个原子引用，无法自动改为多个原子');}return [ref];
  };
  for(const object of Object.values(doc.depiction.objects??{})){
    object.atomIds=replace(object.atomIds);
    for(const [key,refs]of Object.entries(object.references)){
      if(object.tag==='crossingbond'&&key==='InnerAtomID'&&refs.some(ref=>ref.kind==='atom'&&ref.id===atomId)){
        const boundary=object.references.BondID?.[0],port=boundary?.kind==='bond'?[...bound.values()].find(p=>p.outer.id===boundary.id):undefined;if(!port)fail('聚合物边界无法匹配缩写端口');object.references[key]=[{kind:'atom',id:atomMap.get(port.anchor)!}];
      }else object.references[key]=refs.flatMap(ref=>reference(ref,key));
    }
  }
  for(const step of Object.values(doc.graph.reactions??{})){
    for(const mapping of step.atomMappings??[])if(mapping.atoms.some(pair=>pair.includes(atomId)))fail('反应原子映射引用了整个缩写，不能猜测其对应的内部原子');
    for(const role of ['reactants','products','arrows','above','below','pluses']as const)step[role]=step[role].flatMap(ref=>reference(ref));
  }
  for(const atom of Object.values(doc.graph.atoms))if(atom.id!==atomId&&atom.multiAttachment?.includes(atomId))fail('多中心连接引用了整个缩写，不能自动猜测内部目标原子');
  delete doc.graph.atoms[atomId];delete doc.depiction.positions[atomId];
  assertMappedStereo(inside,doc,atomMap,bondMap);
  assertMappedStereo(before,doc,new Map(Object.keys(before.graph.atoms).filter(id=>id!==atomId).map(id=>[id,id])),new Map(Object.keys(before.graph.bonds).map(id=>[id,id])));
  return {atomId,atomIds,atomMap,bondMap,removedPorts:[...bound.keys()]};
}
/** Caller supplies the transaction clone; failures never reach the live store. */
export function expandSubstructureInPlace(doc:ChemicalDocument,atomId:string,recursive=false):SubstructureExpansion[]{
  const result=[expandOne(doc,atomId)];if(recursive){const queue=[...result[0].atomIds];let count=0;while(queue.length){const id=queue.shift()!;if(doc.graph.atoms[id]?.substructure){if(++count>2000)fail('递归展开超过限额');const next=expandOne(doc,id);result.push(next);queue.push(...next.atomIds);}}}return result;
}
