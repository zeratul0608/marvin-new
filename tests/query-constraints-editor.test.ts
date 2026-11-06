import {afterEach,describe,expect,it} from 'vitest';
import {addAtom,addBond,emptyDocument} from '../src/core/model';
import {createChemicalEditor,type ChemicalEditorElement} from '../src/editor/chemical-editor';
import {exportSvg} from '../src/editor/render';
import {knownChemicalSummary} from '../src/core/chemical-summary';
const editors:ChemicalEditorElement[]=[];
const setup=()=>{const doc=emptyDocument(),a=addAtom(doc,'C',{x:0,y:0}),b=addAtom(doc,'N',{x:1.5,y:0}),bond=addBond(doc,a,b),editor=createChemicalEditor({container:document.body,document:doc});editors.push(editor);editor.setSelection({atomIds:[a]});editor.showAdvancedEditor('queries');return {editor,a,b,bond};};
const change=(editor:ChemicalEditorElement,field:string,value:string)=>{const control=editor.shadowRoot!.querySelector<HTMLInputElement|HTMLSelectElement>(`[data-query-constraint="${field}"]`)!;control.value=value;control.dispatchEvent(new Event('change',{bubbles:true}));};
afterEach(()=>{editors.splice(0).forEach(editor=>editor.destroy());document.body.replaceChildren();});
describe('advanced chemical query controls and canvas annotations',()=>{
 it('preserves concrete elements while editing zero and maximum substitution counts',()=>{
  const {editor,a}=setup(),before=editor.getDocument();change(editor,'substituentsExactly','0');change(editor,'substituentsUpTo','255');
  expect(editor.getDocument().graph.atoms[a]).toMatchObject({element:'C',queryConstraints:{substituentsExactly:0,substituentsUpTo:255}});expect(editor.getDocument().graph.atoms[a].query).toBeUndefined();
  expect(knownChemicalSummary(editor.getDocument()).complete).toBe(false);expect(editor.shadowRoot!.querySelector('[data-query-constraints]')!.textContent).toContain('Q');
  editor.undo();editor.undo();expect(editor.getDocument()).toEqual(before);editor.redo();expect(editor.getDocument().graph.atoms[a].queryConstraints!.substituentsExactly).toBe(0);
 });
 it.each([['ringBondCount','SpiroOrHigher'],['unsaturatedBonds','MustBeAbsent'],['reactionStereo','Retention']])('edits %s as its own independent condition', (field,value)=>{
  const {editor,a}=setup();change(editor,field,value);expect(editor.getDocument().graph.atoms[a].queryConstraints).toEqual({[field]:value});
  change(editor,field,'');expect(editor.getDocument().graph.atoms[a].queryConstraints).toBeUndefined();
 });
 it('clears reaction-change by removing the presence-only condition',()=>{
  const {editor,a}=setup();const toggle=(checked:boolean)=>{const control=editor.shadowRoot!.querySelector<HTMLInputElement>('[data-query-constraint="reactionChange"]')!;control.checked=checked;control.dispatchEvent(new Event('change',{bubbles:true}));};
  toggle(true);expect(editor.getDocument().graph.atoms[a].queryConstraints).toEqual({reactionChange:true});toggle(false);expect(editor.getDocument().graph.atoms[a].queryConstraints).toBeUndefined();
 });
 it.each(['-1','256','0.5'])('rejects invalid count %s without changing the document',value=>{
  const {editor}=setup(),before=editor.getDocument();change(editor,'substituentsExactly',value);expect(editor.getDocument()).toEqual(before);
 });
 it('keeps contradictory independent conditions and clears them with one undoable action',()=>{
  const {editor,a}=setup();change(editor,'substituentsExactly','3');change(editor,'substituentsUpTo','1');const before=editor.getDocument();expect(before.graph.atoms[a].queryConstraints).toEqual({substituentsExactly:3,substituentsUpTo:1});
  editor.shadowRoot!.querySelector<HTMLButtonElement>('[data-action="clear-query-constraints"]')!.click();expect(editor.getDocument().graph.atoms[a].queryConstraints).toBeUndefined();editor.undo();expect(editor.getDocument()).toEqual(before);
 });
 it('preserves RingOrChain separately from explicit Unspecified and absent topology',()=>{
  const {editor,bond}=setup();editor.setSelection({atomIds:[],bondId:bond});
  const topology=(value:string)=>{const control=editor.shadowRoot!.querySelector<HTMLSelectElement>('[data-bond-topology]')!;control.value=value;control.dispatchEvent(new Event('change',{bubbles:true}));};
  topology('RingOrChain');expect(editor.getDocument().graph.bonds[bond].topology).toBe('RingOrChain');expect(editor.shadowRoot!.querySelector('[data-query-topology]')!.textContent).toContain('环/链');
  topology('Unspecified');expect(editor.getDocument().graph.bonds[bond].topology).toBe('Unspecified');topology('');expect(editor.getDocument().graph.bonds[bond].topology).toBeUndefined();editor.undo();expect(editor.getDocument().graph.bonds[bond].topology).toBe('Unspecified');
 });
 it('exports query annotations as SVG without changing the molecular graph',()=>{
  const {editor,a,bond}=setup();change(editor,'substituentsExactly','2');editor.applyEdits({operations:[{type:'set-bond-annotations',bondId:bond,changes:{topology:'Ring'}}]});const before=editor.getDocument(),svg=exportSvg(before);
  expect(svg).toContain(`data-query-constraints="${a}"`);expect(svg).toContain(`data-query-topology="${bond}"`);expect(svg).toContain('非氢取代数恰好 2');expect(svg).toContain('query-condition-label');expect(editor.getDocument()).toEqual(before);expect(Object.keys(before.graph.bonds)).toHaveLength(1);
 });
});
