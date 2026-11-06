import {afterEach,beforeAll,describe,expect,it} from 'vitest';
import initRDKit from '@rdkit/rdkit';
import {createChemistryEngine,type ChemistryEngine} from '../src/chemistry/engine';
import {addAtom,addBond,clone,emptyDocument,molecularFormula} from '../src/core/model';
import {exampleDocument} from '../src/core/templates';
import {applyDocumentEdits} from '../src/core/edits';
import {DocumentStore} from '../src/core/store';
import {exportSourceFile} from '../src/formats/preservation';
import {importDocument,exportDocument} from '../src/formats';
import {createChemicalEditor} from '../src/editor/chemical-editor';
import {createChemistryPlugin} from '../src/plugins/chemistry-engine';
import {polymerXml} from './fixtures/polymer-fixture';

let engine:ChemistryEngine;
beforeAll(async()=>{engine=createChemistryEngine(await initRDKit());});
afterEach(()=>{document.body.replaceChildren();localStorage.clear();});
describe('real RDKit computation adapter',()=>{
  it('calculates ethanol mass, exact mass, formula and descriptors locally',()=>{
    const doc=exampleDocument('ethanol'),before=clone(doc),analysis=engine.analyze(doc);
    expect(analysis.formula).toBe('C2H6O');expect(analysis.molecularWeight).toBeCloseTo(46.069,3);expect(analysis.exactMass).toBeCloseTo(46.041864812,6);expect(analysis.descriptors.hBondDonors).toBe(1);expect(analysis.smiles).toBe('CCO');expect(doc).toEqual(before);
  });
  it.each(['c1ccccc1','c1ccncc1','c1cc[nH]c1','C[N+](C)(C)C','[NH4+]','[13CH3][18OH]','[H]O[H]','[CH3]','CCO.[Na+]'])('imports and verifies complete SMILES chemistry: %s',smiles=>{
    const doc=engine.importSmiles(smiles),analysis=engine.analyze(doc);expect(analysis.atomCount).toBe(Object.keys(doc.graph.atoms).length);expect(analysis.molecularWeight).toBeGreaterThan(0);
    const again=engine.importSmiles(analysis.smiles);expect(engine.analyze(again).smiles).toBe(analysis.smiles);
    const source=importDocument({data:exportDocument(doc,{format:'cdxml'}).data}).document;expect(engine.analyze(source).smiles).toBe(analysis.smiles);
  });
  it.each(['CC(C)CC(O)C','c1ccc2ccccc2c1','C1CC2CCC1C2','C1CCC2(CC1)CCCC2','CC(=O)Oc1ccccc1C(=O)O'])('cleans chains, fused, bridged and spiro rings without changing chemistry: %s',smiles=>{
    const doc=engine.importSmiles(smiles);Object.values(doc.depiction.positions).forEach((p,i)=>{p.x=i*.1;p.y=0;});
    const before=clone(doc),store=new DocumentStore(doc),result=engine.cleanup2D(doc);store.replace(result.document);
    expect(doc).toEqual(before);expect(result.document.graph).toEqual(doc.graph);expect(engine.analyze(result.document).smiles).toBe(engine.analyze(doc).smiles);
    const lengths=Object.values(result.document.graph.bonds).map(b=>{const[a,c]=b.atoms.map(id=>result.document.depiction.positions[id]);return Math.hypot(a.x-c.x,a.y-c.y);});expect(Math.min(...lengths)).toBeGreaterThan(1.3);expect(Math.max(...lengths)).toBeLessThan(1.7);
    store.undo();expect(store.document).toEqual(before);store.redo();expect(store.document).toEqual(result.document);
  });
  it.each(['F[C@](Cl)(Br)I','N[C@@H](C)C(=O)O','C/C=C/C','C/C=C\u005cC'])('preserves specified tetrahedral or alkene identity during cleanup: %s',smiles=>{
    const doc=engine.importSmiles(smiles),before=engine.analyze(doc),result=engine.cleanup2D(doc).document,after=engine.analyze(result);
    expect(after.smiles).toBe(before.smiles);expect(after.stereoAtoms).toEqual(before.stereoAtoms);expect(after.stereoBonds).toEqual(before.stereoBonds);
  });
  it('retains explicit tetrahedral ordering and source-saving after cleanup',()=>{
    const doc=emptyDocument(),center=addAtom(doc,'C',{x:0,y:0}),refs=['F','Cl','Br','I'].map((e,i)=>addBond(doc,center,addAtom(doc,e,[{x:1.5,y:0},{x:0,y:1.5},{x:-1.5,y:0},{x:0,y:-1.5}][i])));
    doc.depiction.bonds[refs[0]]={style:'wedge',from:center};doc.graph.atoms[center].geometry={type:'tetrahedral',bondOrdering:refs as [string,string,string,string]};
    const original=importDocument({data:exportDocument(doc,{format:'cdxml'}).data}).document,clean=engine.cleanup2D(original).document,back=importDocument({data:exportSourceFile(clean).data}).document;
    expect(engine.analyze(back).smiles).toBe(engine.analyze(original).smiles);expect(Object.values(clean.graph.atoms).find(a=>a.geometry)!.geometry).toEqual(Object.values(original.graph.atoms).find(a=>a.geometry)!.geometry);
  });
  it('preserves original user atom maps and explicit hydrogen identities',()=>{
    const doc=engine.importSmiles('[H:7][O:2][H:9]'),before=clone(doc),analysis=engine.analyze(doc),clean=engine.cleanup2D(doc).document;
    expect(analysis.smiles).toContain(':7');expect(Object.keys(clean.graph.atoms)).toHaveLength(3);expect(clean.graph).toEqual(before.graph);expect(molecularFormula(clean)).toBe('H2O');
  });
  it('rejects partial selections, undefined chemistry and invalid SMILES without modifying input',()=>{
    const doc=exampleDocument('ethanol'),before=clone(doc);expect(()=>engine.cleanup2D(doc,[Object.keys(doc.graph.atoms)[0]])).toThrow('完整分子');expect(doc).toEqual(before);
    expect(()=>engine.importSmiles('not a molecule')).toThrow();expect(()=>engine.importSmiles('CCO>O>CC=O')).toThrow('单条');expect(()=>engine.importSmiles('*CC')).toThrow();
    const query=emptyDocument();addAtom(query,'*',{x:0,y:0},{query:{kind:'any'}});expect(()=>engine.analyze(query)).toThrow('查询');
  });
  it('retains unsupported advanced stereo fields and refuses lossy computation',()=>{
    const doc=exampleDocument('ethanol');Object.values(doc.graph.atoms)[0].enhancedStereo={type:'And',group:1};const before=clone(doc);expect(()=>engine.cleanup2D(doc)).toThrow('增强立体');expect(doc).toEqual(before);
  });
  it('applies a bulk layout in one validated atomic edit and rejects forged atom IDs',()=>{
    const doc=exampleDocument('ethanol'),id=Object.keys(doc.graph.atoms)[0];expect(()=>applyDocumentEdits(doc,[{type:'set-layout',positions:{missing:{x:1,y:1}}}])).toThrow();expect(()=>applyDocumentEdits(doc,[{type:'set-layout',positions:{[id]:{x:NaN,y:1}}}])).toThrow();
    const moved=applyDocumentEdits(doc,[{type:'set-layout',positions:{[id]:{x:8,y:9}}}]).document;expect(moved.depiction.positions[id]).toEqual({x:8,y:9});
  });
  it('preserves disconnected fragment centroids and untouched drawing metadata',()=>{
    const doc=engine.importSmiles('CCC.O');doc.depiction.style={attributes:{Comment:'keep this'},fonts:[],colors:[]};
    const components=Object.keys(doc.graph.atoms),oxygen=components[3];doc.depiction.positions[oxygen]={x:50,y:40};
    const before=clone(doc),clean=engine.cleanup2D(doc,components.slice(0,3)).document;
    expect(clean.depiction.positions[oxygen]).toEqual(before.depiction.positions[oxygen]);expect(clean.depiction.style).toEqual(before.depiction.style);
    for(const axis of ['x','y']as const)expect(components.slice(0,3).reduce((n,id)=>n+clean.depiction.positions[id][axis],0)).toBeCloseTo(components.slice(0,3).reduce((n,id)=>n+before.depiction.positions[id][axis],0),8);
  });
  it('does not invent an unmarked stereocenter or accept an invalid fixed hydrogen count',()=>{
    const doc=engine.importSmiles('FC(Cl)(Br)I'),analysis=engine.analyze(doc);expect(analysis.unspecifiedStereoCenters).toBe(1);expect(analysis.stereoAtoms).toEqual({});
    const invalid=exampleDocument('ethanol');Object.values(invalid.graph.atoms)[0].hydrogens={mode:'fixed',count:0};expect(()=>engine.analyze(invalid)).toThrow('指定氢数');
  });
  it('does not report a repeat unit as a complete polymer or alter its boundary geometry',()=>{
    const doc=importDocument({data:polymerXml}).document,before=clone(doc);expect(()=>engine.analyze(doc)).toThrow('整个分子');expect(()=>engine.cleanup2D(doc)).toThrow('整个分子');expect(doc).toEqual(before);
  });
  it('can still calculate an independent complete molecule outside typed polymer groups',()=>{
    const doc=importDocument({data:polymerXml}).document,carbon=addAtom(doc,'C',{x:5,y:5}),oxygen=addAtom(doc,'O',{x:6.5,y:5});addBond(doc,carbon,oxygen);
    expect(engine.analyze(doc,[carbon,oxygen]).formula).toBe('CH4O');expect(engine.cleanup2D(doc,[carbon,oxygen]).document.graph).toEqual(doc.graph);
  });
});

describe('chemical computation editor transactions',()=>{
  const mount=(loadEngine=()=>Promise.resolve(engine))=>createChemicalEditor({container:document.body,document:exampleDocument('ethanol'),plugins:[createChemistryPlugin({loadEngine})]});
  it('analyzes without history changes, imports atomically, writes real CIP and supports undo',async()=>{
    const editor=mount();try{
      const before=editor.getDocument(),revision=editor.getSnapshot().revision;
      await editor.executeCommand('chemistry-engine.analyze');expect(editor.getSnapshot().revision).toBe(revision);expect(editor.shadowRoot!.querySelector('[data-chemistry-summary]')!.textContent).toContain('C2H6O');
      await editor.executeCommand('chemistry-engine.import-smiles','F[C@](Cl)(Br)I');const imported=editor.getDocument();
      expect(engine.analyze(imported).stereoAtoms).not.toEqual({});await editor.executeCommand('chemistry-engine.assign-stereo');
      expect(Object.values(editor.getDocument().graph.atoms).some(a=>a.cipLabel==='S'||a.cipLabel==='R')).toBe(true);
      editor.undo();expect(editor.getDocument()).toEqual(imported);editor.undo();expect(editor.getDocument()).toEqual(before);
      await expect(editor.executeCommand('chemistry-engine.import-smiles','invalid')).rejects.toThrow();expect(editor.getDocument()).toEqual(before);
    }finally{editor.destroy();}
  });
  it('rejects a stale asynchronous result after a document edit',async()=>{
    let resolve!:(engine:ChemistryEngine)=>void;const editor=mount(()=>new Promise(r=>resolve=r));try{
      const pending=editor.executeCommand('chemistry-engine.clean-2d');editor.applyEdits({operations:[{type:'rename',title:'Changed during load'}]});const edited=editor.getDocument();
      resolve(engine);await expect(pending).rejects.toThrow('文档已更新');expect(editor.getDocument()).toEqual(edited);
    }finally{editor.destroy();}
  });
  it('does not submit a result after plugin disposal and prevents overlapping commands',async()=>{
    let resolve!:(engine:ChemistryEngine)=>void;const editor=mount(()=>new Promise(r=>resolve=r));try{
      const before=editor.getDocument(),pending=editor.executeCommand('chemistry-engine.clean-2d');
      await expect(editor.executeCommand('chemistry-engine.import-smiles','CCC')).rejects.toThrow('正在进行');
      editor.setPluginEnabled('chemistry-engine',false);resolve(engine);await expect(pending).rejects.toThrow('已停用');expect(editor.getDocument()).toEqual(before);
    }finally{editor.destroy();}
  });
});
