import type {ChemicalDocument,DocumentReference,DrawingObject} from './types';

// Public CDX/CDXML values. The editor keeps native attributes and references as
// the single storage representation; this typed view supplies chemical meaning.
export const bracketUsages=['Unspecified','Unused1','Unused2','SRU','Monomer','Mer','Copolymer','CopolymerAlternating','CopolymerRandom','CopolymerBlock','Crosslink','Graft','Modification','Component','MixtureUnordered','MixtureOrdered','MultipleGroup','Generic','Anypolymer']as const;
export const polymerRepeatPatterns=['HeadToTail','HeadToHead','EitherUnknown']as const;
export const polymerFlipTypes=['Unspecified','NoFlip','Flip']as const;
export type BracketUsage=typeof bracketUsages[number];
export interface PolymerChanges{usage?:BracketUsage;repeatPattern?:typeof polymerRepeatPatterns[number]|null;flipType?:typeof polymerFlipTypes[number]|null;repeatCount?:number|null;componentOrder?:number|null;label?:string|null;atomIds?:string[]}
export interface PolymerGroup{
  id:string;usage:string;repeatPattern:string;flipType:string;repeatCount?:number;componentOrder?:number;label?:string;
  atomIds:string[];crossings:{id:string;attachmentId:string;bondId:string;innerAtomId:string;graphicId?:string}[];
}
function fail(message:string):never{throw new Error(message);}
function objects(doc:ChemicalDocument){return doc.depiction.objects??{};}
/** Resolve explicit bracket members, including nested groups and molecule refs. */
export function polymerMembers(doc:ChemicalDocument,groupId:string):string[]{
  const found=new Set<string>(),visiting=new Set<string>(),table=objects(doc);
  const visit=(ref:DocumentReference)=>{
    if(ref.kind==='atom')found.add(ref.id);
    else if(ref.kind==='molecule')ref.atomIds.forEach(id=>found.add(id));
    else if(ref.kind==='bond')doc.graph.bonds[ref.id]?.atoms.forEach(id=>found.add(id));
    else{
      if(visiting.has(ref.id)||visiting.size>=64)fail('括号组成员含循环引用或超过 64 层');const object=table[ref.id];if(!object)return;
      visiting.add(ref.id);object.atomIds.forEach(id=>found.add(id));(object.references.BracketedObjectIDs??[]).forEach(visit);visiting.delete(ref.id);
    }
  };
  visit({kind:'drawing',id:groupId});return [...found];
}
const single=(object:DrawingObject,key:string,kind:DocumentReference['kind']):string|undefined=>{
  const refs=object.references[key]??[];if(refs.length>1||refs.some(ref=>ref.kind!==kind))fail(`聚合物 ${key} 必须是单一${kind}引用`);
  return refs.length?(refs[0]as {id:string}).id:undefined;
};
export function getPolymerGroup(doc:ChemicalDocument,id:string):PolymerGroup{
  const table=objects(doc),group=table[id];if(group?.tag!=='bracketedgroup')fail('请选择聚合物／重复括号组');
  const a=group.attributes,crossings:PolymerGroup['crossings']=[];
  for(const attachmentId of group.children){const attachment=table[attachmentId];if(attachment.tag!=='bracketattachment')continue;
    const graphicId=single(attachment,'GraphicID','drawing');
    for(const crossingId of attachment.children){const crossing=table[crossingId];if(crossing.tag!=='crossingbond')continue;
      const bondId=single(crossing,'BondID','bond'),innerAtomId=single(crossing,'InnerAtomID','atom');
      if(!bondId||!innerAtomId)fail('跨括号键缺少 BondID 或 InnerAtomID');
      crossings.push({id:crossingId,attachmentId,bondId,innerAtomId,...(graphicId?{graphicId}:{})});
    }
  }
  return {id,usage:a.BracketUsage??'Unspecified',repeatPattern:a.PolymerRepeatPattern??'HeadToTail',flipType:a.PolymerFlipType??'Unspecified',
    ...(a.RepeatCount!==undefined?{repeatCount:Number(a.RepeatCount)}:a.BracketUsage==='MultipleGroup'?{repeatCount:2}:{}),
    ...(a.ComponentOrder!==undefined?{componentOrder:Number(a.ComponentOrder)}:{}),...(a.SRULabel!==undefined?{label:a.SRULabel}:{}),atomIds:polymerMembers(doc,id),crossings};
}
export function validatePolymers(doc:ChemicalDocument):void{
  const table=objects(doc);
  for(const object of Object.values(table)){
    if(object.tag==='bracketedgroup'){
      const group=getPolymerGroup(doc,object.id),members=new Set(group.atomIds);
      if(group.repeatCount!==undefined&&(!Number.isFinite(group.repeatCount)||group.repeatCount<=0))fail('重复次数必须是有限正数');
      for(const crossing of group.crossings){const bond=doc.graph.bonds[crossing.bondId];if(!bond?.atoms.includes(crossing.innerAtomId)||!members.has(crossing.innerAtomId)||bond.atoms.filter(id=>members.has(id)).length!==1)fail('跨括号键必须连接一个组内原子和一个组外原子，InnerAtomID 必须位于组内');}
    }else if(object.tag==='bracketattachment'){
      if(!object.parentId||table[object.parentId]?.tag!=='bracketedgroup')fail('括号连接必须属于括号组');
      const graphic=single(object,'GraphicID','drawing');if(graphic&&table[graphic]?.tag!=='graphic')fail('括号连接的 GraphicID 必须指向图形');
    }else if(object.tag==='crossingbond'&&(!object.parentId||table[object.parentId]?.tag!=='bracketattachment'))fail('跨括号键必须属于括号连接');
  }
}
export function updatePolymer(doc:ChemicalDocument,id:string,changes:PolymerChanges):void{
  const group=objects(doc)[id];if(group?.tag!=='bracketedgroup')fail('聚合物括号组不存在');
  if(!changes||typeof changes!=='object'||Array.isArray(changes)||Object.keys(changes).some(k=>!['usage','repeatPattern','flipType','repeatCount','componentOrder','label','atomIds'].includes(k)))fail('聚合物编辑字段无效');
  const enums={usage:bracketUsages,repeatPattern:polymerRepeatPatterns,flipType:polymerFlipTypes};
  if(Object.hasOwn(changes,'usage')&&changes.usage===null)fail('括号化学类型不可为空，请选择 Unspecified');
  for(const [key,values]of Object.entries(enums))if(Object.hasOwn(changes,key)){const value=changes[key as keyof PolymerChanges];if(value!==null&&!(values as readonly unknown[]).includes(value))fail('聚合物枚举值无效');}
  if(Object.hasOwn(changes,'repeatCount')&&changes.repeatCount!==null&&(typeof changes.repeatCount!=='number'||!Number.isFinite(changes.repeatCount)||changes.repeatCount<=0))fail('重复次数必须是有限正数');
  if(Object.hasOwn(changes,'componentOrder')&&changes.componentOrder!==null&&(typeof changes.componentOrder!=='number'||!Number.isInteger(changes.componentOrder)||changes.componentOrder<0||changes.componentOrder>32767))fail('组分顺序必须为 0–32767 的整数');
  if(Object.hasOwn(changes,'label')&&changes.label!==null&&(typeof changes.label!=='string'||changes.label.length>256))fail('重复单元标签最多 256 字符');
  const names={usage:'BracketUsage',repeatPattern:'PolymerRepeatPattern',flipType:'PolymerFlipType',repeatCount:'RepeatCount',componentOrder:'ComponentOrder',label:'SRULabel'}as const;
  for(const [key,name]of Object.entries(names))if(Object.hasOwn(changes,key)){const value=changes[key as keyof typeof names];if(value===null)delete group.attributes[name];else group.attributes[name]=String(value);}
  if(Object.hasOwn(changes,'atomIds')){
    const ids=changes.atomIds;if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!Object.hasOwn(doc.graph.atoms,id)))fail('括号组成员必须是非空、无重复的有效原子列表');
    group.references.BracketedObjectIDs=ids.map(id=>({kind:'atom',id}));
  }
}
/** Keep repeat-unit chemistry distinct from the molecular graph drawn on paper. */
export function hasRepeatingChemistry(doc:ChemicalDocument,selected?:ReadonlySet<string>):boolean{
  return Object.values(objects(doc)).some(o=>{
    if(o.tag==='bracketedgroup')return !selected||polymerMembers(doc,o.id).some(id=>selected.has(id));
    return o.tag==='graphic'&&!!o.attributes.BracketUsage&&!['Unspecified','Unused1','Unused2'].includes(o.attributes.BracketUsage);
  });
}
/** Removing chemistry also removes its boundary records and explicit membership. */
export function prunePolymerReferences(doc:ChemicalDocument,kind:'atom'|'bond',id:string):void{
  const table=objects(doc),removed=new Set(Object.values(table).filter(o=>o.tag==='crossingbond'&&Object.values(o.references).flat().some(ref=>ref.kind===kind&&ref.id===id)).map(o=>o.id));
  for(const key of removed)delete table[key];
  for(const object of Object.values(table)){
    object.children=object.children.filter(key=>!removed.has(key));
    for(const [key,refs]of Object.entries(object.references)){
      if(object.tag==='bracketedgroup'&&key==='BracketedObjectIDs')object.references[key]=refs.filter(ref=>ref.kind!==kind||ref.id!==id).map(ref=>ref.kind==='molecule'&&kind==='atom'?{...ref,atomIds:ref.atomIds.filter(a=>a!==id)}:ref);
      else object.references[key]=refs.filter(ref=>ref.kind!=='drawing'||!removed.has(ref.id));
    }
  }
}
