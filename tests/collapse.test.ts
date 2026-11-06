import {afterEach,beforeAll,describe,expect,it} from 'vitest';
import initRDKit from '@rdkit/rdkit';
import {createChemistryEngine,type ChemistryEngine} from '../src/chemistry/engine';
import {applyDocumentEdits} from '../src/core/edits';
import {addAtom,addBond,clone,emptyDocument,molecularFormula,validateDocument} from '../src/core/model';
import {DocumentStore} from '../src/core/store';
import {stereoProjection} from '../src/formats/stereo';
import {importDocument,exportDocument} from '../src/formats';
import {createChemicalEditor} from '../src/editor/chemical-editor';
import {knownChemicalSummary} from '../src/core/chemical-summary';
import {getPolymerGroup} from '../src/core/polymers';
let engine:ChemistryEngine;beforeAll(async()=>{engine=createChemistryEngine(await initRDKit());});
afterEach(()=>{document.body.replaceChildren();localStorage.clear();});
const collapse=(doc:ReturnType<typeof emptyDocument>,atoms=Object.keys(doc.graph.atoms),label='片段')=>applyDocumentEdits(doc,[{type:'collapse-substructure',atomIds:atoms,label,ref:'$group'}]);
const expand=(doc:ReturnType<typeof emptyDocument>,id:string)=>applyDocumentEdits(doc,[{type:'expand-substructure',atomId:id,recursive:true}]).document;
const projection=(doc:ReturnType<typeof emptyDocument>,like=doc)=>JSON.stringify(stereoProjection(doc,Object.keys(like.graph.atoms),Object.keys(like.graph.bonds)),(_k,v)=>typeof v==='number'?Math.round(v*1e6)/1e6:v);
describe('editable selection contraction',()=>{
  it.each(['COC','c1ccccc1','N[C@@H](C)C(=O)O','C/C=C/C','C/C=C\\C','[13CH3][18OH]','[NH4+]'])('contracts and restores a complete structure including chemistry and identities: %s',smiles=>{
    const doc=engine.importSmiles(smiles),before=clone(doc),result=collapse(doc),id=result.created.atoms.$group,child=result.document.graph.atoms[id].substructure!.fragments[0].document;
    expect(doc).toEqual(before);expect(Object.keys(result.document.graph.atoms)).toEqual([id]);expect(Object.keys(child.graph.atoms)).toEqual(Object.keys(doc.graph.atoms));expect(molecularFormula(result.document)).toBe(molecularFormula(doc));
    expect(knownChemicalSummary(result.document)).toEqual(knownChemicalSummary(doc));const restored=expand(result.document,id);expect(engine.analyze(restored).smiles).toBe(engine.analyze(doc).smiles);expect(projection(restored,doc)).toBe(projection(doc));
  });
  it('keeps boundary bond identity, creates real editable ports and supports one-step undo/redo',()=>{
    const doc=engine.importSmiles('COC'),ids=Object.keys(doc.graph.atoms),result=collapse(doc,ids.slice(1),'OMe'),id=result.created.atoms.$group,group=result.document.graph.atoms[id].substructure!;
    expect(group.connections).toHaveLength(1);expect(group.fragments[0].attachmentOrder).toHaveLength(1);expect(Object.values(group.fragments[0].document.graph.atoms).filter(a=>a.attachment)).toHaveLength(1);expect(Object.keys(result.document.graph.bonds)).toEqual([Object.keys(doc.graph.bonds)[0]]);
    const store=new DocumentStore(doc);store.replace(result.document);store.undo();expect(store.document).toEqual(doc);store.redo();expect(store.document).toEqual(result.document);expect(projection(expand(result.document,id),doc)).toBe(projection(doc));
  });
  it('contracts a two-port chain without changing placement, outside chemistry or E/Z',()=>{
    const doc=engine.importSmiles('OCCN'),ids=Object.values(doc.graph.atoms).filter(a=>a.element==='C').map(a=>a.id),result=collapse(doc,ids,'CH2CH2'),id=result.created.atoms.$group;
    expect(result.document.graph.atoms[id].substructure!.connections).toHaveLength(2);const restored=expand(result.document,id);expect(projection(restored,doc)).toBe(projection(doc));expect(engine.analyze(restored).smiles).toBe('NCCO');
  });
  it.each(['C[C@](F)(Cl)Br','C/C=C/C','C/C=C\\C'])('preserves outside stereochemistry when a terminal group is contracted: %s',smiles=>{
    const doc=engine.importSmiles(smiles),terminal=Object.values(doc.graph.atoms).find(a=>a.element==='C'&&Object.values(doc.graph.bonds).filter(b=>b.atoms.includes(a.id)).length===1)!,result=collapse(doc,[terminal.id],'Me');
    expect(engine.analyze(expand(result.document,result.created.atoms.$group)).smiles).toBe(engine.analyze(doc).smiles);
  });
  it('preserves internal tetrahedral ordering and boundary wedge after contraction',()=>{
    const doc=engine.importSmiles('C[C@](F)(Cl)Br'),terminal=Object.values(doc.graph.atoms).find(a=>a.element==='C'&&Object.values(doc.graph.bonds).filter(b=>b.atoms.includes(a.id)).length===1)!,selected=Object.keys(doc.graph.atoms).filter(id=>id!==terminal.id),result=collapse(doc,selected,'chiral');
    expect(engine.analyze(expand(result.document,result.created.atoms.$group)).smiles).toBe(engine.analyze(doc).smiles);
  });
  it('rejects disconnected selections, aromatic cut edges, duplicate outer bonds and blank names atomically',()=>{
    const doc=engine.importSmiles('CCC'),ids=Object.keys(doc.graph.atoms),before=clone(doc);expect(()=>collapse(doc,[ids[0],ids[2]])).toThrow('连通');expect(()=>collapse(doc,ids,' ')).toThrow('名称');expect(doc).toEqual(before);
    const ring=engine.importSmiles('c1ccccc1');expect(()=>collapse(ring,Object.keys(ring.graph.atoms).slice(1))).toThrow('单键');const cyclo=engine.importSmiles('C1CCCCC1');expect(()=>collapse(cyclo,Object.keys(cyclo.graph.atoms).slice(1))).toThrow('重复键');
  });
  it('retains new contractions through native JSON and can rebuild editable CDXML',()=>{
    const doc=engine.importSmiles('CCOC'),selected=Object.keys(doc.graph.atoms).slice(2),result=collapse(doc,selected,'OMe'),id=result.created.atoms.$group;
    const json=importDocument({format:'json',data:exportDocument(result.document,{format:'json'}).data}).document;expect(engine.analyze(expand(json,id)).smiles).toBe(engine.analyze(doc).smiles);
    const xml=importDocument({format:'cdxml',data:exportDocument(result.document,{format:'cdxml'}).data}).document,wrapper=Object.values(xml.graph.atoms).find(a=>a.substructure)!;expect(engine.analyze(expand(xml,wrapper.id)).smiles).toBe(engine.analyze(doc).smiles);
  });
  it('synchronizes polymer membership and boundary endpoints while rejecting straddling selections',()=>{
    const raw='<CDXML><page id="1"><fragment id="2"><n id="3" p="0 0"/><n id="4" p="30 0"/><n id="5" p="60 0"/><n id="6" p="90 0"/><b id="7" B="3" E="4"/><b id="8" B="4" E="5"/><b id="9" B="5" E="6"/></fragment><bracketedgroup id="10" BracketUsage="SRU" BracketedObjectIDs="4 5"><bracketattachment id="11"><crossingbond id="12" BondID="7" InnerAtomID="4"/></bracketattachment><bracketattachment id="13"><crossingbond id="14" BondID="9" InnerAtomID="5"/></bracketattachment></bracketedgroup></page></CDXML>',doc=importDocument({data:raw}).document,ids=Object.keys(doc.graph.atoms),result=collapse(doc,ids.slice(1,3)),id=result.created.atoms.$group,polymerId=Object.values(doc.depiction.objects!).find(o=>o.tag==='bracketedgroup')!.id;
    expect(getPolymerGroup(result.document,polymerId).atomIds).toEqual([id]);expect(getPolymerGroup(result.document,polymerId).crossings.every(c=>c.innerAtomId===id)).toBe(true);expect(validateDocument(result.document)).toEqual([]);expect(projection(expand(result.document,id),doc)).toBe(projection(doc));
    expect(()=>collapse(doc,ids.slice(0,2))).toThrow('聚合物');
  });
  it('preserves molecular reaction roles and blocks selected single-atom mappings',()=>{
    const raw='<CDXML><page id="1"><fragment id="2"><n id="3" p="0 0"/><n id="4" p="30 0" Element="8"/><b id="5" B="3" E="4"/></fragment><scheme id="6"><step id="7" ReactionStepReactants="2"/></scheme></page></CDXML>',doc=importDocument({data:raw}).document,result=collapse(doc),id=result.created.atoms.$group;
    expect(Object.values(result.document.graph.reactions!)[0].reactants[0]).toMatchObject({kind:'molecule',atomIds:[id]});expect(projection(expand(result.document,id),doc)).toBe(projection(doc));
    const mapped=importDocument({data:raw.replace('ReactionStepReactants="2"','ReactionStepReactants="2" ReactionStepAtomMap="3 4"')}).document;expect(()=>collapse(mapped)).toThrow('单原子映射');
  });
  it('supports a batch-created fragment and the visible contraction action',()=>{
    const doc=emptyDocument(),a=addAtom(doc,'C',{x:0,y:0}),b=addAtom(doc,'O',{x:1.5,y:0});addBond(doc,a,b);
    const editor=createChemicalEditor({container:document.body,document:doc});try{editor.setSelection({atomIds:[b]});editor.showAdvancedEditor('fragments');const input=editor.shadowRoot!.querySelector<HTMLInputElement>('[data-collapse-label]')!;input.value='OH';editor.shadowRoot!.querySelector<HTMLButtonElement>('[data-action="collapse-substructure"]')!.click();expect(Object.values(editor.getDocument().graph.atoms).find(atom=>atom.substructure)?.substructure!.label).toBe('OH');editor.undo();expect(editor.getDocument()).toEqual(doc);}finally{editor.destroy();}
  });
  it('atomically adds a new external connection with a batch bond reference',()=>{
    const original=engine.importSmiles('COC'),collapsed=collapse(original,Object.keys(original.graph.atoms).slice(1),'OMe'),id=collapsed.created.atoms.$group,group=clone(collapsed.document.graph.atoms[id].substructure!),child=group.fragments[0].document,carbon=Object.values(child.graph.atoms).find(a=>a.element==='C')!,port=addAtom(child,'*',{x:4.5,y:0},{attachment:'external',hydrogens:{mode:'fixed',count:0}});addBond(child,carbon.id,port);group.fragments[0].attachmentOrder.push(port);group.connections.push({bondId:'$newEdge',fragment:0,atomId:port});
    const updated=applyDocumentEdits(collapsed.document,[{type:'add-atom',ref:'$newN',element:'N',position:{x:4.5,y:0}},{type:'add-bond',ref:'$newEdge',atoms:[id,'$newN']},{type:'set-substructure',atomId:id,substructure:group}]).document;
    expect(updated.graph.atoms[id].substructure!.connections).toHaveLength(2);expect(engine.analyze(expand(updated,id)).smiles).toBe('COCN');
  });
});
