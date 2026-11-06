import {describe,expect,it} from 'vitest';
import {applyDocumentEdits} from '../src/core/edits';
import {clone} from '../src/core/model';
import {createChemistryEngine,type ChemistryEngine} from '../src/chemistry/engine';
import initRDKit from '@rdkit/rdkit';
import {beforeAll} from 'vitest';
import {abbreviationXml,chiralAbbreviationXml} from './fixtures/abbreviation-fixture';
import {importDocument,exportDocument,exportSourceFile} from '../src/formats';
import {equivalentDocuments} from '../scripts/document-correspondence.mjs';
import {stereoProjection} from '../src/formats/stereo';
const raw='<CDXML LabelFont="3" LabelSize="10"><fonttable><font id="3" name="Arial" charset="utf-8"/></fonttable><page id="1"><fragment id="2"><n id="3" p="0 0"/><n id="4" p="30 0" Element="8" Z="7"><t p="30 0"><s font="3" size="11" color="4">O</s></t></n><n id="5" p="60 0"/><b id="6" B="3" E="4" BeginAttach="2" EndAttach="1"/><b id="7" B="4" E="5" Z="9" LineWidth="0.7"/></fragment></page></CDXML>';
const load=(input=raw)=>importDocument({data:input}).document;
const collapse=(doc:ReturnType<typeof load>,ids?:string[])=>applyDocumentEdits(doc,[{type:'collapse-substructure',atomIds:ids??Object.keys(doc.graph.atoms).slice(1),label:'OMe'}]).document;
const same=(actual:ReturnType<typeof load>,expected:ReturnType<typeof load>)=>expect(equivalentDocuments({documentProjection:stereoProjection},actual,expected)).toBe(true);
let engine:ChemistryEngine;beforeAll(async()=>{engine=createChemistryEngine(await initRDKit());});
describe('native CDXML preservation when contracting a selected subgraph',()=>{
  it('moves original atom/bond nodes into a fragment and preserves styles and boundary fields',()=>{
    const doc=collapse(load()),saved=exportSourceFile(doc),back=importDocument({data:saved.data}).document;same(back,doc);
    const xml=new DOMParser().parseFromString(saved.data,'application/xml'),nested=xml.querySelector('n[NodeType="Fragment"] fragment')!;
    expect(nested.querySelector('n[id="4"]')!.getAttribute('Z')).toBe('7');expect(nested.querySelector('n[id="4"] s')!.getAttribute('size')).toBe('11');expect(nested.querySelector('b[id="7"]')!.getAttribute('LineWidth')).toBe('0.7');
    const restored=importDocument({data:exportDocument(doc,{format:'json'}).data}).document;expect(exportSourceFile(restored).data).toBe(saved.data);
  });
  it('edits internal chemistry after contraction through a trusted local source baseline',()=>{
    const doc=collapse(load()),wrapper=Object.values(doc.graph.atoms).find(a=>a.substructure)!,group=clone(wrapper.substructure!),child=group.fragments[0].document,oxygen=Object.values(child.graph.atoms).find(a=>a.element==='O')!;
    group.fragments[0].document=applyDocumentEdits(child,[{type:'update-atom',atomId:oxygen.id,changes:{element:'S'}}]).document;
    const edited=applyDocumentEdits(doc,[{type:'set-substructure',atomId:wrapper.id,substructure:group}]).document,saved=exportSourceFile(edited),back=importDocument({data:saved.data}).document;same(back,edited);
    const xml=new DOMParser().parseFromString(saved.data,'application/xml');expect(xml.querySelector('n[id="4"]')!.getAttribute('Z')).toBe('7');expect(xml.querySelector('n[id="4"] s')!.textContent).toBe('S');expect(xml.querySelector('n[id="4"] s')!.getAttribute('size')).toBe('11');
  });
  it('supports a complete component without external ports',()=>{
    const original=load(),doc=collapse(original,Object.keys(original.graph.atoms));same(importDocument({data:exportSourceFile(doc).data}).document,doc);
  });
  it('reimports the collapsed source, edits the child and expands to the original identities',()=>{
    const original=load(),collapsed=collapse(original),expanded=applyDocumentEdits(collapsed,[{type:'expand-substructure',atomId:Object.values(collapsed.graph.atoms).find(a=>a.substructure)!.id}]).document;
    same(expanded,original);expect(Object.keys(expanded.graph.atoms).sort()).toEqual(Object.keys(original.graph.atoms).sort());same(importDocument({data:exportSourceFile(expanded).data}).document,expanded);
    const imported=importDocument({data:exportSourceFile(collapsed).data}).document,wrapper=Object.values(imported.graph.atoms).find(a=>a.substructure)!,group=clone(wrapper.substructure!),oxygen=Object.values(group.fragments[0].document.graph.atoms).find(a=>a.element==='O')!;group.fragments[0].document=applyDocumentEdits(group.fragments[0].document,[{type:'update-atom',atomId:oxygen.id,changes:{isotope:18}}]).document;
    const edited=applyDocumentEdits(imported,[{type:'set-substructure',atomId:wrapper.id,substructure:group}]).document;same(importDocument({data:exportSourceFile(edited).data}).document,edited);
  });
  it('adds an internal atom without creating parent/child native ID collisions',()=>{
    const doc=collapse(load()),wrapper=Object.values(doc.graph.atoms).find(a=>a.substructure)!,group=clone(wrapper.substructure!),child=group.fragments[0].document,carbon=Object.values(child.graph.atoms).find(a=>a.element==='C')!;
    group.fragments[0].document=applyDocumentEdits(child,[{type:'add-atom',ref:'$oxygen',element:'O',position:{x:4.5,y:0}},{type:'add-bond',atoms:[carbon.id,'$oxygen']}]).document;
    const edited=applyDocumentEdits(doc,[{type:'set-substructure',atomId:wrapper.id,substructure:group}]).document,saved=exportSourceFile(edited),back=importDocument({data:saved.data}).document;same(back,edited);
    const xml=new DOMParser().parseFromString(saved.data,'application/xml'),ids=[...xml.getElementsByTagName('*')].filter(el=>el.hasAttribute('id')&&!['font','color'].includes(el.localName)).map(el=>el.getAttribute('id'));expect(new Set(ids).size).toBe(ids.length);expect(xml.querySelector('n[id="4"]')!.getAttribute('Z')).toBe('7');
  });
  it('refuses a selection spanning two native source fragments and protects private references',()=>{
    const split=load(raw.replace('</page>','<fragment id="500"><n id="501" p="90 0"/></fragment></page>')),ids=Object.keys(split.graph.atoms),connected=applyDocumentEdits(split,[{type:'add-bond',atoms:[ids[2],ids[3]]}]).document,collapsed=collapse(connected,ids),snapshot=clone(collapsed);expect(()=>exportSourceFile(collapsed)).toThrow('同一个明确来源片段');expect(collapsed).toEqual(snapshot);
    const privateDoc=collapse(load(raw.replace('</page>','<bioshape id="1000" BioShapeType="DNA" PrivateObjectID="4" DNAWaveHeight="23.68" xyz="0 50 0"/></page>'))),before=clone(privateDoc);expect(()=>exportSourceFile(privateDoc)).toThrow('引用类型未知');expect(privateDoc).toEqual(before);
  });
  it('rewrites reaction participants and polymer member/crossing references during native contraction',()=>{
    const scene=raw.replace('</page>','<bracketedgroup id="1000" BracketUsage="SRU" BracketedObjectIDs="4 5"><bracketattachment id="1001"><crossingbond id="1002" BondID="6" InnerAtomID="4"/></bracketattachment></bracketedgroup><scheme id="1003"><step id="1004" ReactionStepReactants="2"/></scheme></page>'),doc=collapse(load(scene)),saved=exportSourceFile(doc);same(importDocument({data:saved.data}).document,doc);
    const xml=new DOMParser().parseFromString(saved.data,'application/xml'),wrapper=xml.querySelector('n[NodeType="Fragment"]')!;expect(xml.querySelector('bracketedgroup')!.getAttribute('BracketedObjectIDs')).toBe(wrapper.getAttribute('id'));expect(xml.querySelector('crossingbond')!.getAttribute('InnerAtomID')).toBe(wrapper.getAttribute('id'));
  });
  it('refuses to duplicate native objects owned by a cut boundary bond',()=>{
    const doc=collapse(load(raw.replace('BeginAttach="2" EndAttach="1"/>','BeginAttach="2" EndAttach="1"><objecttag id="1000" Value="boundary"/></b>'))),before=clone(doc);expect(()=>exportSourceFile(doc)).toThrow('边界键附有独立原生对象');expect(doc).toEqual(before);
  });
  it('source-saves two nested contractions without recreating the original styled atoms',()=>{
    const first=collapse(load()),second=collapse(first,Object.keys(first.graph.atoms)),saved=exportSourceFile(second);same(importDocument({data:saved.data}).document,second);
    const xml=new DOMParser().parseFromString(saved.data,'application/xml');expect(xml.querySelectorAll('n[NodeType="Fragment"]')).toHaveLength(2);expect(xml.querySelector('n[id="4"] s')!.getAttribute('size')).toBe('11');
    const restored=importDocument({data:exportDocument(second,{format:'json'}).data}).document;expect(exportSourceFile(restored).data).toBe(saved.data);
  });
  it('preserves native styles when an original abbreviation is expanded and contracted with a new name',()=>{
    const original=load(abbreviationXml.replace('NumHydrogens="0" Z="2"/>','NumHydrogens="0" Z="2"><t><s font="3" size="11">O</s></t></n>')),wrapper=Object.values(original.graph.atoms).find(a=>a.substructure)!,group=wrapper.substructure!,ports=new Set(group.connections.map(p=>p.atomId)),selected=Object.keys(group.fragments[0].document.graph.atoms).filter(id=>!ports.has(id)),expanded=applyDocumentEdits(original,[{type:'expand-substructure',atomId:wrapper.id}]).document,doc=applyDocumentEdits(expanded,[{type:'collapse-substructure',atomIds:selected,label:'Renamed'}]).document,saved=exportSourceFile(doc);same(importDocument({data:saved.data}).document,doc);
    const xml=new DOMParser().parseFromString(saved.data,'application/xml');expect(xml.querySelector('n[Z="2"] s')?.getAttribute('size')).toBe('11');expect(xml.querySelector('n[NodeType="Fragment"] > t s')!.textContent).toBe('Renamed');
    const restored=importDocument({data:exportDocument(doc,{format:'json'}).data}).document;expect(exportSourceFile(restored).data).toBe(saved.data);
  });
  it('moves a retained original abbreviation inside a new wrapper without treating it as expanded',()=>{
    const original=load(abbreviationXml),doc=collapse(original,Object.keys(original.graph.atoms)),saved=exportSourceFile(doc);same(importDocument({data:saved.data}).document,doc);
    const xml=new DOMParser().parseFromString(saved.data,'application/xml');expect(xml.querySelectorAll('n[NodeType="Fragment"]')).toHaveLength(2);expect(xml.querySelector('n[id="20"] n[id="101"]')!.getAttribute('Z')).toBe('2');
  });
  it('refuses ambiguous repeated child identities while recovering an expanded source',()=>{
    const original=load(abbreviationXml),wrapper=Object.values(original.graph.atoms).find(a=>a.substructure)!,group=wrapper.substructure!,ports=new Set(group.connections.map(p=>p.atomId)),selected=Object.keys(group.fragments[0].document.graph.atoms).filter(id=>!ports.has(id)),expanded=applyDocumentEdits(original,[{type:'expand-substructure',atomId:wrapper.id}]).document,doc=collapse(expanded,selected),nested=Object.values(doc.graph.atoms).find(a=>a.substructure)!;
    doc.graph.atoms.duplicate={...clone(nested),id:'duplicate'};doc.graph.atoms.duplicate.substructure!.connections=[];doc.depiction.positions.duplicate={x:10,y:10};const before=clone(doc);expect(()=>exportSourceFile(doc)).toThrow('歧义重复局部 ID');expect(doc).toEqual(before);
  });
  it('preserves an internal tetrahedral ordering and boundary wedge in the native contracted source',()=>{
    const collapsedOriginal=load(chiralAbbreviationXml),wrapper=Object.values(collapsedOriginal.graph.atoms).find(a=>a.substructure)!,flat=applyDocumentEdits(collapsedOriginal,[{type:'expand-substructure',atomId:wrapper.id}]).document;delete flat.source;
    const original=load(exportDocument(flat,{format:'cdxml'}).data),center=Object.values(original.graph.atoms).find(a=>a.geometry)!,selected=Object.values(original.graph.atoms).filter(a=>a.id===center.id||a.element!=='C').map(a=>a.id),doc=collapse(original,selected),saved=exportSourceFile(doc),back=importDocument({data:saved.data}).document;same(back,doc);
    const expanded=applyDocumentEdits(back,[{type:'expand-substructure',atomId:Object.values(back.graph.atoms).find(a=>a.substructure)!.id}]).document;expect(engine.analyze(expanded).smiles).toBe(engine.analyze(original).smiles);
  });
  it('clears stale atom and bond CIP caches against the actual moved native baseline',()=>{
    const nested=load(chiralAbbreviationXml),flat=applyDocumentEdits(nested,[{type:'expand-substructure',atomId:Object.values(nested.graph.atoms).find(a=>a.substructure)!.id}]).document;delete flat.source;
    const tetra=exportDocument(flat,{format:'cdxml'}).data.replace('Geometry="Tetrahedral"','AS="R" Geometry="Tetrahedral"'),alkene='<CDXML><page id="1"><fragment id="2"><n id="3" p="0 0"/><n id="4" p="30 0" Z="7"/><n id="5" p="60 0"/><n id="8" p="90 0"/><b id="6" B="3" E="4"/><b id="7" B="4" E="5" Order="2" BS="E"/><b id="9" B="5" E="8"/></fragment></page></CDXML>';
    for(const input of [tetra,alkene]){
      const original=load(input),doc=collapse(original,Object.keys(original.graph.atoms)),saved=exportSourceFile(doc);same(importDocument({data:saved.data}).document,doc);
      const xml=new DOMParser().parseFromString(saved.data,'application/xml');expect(xml.querySelector('[AS],[BS]')).toBeNull();
      const restored=importDocument({data:exportDocument(doc,{format:'json'}).data}).document;expect(exportSourceFile(restored).data).toBe(saved.data);
    }
  });
});
