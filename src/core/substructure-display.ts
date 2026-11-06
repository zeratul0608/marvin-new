import type {AtomSubstructure,ChemicalDocument} from './types';

/** This changes presentation only. It never promotes atoms or chooses alternatives. */
export function setSubstructureDisplayInPlace(doc:ChemicalDocument,atomId:string,expanded:boolean,recursive=false):void{
  if(typeof expanded!=='boolean'||typeof recursive!=='boolean')throw new Error('片段显示参数无效');
  const group=doc.graph.atoms[atomId]?.substructure;if(!group)throw new Error('此节点没有可显示的内部化学片段');
  const visit=(current:AtomSubstructure,depth=0)=>{
    if(depth>=16)throw new Error('内部片段显示超过 16 层');
    if(expanded)current.display='expanded';else delete current.display;
    if(recursive)for(const fragment of current.fragments)for(const atom of Object.values(fragment.document.graph.atoms))if(atom.substructure)visit(atom.substructure,depth+1);
  };
  visit(group);
}

/** Ignore only the explicit substructure display flag when comparing chemistry.
 * Other display/style data and every field of the real chemical graph remain. */
export function substructureDisplayReplacer(_key:string,value:unknown):unknown{
  if(value&&typeof value==='object'&&!Array.isArray(value)){
    const group=value as Partial<AtomSubstructure>;
    if((group.kind==='abbreviation'||group.kind==='alternatives')&&Array.isArray(group.fragments)&&Array.isArray(group.connections)&&group.display==='expanded'){
      const {display:_,...rest}=group;return rest;
    }
  }
  return value;
}
