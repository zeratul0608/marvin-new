import {beforeAll,describe,expect,it} from 'vitest';
import initRDKit from '@rdkit/rdkit';
import {clone,validateDocument} from '../src/core/model';
import {applyDocumentEdits} from '../src/core/edits';
import {DocumentStore} from '../src/core/store';
import {createChemistryEngine,type ChemistryEngine} from '../src/chemistry/engine';
import {importDocument,exportDocument,exportSourceFile} from '../src/formats';
import {stereoProjection} from '../src/formats/stereo';
import {equivalentDocuments} from '../scripts/document-correspondence.mjs';
import type {BondOrder,ChemicalDocument} from '../src/core/types';

let engine:ChemistryEngine;beforeAll(async()=>{engine=createChemistryEngine(await initRDKit());});
/** Self-built C=N-C / C#N with a real external-connection node. */
function fixture(order:2|3,innerOrder:BondOrder=order):string{
 const inner=innerOrder==='aromatic'?'1.5':innerOrder;
 return `<CDXML><page id="1"><fragment id="2"><n id="3" p="-30 0"/><n id="20" p="0 0" NodeType="Fragment"><fragment id="100" ConnectionOrder="103"><n id="101" p="0 0" Element="7" Z="7" color="4"/><n id="103" p="-30 0" NodeType="ExternalConnectionPoint"/>${order===2?'<n id="102" p="30 0"/><b id="104" B="101" E="102"/>':''}<b id="105" B="103" E="101" Order="${inner}"/></fragment><t><s>NR</s></t></n><b id="30" B="3" E="20" Order="${order}" Z="8" LineWidth="1.15"/></fragment></page></CDXML>`;
}
const alkeneFixture=()=>fixture(2).replace('<n id="102" p="30 0"/><b id="104" B="101" E="102"/>','<n id="102" p="30 20"/><n id="106" p="60 20"/><n id="107" p="90 40" Element="9"/><b id="104" B="101" E="102"/><b id="108" B="102" E="106" Order="2" BondCircularOrdering="104 0 109 0" BS="E"/><b id="109" B="106" E="107"/>');
const load=(raw=fixture(2))=>importDocument({data:raw}).document;
const wrapper=(doc:ChemicalDocument)=>Object.values(doc.graph.atoms).find(a=>a.substructure)!;
const expand=(doc:ChemicalDocument)=>applyDocumentEdits(doc,[{type:'expand-substructure',atomId:wrapper(doc).id}]).document;
const same=(actual:ChemicalDocument,expected:ChemicalDocument)=>expect(equivalentDocuments({documentProjection:stereoProjection},actual,expected)).toBe(true);

describe('expand matching multiple-bond abbreviation boundaries',()=>{
 it.each([2,3]as const)('promotes an equal-order %i boundary while retaining the outer bond identity',order=>{
  const doc=load(fixture(order)),before=clone(doc),outer=Object.values(doc.graph.bonds)[0],result=expand(doc);
  expect(doc).toEqual(before);expect(result.graph.bonds[outer.id].order).toBe(order);expect(result.graph.atoms[wrapper(doc).id]).toBeUndefined();
  expect(Object.values(result.graph.atoms).some(a=>a.attachment||a.substructure)).toBe(false);expect(Object.values(result.graph.atoms).filter(a=>a.element==='N')).toHaveLength(1);
  expect(Object.keys(result.graph.bonds)).toHaveLength(order===2?2:1);expect(validateDocument(result)).toEqual([]);
  expect(engine.analyze(result).smiles).toBe(order===2?'C=NC':'C#N');
  const store=new DocumentStore(doc);store.replace(result);store.undo();expect(store.document).toEqual(doc);store.redo();expect(store.document).toEqual(result);
 });
 it.each([1,3,'aromatic','any']as const)('refuses a double boundary whose inner order is %s atomically',innerOrder=>{
  const doc=load(fixture(2,innerOrder)),before=clone(doc);expect(()=>expand(doc)).toThrow('内外同阶');expect(doc).toEqual(before);
 });
 it('continues to refuse matching aromatic and query boundaries',()=>{
  for(const order of ['aromatic','any']as const){const doc=load();Object.values(doc.graph.bonds)[0].order=order;Object.values(wrapper(doc).substructure!.fragments[0].document.graph.bonds).find(b=>b.atoms.some(id=>wrapper(doc).substructure!.fragments[0].document.graph.atoms[id].attachment))!.order=order;expect(()=>expand(doc)).toThrow('普通单键、双键或三键');}
 });
 it.each([false,true])('merges reaction annotations with reversed inner direction %s and rejects conflicts',reverse=>{
  const doc=load(),outer=Object.values(doc.graph.bonds)[0],child=wrapper(doc).substructure!.fragments[0].document,inner=Object.values(child.graph.bonds).find(b=>b.order===2)!;
  if(reverse)inner.atoms.reverse();inner.reactionParticipation='ChangeType';inner.externalNumbers=[2,3];const result=expand(doc);expect(result.graph.bonds[outer.id]).toMatchObject({reactionParticipation:'ChangeType',externalNumbers:reverse?[3,2]:[2,3]});
  outer.reactionParticipation='NoChange';const before=clone(doc);expect(()=>expand(doc)).toThrow('化学注释冲突');expect(doc).toEqual(before);
 });
 it('invalidates source CIP caches on the promoted atoms and retained boundary',()=>{
  const raw=fixture(2).replace('Element="7" Z="7"','Element="7" AS="R" Z="7"').replace('id="105" B="103" E="101"','id="105" B="103" E="101" BS="Z"').replace('id="30" B="3" E="20"','id="30" B="3" E="20" BS="E"'),result=expand(load(raw));
  expect(Object.values(result.graph.atoms).every(a=>a.cipLabel===undefined)).toBe(true);expect(Object.values(result.graph.bonds).every(b=>b.cipLabel===undefined)).toBe(true);
  const back=importDocument({data:exportSourceFile(result).data}).document;same(back,result);expect(Object.values(back.graph.atoms).every(a=>a.cipLabel===undefined)).toBe(true);expect(Object.values(back.graph.bonds).every(b=>b.cipLabel===undefined)).toBe(true);
 });
 it('retains an internal E alkene ordering through promotion and native source saving',()=>{
  const result=expand(load(alkeneFixture())),alkene=Object.values(result.graph.bonds).find(b=>b.circularOrdering)!;
  expect(alkene.circularOrdering!.filter(Boolean)).toHaveLength(2);expect(alkene.cipLabel).toBeUndefined();expect(engine.analyze(result).stereoBonds[alkene.id]).toBe('E');
  const back=importDocument({data:exportSourceFile(result).data}).document;same(back,result);expect(engine.analyze(back).smiles).toBe(engine.analyze(result).smiles);
 });
 it('keeps the stereo guard when a second bound port would invert an internal alkene',()=>{
  const raw=alkeneFixture().replace('<n id="20"','<n id="4" p="30 30"/><n id="20"').replace('NodeType="Fragment"','NodeType="Fragment" BondOrdering="30 32"').replace('ConnectionOrder="103"','ConnectionOrder="103 111"').replace('BondCircularOrdering="104 0 109 0"','BondCircularOrdering="104 0 110 109"').replace('<b id="105"','<n id="111" p="90 0" NodeType="ExternalConnectionPoint"/><b id="110" B="106" E="111"/><b id="105"').replace('</fragment></page>','<b id="32" B="20" E="4"/></fragment></page>'),doc=load(raw),before=clone(doc);
  expect(()=>expand(doc)).toThrow('双键构型');expect(doc).toEqual(before);
 });
 it('does not discard an explicit outer boundary ordering',()=>{
  const constrained=load(fixture(2).replace('<n id="3" p="-30 0"/>','<n id="3" p="-30 0"/><n id="4" p="-60 30"/><b id="31" B="4" E="3"/>').replace('<b id="30"','<b BondCircularOrdering="31 0 0 0" id="30"'));
  const before=clone(constrained);expect(()=>expand(constrained)).toThrow('显式立体排序');expect(constrained).toEqual(before);
 });
 it('does not silently drop an explicit inner boundary ordering',()=>{
  const doc=load(fixture(2).replace('id="105" B="103" E="101" Order="2"','id="105" B="103" E="101" Order="2" BondCircularOrdering="0 0 104 0"')),before=clone(doc);
  expect(()=>expand(doc)).toThrow('显式立体排序');expect(doc).toEqual(before);
 });
 it.each([2,3]as const)('source-saves a promoted %i boundary and retains native attributes across JSON restoration',order=>{
  const doc=expand(load(fixture(order))),saved=exportSourceFile(doc),back=importDocument({data:saved.data}).document;same(back,doc);
  const xml=new DOMParser().parseFromString(saved.data,'application/xml');expect(xml.querySelector('n[NodeType="Fragment"]')).toBeNull();expect(xml.querySelector('n[NodeType="ExternalConnectionPoint"]')).toBeNull();expect(xml.querySelector('n[Z="7"]')!.getAttribute('color')).toBe('4');
  expect(xml.querySelector('b[id="30"]')!.getAttribute('Order')).toBe(String(order));expect(xml.querySelector('b[id="30"]')!.getAttribute('LineWidth')).toBe('1.15');
  const restored=importDocument({data:exportDocument(doc,{format:'json'}).data}).document;expect(exportSourceFile(restored).data).toBe(saved.data);expect(engine.analyze(back).smiles).toBe(engine.analyze(doc).smiles);
 });
});
