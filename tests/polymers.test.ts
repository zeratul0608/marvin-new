import {afterEach,describe,expect,it} from 'vitest';
import {polymerXml,polymerCdx} from './fixtures/polymer-fixture';
import {exportDocument,exportSourceFile,importDocument} from '../src/formats';
import {decodeCdx,parseCdxTree} from '../src/formats/cdx';
import {getPolymerGroup,polymerMembers} from '../src/core/polymers';
import {applyDocumentEdits} from '../src/core/edits';
import {clone,molecularFormula,validateDocument} from '../src/core/model';
import {stereoProjection} from '../src/formats/stereo';
import {createChemicalEditor} from '../src/editor/chemical-editor';
import {exportSvg} from '../src/editor/render';
const load=(format:'cdx'|'cdxml')=>importDocument({data:format==='cdx'?polymerCdx():polymerXml}).document;
const groupId=(doc:ReturnType<typeof load>)=>Object.values(doc.depiction.objects!).find(o=>o.tag==='bracketedgroup')!.id;
afterEach(()=>{document.body.replaceChildren();localStorage.clear();});
describe.each(['cdx','cdxml']as const)('%s polymer chemistry',format=>{
  it('parses typed members, boundary atom identities, usage and correct default connectivity',()=>{
    const doc=load(format),group=getPolymerGroup(doc,groupId(doc));expect(group.atomIds).toEqual(Object.keys(doc.graph.atoms).slice(1,3));expect(group.crossings).toHaveLength(2);expect(group.repeatPattern).toBe('HeadToTail');
    expect(group.crossings.map(c=>c.innerAtomId)).toEqual(group.atomIds);expect(group.usage).toBe(format==='cdx'?'MultipleGroup':'SRU');if(format==='cdx')expect(group.repeatCount).toBe(3.5);
    expect(validateDocument(doc)).toEqual([]);expect(molecularFormula(doc)).toContain('非整体分子式');
  });
  it('saves changed chemical type, fractional FLOAT64 count, connectivity and SRU label',()=>{
    const original=load(format),id=groupId(original),before=clone(original),doc=applyDocumentEdits(original,[{type:'update-polymer',objectId:id,changes:{usage:'MultipleGroup',repeatCount:7.25,repeatPattern:'HeadToHead',flipType:'Flip',componentOrder:4,label:'m'}}]).document;
    const saved=exportSourceFile(doc),back=importDocument({data:saved.data}).document;
    expect(getPolymerGroup(back,groupId(back))).toMatchObject({usage:'MultipleGroup',repeatCount:7.25,repeatPattern:'HeadToHead',flipType:'Flip',componentOrder:4,label:'m'});expect(stereoProjection(back)).toEqual(stereoProjection(doc));expect(original).toEqual(before);
    if(format==='cdx'){const scan=(o:ReturnType<typeof parseCdxTree>):typeof o|undefined=>o.tag===0x8017?o:o.children.map(scan).find(Boolean),group=scan(parseCdxTree(decodeCdx(saved.data)))!,bytes=group.props.get(0x0a28)!;expect(bytes).toHaveLength(8);expect(new DataView(bytes.buffer,bytes.byteOffset,8).getFloat64(0,true)).toBe(7.25);}
  });
  it('updates members and crossing bindings atomically, then saves exact references',()=>{
    const doc=load(format),id=groupId(doc),group=getPolymerGroup(doc,id),atoms=Object.keys(doc.graph.atoms),bonds=Object.keys(doc.graph.bonds);
    const edited=applyDocumentEdits(doc,[{type:'update-polymer',objectId:id,changes:{atomIds:atoms.slice(2)}},{type:'update-polymer-crossing',objectId:group.crossings[0].id,bondId:bonds[1],innerAtomId:atoms[2]},{type:'remove-drawing',objectId:group.crossings[1].id}]).document;
    const back=importDocument({data:exportSourceFile(edited).data}).document;expect(stereoProjection(back)).toEqual(stereoProjection(edited));expect(getPolymerGroup(back,groupId(back)).atomIds).toEqual(Object.keys(back.graph.atoms).slice(2));
  });
  it('rejects an exterior inner-atom or a non-crossing bond without touching the input',()=>{
    const doc=load(format),before=clone(doc),crossing=getPolymerGroup(doc,groupId(doc)).crossings[0];
    expect(()=>applyDocumentEdits(doc,[{type:'update-polymer-crossing',objectId:crossing.id,bondId:Object.keys(doc.graph.bonds)[1],innerAtomId:Object.keys(doc.graph.atoms)[1]}])).toThrow('跨括号键');
    expect(()=>applyDocumentEdits(doc,[{type:'update-polymer',objectId:groupId(doc),changes:{repeatCount:0}}])).toThrow('正数');expect(doc).toEqual(before);
  });
  it('prunes removed atom membership and boundary records and saves remaining chemistry',()=>{
    const doc=load(format),atom=Object.keys(doc.graph.atoms)[1],edited=applyDocumentEdits(doc,[{type:'remove-atom',atomId:atom}]).document;
    expect(polymerMembers(edited,groupId(edited))).not.toContain(atom);expect(getPolymerGroup(edited,groupId(edited)).crossings).toHaveLength(1);
    const back=importDocument({data:exportSourceFile(edited).data}).document;expect(stereoProjection(back)).toEqual(stereoProjection(edited));
  });
  it('edits through the visible inspector with undo and redo',()=>{
    const doc=load(format),editor=createChemicalEditor({container:document.body,document:doc});try{
      const id=groupId(doc);editor.setSelection({atomIds:[],objectId:id});editor.showAdvancedEditor('document');const root=editor.shadowRoot!,input=root.querySelector<HTMLInputElement>('[data-polymer-field="label"]')!;input.value='repeat';input.dispatchEvent(new Event('change',{bubbles:true}));
      expect(getPolymerGroup(editor.getDocument(),id).label).toBe('repeat');editor.undo();expect(editor.getDocument()).toEqual(doc);editor.redo();expect(getPolymerGroup(editor.getDocument(),id).label).toBe('repeat');
    }finally{editor.destroy();}
  });
});
describe('polymer format and topology boundaries',()=>{
  it('converts all mapped binary bracket records to CDXML without hiding native bytes',()=>{
    const doc=load('cdx'),output=exportDocument(doc,{format:'cdxml'});expect(output.issues).toEqual([]);expect(output.data).toContain('<crossingbond');expect(output.data).toContain('RepeatCount="3.5"');expect(output.data).not.toContain('CDXProperty');expect(stereoProjection(importDocument({data:output.data}).document)).toEqual(stereoProjection(doc));
  });
  it('keeps nested unit membership and refuses cycles, missing bond targets or misplaced crossing records',()=>{
    const doc=load('cdxml'),id=groupId(doc),group=doc.depiction.objects![id];group.references.BracketedObjectIDs=[{kind:'drawing',id}];expect(()=>validateDocument(doc)).toThrow('循环');
    expect(()=>importDocument({data:polymerXml.replace('BondID="7"','BondID="999"')})).toThrow('引用');
    expect(()=>importDocument({data:polymerXml.replace('InnerAtomID="4"','InnerAtomID="3"')})).toThrow('跨括号键');
  });
  it('rebuilds full polymer semantics into a fresh CDXML document',()=>{
    const doc=load('cdxml');delete doc.source;const output=exportDocument(doc,{format:'cdxml'}),back=importDocument({data:output.data}).document;expect(stereoProjection(back)).toEqual(stereoProjection(doc));
    expect(exportSvg(doc)).toContain('data-bracket-type="Square"');expect(exportSvg(doc)).toContain('data-polymer-label=');
  });
  it('defaults an omitted MultipleGroup count to 2 and validates typed changes without coercion',()=>{
    const doc=load('cdxml'),id=groupId(doc),changed=applyDocumentEdits(doc,[{type:'update-polymer',objectId:id,changes:{usage:'MultipleGroup',repeatCount:null}}]).document;
    expect(getPolymerGroup(changed,id).repeatCount).toBe(2);
    for(const changes of [{repeatCount:Infinity},{repeatCount:'5'},{componentOrder:32768},{usage:'unknown'},{label:'x'.repeat(257)},{atomIds:[]}])expect(()=>applyDocumentEdits(doc,[{type:'update-polymer',objectId:id,changes:changes as never}])).toThrow();
  });
  it.each(['cdx','cdxml']as const)('adds a new member using batch references and saves it in %s',format=>{
    const doc=load(format),id=groupId(doc),members=polymerMembers(doc,id),edited=applyDocumentEdits(doc,[{type:'add-atom',ref:'$branch',element:'O',position:{x:1.5,y:1}},{type:'add-bond',atoms:[members[0],'$branch']},{type:'update-polymer',objectId:id,changes:{atomIds:[...members,'$branch']}}]).document;
    expect(getPolymerGroup(edited,id).atomIds).toHaveLength(3);const back=importDocument({data:exportSourceFile(edited).data}).document;expect(stereoProjection(back)).toEqual(stereoProjection(edited));
  });
  it('updates nested group membership after an internal member is removed',()=>{
    const nested=polymerXml.replace('<bracketedgroup id="12"','<bracketedgroup id="17" BracketUsage="Copolymer" BracketedObjectIDs="12"><bracketedgroup id="12"').replace('</bracketedgroup>','</bracketedgroup></bracketedgroup>');
    const doc=importDocument({data:nested}).document,outer=groupId(doc),removed=Object.keys(doc.graph.atoms)[1],edited=applyDocumentEdits(doc,[{type:'remove-atom',atomId:removed}]).document;
    expect(getPolymerGroup(edited,outer).atomIds).toEqual([Object.keys(doc.graph.atoms)[2]]);const back=importDocument({data:exportSourceFile(edited).data}).document;expect(stereoProjection(back)).toEqual(stereoProjection(edited));
  });
  it('renders oriented square brackets and horizontal braces rather than zero-height outlines',()=>{
    const doc=load('cdxml'),xml=new DOMParser().parseFromString(exportSvg(doc),'image/svg+xml'),brackets=[...xml.querySelectorAll('[data-bracket-type]')];
    expect(brackets[0].getAttribute('d')).toContain('M0.97 1');expect(brackets[1].getAttribute('d')).toContain('M3.53 -1');
    const graphic=Object.values(doc.depiction.objects!).find(o=>o.tag==='graphic')!;graphic.geometry.BoundingBox=[100,20,0,20];graphic.attributes.BracketType='Curly';
    const svg=new DOMParser().parseFromString(exportSvg(doc),'image/svg+xml'),curve=svg.querySelector('[data-bracket-type="Curly"]')!.getAttribute('d')!;expect(curve).toContain('3.75 1');expect(curve).toContain('1.25 1');expect(curve).toContain('2.5 1.22');
  });
});
