import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createChemicalEditor,type ChemicalEditorElement} from '../src/editor/chemical-editor';
import {importDocument,exportSourceFile} from '../src/formats';
import {stereoProjection} from '../src/formats/stereo';
import {peptideGroupXml,alternativesGroupXml,nestedPeptideGroupXml,referencedGroupXml,inconsistentBoundaryXml} from './fixtures/expanded-group-fixture';
const editors:ChemicalEditorElement[]=[];
const nativeShadowActiveElement=Object.getOwnPropertyDescriptor(ShadowRoot.prototype,'activeElement')!.get!;
beforeEach(()=>{
 // happy-dom 20 walks beyond Document when reading an unrelated nested shadow
 // root. Query only the actual focus chain, as the browser's getter does.
 vi.spyOn(ShadowRoot.prototype,'activeElement','get').mockImplementation(function(this:ShadowRoot){
  let focused:Element|null=this.ownerDocument.activeElement;
  while(focused){
   const root=focused===this.host?this:focused.shadowRoot;if(!root)return null;
   const active=nativeShadowActiveElement.call(root)as Element|null;
   if(root===this)return active;focused=active;
  }
  return null;
 });
});
afterEach(()=>{editors.splice(0).forEach(editor=>editor.destroy());document.body.replaceChildren();vi.restoreAllMocks();});
const mount=(raw:string)=>{const container=document.createElement('div');document.body.append(container);const editor=createChemicalEditor({container,document:importDocument({data:raw}).document});editors.push(editor);return editor;};
const group=(editor:ChemicalEditorElement)=>Object.values(editor.getDocument().graph.atoms).find(a=>a.substructure)!;
const expand=(editor:ChemicalEditorElement,recursive=false)=>{editor.setSelection({atomIds:[group(editor).id]});editor.showAdvancedEditor('fragments');editor.shadowRoot!.querySelector<HTMLButtonElement>(`[data-action="${recursive?'show-substructure-recursive':'toggle-substructure-display'}"]`)!.click();};
const click=(element:Element)=>element.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:20,clientY:20}));
describe('expanded group editing from real graph hits',()=>{
 it.each([peptideGroupXml,referencedGroupXml,inconsistentBoundaryXml])('opens protected groups without discarding annotations or boundary information',raw=>{
  const editor=mount(raw),before=editor.getDocument();expand(editor);expect(group(editor).substructure!.display).toBe('expanded');expect(editor.shadowRoot!.querySelectorAll('[data-expanded-atom]').length).toBeGreaterThan(0);
  const changed=editor.getDocument();expect(stereoProjection(importDocument({data:exportSourceFile(changed).data}).document)).toEqual(stereoProjection(changed));editor.undo();expect(editor.getDocument()).toEqual(before);editor.redo();expect(editor.getDocument()).toEqual(changed);
 });
 it('routes an actual internal atom to its own editor and saves chemistry as one parent undo step',()=>{
  const editor=mount(peptideGroupXml);expand(editor);const before=editor.getDocument(),wrapper=group(editor),oxygen=Object.values(wrapper.substructure!.fragments[0].document.graph.atoms).find(a=>a.element==='O')!;
  const hit=editor.shadowRoot!.querySelector(`[data-expanded-atom="${oxygen.id}"]`)!;click(hit);
  const dialog=editor.shadowRoot!.querySelector<HTMLDialogElement>('dialog[aria-label="编辑内部化学片段"]')!,child=dialog.querySelector<ChemicalEditorElement>('chemical-editor')!;
  expect(dialog.open).toBe(true);expect(child.getSelection().atomIds,JSON.stringify({ids:Object.keys(child.getDocument().graph.atoms),target:oxygen.id,hit:hit.outerHTML,status:editor.shadowRoot!.querySelector('[role="status"]')?.textContent})).toEqual([oxygen.id]);
  const input=child.shadowRoot!.querySelector<HTMLInputElement>('[data-property="isotope"]')!;input.value='18';input.dispatchEvent(new Event('change',{bubbles:true}));dialog.querySelector<HTMLButtonElement>('[data-nested-save]')!.click();
  expect(group(editor).substructure!.fragments[0].document.graph.atoms[oxygen.id].isotope).toBe(18);expect(group(editor).residueId).toBe(3);expect(group(editor).connectionType).toBe('Peptide');
  const changed=editor.getDocument();expect(stereoProjection(importDocument({data:exportSourceFile(changed).data}).document)).toEqual(stereoProjection(changed));editor.undo();expect(editor.getDocument()).toEqual(before);editor.redo();expect(editor.getDocument()).toEqual(changed);
 });
 it('shows and edits every alternative without changing another branch or picking a default',()=>{
  const editor=mount(alternativesGroupXml);expand(editor);expect(editor.shadowRoot!.querySelectorAll('[data-expanded-card]')).toHaveLength(2);const original=group(editor),branch=original.substructure!.fragments[1].document,atom=Object.values(branch.graph.atoms)[0];
  click(editor.shadowRoot!.querySelector(`[data-expanded-atom="${atom.id}"]`)!);const dialog=editor.shadowRoot!.querySelector<HTMLDialogElement>('dialog[aria-label="编辑内部化学片段"]')!,child=dialog.querySelector<ChemicalEditorElement>('chemical-editor')!;
  expect(dialog.querySelector<HTMLSelectElement>('select')!.value).toBe('1');expect(child.getSelection().atomIds).toEqual([atom.id]);
  const input=child.shadowRoot!.querySelector<HTMLInputElement>('[data-property="isotope"]')!;input.value='15';input.dispatchEvent(new Event('change',{bubbles:true}));dialog.querySelector<HTMLButtonElement>('[data-nested-save]')!.click();
  const result=group(editor).substructure!;expect(result.kind).toBe('alternatives');expect(result.fragments).toHaveLength(2);expect(result.fragments[0]).toEqual(original.substructure!.fragments[0]);expect(result.fragments[1].document.graph.atoms[atom.id].isotope).toBe(15);
 });
 it('routes a nested hit by its complete hierarchy path',()=>{
  const editor=mount(nestedPeptideGroupXml);expand(editor,true);const wrapper=group(editor),childDoc=wrapper.substructure!.fragments[0].document,nested=Object.values(childDoc.graph.atoms).find(a=>a.substructure)!,oxygen=Object.values(nested.substructure!.fragments[0].document.graph.atoms).find(a=>a.element==='O')!;
  const hit=editor.shadowRoot!.querySelector(`[data-expanded-atom="${oxygen.id}"]`)!;expect(JSON.parse(hit.getAttribute('data-expanded-path')!)).toHaveLength(2);click(hit);
  const dialog=editor.shadowRoot!.querySelector<HTMLDialogElement>('dialog[aria-label="编辑内部化学片段"]')!,child=dialog.querySelector<ChemicalEditorElement>('chemical-editor')!;expect(child.getSelection().atomIds).toEqual([oxygen.id]);
  const input=child.shadowRoot!.querySelector<HTMLSelectElement>('[data-property="element"]')!;input.value='S';input.dispatchEvent(new Event('change',{bubbles:true}));dialog.querySelector<HTMLButtonElement>('[data-nested-save]')!.click();
  expect(group(editor).substructure!.fragments[0].document.graph.atoms[nested.id].substructure!.fragments[0].document.graph.atoms[oxygen.id].element).toBe('S');expect(group(editor).residueId).toBe(8);
 });
 it('can cancel internal changes without modifying the expanded parent',()=>{
  const editor=mount(peptideGroupXml);expand(editor);const before=editor.getDocument();click(editor.shadowRoot!.querySelector('[data-expanded-atom]')!);const dialog=editor.shadowRoot!.querySelector<HTMLDialogElement>('dialog[aria-label="编辑内部化学片段"]')!;dialog.querySelector<HTMLButtonElement>('[data-nested-close]')!.click();expect(editor.getDocument()).toEqual(before);
 });
});
