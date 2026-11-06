import {describe,expect,it} from 'vitest';
import {addAtom,addBond,clone,emptyDocument} from '../src/core/model';
import type {AtomQueryConstraints,ChemicalDocument} from '../src/core/types';
import {applyDocumentEdits} from '../src/core/edits';
import {importDocument,exportDocument,exportSourceFile} from '../src/formats';
import {decodeCdx,parseCdxTree} from '../src/formats/cdx';
import {stereoProjection} from '../src/formats/stereo';
import {writeMol} from '../src/formats/mol';
import {writeMrv} from '../src/formats/xml';
import {abbreviationXml} from './fixtures/abbreviation-fixture';

const all:AtomQueryConstraints={substituentsExactly:0,substituentsUpTo:255,ringBondCount:'AsDrawn',unsaturatedBonds:'MustBePresent',reactionChange:true,reactionStereo:'Retention'};
const plain='<CDXML><page id="1"><fragment id="2"><n id="3" p="0 0"/><n id="4" Element="8" p="30 0"><t><s font="3" size="11" face="2">O</s></t></n><b id="5" B="3" E="4"/></fragment></page></CDXML>';
const load=(raw=plain)=>importDocument({data:raw}).document;
const same=(a:ChemicalDocument,b:ChemicalDocument)=>expect(JSON.parse(JSON.stringify(stereoProjection(a)))).toEqual(JSON.parse(JSON.stringify(stereoProjection(b))));
function seed(constraints:AtomQueryConstraints=all,topology:NonNullable<import('../src/core/types').Bond['topology']>='Ring'){
 const doc=emptyDocument('query constraints'),a=addAtom(doc,'C',{x:0,y:0},{queryConstraints:clone(constraints)}),b=addAtom(doc,'O',{x:1.5,y:0}),edge=addBond(doc,a,b);doc.graph.bonds[edge].topology=topology;return {doc,a,b,edge};
}
const uint=(n:number,width=2)=>Array.from({length:width},(_,i)=>(n>>>(i*8))&255);
const property=(tag:number,value:number[])=>[...uint(tag),...uint(value.length),...value];
const object=(tag:number,id:number,children:number[])=>[...uint(tag),...uint(id,4),...children,0,0];
const node=(id:number,properties:number[]=[])=>object(0x8004,id,[...property(0x0200,[...uint(0,4),...uint(id*30*65536,4)]),...properties]);
const cdx=(atomProps:number[]=[],bondProps:number[]=[])=>new Uint8Array([...new TextEncoder().encode('VjCD0100'),4,3,2,1,...Array(16).fill(0),...object(0x8001,1,object(0x8003,2,[...node(3,atomProps),...node(4),...object(0x8005,5,[...property(0x0604,uint(3,4)),...property(0x0605,uint(4,4)),...bondProps])])),0,0]);
const nativeObjects=(raw:string)=>{const tree=parseCdxTree(decodeCdx(raw)),rows:typeof tree[]=[];const visit=(o:typeof tree)=>{rows.push(o);o.children.forEach(visit);};visit(tree);return rows;};

describe('advanced query restrictions in ChemDraw formats',()=>{
 it.each(['cdxml','cdx'] as const)('round-trips a specific element with independent restrictions through %s',format=>{
  const {doc}=seed(),result=importDocument({data:exportDocument(doc,{format}).data}).document;same(result,doc);const carbon=Object.values(result.graph.atoms)[0];expect(carbon.element).toBe('C');expect(carbon.query).toBeUndefined();expect(carbon.queryConstraints).toEqual(all);
 });
 it.each(['Unspecified','NoRingBonds','AsDrawn','SimpleRing','Fusion','SpiroOrHigher'] as const)('preserves the RingBondCount %s enumeration, including explicit defaults',value=>{
  const {doc}=seed({ringBondCount:value});for(const format of ['cdxml','cdx'] as const)same(importDocument({data:exportDocument(doc,{format}).data}).document,doc);
 });
 it.each(['Unspecified','MustBeAbsent','MustBePresent'] as const)('round-trips UnsaturatedBonds=%s',value=>{
  const {doc}=seed({unsaturatedBonds:value});for(const format of ['cdxml','cdx'] as const)same(importDocument({data:exportDocument(doc,{format}).data}).document,doc);
 });
 it.each(['Unspecified','Inversion','Retention'] as const)('round-trips reaction stereo %s',value=>{
  const {doc}=seed({reactionStereo:value});for(const format of ['cdxml','cdx'] as const)same(importDocument({data:exportDocument(doc,{format}).data}).document,doc);
 });
 it.each(['Unspecified','Ring','Chain','RingOrChain'] as const)('round-trips bond topology %s',value=>{
  const {doc}=seed({substituentsExactly:255,substituentsUpTo:0},value);for(const format of ['cdxml','cdx'] as const)same(importDocument({data:exportDocument(doc,{format}).data}).document,doc);
 });
 it('decodes independently constructed CDX fields using native widths and signed sentinels',()=>{
  const doc=importDocument({data:cdx([...property(0x0425,[255]),...property(0x0426,[1]),...property(0x0427,[]),...property(0x0428,[2]),...property(0x0435,[0]),...property(0x0436,[255])],property(0x0606,[3]))}).document;
  expect(Object.values(doc.graph.atoms)[0].queryConstraints).toEqual({ringBondCount:'Unspecified',unsaturatedBonds:'MustBeAbsent',reactionChange:true,reactionStereo:'Retention',substituentsUpTo:0,substituentsExactly:255});expect(Object.values(doc.graph.bonds)[0].topology).toBe('RingOrChain');
 });
 it('writes the documented query bytes without swapping zero with unspecified',()=>{
  const {doc}=seed({ringBondCount:'Unspecified',reactionChange:true,substituentsExactly:0,substituentsUpTo:255},'Chain'),objects=nativeObjects(exportDocument(doc,{format:'cdx'}).data),node=objects.find(o=>o.tag===0x8004)!,bond=objects.find(o=>o.tag===0x8005)!;
  expect([...node.props.get(0x0425)!]).toEqual([255]);expect(node.props.get(0x0427)!.length).toBe(0);expect([...node.props.get(0x0436)!]).toEqual([0]);expect([...node.props.get(0x0435)!]).toEqual([255]);expect([...bond.props.get(0x0606)!]).toEqual([2]);
 });
 it('maps every CDX query field into CDXML during exact source conversion',()=>{
  const {doc}=seed(),source=importDocument({data:exportDocument(doc,{format:'cdx'}).data}).document,converted=exportDocument(source,{format:'cdxml'});expect(converted.preservation).toBe('converted');same(importDocument({data:converted.data}).document,source);expect(converted.data).toContain('RxnChange="yes"');expect(converted.data).toContain('Topology="Ring"');
 });
 it.each(['cdxml','cdx'] as const)('adds, edits and removes all restrictions in %s source without losing labels',format=>{
  const source=format==='cdxml'?load():importDocument({data:exportDocument(load(),{format:'cdx',allowLossy:true}).data}).document,oxygen=Object.values(source.graph.atoms).find(a=>a.element==='O')!,edge=Object.values(source.graph.bonds)[0];
  const added=applyDocumentEdits(source,[{type:'update-atom',atomId:oxygen.id,changes:{queryConstraints:clone(all)}},{type:'update-bond',bondId:edge.id,topology:'RingOrChain'}]).document,output=exportSourceFile(added);same(importDocument({data:output.data}).document,added);
  if(format==='cdxml')expect(new DOMParser().parseFromString(output.data,'application/xml').querySelector('n[id="4"] t')!.outerHTML).toBe(new DOMParser().parseFromString(plain,'application/xml').querySelector('n[id="4"] t')!.outerHTML);
  else{const find=(raw:string)=>nativeObjects(raw).filter(o=>o.tag===0x8006).map(o=>[...o.props.get(0x0700)!]);expect(find(output.data)).toEqual(find(source.source!.raw));}
  const loaded=importDocument({data:output.data}).document,id=Object.values(loaded.graph.atoms).find(a=>a.element==='O')!.id,bond=Object.keys(loaded.graph.bonds)[0],edited=applyDocumentEdits(loaded,[{type:'update-atom',atomId:id,changes:{queryConstraints:{substituentsExactly:7,ringBondCount:'Fusion',reactionStereo:'Inversion'}}},{type:'update-bond',bondId:bond,topology:'Chain'}]).document;
  const native=importDocument({data:exportDocument(edited,{format:'json'}).data}).document;same(importDocument({data:exportSourceFile(native).data}).document,edited);
  const cleared=applyDocumentEdits(native,[{type:'update-atom',atomId:id,changes:{queryConstraints:null}},{type:'update-bond',bondId:bond,topology:null}]).document,clearOutput=exportSourceFile(cleared);same(importDocument({data:clearOutput.data}).document,cleared);
  if(format==='cdxml'){expect(clearOutput.data).not.toContain('SubstituentsExactly=');expect(clearOutput.data).not.toContain('Topology=');expect(clearOutput.data).not.toContain('RxnChange=');}
  else{const objects=nativeObjects(clearOutput.data);for(const object of objects)for(const tag of [0x0425,0x0426,0x0427,0x0428,0x0435,0x0436,0x0606])expect(object.props.has(tag)).toBe(false);}
 });
 it('supports adding constrained atoms and a topology bond to an existing native source',()=>{
  for(const format of ['cdxml','cdx'] as const){const original=format==='cdxml'?load():importDocument({data:exportDocument(load(),{format:'cdx',allowLossy:true}).data}).document,anchor=Object.keys(original.graph.atoms)[0],edited=applyDocumentEdits(original,[{type:'add-atom',element:'N',ref:'$q',position:{x:-1.5,y:0},properties:{queryConstraints:{substituentsUpTo:3}}},{type:'add-bond',atoms:[anchor,'$q'],topology:'Chain'}]).document;same(importDocument({data:exportSourceFile(edited).data}).document,edited);}
 });
 it.each(['cdxml','cdx'] as const)('can add restrictions and an isotope together to a bare element label in %s',format=>{
  const source=format==='cdxml'?load():importDocument({data:exportDocument(load(),{format:'cdx',allowLossy:true}).data}).document,oxygen=Object.values(source.graph.atoms).find(a=>a.element==='O')!,edge=Object.keys(source.graph.bonds)[0];
  const changed=applyDocumentEdits(source,[{type:'update-atom',atomId:oxygen.id,changes:{queryConstraints:{substituentsExactly:2},isotope:18}},{type:'update-bond',bondId:edge,topology:'Chain'}]).document;
  same(importDocument({data:exportSourceFile(changed).data}).document,changed);expect(changed.graph.atoms[oxygen.id].isotope).toBe(18);
 });
 it('retains a source hydrogen label for restriction-only edits and refuses to guess H during later chemistry edits',()=>{
  const source=load(plain.replace('>O</s>','>HO</s>')),oxygen=Object.values(source.graph.atoms).find(a=>a.element==='O')!,changed=applyDocumentEdits(source,[{type:'update-atom',atomId:oxygen.id,changes:{queryConstraints:{substituentsUpTo:3}}}]).document;
  expect(exportSourceFile(changed).data).toContain('>HO</s>');const isotope=applyDocumentEdits(changed,[{type:'update-atom',atomId:oxygen.id,changes:{isotope:18}}]).document,before=clone(isotope);expect(()=>exportSourceFile(isotope)).toThrow('氢数尚不能确定');expect(isotope).toEqual(before);
 });
 it('retains wrapper restrictions and nested atom restrictions without flattening their scopes',()=>{
  const raw=abbreviationXml.replace('NodeType="Fragment"','NodeType="Fragment" RingBondCount="AsDrawn"').replace('Element="8"','Element="8" SubstituentsExactly="2"'),doc=load(raw),wrapper=Object.values(doc.graph.atoms).find(a=>a.substructure)!;
  expect(wrapper.queryConstraints).toEqual({ringBondCount:'AsDrawn'});expect(Object.values(wrapper.substructure!.fragments[0].document.graph.atoms).find(a=>a.element==='O')!.queryConstraints).toEqual({substituentsExactly:2});
  const edited=applyDocumentEdits(doc,[{type:'update-atom',atomId:wrapper.id,changes:{queryConstraints:{reactionChange:true}}}]).document;same(importDocument({data:exportSourceFile(edited).data}).document,edited);delete edited.source;same(importDocument({data:exportDocument(edited,{format:'cdxml'}).data}).document,edited);
 });
 it('normalizes RxnChange=no only, while retaining explicit neutral enum values',()=>{
  const doc=load(plain.replace('<n id="3"','<n RxnChange="no" RingBondCount="Unspecified" UnsaturatedBonds="Unspecified" RxnStereo="Unspecified" id="3"'));
  expect(Object.values(doc.graph.atoms)[0].queryConstraints).toEqual({ringBondCount:'Unspecified',unsaturatedBonds:'Unspecified',reactionStereo:'Unspecified'});same(importDocument({data:exportDocument({...doc,source:undefined},{format:'cdxml'}).data}).document,doc);
 });
 it.each(['SubstituentsExactly="-1"','SubstituentsExactly="256"','SubstituentsUpTo="1.5"','RingBondCount="1"','UnsaturatedBonds="yes"','RxnStereo="3"','RxnChange="1"','Unsaturated="yes"'])('rejects invalid XML atom condition %s',attribute=>{expect(()=>load(plain.replace('<n id="3"',`<n ${attribute} id="3"`))).toThrow();});
 it.each([[0x0425,[254]],[0x0425,[0,0]],[0x0426,[3]],[0x0427,[0]],[0x0428,[3]],[0x0435,[]],[0x0436,[0,0]]] as [number,number[]][])('rejects malformed binary query field %i', (tag,bytes)=>{expect(()=>importDocument({data:cdx(property(tag,bytes))})).toThrow();});
 it.each([4,255])('rejects undefined bond topology %i',value=>{expect(()=>importDocument({data:cdx([],property(0x0606,[value]))})).toThrow();});
 it('rejects invalid XML topology and does not repair contradictory but valid query counts',()=>{
  expect(()=>load(plain.replace('<b id="5"','<b Topology="Aromatic" id="5"'))).toThrow();const doc=load(plain.replace('<n id="3"','<n SubstituentsExactly="7" SubstituentsUpTo="1" id="3"'));expect(Object.values(doc.graph.atoms)[0].queryConstraints).toEqual({substituentsExactly:7,substituentsUpTo:1});
 });
 it.each(['mol','mol-v3000','mrv','rxn','rxn-v3000'] as const)('refuses query loss in %s even when lossy drawing output is allowed',format=>{
  for(const mode of ['atom','bond']){const {doc,a,edge}=seed();if(mode==='atom')delete doc.graph.bonds[edge].topology;else delete doc.graph.atoms[a].queryConstraints;doc.graph.reactions={r:{id:'r',schemeId:'s',reactants:[{kind:'molecule',atomIds:Object.keys(doc.graph.atoms)}],products:[],arrows:[],above:[],below:[],pluses:[]}};expect(()=>exportDocument(doc,{format,allowLossy:true})).toThrow(/查询|query/i);}
 });
 it('also protects the direct internal MOL and MRV writers',()=>{const {doc}=seed();expect(()=>writeMol(doc,'mol')).toThrow(/查询/);expect(()=>writeMrv(doc)).toThrow(/查询/);});
});
