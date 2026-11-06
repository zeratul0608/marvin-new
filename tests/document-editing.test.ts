import {describe,expect,it} from 'vitest';
import {importDocument,exportDocument,exportSourceFile} from '../src/formats';
import {applyDocumentEdits} from '../src/core/edits';
import {DocumentStore} from '../src/core/store';
import {addAtom,addBond,emptyDocument,validateDocument} from '../src/core/model';
import {stereoProjection} from '../src/formats/stereo';
import {exportSvg} from '../src/editor/render';
import {createChemicalEditor} from '../src/editor/chemical-editor';

const raw=`<CDXML CaptionFont="3" CaptionSize="10"><fonttable><font id="3" name="Arial" charset="utf-8"/></fonttable><page id="1"><group id="2"><fragment id="3"><n id="4" p="0 0"/><n id="5" p="30 0" Element="8"/><b id="6" B="4" E="5"/><t id="7" p="0 40" LineStarts="1"><s font="3" size="10">heat</s></t></fragment></group><fragment id="8"><n id="9" p="120 0" Element="7"/></fragment><arrow id="10" Head3D="100 0 0" Tail3D="60 0 0" ArrowheadHead="Full"/><scheme id="11"><step id="12" ReactionStepReactants="3" ReactionStepProducts="8" ReactionStepArrows="10" ReactionStepObjectsAboveArrow="7" ReactionStepAtomMap="4 9"/></scheme></page></CDXML>`;
const load=()=>importDocument({data:raw}).document;
const saved=(doc:ReturnType<typeof load>)=>importDocument({data:exportSourceFile(doc).data}).document;

describe('editable documents and reaction roles',()=>{
  it('parses reactions, atom mappings, text runs, nested grouping and native coordinates',()=>{
    const doc=load(),step=Object.values(doc.graph.reactions!)[0];expect(step.reactants[0]).toMatchObject({kind:'molecule',atomIds:Object.keys(doc.graph.atoms).slice(0,2)});expect(step.atomMappings?.[0].atoms).toHaveLength(1);
    expect(Object.values(doc.depiction.objects!).find(o=>o.tag==='t')?.runs?.[0].text).toBe('heat');expect(validateDocument(doc)).toEqual([]);
  });
  it('keeps captions inside their original chemical fragment while editing atoms',()=>{
    const doc=load(),atom=Object.values(doc.graph.atoms)[0],edited=applyDocumentEdits(doc,[{type:'update-atom',atomId:atom.id,changes:{isotope:13}}]).document;
    const output=exportSourceFile(edited).data;const xml=new DOMParser().parseFromString(output,'application/xml');expect(xml.querySelector('t[id="7"]')?.parentElement?.getAttribute('id')).toBe('3');
    expect(stereoProjection(saved(edited))).toEqual(stereoProjection(edited));
  });
  it('edits condition text and vector geometry with undo/redo and exact references',()=>{
    const doc=load(),text=Object.values(doc.depiction.objects!).find(o=>o.tag==='t')!,arrow=Object.values(doc.depiction.objects!).find(o=>o.tag==='arrow')!;
    const store=new DocumentStore(doc);store.replace(applyDocumentEdits(doc,[{type:'move-drawing',objectId:arrow.id,delta:{x:1,y:2}},{type:'update-drawing',objectId:text.id,changes:{runs:[{...text.runs![0],text:'80 °C'}]}}]).document);
    expect(stereoProjection(saved(store.document))).toEqual(stereoProjection(store.document));expect(store.document.depiction.objects![arrow.id].geometry.Head3D).toEqual([120,-40,0]);store.undo();expect(store.document).toEqual(doc);store.redo();expect(store.document.depiction.objects![text.id].runs![0].text).toBe('80 °C');
  });
  it('moves chemical groups with their drawing children without changing reaction membership',()=>{
    const doc=load(),group=Object.values(doc.depiction.objects!).find(o=>o.tag==='group')!;
    const moved=applyDocumentEdits(doc,[{type:'move-drawing',objectId:group.id,delta:{x:2,y:3}}]).document;
    expect(moved.depiction.positions[Object.keys(doc.graph.atoms)[0]]).toEqual({x:2,y:3});expect(stereoProjection(saved(moved))).toEqual(stereoProjection(moved));
  });
  it('saves chemical additions into their reaction participant and group',()=>{
    const doc=load(),carbon=Object.keys(doc.graph.atoms)[0],oxygen=addAtom(doc,'O',{x:0,y:1.5});addBond(doc,carbon,oxygen);
    const back=saved(doc),step=Object.values(back.graph.reactions!)[0];expect(Object.keys(back.graph.atoms)).toHaveLength(4);expect(step.reactants[0]).toMatchObject({atomIds:expect.any(Array)});expect(step.reactants[0].kind==='molecule'&&step.reactants[0].atomIds.map(id=>back.graph.atoms[id].element).sort()).toEqual(['C','O','O']);expect(Object.values(doc.graph.reactions!)[0].reactants[0]).toMatchObject({atomIds:expect.arrayContaining([oxygen])});
  });
  it('changes reaction roles and prunes a deleted condition from all steps',()=>{
    const doc=load(),step=Object.values(doc.graph.reactions!)[0],condition=Object.values(doc.depiction.objects!).find(o=>o.tag==='t')!;
    const edited=applyDocumentEdits(doc,[{type:'update-reaction',stepId:step.id,changes:{reactants:step.products,products:step.reactants}},{type:'remove-drawing',objectId:condition.id}]).document;
    expect(stereoProjection(saved(edited))).toEqual(stereoProjection(edited));expect(Object.values(edited.graph.reactions!)[0].above).toEqual([]);
  });
  it('rebuilds CDXML drawing content, styles and reaction membership after native JSON restoration',()=>{
    const doc=importDocument({data:JSON.stringify(load()),format:'json'}).document;delete doc.source;
    const back=importDocument({data:exportDocument(doc,{format:'cdxml'}).data}).document;
    expect(stereoProjection(back)).toEqual(stereoProjection(doc));
    expect(()=>exportDocument(doc,{format:'mrv'})).toThrow();
  });
  it('rejects dangling references, unsafe fields and inconsistent hierarchy atomically',()=>{
    const doc=load(),step=Object.values(doc.graph.reactions!)[0],snapshot=structuredClone(doc);
    expect(()=>applyDocumentEdits(doc,[{type:'update-reaction',stepId:step.id,changes:{reactants:[{kind:'atom',id:'missing'}]}}])).toThrow('引用');expect(doc).toEqual(snapshot);
    const object=Object.values(doc.depiction.objects!)[0];expect(()=>applyDocumentEdits(doc,[{type:'update-drawing',objectId:object.id,changes:{geometry:{Head3D:[NaN,0,0]}}}])).toThrow('坐标');
  });
  it('renders independently editable text and arrows while escaping imported content',()=>{
    const doc=load(),text=Object.values(doc.depiction.objects!).find(o=>o.tag==='t')!;text.runs![0].text='<script>alert(1)</script>';
    const svg=exportSvg(doc);expect(svg).toContain('data-drawing=');expect(svg).toContain('&lt;script&gt;');expect(svg).not.toContain('<script>');
  });
  it('edits imported text through the visible inspector and preserves format runs',()=>{
    const container=document.createElement('div');document.body.append(container);const editor=createChemicalEditor({container,document:load()});
    const text=Object.values(editor.getDocument().depiction.objects!).find(o=>o.tag==='t')!;editor.setSelection({atomIds:[],objectId:text.id});
    editor.showAdvancedEditor('document');
    const input=editor.shadowRoot!.querySelector<HTMLTextAreaElement>('[data-drawing-text]')!;expect(input).not.toBeNull();input.value='heat gently';input.dispatchEvent(new Event('change',{bubbles:true}));
    expect(editor.getDocument().depiction.objects![text.id].runs![0]).toMatchObject({text:'heat gently',attributes:{font:'3',size:'10'}});expect(stereoProjection(saved(editor.getDocument()))).toEqual(stereoProjection(editor.getDocument()));editor.undo();expect(editor.getDocument().depiction.objects![text.id].runs![0].text).toBe('heat');editor.destroy();container.remove();
  });
  it('selects a page without mutating the document or selecting hidden atoms',()=>{
    const doc=importDocument({data:'<CDXML><page id="1"><fragment id="2"><n id="3" p="0 0"/></fragment></page><page id="4"><fragment id="5"><n id="6" p="0 0" Element="8"/></fragment></page></CDXML>'}).document;
    const container=document.createElement('div');document.body.append(container);const editor=createChemicalEditor({container,document:doc}),pages=Object.values(doc.depiction.objects!).filter(o=>o.tag==='page');
    const control=editor.shadowRoot!.querySelector<HTMLSelectElement>('[data-document-page]')!;control.value=pages[1].id;control.dispatchEvent(new Event('change',{bubbles:true}));
    expect(editor.shadowRoot!.querySelectorAll('[data-atom]')).toHaveLength(1);expect(editor.getDocument()).toEqual(doc);
    editor.shadowRoot!.querySelector<HTMLButtonElement>('[data-action="select-all"]')!.click();expect(editor.getSelection().atomIds).toEqual(pages[1].atomIds);editor.destroy();container.remove();
  });
});

describe('complete chemical annotations',()=>{
  it('invalidates both the CIP field and its displayed derived caption after chemistry changes',()=>{
    const doc=importDocument({data:'<CDXML><page><fragment><n id="1" p="0 0" AS="R"><objecttag id="2" Name="stereo"><t><s>(R)</s></t></objecttag></n></fragment></page></CDXML>'}).document;
    const edited=applyDocumentEdits(doc,[{type:'update-atom',atomId:Object.keys(doc.graph.atoms)[0],changes:{isotope:13}}]).document;
    const output=exportSourceFile(edited).data;expect(output).not.toContain('AS="R"');expect(output).not.toContain('(R)');
  });
  it('round-trips enhanced groups, independent 3D coordinates and secondary bond display',()=>{
    const doc=importDocument({data:'<CDXML><page><fragment><n id="1" p="0 0" xyz="1 2 3" EnhancedStereoType="And" EnhancedStereoGroupNum="2"/><n id="2" p="30 0"/><b id="3" B="1" E="2" Order="1.5" Display2="Dash"/></fragment></page></CDXML>'}).document;
    const atom=Object.values(doc.graph.atoms)[0];const edited=applyDocumentEdits(doc,[{type:'update-atom',atomId:atom.id,changes:{spatial:[4,5,6],enhancedStereo:{type:'Or',group:3}}}]).document;
    expect(stereoProjection(saved(edited))).toEqual(stereoProjection(edited));delete edited.source;expect(stereoProjection(importDocument({data:exportDocument(edited,{format:'cdxml'}).data}).document)).toEqual(stereoProjection(edited));
  });
  it('keeps multi-center hubs distinct from ordinary carbon and maps all target identities',()=>{
    const doc=importDocument({data:'<CDXML><page><fragment><n id="1" p="0 0"/><n id="2" p="30 0"/><n id="3" p="15 15" NodeType="MultiAttachment" Attachments="1 2"/></fragment></page></CDXML>'}).document;
    const hub=Object.values(doc.graph.atoms).find(a=>a.multiAttachment)!;expect(hub.element).toBe('*');const changed=applyDocumentEdits(doc,[{type:'update-atom',atomId:hub.id,changes:{multiAttachment:hub.multiAttachment!.slice().reverse()}}]).document;expect(stereoProjection(saved(changed))).toEqual(stereoProjection(changed));
  });
  it('retains a source-declared unresolved name without fabricating internal chemistry',()=>{
    const doc=importDocument({data:'<CDXML><page><fragment><n id="1" p="0 0" NodeType="Fragment"><t><s>UnknownGroup</s></t></n></fragment></page></CDXML>'}).document;
    const atom=Object.values(doc.graph.atoms)[0];expect(atom.namedFragment).toEqual({type:'Fragment',label:'UnknownGroup'});const changed=applyDocumentEdits(doc,[{type:'update-atom',atomId:atom.id,changes:{namedFragment:{type:'Fragment',label:'DefinedByUser'}}}]).document;expect(stereoProjection(saved(changed))).toEqual(stereoProjection(changed));
  });
  it('validates axial ligand ordering across a complete cumulene axis',()=>{
    const doc=emptyDocument(),axis=[0,1,2].map(x=>addAtom(doc,'C',{x,y:0}));addBond(doc,axis[0],axis[1],2);addBond(doc,axis[1],axis[2],2);
    const refs=[0,0,2,2].map((end,i)=>addBond(doc,axis[end],addAtom(doc,['F','Cl','Br','I'][i],{x:end,y:i%2?1:-1})));
    const changed=applyDocumentEdits(doc,[{type:'set-atom-geometry',atomId:axis[1],bondOrdering:refs as [string,string,string,string]}]).document;expect(changed.graph.atoms[axis[1]].geometry?.type).toBe('axial');
    const back=importDocument({data:exportDocument(changed,{format:'cdxml'}).data}).document;expect(stereoProjection(back)).toEqual(stereoProjection(changed));
  });
});
