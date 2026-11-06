import {afterEach,beforeAll,describe,expect,it} from 'vitest';
import initRDKit from '@rdkit/rdkit';
import {abbreviationXml,twoPortXml,chiralAbbreviationXml,recursiveAbbreviationXml} from './fixtures/abbreviation-fixture';
import {importDocument,exportDocument,exportSourceFile} from '../src/formats';
import {addAtom,addBond,emptyDocument,clone,molecularFormula,validateDocument} from '../src/core/model';
import {applyDocumentEdits} from '../src/core/edits';
import {DocumentStore} from '../src/core/store';
import {createChemistryEngine,type ChemistryEngine} from '../src/chemistry/engine';
import {expandedId} from '../src/core/expansion';
import {stereoProjection} from '../src/formats/stereo';
import {createChemicalEditor} from '../src/editor/chemical-editor';
import {getPolymerGroup} from '../src/core/polymers';
import {equivalentDocuments} from '../scripts/document-correspondence.mjs';
let engine:ChemistryEngine;beforeAll(async()=>{engine=createChemistryEngine(await initRDKit());});
const load=(raw=abbreviationXml)=>importDocument({data:raw}).document;
const wrapper=(doc:ReturnType<typeof load>)=>Object.values(doc.graph.atoms).find(a=>a.substructure)!;
const expand=(doc:ReturnType<typeof load>,recursive=false)=>applyDocumentEdits(doc,[{type:'expand-substructure',atomId:wrapper(doc).id,recursive}]).document;
afterEach(()=>{document.body.replaceChildren();localStorage.clear();});
describe('expand abbreviations into the editable parent graph',()=>{
  it('replaces the label and bound virtual port with a real, connected graph',()=>{
    const doc=load(),before=clone(doc),outer=Object.values(doc.graph.bonds)[0],result=expand(doc);
    expect(doc).toEqual(before);expect(Object.values(result.graph.atoms).map(a=>a.element)).toEqual(['C','O','C']);expect(Object.values(result.graph.atoms).some(a=>a.attachment||a.substructure)).toBe(false);
    expect(Object.keys(result.graph.bonds)).toContain(outer.id);expect(molecularFormula(result)).toBe('C2H6O');expect(engine.analyze(result).smiles).toBe('COC');expect(validateDocument(result)).toEqual([]);
    const back=importDocument({data:exportDocument(result,{format:'json'}).data}).document;expect(JSON.stringify(back)).toBe(JSON.stringify(result));
  });
  it('promotes ordinary child atoms and internal bonds without changing their stable identities',()=>{
    const doc=load(),group=wrapper(doc).substructure!,child=group.fragments[0].document,ports=new Set(group.connections.map(p=>p.atomId)),boundBonds=new Set(Object.values(child.graph.bonds).filter(b=>b.atoms.some(a=>ports.has(a))).map(b=>b.id)),atoms=Object.keys(child.graph.atoms).filter(a=>!ports.has(a)),bonds=Object.keys(child.graph.bonds).filter(b=>!boundBonds.has(b)),result=expand(doc);
    expect(Object.keys(result.graph.atoms)).toEqual(expect.arrayContaining(atoms));expect(Object.keys(result.graph.bonds)).toEqual(expect.arrayContaining(bonds));
    for(const port of ports)expect(result.graph.atoms[port]).toBeUndefined();
  });
  it('rewires two distinct anchors using explicit port mapping',()=>{
    const doc=load(twoPortXml),outer=Object.keys(doc.graph.bonds),result=expand(doc);
    expect(Object.values(result.graph.atoms).map(a=>a.element)).toEqual(['O','N','C','C']);expect(Object.keys(result.graph.bonds)).toEqual(expect.arrayContaining(outer));expect(engine.analyze(result).smiles).toBe('NCCO');
  });
  it('maps internal tetrahedral ordering and its boundary wedge to the real external bond',()=>{
    const doc=load(chiralAbbreviationXml),outer=Object.keys(doc.graph.bonds)[0],result=expand(doc),center=Object.values(result.graph.atoms).find(a=>a.geometry)!;
    expect(center.geometry!.bondOrdering).toContain(outer);expect(result.depiction.bonds[outer]).toMatchObject({style:'wedge',from:center.id});expect(Object.values(engine.analyze(result).stereoAtoms)).toHaveLength(1);
  });
  it('is one undo step and keeps deterministic identities after JSON restoration',()=>{
    const doc=load(),store=new DocumentStore(doc),result=expand(doc);store.replace(result);store.undo();expect(store.document).toEqual(doc);store.redo();expect(store.document).toEqual(result);
    expect(JSON.stringify(expand(importDocument({data:exportDocument(doc,{format:'json'}).data}).document))).toBe(JSON.stringify(result));
  });
  it('keeps unbound template ports explicit instead of inventing a hydrogen cap',()=>{
    const doc=load(),id=Object.keys(doc.graph.bonds)[0],detached=applyDocumentEdits(doc,[{type:'remove-bond',bondId:id}]).document,result=expand(detached);
    expect(Object.values(result.graph.atoms).filter(a=>a.attachment)).toHaveLength(1);expect(()=>engine.analyze(result)).toThrow('模板边界');
  });
  it('refuses ambiguity, wrapper annotations and unmapped ports atomically',()=>{
    const doc=load(),id=wrapper(doc).id,alternatives=clone(doc);alternatives.graph.atoms[id].substructure!.kind='alternatives';expect(()=>expand(alternatives)).toThrow('备选组');
    const annotated=clone(doc);annotated.graph.atoms[id].residueId=1;const before=clone(annotated);expect(()=>expand(annotated)).toThrow('生物序列');expect(annotated).toEqual(before);
    const query=clone(doc);delete query.graph.atoms[id].substructure;query.graph.atoms[id].namedFragment={type:'Nickname',label:'unknown'};expect(()=>applyDocumentEdits(query,[{type:'expand-substructure',atomId:id}])).toThrow('没有可展开');
  });
  it('keeps new IDs disjoint from reused child-local IDs',()=>{
    const doc=load(),group=wrapper(doc),inner=group.substructure!.fragments[0].document,old=Object.values(inner.graph.atoms)[0],id=Object.keys(doc.graph.atoms)[0];
    delete inner.graph.atoms[old.id];inner.graph.atoms[id]={...old,id};inner.depiction.positions[id]=inner.depiction.positions[old.id];delete inner.depiction.positions[old.id];for(const b of Object.values(inner.graph.bonds))b.atoms=b.atoms.map(a=>a===old.id?id:a)as [string,string];
    const result=expand(doc);expect(Object.keys(result.graph.atoms)).toContain(expandedId('a',group.id,id));expect(engine.analyze(result).smiles).toBe('COC');
  });
  it('source-saves and JSON-restores deliberate child/top-level atom and bond ID collisions',()=>{
    const doc=load(),group=wrapper(doc),child=group.substructure!.fragments[0].document,old=Object.values(child.graph.atoms).find(a=>a.element==='O')!,outerAtom=Object.values(doc.graph.atoms).find(a=>!a.substructure)!.id,oldBond=Object.values(child.graph.bonds).find(b=>b.atoms.every(a=>!child.graph.atoms[a].attachment))!,outerBond=Object.keys(doc.graph.bonds)[0];
    child.graph.atoms=Object.fromEntries(Object.entries(child.graph.atoms).map(([id,a])=>[id===old.id?outerAtom:id,id===old.id?{...a,id:outerAtom}:a]));child.depiction.positions[outerAtom]=child.depiction.positions[old.id];delete child.depiction.positions[old.id];
    for(const b of Object.values(child.graph.bonds))b.atoms=b.atoms.map(a=>a===old.id?outerAtom:a)as [string,string];
    child.graph.bonds=Object.fromEntries(Object.entries(child.graph.bonds).map(([id,b])=>[id===oldBond.id?outerBond:id,id===oldBond.id?{...b,id:outerBond}:b]));
    // Stable IDs are namespace data. The trusted raw source still has the same
    // projection and binds by the fresh parser's object order, never JSON paths.
    doc.source!.fingerprint=JSON.stringify({title:doc.title,graph:doc.graph,depiction:doc.depiction});
    const result=expand(doc);expect(result.graph.atoms[expandedId('a',group.id,outerAtom)]).toBeDefined();expect(result.graph.bonds[expandedId('b',group.id,outerBond)]).toBeDefined();
    const saved=exportSourceFile(result),back=importDocument({data:saved.data}).document;expect(equivalentDocuments({documentProjection:stereoProjection},back,result)).toBe(true);
    expect(new DOMParser().parseFromString(saved.data,'application/xml').querySelector('n[Z="2"]')).not.toBeNull();
    const restored=importDocument({data:exportDocument(result,{format:'json'}).data}).document;expect(exportSourceFile(restored).data).toBe(saved.data);
  });
  it('can rebuild a fresh CDXML after promotion',()=>{
    const doc=expand(load());delete doc.source;const back=importDocument({data:exportDocument(doc,{format:'cdxml'}).data}).document;expect(stereoProjection(back)).toEqual(stereoProjection(doc));
  });
  it.each([abbreviationXml,twoPortXml,chiralAbbreviationXml])('source-saves promoted native chemistry without dropping internal attributes',raw=>{
    const doc=expand(load(raw)),saved=exportSourceFile(doc),back=importDocument({data:saved.data}).document;
    expect(stereoProjection(back)).toEqual(stereoProjection(doc));expect(engine.analyze(back).smiles).toBe(engine.analyze(doc).smiles);
    if(raw===abbreviationXml)expect(new DOMParser().parseFromString(saved.data,'application/xml').querySelector('n[Z="2"]')).not.toBeNull();
    const restored=importDocument({data:exportDocument(doc,{format:'json'}).data}).document;expect(exportSourceFile(restored).data).toBe(saved.data);
  });
  it('supports one-level and recursive expansion and source-saving nested graphs',()=>{
    const doc=load(recursiveAbbreviationXml),once=expand(doc);expect(Object.values(once.graph.atoms).filter(a=>a.substructure)).toHaveLength(1);
    const twice=expand(once),all=expand(doc,true);expect(twice).toEqual(all);expect(engine.analyze(all).smiles).toBe('COCN');
    for(const expanded of [once,all])expect(stereoProjection(importDocument({data:exportSourceFile(expanded).data}).document)).toEqual(stereoProjection(expanded));
  });
  it('recursively retains disjoint child IDs and uses a hash only for a nested root collision',()=>{
    const doc=load(recursiveAbbreviationXml),outer=wrapper(doc),first=outer.substructure!.fragments[0].document,nested=Object.values(first.graph.atoms).find(a=>a.substructure)!,child=nested.substructure!.fragments[0].document,old=Object.values(child.graph.atoms).find(a=>a.element==='O')!,root=Object.values(doc.graph.atoms).find(a=>!a.substructure)!.id;
    child.graph.atoms=Object.fromEntries(Object.entries(child.graph.atoms).map(([id,a])=>[id===old.id?root:id,id===old.id?{...a,id:root}:a]));child.depiction.positions[root]=child.depiction.positions[old.id];delete child.depiction.positions[old.id];for(const b of Object.values(child.graph.bonds))b.atoms=b.atoms.map(a=>a===old.id?root:a)as [string,string];
    doc.source!.fingerprint=JSON.stringify({title:doc.title,graph:doc.graph,depiction:doc.depiction});
    const result=expand(doc,true);expect(result.graph.atoms[expandedId('a',nested.id,root)]).toBeDefined();expect(engine.analyze(result).smiles).toBe('COCN');
    expect(equivalentDocuments({documentProjection:stereoProjection},importDocument({data:exportSourceFile(result).data}).document,result)).toBe(true);
  });
  it('preserves free And/Or group numbers and reserves them before reassigning conflicting groups',()=>{
    const doc=load(),child=wrapper(doc).substructure!.fragments[0].document,atoms=Object.values(child.graph.atoms).filter(a=>!a.attachment),root=Object.values(doc.graph.atoms).find(a=>!a.substructure)!;
    root.enhancedStereo={type:'And',group:1};atoms[0].enhancedStereo={type:'And',group:1};atoms[1].enhancedStereo={type:'And',group:2};
    const result=expand(doc);expect(result.graph.atoms[atoms[1].id].enhancedStereo).toEqual({type:'And',group:2});expect(result.graph.atoms[atoms[0].id].enhancedStereo).toEqual({type:'And',group:3});expect(result.graph.atoms[root.id].enhancedStereo).toEqual({type:'And',group:1});
    const free=load(chiralAbbreviationXml),inside=Object.values(wrapper(free).substructure!.fragments[0].document.graph.atoms).find(a=>a.geometry)!;inside.enhancedStereo={type:'Or',group:7};expect(expand(free).graph.atoms[inside.id].enhancedStereo).toEqual({type:'Or',group:7});
  });
  it('restores the real anchor label offset from the inner port bond and preserves the outer endpoint offset',()=>{
    const doc=load(),group=wrapper(doc).substructure!,child=group.fragments[0].document,port=group.connections[0],inner=Object.values(child.graph.bonds).find(b=>b.atoms.includes(port.atomId))!,anchor=inner.atoms.find(a=>a!==port.atomId)!,outer=doc.graph.bonds[port.bondId],side=outer.atoms.indexOf(wrapper(doc).id),insideSide=inner.atoms.indexOf(anchor),offsets:[number,number]=[0,0];offsets[insideSide]=3;offsets[1-insideSide]=8;
    child.depiction.bonds[inner.id]={style:'plain',from:anchor,labelOffsets:offsets};doc.depiction.bonds[outer.id]={style:'plain',from:outer.atoms[0],labelOffsets:side===0?[9,4]:[4,9]};
    const result=expand(doc);expect(result.depiction.bonds[outer.id].labelOffsets).toEqual(side===0?[3,4]:[4,3]);
  });
  it('retains subsequent internal chemistry edits and source styling after expansion',()=>{
    const doc=load(),atom=wrapper(doc),group=clone(atom.substructure!),child=group.fragments[0].document,oxygen=Object.values(child.graph.atoms).find(a=>a.element==='O')!;
    group.fragments[0].document=applyDocumentEdits(child,[{type:'update-atom',atomId:oxygen.id,changes:{element:'S'}}]).document;
    const updated=applyDocumentEdits(doc,[{type:'set-substructure',atomId:atom.id,substructure:group}]).document,expanded=expand(updated),back=importDocument({data:exportSourceFile(expanded).data}).document;
    expect(engine.analyze(back).smiles).toBe('CSC');expect(stereoProjection(back)).toEqual(stereoProjection(expanded));
  });
  it.each(['C[C@](F)(Cl)Br','C/C=C/C','C/C=C\\C'])('preserves outside stereo while expanding a terminal methyl of %s',smiles=>{
    const doc=engine.importSmiles(smiles),expected=engine.analyze(doc).smiles,terminal=Object.values(doc.graph.atoms).find(a=>a.element==='C'&&Object.values(doc.graph.bonds).filter(b=>b.atoms.includes(a.id)).length===1)!,edge=Object.values(doc.graph.bonds).find(b=>b.atoms.includes(terminal.id))!,other=edge.atoms.find(id=>id!==terminal.id)!;
    const child=emptyDocument(),anchor=addAtom(child,'C',doc.depiction.positions[terminal.id]),port=addAtom(child,'*',doc.depiction.positions[other],{attachment:'external',hydrogens:{mode:'fixed',count:0}}),bond=addBond(child,anchor,port);if(doc.depiction.bonds[edge.id])child.depiction.bonds[bond]={...clone(doc.depiction.bonds[edge.id]),from:doc.depiction.bonds[edge.id].from===terminal.id?anchor:port};
    doc.graph.atoms[terminal.id]={id:terminal.id,element:'*',charge:0,hydrogens:{mode:'auto'},substructure:{kind:'abbreviation',label:'Me',fragments:[{document:child,attachmentOrder:[port]}],connections:[{bondId:edge.id,fragment:0,atomId:port}]}};
    expect(engine.analyze(expand(doc)).smiles).toBe(expected);
  });
  it('updates reaction participants and polymer membership including boundary endpoints',()=>{
    const reaction=abbreviationXml.replace('</page>','<scheme id="1000"><step id="1001" ReactionStepReactants="2"/></scheme></page>'),doc=expand(load(reaction));
    expect(Object.values(doc.graph.reactions!)[0].reactants[0]).toMatchObject({kind:'molecule',atomIds:Object.keys(doc.graph.atoms)});expect(stereoProjection(importDocument({data:exportSourceFile(doc).data}).document)).toEqual(stereoProjection(doc));
    const polymer=twoPortXml.replace('</page>','<bracketedgroup id="1000" BracketUsage="SRU" BracketedObjectIDs="5"><bracketattachment id="1001"><crossingbond id="1002" BondID="6" InnerAtomID="5"/></bracketattachment><bracketattachment id="1003"><crossingbond id="1004" BondID="7" InnerAtomID="5"/></bracketattachment></bracketedgroup></page>'),expanded=expand(load(polymer)),id=Object.values(expanded.depiction.objects!).find(o=>o.tag==='bracketedgroup')!.id,group=getPolymerGroup(expanded,id);
    expect(group.atomIds).toHaveLength(2);expect(new Set(group.crossings.map(c=>c.innerAtomId)).size).toBe(2);expect(stereoProjection(importDocument({data:exportSourceFile(expanded).data}).document)).toEqual(stereoProjection(expanded));
  });
  it('refuses conflicting boundary wedges or one-to-many reaction atom maps atomically',()=>{
    const doc=load(chiralAbbreviationXml),before=clone(doc),edge=Object.keys(doc.graph.bonds)[0];doc.depiction.bonds[edge]={style:'hashed',from:wrapper(doc).id};expect(()=>expand(doc)).toThrow('描绘冲突');expect(before.graph).toEqual(doc.graph);
    const reaction=load(abbreviationXml.replace('</page>','<scheme id="1000"><step id="1001" ReactionStepReactants="2" ReactionStepAtomMap="20 3"/></scheme></page>'));expect(()=>expand(reaction)).toThrow('反应原子映射');
  });
  it('expands from a visible button, supports undo/redo and leaves undefined labels unchanged',()=>{
    const doc=load(),editor=createChemicalEditor({container:document.body,document:doc});try{
      editor.setSelection({atomIds:[wrapper(doc).id]});editor.showAdvancedEditor('fragments');editor.shadowRoot!.querySelector<HTMLButtonElement>('[data-action="expand-substructure"]')!.click();expect(engine.analyze(editor.getDocument()).smiles).toBe('COC');editor.undo();expect(editor.getDocument()).toEqual(doc);editor.redo();expect(engine.analyze(editor.getDocument()).smiles).toBe('COC');
    }finally{editor.destroy();}
  });
  it('preserves documented BioDraw scalar parameters while keeping unknown references protected',()=>{
    const raw=abbreviationXml.replace('</page>','<bioshape id="1000" BioShapeType="DNA" DNAWaveHeight="23.68" DNAWaveLength="31.25" EnzymeReceptorSize="25" NeckWidth="8" xyz="0 50 0"/></page>'),doc=expand(load(raw)),back=importDocument({data:exportSourceFile(doc).data}).document;
    expect(stereoProjection(back)).toEqual(stereoProjection(doc));expect(Object.values(back.depiction.objects!).find(o=>o.tag==='bioshape')!.attributes.DNAWaveHeight).toBe('23.68');
    const unknown=expand(load(raw.replace('DNAWaveHeight="23.68"','PrivateObjectID="3" DNAWaveHeight="23.68"'))),before=clone(unknown);expect(()=>exportSourceFile(unknown)).toThrow('引用类型未知');expect(unknown).toEqual(before);
  });
  it('reports the source-preservation limit after an internal port has been rebound',()=>{
    const doc=load(),atom=wrapper(doc),group=clone(atom.substructure!),child=group.fragments[0].document,carbon=Object.values(child.graph.atoms).find(a=>a.element==='C')!,port=addAtom(child,'*',{x:4,y:0},{attachment:'external',hydrogens:{mode:'fixed',count:0}});addBond(child,carbon.id,port);group.fragments[0].attachmentOrder.push(port);group.connections[0].atomId=port;
    const updated=applyDocumentEdits(doc,[{type:'set-substructure',atomId:atom.id,substructure:group}]).document,expanded=expand(updated);expect(()=>exportSourceFile(expanded)).toThrow('内部改绑');
    const contracted=applyDocumentEdits(expanded,[{type:'collapse-substructure',atomIds:Object.keys(expanded.graph.atoms),label:'Rebound'}]).document;expect(()=>exportSourceFile(contracted)).toThrow('内部改绑');
    delete expanded.source;const normalize=(d:Parameters<typeof stereoProjection>[0])=>JSON.stringify(stereoProjection(d),(_k,v)=>typeof v==='number'?Math.round(v*1e6)/1e6:v);expect(normalize(importDocument({data:exportDocument(expanded,{format:'cdxml'}).data}).document)).toBe(normalize(expanded));
  });
  it('verifies source graph equivalence across fragment serialization order and rejects altered chemistry',()=>{
    const raw=abbreviationXml.replace('</page>','<fragment id="500"><n id="501" p="300 0" Element="7"/></fragment></page>'),expanded=expand(load(raw)),back=importDocument({data:exportSourceFile(expanded).data}).document;
    expect(stereoProjection(back)).not.toEqual(stereoProjection(expanded));expect(equivalentDocuments({documentProjection:stereoProjection},back,expanded)).toBe(true);
    Object.values(back.graph.atoms).find(a=>a.element==='N')!.charge=1;expect(equivalentDocuments({documentProjection:stereoProjection},back,expanded)).toBe(false);
  });
  it('resolves indistinguishable coordinate candidates by topology and rejects a different graph',()=>{
    const chain=emptyDocument(),atoms=Array.from({length:4},()=>addAtom(chain,'C',{x:0,y:0}));for(let i=1;i<4;i++)addBond(chain,atoms[i-1],atoms[i]);
    const star=emptyDocument(),vertices=Array.from({length:4},()=>addAtom(star,'C',{x:0,y:0}));for(let i=1;i<4;i++)addBond(star,vertices[0],vertices[i]);
    expect(equivalentDocuments({documentProjection:stereoProjection},clone(chain),chain)).toBe(true);expect(equivalentDocuments({documentProjection:stereoProjection},star,chain)).toBe(false);
  });
});
