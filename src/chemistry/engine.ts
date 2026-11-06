import type {MainModule,Mol} from '@rdkit/rdkit';
import {addAtom,addBond,atomicNumber,clone,connectedComponents,emptyDocument,hydrogenCount,validateDocument,ELEMENTS} from '../core/model';
import type {Atom,BondDepiction,ChemicalDocument,Point} from '../core/types';
import {applyDocumentEdits,type EditOperation} from '../core/edits';
import {readMol,writeMol} from '../formats/mol';
import {hasRepeatingChemistry} from '../core/polymers';

export interface ChemistryAnalysis{
  engine:'RDKit';version:string;atomIds:string[];atomCount:number;bondCount:number;moleculeCount:number;
  formula:string;formalCharge:number;molecularWeight:number;exactMass:number;smiles:string;
  ringCount:number;aromaticAtomIds:string[];aromaticBondIds:string[];hydrogenCounts:Record<string,number>;
  stereoAtoms:Record<string,'R'|'S'|'r'|'s'>;stereoBonds:Record<string,'E'|'Z'>;
  unspecifiedStereoCenters:number;descriptors:{logP:number;tpsa:number;hBondDonors:number;hBondAcceptors:number};
  scope:string;
}
export interface CleanupResult{document:ChemicalDocument;operations:EditOperation[];atomIds:string[];engineVersion:string;isomericSmiles:string}
export interface ChemistryEngine{
  readonly version:string;
  analyze(doc:ChemicalDocument,atomIds?:readonly string[]):ChemistryAnalysis;
  cleanup2D(doc:ChemicalDocument,atomIds?:readonly string[]):CleanupResult;
  importSmiles(smiles:string,title?:string):ChemicalDocument;
}
type JsonAtom={z?:number;impHs?:number;chg?:number;nRad?:number;isotope?:number;stereo?:string};
type JsonBond={bo?:number;atoms:[number,number];stereo?:string;stereoAtoms?:number[]};
type JsonExtension={name:string;aromaticAtoms?:number[];aromaticBonds?:number[];atomRings?:number[][]};
type MolJson={rdkitjson:{version:number};defaults:{atom:JsonAtom;bond:Partial<JsonBond>};molecules:{atoms:JsonAtom[];bonds:JsonBond[];extensions?:JsonExtension[];conformers?:{dim:number;coords:number[][]}[]}[]};
function fail(message:string):never{throw new Error(message);}
const MAX_ATOMS=1000;
const rad=(atom:Atom)=>atom.radical===2?1:atom.radical?2:0;
function json(mol:Mol):MolJson{return JSON.parse(mol.get_json());}
function atomsOf(data:MolJson):JsonAtom[]{return data.molecules[0].atoms.map(a=>({...data.defaults.atom,...a}));}
function representation(data:MolJson){return data.molecules[0].extensions?.find(e=>e.name==='rdkitRepresentation');}
function molecule(module:MainModule,input:string):Mol{
  const mol=module.get_mol(input,JSON.stringify({removeHs:false,strictParsing:true}));
  if(!mol||!mol.is_valid()){mol?.delete();fail('结构未通过 RDKit 化学检查；请检查价态、芳香键及指定氢数，文档未被修改。');}return mol;
}
function selection(doc:ChemicalDocument,selected:readonly string[]=[]):ChemicalDocument{
  validateDocument(doc);
  if(!Array.isArray(selected)||selected.some(id=>!Object.hasOwn(doc.graph.atoms,id)))fail('计算选区包含不存在的原子');
  const ids=new Set(selected.length?selected:Object.keys(doc.graph.atoms));
  if(hasRepeatingChemistry(doc,ids))fail('当前选区含聚合物、重复单元或混合物括号组；尚未展开其整体化学，不能把所画单元当作整个分子计算或清理。可选择组外的完整普通分子。');
  if(!ids.size)fail('请先绘制或导入分子');if(ids.size>MAX_ATOMS)fail(`每次化学计算最多处理 ${MAX_ATOMS} 个原子，请选择较小的完整分子。`);
  for(const bond of Object.values(doc.graph.bonds))if(ids.has(bond.atoms[0])!==ids.has(bond.atoms[1]))fail('请选择完整分子后计算，当前选区切断了化学键。');
  const result=emptyDocument(doc.title);
  for(const id of ids){
    const atom=doc.graph.atoms[id];
    if(atom.query||atom.queryConstraints||atom.attachment||atom.substructure||atom.namedFragment||atom.multiAttachment)fail('当前计算入口支持已完整定义的普通分子；查询、内部片段和模板边界请保留在原编辑模型中。');
    if(atom.geometry?.type==='axial'||atom.enhancedStereo)fail('轴手性与增强立体组尚未接入此计算入口，已保留文档且未执行简化。');
    if(atom.radical===1||atom.radical===3)fail('单重／三重态区分尚未接入此计算入口，原始自旋态不会被改写。');
    result.graph.atoms[id]=clone(atom);result.depiction.positions[id]=clone(doc.depiction.positions[id]);
  }
  for(const bond of Object.values(doc.graph.bonds))if(bond.atoms.every(id=>ids.has(id))){
    if(bond.order==='any'||bond.order===2.5||bond.topology!==undefined)fail('查询键、拓扑查询和部分键尚不参与确定分子的化学计算。');
    result.graph.bonds[bond.id]=clone(bond);if(doc.depiction.bonds[bond.id])result.depiction.bonds[bond.id]=clone(doc.depiction.bonds[bond.id]);
  }
  return result;
}
function prepare(module:MainModule,doc:ChemicalDocument):Mol{
  const working=clone(doc),atoms=Object.values(working.graph.atoms);
  atoms.forEach((a,i)=>{a.atomMap=i+1;a.hydrogens={mode:'auto'};});
  let mol=module.get_mol(writeMol(working,'mol-v3000'),JSON.stringify({removeHs:false,strictParsing:true}));
  try{
    const original=Object.values(doc.graph.atoms),actual=mol?atomsOf(json(mol)):undefined;
    if(!mol||original.some((a,i)=>a.hydrogens.mode==='fixed'&&a.hydrogens.count!==(actual?.[i].impHs??0))){
      // HCOUNT is a query in MDL. For pyrrolic [nH], use real temporary H
      // vertices, then remove only these unmapped Hs. Original H IDs survive.
      mol?.delete();mol=null;
      if(original.some(a=>a.geometry)&&original.some(a=>a.hydrogens.mode==='fixed'&&a.hydrogens.count>0))fail('此指定氢数与显式构型组合尚不能完整传递，文档未修改。');
      let total=0;
      original.forEach((a,i)=>{if(a.hydrogens.mode==='fixed')for(let h=0;h<a.hydrogens.count;h++){
        if(++total>4000)fail('指定氢数超过计算限额');const p=working.depiction.positions[a.id],angle=2*Math.PI*h/Math.max(1,a.hydrogens.count);
        const id=addAtom(working,'H',{x:p.x+.5*Math.cos(angle),y:p.y+.5*Math.sin(angle)});addBond(working,atoms[i].id,id);
      }});
      if(!total)fail('指定氢数与价态不一致，当前计算入口拒绝推测缺失的电子或氢。');
      mol=molecule(module,writeMol(working,'mol-v3000'));mol.remove_hs_in_place(JSON.stringify({removeMapped:false}));
    }
    verifyAtoms(doc,mol);verifyGeometry(doc,mol);return mol;
  }catch(error){mol?.delete();throw error;}
}
function verifyAtoms(doc:ChemicalDocument,mol:Mol):void{
  const actual=atomsOf(json(mol)),expected=Object.values(doc.graph.atoms);
  if(actual.length!==expected.length||mol.get_num_bonds()!==Object.keys(doc.graph.bonds).length)fail('计算适配改变了原子或键数量，已停止。');
  expected.forEach((a,i)=>{
    const b=actual[i];if(b.z!==atomicNumber(a.element)||(b.chg??0)!==a.charge||(b.isotope??0)!==(a.isotope??0)||(b.nRad??0)!==rad(a))fail(`原子 ${i+1} 的元素、电荷、同位素或自由基语义不能完整传入计算模块，已停止。`);
    if(a.hydrogens.mode==='fixed'&&(b.impHs??0)!==a.hydrogens.count)fail(`原子 ${i+1} 的指定氢数无法完整传入计算模块，已停止。`);
  });
}
function tags(doc:ChemicalDocument,mol:Mol):Pick<ChemistryAnalysis,'stereoAtoms'|'stereoBonds'>{
  const values=JSON.parse(mol.get_stereo_tags()) as {CIP_atoms:[number,string][];CIP_bonds:[number,number,string][]},atoms=Object.keys(doc.graph.atoms),stereoAtoms:ChemistryAnalysis['stereoAtoms']={},stereoBonds:ChemistryAnalysis['stereoBonds']={};
  for(const [index,label]of values.CIP_atoms){const tag=label.replace(/[()]/g,'');if(['R','S','r','s'].includes(tag))stereoAtoms[atoms[index]]=tag as 'R'|'S'|'r'|'s';}
  for(const [a,b,label]of values.CIP_bonds){const tag=label.replace(/[()]/g,''),bond=Object.values(doc.graph.bonds).find(bond=>bond.atoms.includes(atoms[a])&&bond.atoms.includes(atoms[b]));if(bond&&['E','Z'].includes(tag))stereoBonds[bond.id]=tag as 'E'|'Z';}
  return {stereoAtoms,stereoBonds};
}
function verifyGeometry(doc:ChemicalDocument,mol:Mol):void{
  const stereo=tags(doc,mol);
  for(const atom of Object.values(doc.graph.atoms))if(atom.geometry&&!stereo.stereoAtoms[atom.id])fail('存在尚不能由当前二维楔键完整传递的显式原子构型；请保留原绘图，未执行自动清理或简化。');
  for(const bond of Object.values(doc.graph.bonds))if(bond.circularOrdering&&!stereo.stereoBonds[bond.id])fail('存在尚不能由当前二维坐标完整传递的双键构型；请保留原绘图，未执行自动清理或简化。');
}
function withoutMaps(mol:Mol,doc:ChemicalDocument):string{
  const atoms=Object.values(doc.graph.atoms);
  return rewriteMaps(mol.get_v3Kmolblock(),map=>{const atom=atoms[map-1];if(!atom)fail('RDKit 原子身份映射无效');return atom.atomMap??0;});
}
function rewriteMaps(raw:string,value:(original:number,index:number)=>number):string{
  let atomSection=false;
  let index=0;
  return raw.split('\n').map(line=>{
    if(line==='M  V30 BEGIN ATOM'){atomSection=true;return line;}if(line==='M  V30 END ATOM'){atomSection=false;return line;}
    if(!atomSection||!line.startsWith('M  V30 '))return line;
    const tokens=line.slice(7).trim().split(/\s+/);
    tokens[5]=String(value(Number(tokens[5]),index++));return 'M  V30 '+tokens.join(' ');
  }).join('\n');
}
/** VAL carries an H/valence representation already verified against RDKit JSON.
 * Geometry import uses only coordinates/IDs/depiction; chemistry stays in the model. */
function geometryMol(mol:Mol):ChemicalDocument{return readMol(mol.get_v3Kmolblock().replace(/ VAL=-?\d+/g,'')).document;}
function publicSmiles(module:MainModule,doc:ChemicalDocument,mol:Mol):string{
  const output=molecule(module,withoutMaps(mol,doc));try{return output.get_smiles();}finally{output.delete();}
}
function formula(data:MolJson):string{
  const counts:Record<string,number>={};let charge=0;
  for(const atom of atomsOf(data)){const symbol=ELEMENTS[atom.z!-1];counts[symbol]=(counts[symbol]??0)+1;counts.H=(counts.H??0)+(atom.impHs??0);charge+=atom.chg??0;}
  const order=Object.keys(counts).filter(k=>counts[k]>0).sort((a,b)=>counts.C?(a==='C'?-1:b==='C'?1:a==='H'?-1:b==='H'?1:a.localeCompare(b)):a.localeCompare(b));
  return order.map(e=>e+(counts[e]===1?'':counts[e])).join('')+(charge?`${Math.abs(charge)===1?'':Math.abs(charge)}${charge>0?'+':'-'}`:'');
}
function analyze(module:MainModule,doc:ChemicalDocument,mol:Mol):ChemistryAnalysis{
  const data=json(mol),rep=representation(data),atoms=Object.keys(doc.graph.atoms),bonds=Object.keys(doc.graph.bonds),descriptors=JSON.parse(mol.get_descriptors()) as Record<string,number>;
  const finite=(key:string)=>{const value=descriptors[key];if(!Number.isFinite(value))fail(`化学计算没有返回有效的 ${key}`);return value;};
  return {engine:'RDKit',version:module.version(),atomIds:atoms,atomCount:atoms.length,bondCount:bonds.length,moleculeCount:connectedComponents(doc).length,
    formula:formula(data),formalCharge:Object.values(doc.graph.atoms).reduce((sum,a)=>sum+a.charge,0),molecularWeight:finite('amw'),exactMass:finite('exactmw'),smiles:publicSmiles(module,doc,mol),
    ringCount:finite('NumRings'),aromaticAtomIds:(rep?.aromaticAtoms??[]).map(i=>atoms[i]),aromaticBondIds:(rep?.aromaticBonds??[]).map(i=>bonds[i]),
    hydrogenCounts:Object.fromEntries(atomsOf(data).map((a,i)=>[atoms[i],a.impHs??0])),...tags(doc,mol),unspecifiedStereoCenters:finite('NumUnspecifiedAtomStereoCenters'),
    descriptors:{logP:finite('CrippenClogP'),tpsa:finite('tpsa'),hBondDonors:finite('NumHBD'),hBondAcceptors:finite('NumHBA')},
    scope:'基于已定义的二维分子图及楔键计算；独立三维坐标不参与。性质为计算值，来源 CIP 缓存不参与指派。',
  };
}
function layout(module:MainModule,original:ChemicalDocument,selected:readonly string[]):CleanupResult{
  const doc=selection(original,selected),mol=prepare(module,doc);
  try{
    const before=mol.get_smiles();if(!mol.set_new_coords(false))fail('二维坐标生成失败，文档未修改。');
    const after=geometryMol(mol),sourceAtoms=Object.keys(doc.graph.atoms),nativeAtoms=Object.values(after.graph.atoms);
    const mapping=new Map(nativeAtoms.map(a=>[a.id,sourceAtoms[(a.atomMap??0)-1]]));
    if(mapping.size!==sourceAtoms.length||new Set(mapping.values()).size!==sourceAtoms.length||[...mapping.values()].some(id=>!id))fail('自动排版无法验证全部原子的身份映射');
    const positions:Record<string,Point>={},depictions:Record<string,BondDepiction|null>={};
    // Preserve each disconnected fragment's page placement and centroid.
    for(const component of connectedComponents(doc)){
      const source=component.map(id=>doc.depiction.positions[id]),target=component.map(id=>after.depiction.positions[nativeAtoms.find(a=>mapping.get(a.id)===id)!.id]);
      const center=(points:Point[])=>points.reduce((p,q)=>({x:p.x+q.x/points.length,y:p.y+q.y/points.length}),{x:0,y:0}),a=center(source),b=center(target);
      component.forEach((id,i)=>positions[id]={x:target[i].x+a.x-b.x,y:target[i].y+a.y-b.y});
    }
    const nativeBonds=new Map(Object.values(after.graph.bonds).map(b=>[[...b.atoms.map(id=>mapping.get(id)!)].sort().join('|'),b]));
    for(const bond of Object.values(doc.graph.bonds)){
      const counterpart=nativeBonds.get([...bond.atoms].sort().join('|'));if(!counterpart)fail('二维排版改变了化学键连接');
      const old=doc.depiction.bonds[bond.id],generated=after.depiction.bonds[counterpart.id];
      const stereo=(style:string|undefined)=>style==='wedge'||style==='hashed';
      if(stereo(generated?.style))depictions[bond.id]={...old,style:generated.style,from:mapping.get(generated.from)!};
      else if(stereo(old?.style))depictions[bond.id]={...old,style:'plain',from:bond.atoms[0]};
    }
    const operations:EditOperation[]=[{type:'set-layout',positions,depictions}];
    const result=applyDocumentEdits(original,operations).document,recheck=prepare(module,selection(result,sourceAtoms));
    try{if(recheck.get_smiles()!==before)fail('清理前后异构结构不一致，已拒绝提交；原文档未修改。');}finally{recheck.delete();}
    return {document:result,operations,atomIds:sourceAtoms,engineVersion:module.version(),isomericSmiles:publicSmiles(module,doc,mol)};
  }finally{mol.delete();}
}

export function createChemistryEngine(module:MainModule):ChemistryEngine{
  return {version:module.version(),
    analyze(document,atomIds=[]){const doc=selection(document,atomIds),mol=prepare(module,doc);try{return analyze(module,doc,mol);}finally{mol.delete();}},
    cleanup2D(document,atomIds=[]){return layout(module,document,atomIds);},
    importSmiles(input,title='SMILES 结构'){
      const text=input.trim();if(!text||text.length>50000||/[\r\n>]/.test(text))fail('请输入单条分子 SMILES，可包含用点分隔的片段；反应和多记录文本尚未接入。');
      const mol=molecule(module,text);
      try{
        if(mol.get_num_atoms(false)>MAX_ATOMS)fail(`SMILES 超过 ${MAX_ATOMS} 原子计算限额`);
        if(!mol.set_new_coords(false))fail('SMILES 坐标生成失败');
        const doc=geometryMol(mol);delete doc.source;doc.title=title;
        const data=json(mol),actual=atomsOf(data),rep=representation(data),atoms=Object.values(doc.graph.atoms),bonds=Object.values(doc.graph.bonds);
        if(atoms.length!==actual.length)fail('SMILES 导入未能保留全部原子');
        for(const i of rep?.aromaticBonds??[])bonds[i].order='aromatic';
        atoms.forEach((a,i)=>{const h=actual[i].impHs??0;if(hydrogenCount(doc,a.id)!==h)a.hydrogens={mode:'fixed',count:h};});
        validateDocument(doc);const projected=selection(doc),back=prepare(module,projected);
        try{const canonical=molecule(module,withoutMaps(back,projected));try{if(canonical.get_smiles()!==mol.get_smiles())fail('SMILES 的化学语义无法完整进入当前编辑模型，已停止导入。');}finally{canonical.delete();}}finally{back.delete();}
        return doc;
      }finally{mol.delete();}
    },
  };
}
