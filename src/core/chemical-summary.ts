import type {ChemicalDocument} from './types';
import {hasRepeatingChemistry} from './polymers';

export interface KnownChemicalSummary{
  knownChemicalAtomCount:number;
  formalCharge:number;
  isotopeAtomCount:number;
  complete:boolean;
  incompleteReasons:string[];
}

/** Composition of the explicitly defined graph, including collapsed children.
 * Unknown alternatives and virtual vertices never become fictitious atoms.
 * Completeness describes represented composition, not a valence certificate. */
export function knownChemicalSummary(document:ChemicalDocument):KnownChemicalSummary{
  let knownChemicalAtomCount=0,formalCharge=0,isotopeAtomCount=0;
  const reasons=new Set<string>();
  const visit=(doc:ChemicalDocument,boundPorts:ReadonlySet<string>,ancestors:ReadonlySet<ChemicalDocument>)=>{
    if(ancestors.has(doc)||ancestors.size>=16){reasons.add('嵌套循环或深度超限');return;}
    const path=new Set(ancestors);path.add(doc);
    if(hasRepeatingChemistry(doc))reasons.add('聚合物、重复或混合物组');
    if(Object.values(doc.graph.bonds).some(b=>b.topology!==undefined))reasons.add('键拓扑查询');
    for(const atom of Object.values(doc.graph.atoms)){
      if(atom.queryConstraints)reasons.add('原子查询约束');
      if(atom.substructure){
        const group=atom.substructure;
        if(group.kind!=='abbreviation'||group.fragments.length!==1){reasons.add('未选定的备选结构');continue;}
        if(atom.charge||atom.isotope!==undefined||atom.radical)reasons.add('缩写整体注释与内部图的对应未确定');
        visit(group.fragments[0].document,new Set(group.connections.filter(port=>port.fragment===0).map(port=>port.atomId)),path);
        continue;
      }
      if(atom.attachment){if(!boundPorts.has(atom.id))reasons.add('未绑定的模板连接点');continue;}
      if(atom.query){reasons.add('查询结构');continue;}
      if(atom.namedFragment){reasons.add('未定义内部图的名称');continue;}
      if(atom.multiAttachment){reasons.add('多中心连接');continue;}
      knownChemicalAtomCount++;formalCharge+=atom.charge;
      if(atom.isotope!==undefined)isotopeAtomCount++;
    }
  };
  visit(document,new Set(),new Set());
  return {knownChemicalAtomCount,formalCharge,isotopeAtomCount,complete:reasons.size===0,incompleteReasons:[...reasons]};
}
