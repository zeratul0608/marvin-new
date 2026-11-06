import {describe,expect,it} from 'vitest';
import {addAtom,addBond,clone,emptyDocument,id,validateDocument} from '../src/core/model';
import type {ChemicalDocument,DocumentReference,Format,ReactionParticipation} from '../src/core/types';
import {applyDocumentEdits} from '../src/core/edits';
import {detectFormat,exportDocument,importDocument} from '../src/formats';

function reaction(agent=true):ChemicalDocument{
  const doc=emptyDocument('Mapped oxidation');
  const a=addAtom(doc,'C',{x:0,y:0},{isotope:13,atomMap:1}),b=addAtom(doc,'O',{x:1.5,y:0},{atomMap:2});addBond(doc,a,b);
  const c=addAtom(doc,'C',{x:5,y:0},{isotope:13,atomMap:1}),d=addAtom(doc,'O',{x:6.5,y:0},{atomMap:2});addBond(doc,c,d,2);
  const e=agent?addAtom(doc,'Na',{x:3,y:2},{charge:1,hydrogens:{mode:'fixed',count:0}}):undefined,step=id('reaction');
  doc.graph.reactions={[step]:{id:step,schemeId:id('scheme'),reactants:[{kind:'molecule',atomIds:[a,b]}],products:[{kind:'molecule',atomIds:[c,d]}],above:e?[{kind:'molecule',atomIds:[e]}]:[],below:[],arrows:[],pluses:[]}};return doc;
}
const step=(doc:ChemicalDocument)=>Object.values(doc.graph.reactions!)[0];
function summary(doc:ChemicalDocument){
  const participant=(ref:DocumentReference)=>{if(ref.kind!=='molecule')throw Error('Not a molecule');const indices=new Map(ref.atomIds.map((id,i)=>[id,i]));return {
    atoms:ref.atomIds.map(id=>{const a=doc.graph.atoms[id];return [a.element,a.charge,a.isotope??null,a.radical??null,a.atomMap??null,a.hydrogens];}),
    positions:ref.atomIds.map(id=>{const p=doc.depiction.positions[id];return [Math.round(p.x*1e4)/1e4,Math.round(p.y*1e4)/1e4];}),
    bonds:Object.values(doc.graph.bonds).filter(b=>b.atoms.every(id=>indices.has(id))).map(b=>{const d=doc.depiction.bonds[b.id];return {atoms:b.atoms.map(id=>indices.get(id)).sort(),order:b.order,reactionParticipation:b.reactionParticipation,depiction:d?.style&&d.style!=='plain'?{style:d.style,from:indices.get(d.from)}:undefined};}),
  };};return {reactants:step(doc).reactants.map(participant),products:step(doc).products.map(participant),agents:step(doc).above.map(participant)};
}
const encode=(doc:ChemicalDocument,format:Format)=>exportDocument(doc,{format}).data;
describe.each(['rxn','rxn-v3000']as const)('%s reaction exchange',format=>{
  it('round-trips independent reactant/product/agent roles, maps, isotope, charge and coordinates',()=>{
    const doc=reaction(),before=clone(doc),data=encode(doc,format),back=importDocument({data}).document;
    expect(detectFormat(data)).toBe(format);expect(summary(back)).toEqual(summary(doc));expect(step(back).atomMappings![0].atoms).toHaveLength(2);expect(doc).toEqual(before);expect(validateDocument(back)).toEqual([]);
    expect(exportDocument(back,{format})).toMatchObject({data,passthrough:true});
  });
  it('rebuilds after a chemistry edit and survives native JSON restoration',()=>{
    const imported=importDocument({data:encode(reaction(),format)}).document,atom=Object.keys(imported.graph.atoms)[0],changed=applyDocumentEdits(imported,[{type:'update-atom',atomId:atom,changes:{isotope:14}}]).document;
    const restored=importDocument({data:exportDocument(changed,{format:'json'}).data}).document,back=importDocument({data:encode(restored,format)}).document;expect(summary(back)).toEqual(summary(changed));expect(exportDocument(restored,{format}).passthrough).toBe(false);
  });
  it.each(['NotReactionCenter','ReactionCenter','NoChange','MakeOrBreak','ChangeType','MakeAndChange']as ReactionParticipation[])('preserves reaction-center bond semantics %s',participation=>{
    const doc=reaction(false);Object.values(doc.graph.bonds)[0].reactionParticipation=participation;const back=importDocument({data:encode(doc,format)}).document;expect(summary(back)).toEqual(summary(doc));
  });
  it('writes explicit pair mappings as consistent numbers without mutating the caller',()=>{
    const doc=reaction(false),atoms=Object.keys(doc.graph.atoms);for(const a of Object.values(doc.graph.atoms))delete a.atomMap;
    step(doc).atomMappings=[{mode:'specified',atoms:[[atoms[0],atoms[2]],[atoms[1],atoms[3]]]}];const before=clone(doc),back=importDocument({data:encode(doc,format)}).document;
    expect(Object.values(back.graph.atoms).map(a=>a.atomMap)).toEqual([1,2,1,2]);expect(step(back).atomMappings![0].atoms).toHaveLength(2);expect(doc).toEqual(before);
  });
  it('keeps wedge direction through component serialization',()=>{
    const doc=reaction(false),bond=Object.values(doc.graph.bonds)[0];doc.depiction.bonds[bond.id]={style:'hashed',from:bond.atoms[1]};expect(summary(importDocument({data:encode(doc,format)}).document)).toEqual(summary(doc));
  });
  it('refuses multiple steps, unlabeled chemistry, participant overlap and atom-map conflicts',()=>{
    const doc=reaction(),multiple=clone(doc),second=clone(step(multiple));second.id='second';multiple.graph.reactions![second.id]=second;expect(()=>encode(multiple,format)).toThrow('一条反应');
    const extra=clone(doc);addAtom(extra,'Cl',{x:0,y:4});expect(()=>encode(extra,format)).toThrow('未分配');
    const overlap=clone(doc);step(overlap).products=clone(step(overlap).reactants);expect(()=>encode(overlap,format)).toThrow('重叠');
    const conflict=clone(doc),atoms=Object.keys(conflict.graph.atoms);step(conflict).atomMappings=[{mode:'specified',atoms:[[atoms[0],atoms[3]]]}];expect(()=>encode(conflict,format)).toThrow('冲突');
  });
  it('does not turn text conditions or below roles into agents',()=>{
    const doc=reaction(),below=clone(doc);step(below).below=step(below).above;step(below).above=[];expect(()=>encode(below,format)).toThrow('下方条件');
    doc.depiction.objects={condition:{id:'condition',tag:'t',attributes:{},geometry:{p:[60,30]},references:{},children:[],atomIds:[],runs:[{text:'heat',attributes:{}}]}};step(doc).above.push({kind:'drawing',id:'condition'});expect(()=>exportDocument(doc,{format,allowLossy:true})).toThrow('文字和图元条件');
  });
  it('requires explicit consent for presentation loss and never drops chemical polymer objects',()=>{
    const doc=reaction(false);doc.depiction.objects={arrow:{id:'arrow',tag:'arrow',attributes:{ArrowheadHead:'Full'},geometry:{Tail3D:[40,0,0],Head3D:[80,0,0]},references:{},children:[],atomIds:[]}};step(doc).arrows=[{kind:'drawing',id:'arrow'}];
    expect(()=>encode(doc,format)).toThrow('导出已阻止');const output=exportDocument(doc,{format,allowLossy:true});expect(output.issues.some(i=>i.code==='RXN_DRAWING_LOSS')).toBe(true);expect(summary(importDocument({data:output.data}).document)).toEqual(summary(doc));
    const complex=clone(doc);complex.depiction.objects!.polymer={id:'polymer',tag:'bracketedgroup',attributes:{BracketUsage:'SRU'},geometry:{},references:{BracketedObjectIDs:[{kind:'molecule',atomIds:Object.keys(doc.graph.atoms)}]},children:[],atomIds:[]};expect(()=>exportDocument(complex,{format,allowLossy:true})).toThrow('聚合物');
  });
  it('rejects invalid or truncated input without changing the original document',()=>{
    const raw=encode(reaction(),format);expect(()=>importDocument({data:raw+'\nJUNK',format})).toThrow();expect(()=>importDocument({data:raw.replace('M  END',''),format})).toThrow();
    if(format==='rxn')expect(()=>importDocument({data:raw.replace('  1  1  1','  2  1  1'),format})).toThrow();
    else expect(()=>importDocument({data:raw.replace('COUNTS 1 1 1','COUNTS 2 1 1'),format})).toThrow();
  });
  it('supports zero reaction sides while rejecting atomless participant records',()=>{
    const doc=reaction(false),value=step(doc),reactants=value.reactants.flatMap(ref=>ref.kind==='molecule'?ref.atomIds:[]);for(const id of reactants){delete doc.graph.atoms[id];delete doc.depiction.positions[id];}for(const b of Object.values(doc.graph.bonds))if(b.atoms.some(id=>reactants.includes(id)))delete doc.graph.bonds[b.id];value.reactants=[];
    const raw=encode(doc,format),back=importDocument({data:raw}).document;expect(step(back).reactants).toEqual([]);expect(step(back).products).toHaveLength(1);if(format==='rxn-v3000')expect(raw).toContain('BEGIN REACTANT\nM  V30 END REACTANT');
    value.products=[{kind:'molecule',atomIds:[]}];expect(()=>encode(doc,format)).toThrow('必须包含原子');
  });
});
describe('RXN dialect and strict semantic handling',()=>{
  it('detects an RXN wrapper before inspecting its component MOL version',()=>{
    const doc=reaction(false),v3=encode(doc,'rxn-v3000');expect(detectFormat(v3)).toBe('rxn-v3000');
    expect(detectFormat('$RXN\nname\n\n\n  0  0\n')).toBe('rxn');expect(step(importDocument({data:'$RXN\nname\n\n\n  0  0\n'}).document).reactants).toEqual([]);
  });
  it('accepts REAGENT import but writes the widely supported AGENT spelling',()=>{
    const raw=encode(reaction(),'rxn-v3000').replaceAll('BEGIN AGENT','BEGIN REAGENT').replaceAll('END AGENT','END REAGENT'),doc=importDocument({data:raw}).document;delete doc.source;
    expect(encode(doc,'rxn-v3000')).toContain('BEGIN AGENT');expect(summary(doc)).toEqual(summary(reaction()));
  });
  it('checks final closure, duplicate role blocks and unmapped atom reaction flags',()=>{
    const raw=encode(reaction(false),'rxn-v3000');expect(()=>importDocument({data:raw.slice(0,raw.lastIndexOf('M  END'))})).toThrow('最终');expect(()=>importDocument({data:raw.replace('END PRODUCT','END PRODUCT\nM  V30 BEGIN PRODUCT\nM  V30 END PRODUCT')})).toThrow('重复');
    expect(()=>importDocument({data:raw.replace(/^(M  V30 1 C [^\n]*)$/m,'$1 INVRET=1')})).toThrow('反转');expect(()=>importDocument({data:raw.replace('M  V30 1 1 1 2','M  V30 1 1 1 2 RXCTR=5')})).toThrow('组合');
  });
  it('preserves V2000 component titles during editing and reports their V3000 conversion loss',()=>{
    const raw=encode(reaction(false),'rxn').replace('$MOL\n\n','$MOL\nreactant title\n'),doc=importDocument({data:raw}).document;doc.title='Edited';const saved=encode(doc,'rxn');expect(saved).toContain('$MOL\nreactant title\n');
    expect(()=>encode(doc,'rxn-v3000')).toThrow('导出已阻止');expect(exportDocument(doc,{format:'rxn-v3000',allowLossy:true}).issues.some(i=>i.code==='RXN_COMPONENT_NAME_LOSS')).toBe(true);
  });
  it('refuses duplicate mappings and unsupported mapping provenance',()=>{
    const doc=reaction(false),atoms=Object.values(doc.graph.atoms);atoms[1].atomMap=1;expect(()=>encode(doc,'rxn-v3000')).toThrow('必须唯一');
    const manual=reaction(false),ids=Object.keys(manual.graph.atoms);step(manual).atomMappings=[{mode:'manual',atoms:[[ids[0],ids[2]]]}];expect(()=>encode(manual,'rxn')).toThrow('来源模式');
  });
  it('rejects unrepresentable atom-map integers and nonzero V2000 atom reaction flags',()=>{
    const doc=reaction(false),raw=encode(doc,'rxn-v3000');expect(()=>importDocument({data:raw.replace(/^(M  V30 1 C \S+ \S+ \S+) 1/m,'$1 9007199254740993')})).toThrow('32 位');
    Object.values(doc.graph.atoms)[0].atomMap=2147483648;expect(()=>encode(doc,'rxn-v3000')).toThrow('32 位');
    const lines=encode(reaction(false),'rxn').split('\n'),index=lines.indexOf('$MOL')+5;lines[index]=lines[index].slice(0,63)+'  1'+lines[index].slice(66);expect(()=>importDocument({data:lines.join('\n')})).toThrow('反转');
  });
});
