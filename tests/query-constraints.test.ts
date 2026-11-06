import {describe,expect,it,vi} from 'vitest';
import type {MainModule} from '@rdkit/rdkit';
import {addAtom,addBond,clone,emptyDocument,hydrogenCount,molecularFormula,validateDocument} from '../src/core/model';
import type {AtomQueryConstraints,Bond,ChemicalDocument} from '../src/core/types';
import {applyDocumentEdits} from '../src/core/edits';
import {knownChemicalSummary} from '../src/core/chemical-summary';
import {DocumentStore} from '../src/core/store';
import {atomReactionStereos,atomRingBondCounts,atomUnsaturatedBonds,bondTopologies} from '../src/core/query';
import {createChemistryEngine} from '../src/chemistry/engine';
import {importDocument,exportDocument} from '../src/formats';
import {stereoProjection} from '../src/formats/stereo';
import {abbreviationXml} from './fixtures/abbreviation-fixture';

const fixture=()=>{
 const doc=emptyDocument(),a=addAtom(doc,'C',{x:0,y:0}),b=addAtom(doc,'O',{x:1.5,y:0}),bond=addBond(doc,a,b);
 return {doc,a,b,bond};
};
const constraints=(doc:ChemicalDocument,id:string,value:AtomQueryConstraints|null)=>applyDocumentEdits(doc,[{type:'update-atom',atomId:id,changes:{queryConstraints:value}}]).document;
const nested=()=>{const doc=importDocument({data:abbreviationXml}).document;return {doc,wrapper:Object.values(doc.graph.atoms).find(a=>a.substructure)!};};
const project=(doc:ChemicalDocument)=>JSON.parse(JSON.stringify(stereoProjection(doc)));

describe('typed query constraints independent of element identity',()=>{
 it('preserves concrete carbon, zero counts, simultaneous predicates and contradictory searches',()=>{
  const {doc,a}=fixture(),before=clone(doc),value:AtomQueryConstraints={substituentsExactly:0,substituentsUpTo:255,ringBondCount:'Fusion',unsaturatedBonds:'MustBePresent',reactionChange:true,reactionStereo:'Retention'},result=constraints(doc,a,value);
  expect(doc).toEqual(before);expect(result.graph.atoms[a]).toMatchObject({element:'C',queryConstraints:value});expect(result.graph.atoms[a].query).toBeUndefined();expect(validateDocument(result).some(i=>i.code==='ATOM_QUERY_CONSTRAINTS')).toBe(true);
  const contradictory=constraints(doc,a,{substituentsExactly:255,substituentsUpTo:0});expect(contradictory.graph.atoms[a].queryConstraints).toEqual({substituentsExactly:255,substituentsUpTo:0});
 });
 it.each(atomRingBondCounts)('retains explicit ring-bond query %s',ringBondCount=>{const {doc,a}=fixture();expect(constraints(doc,a,{ringBondCount}).graph.atoms[a].queryConstraints).toEqual({ringBondCount});});
 it.each(atomUnsaturatedBonds)('distinguishes unsaturation predicate %s',unsaturatedBonds=>{const {doc,a}=fixture();expect(constraints(doc,a,{unsaturatedBonds}).graph.atoms[a].queryConstraints).toEqual({unsaturatedBonds});});
 it.each(atomReactionStereos)('retains reaction stereo %s without applying a geometric inversion',reactionStereo=>{const {doc,a}=fixture(),result=constraints(doc,a,{reactionStereo});expect(result.depiction).toEqual(doc.depiction);expect(result.graph.atoms[a].geometry).toBeUndefined();});
 it('allows predicates on an explicit wildcard query and clears them independently',()=>{
  const doc=emptyDocument(),id=addAtom(doc,'*',{x:0,y:0},{query:{kind:'any'},queryConstraints:{substituentsExactly:2}}),cleared=constraints(doc,id,null);
  expect(cleared.graph.atoms[id].query).toEqual({kind:'any'});expect(cleared.graph.atoms[id].queryConstraints).toBeUndefined();expect(validateDocument(doc).some(i=>i.code==='ATOM_QUERY_CONSTRAINTS')).toBe(true);
 });
 it.each([{}, {substituentsExactly:-1},{substituentsExactly:256},{substituentsUpTo:1.5},{ringBondCount:'2'},{unsaturatedBonds:false},{reactionChange:false},{reactionStereo:'invert'},{unknown:1}] as unknown as AtomQueryConstraints[])('refuses malformed predicates atomically: %j',value=>{
  const {doc,a}=fixture(),before=clone(doc);expect(()=>constraints(doc,a,value)).toThrow();expect(doc).toEqual(before);
 });
 it('does not attach predicates to virtual template ports or accept an untyped wildcard',()=>{
  const doc=emptyDocument(),id=addAtom(doc,'*',{x:0,y:0},{attachment:'external',hydrogens:{mode:'fixed',count:0}});expect(()=>constraints(doc,id,{ringBondCount:'SimpleRing'})).toThrow('虚拟连接点');
  expect(()=>applyDocumentEdits(emptyDocument(),[{type:'add-atom',element:'*',position:{x:0,y:0},properties:{queryConstraints:{substituentsExactly:1}}}])).toThrow('未知元素');
 });
 it('adds a constrained concrete atom and topology bond in an atomic batch using temporary IDs',()=>{
  const result=applyDocumentEdits(emptyDocument(),[{type:'add-atom',ref:'$a',element:'C',position:{x:0,y:0},properties:{queryConstraints:{ringBondCount:'AsDrawn'}}},{type:'add-atom',ref:'$b',element:'N',position:{x:1.5,y:0}},{type:'add-bond',ref:'$edge',atoms:['$a','$b'],order:2,topology:'Chain'}]);
  expect(result.document.graph.atoms[result.created.atoms.$a]).toMatchObject({element:'C',queryConstraints:{ringBondCount:'AsDrawn'}});expect(result.document.graph.bonds[result.created.bonds.$edge]).toMatchObject({order:2,topology:'Chain'});
 });
 it.each(bondTopologies)('retains bond topology %s, including explicit defaults',topology=>{const {doc,bond}=fixture(),result=applyDocumentEdits(doc,[{type:'update-bond',bondId:bond,topology}]).document;expect(result.graph.bonds[bond].topology).toBe(topology);expect(validateDocument(result).some(i=>i.code==='BOND_TOPOLOGY_QUERY')).toBe(true);});
 it('sets and clears topology through the annotation operation without changing bond order',()=>{
  const {doc,bond}=fixture(),set=applyDocumentEdits(doc,[{type:'set-bond-annotations',bondId:bond,changes:{topology:'RingOrChain'}}]).document,cleared=applyDocumentEdits(set,[{type:'update-bond',bondId:bond,topology:null}]).document;
  expect(set.graph.bonds[bond]).toMatchObject({order:1,topology:'RingOrChain'});expect(cleared.graph.bonds[bond].topology).toBeUndefined();expect(project(cleared)).toEqual(project(doc));
  const again=applyDocumentEdits(set,[{type:'set-bond-annotations',bondId:bond,changes:{topology:null}}]).document;expect(again.graph.bonds[bond].topology).toBeUndefined();
 });
 it('refuses unknown topology values without changing the original',()=>{const {doc,bond}=fixture(),before=clone(doc);expect(()=>applyDocumentEdits(doc,[{type:'update-bond',bondId:bond,topology:'ring' as Bond['topology']}])).toThrow('拓扑');expect(doc).toEqual(before);});
 it('keeps full predicates and topology through JSON restoration and one-step undo/redo',()=>{
  const {doc,a,bond}=fixture(),edited=applyDocumentEdits(doc,[{type:'update-atom',atomId:a,changes:{queryConstraints:{substituentsExactly:0,reactionChange:true,unsaturatedBonds:'MustBeAbsent'}}},{type:'update-bond',bondId:bond,topology:'RingOrChain'}]).document,store=new DocumentStore(doc);
  store.replace(edited);expect(project(importDocument({data:exportDocument(edited,{format:'json'}).data}).document)).toEqual(project(edited));store.undo();expect(store.document).toEqual(doc);store.redo();expect(store.document).toEqual(edited);
 });
});

describe('query computation, summaries and nested graph safety',()=>{
 it('marks concrete-element query compositions partial without inventing hydrogens',()=>{
  const {doc,a}=fixture(),query=constraints(doc,a,{substituentsUpTo:2});expect(hydrogenCount(query,a)).toBeNull();expect(molecularFormula(query)).toContain('待校验');expect(knownChemicalSummary(query)).toMatchObject({knownChemicalAtomCount:2,formalCharge:0,complete:false,incompleteReasons:['原子查询约束']});
  query.graph.atoms[a].hydrogens={mode:'fixed',count:3};expect(hydrogenCount(query,a)).toBeNull();
 });
 it('marks topology-only queries partial at each nested layer',()=>{
  const {doc,a,bond}=fixture();doc.graph.bonds[bond].topology='Ring';expect(hydrogenCount(doc,a)).toBeNull();expect(molecularFormula(doc)).toContain('待校验');expect(knownChemicalSummary(doc).incompleteReasons).toContain('键拓扑查询');
  const outer=emptyDocument();addAtom(outer,'*',{x:0,y:0},{substructure:{kind:'abbreviation',label:'query fragment',fragments:[{document:doc,attachmentOrder:[]}],connections:[]}});expect(molecularFormula(outer)).toContain('待校验');expect(knownChemicalSummary(outer)).toMatchObject({knownChemicalAtomCount:2,complete:false,incompleteReasons:['键拓扑查询']});
 });
 it('retains wrapper query scope and flags its composition as incomplete',()=>{
  const {doc,wrapper}=nested(),query=constraints(doc,wrapper.id,{substituentsExactly:2});expect(knownChemicalSummary(query)).toMatchObject({knownChemicalAtomCount:3,complete:false,incompleteReasons:['原子查询约束']});expect(molecularFormula(query)).toContain('待校验');
  const before=clone(query);expect(()=>applyDocumentEdits(query,[{type:'expand-substructure',atomId:wrapper.id}])).toThrow('整体查询约束');expect(query).toEqual(before);
  const view=applyDocumentEdits(query,[{type:'set-substructure-display',atomId:wrapper.id,expanded:true,recursive:true}]).document;expect(view.graph.atoms[wrapper.id].queryConstraints).toEqual({substituentsExactly:2});expect(view.graph.atoms[wrapper.id].substructure!.display).toBe('expanded');
 });
 it('invalidates CIP caches after a query predicate or topology changes',()=>{
  const {doc,a,bond}=fixture();doc.graph.atoms[a].cipLabel='R';doc.graph.bonds[bond].order=2;doc.graph.bonds[bond].cipLabel='E';
  for(const operations of [[{type:'update-atom' as const,atomId:a,changes:{queryConstraints:{ringBondCount:'AsDrawn' as const}}}],[{type:'update-bond' as const,bondId:bond,topology:'Chain' as const}]]){const edited=applyDocumentEdits(doc,operations).document;expect(edited.graph.atoms[a].cipLabel).toBeUndefined();expect(edited.graph.bonds[bond].cipLabel).toBeUndefined();}
 });
 it('rejects query calculation before passing any simplified structure to RDKit',()=>{
  const getMol=vi.fn(()=>{throw new Error('The query must not reach RDKit as an ordinary molecule');}),engine=createChemistryEngine({version:()=> 'guard-test',get_mol:getMol}as unknown as MainModule),{doc,a,bond}=fixture(),atomQuery=constraints(doc,a,{reactionChange:true}),bondQuery=applyDocumentEdits(doc,[{type:'update-bond',bondId:bond,topology:'RingOrChain'}]).document;
  for(const query of [atomQuery,bondQuery]){const before=clone(query);expect(()=>engine.analyze(query)).toThrow('查询');expect(()=>engine.cleanup2D(query)).toThrow('查询');expect(query).toEqual(before);}expect(getMol).not.toHaveBeenCalled();
 });
 it('preserves internal predicates and topology across collapse and promotion',()=>{
  const {doc,a,bond}=fixture();doc.graph.atoms[a].queryConstraints={unsaturatedBonds:'MustBeAbsent'};doc.graph.bonds[bond].topology='Chain';
  const collapsed=applyDocumentEdits(doc,[{type:'collapse-substructure',atomIds:Object.keys(doc.graph.atoms),label:'Query fragment',ref:'$fragment'}]),expanded=applyDocumentEdits(collapsed.document,[{type:'expand-substructure',atomId:collapsed.created.atoms.$fragment}]).document;
  expect(expanded.graph.atoms[a].queryConstraints).toEqual(doc.graph.atoms[a].queryConstraints);expect(expanded.graph.bonds[bond].topology).toBe('Chain');expect(project(expanded)).toEqual(project(doc));
 });
 it('merges a virtual port topology into its real boundary and protects conflicts',()=>{
  const {doc,wrapper}=nested(),connection=wrapper.substructure!.connections[0],child=wrapper.substructure!.fragments[0].document,edge=Object.values(child.graph.bonds).find(b=>b.atoms.includes(connection.atomId))!;edge.topology='Ring';
  const expanded=applyDocumentEdits(doc,[{type:'expand-substructure',atomId:wrapper.id}]).document;expect(expanded.graph.bonds[connection.bondId].topology).toBe('Ring');
  doc.graph.bonds[connection.bondId].topology='Chain';const before=clone(doc);expect(()=>applyDocumentEdits(doc,[{type:'expand-substructure',atomId:wrapper.id}])).toThrow('化学注释冲突');expect(doc).toEqual(before);
 });
});
