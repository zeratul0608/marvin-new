import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createChemicalEditor,type ChemicalEditorElement} from '../src/editor/chemical-editor';
import {exampleDocument} from '../src/core/templates';
import {importDocument} from '../src/formats';

const editors:ChemicalEditorElement[]=[];
afterEach(()=>{for(const editor of editors.splice(0))editor.destroy();document.body.replaceChildren();localStorage.clear();});
function setup(doc=exampleDocument('ethanol'),locale:'zh-CN'|'en'='zh-CN'){
 const editor=createChemicalEditor({container:document.body,document:doc,locale});editors.push(editor);
 const root=editor.shadowRoot!;
 const click=(action:string)=>root.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!.click();
 const choose=(format:string)=>{const control=root.querySelector<HTMLSelectElement>('.export-format')!;control.value=format;control.dispatchEvent(new Event('change',{bubbles:true}));};
 const consent=root.querySelector<HTMLInputElement>('.allow-lossy')!;
 return{editor,root,click,choose,consent};
}

describe('import confirmation and actionable export feedback',()=>{
 it('explains full-document replacement and preserves the current document until confirmation',()=>{
  const {editor,root,click}=setup(exampleDocument('aspirin')),before=editor.getDocument();
  click('import');
  expect(root.querySelector('.import-replacement-notice')!.textContent).toContain('替换当前整份文档');
  expect(root.querySelector('[data-action="apply-import"]')!.textContent).toBe('替换当前文档');
  root.querySelector<HTMLTextAreaElement>('.import-source')!.value=JSON.stringify(exampleDocument('ethanol'));
  expect(editor.getDocument()).toEqual(before);
  click('apply-import');expect(Object.keys(editor.getDocument().graph.atoms)).toHaveLength(3);
  click('undo');expect(editor.getDocument()).toEqual(before);
 });

 it('opens confirmation for dropped files and lets cancellation keep the current document',async()=>{
  const {editor,root}=setup(exampleDocument('aspirin')),before=editor.getDocument();
  const file=new File([JSON.stringify(exampleDocument('ethanol'))],'ethanol.molecule.json',{type:'application/json'});
  const drop=new Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(drop,'dataTransfer',{value:{files:[file]}});
  root.querySelector('.canvas-area')!.dispatchEvent(drop);
  await vi.waitFor(()=>expect(root.querySelector<HTMLDialogElement>('.import-dialog')!.open).toBe(true));
  expect(Object.keys(JSON.parse(root.querySelector<HTMLTextAreaElement>('.import-source')!.value).graph.atoms)).toHaveLength(3);
  expect(editor.getDocument()).toEqual(before);
  root.querySelector<HTMLButtonElement>('.import-dialog [data-action="close-dialog"]')!.click();
  expect(editor.getDocument()).toEqual(before);
 });

 it('offers consent only when accepting known losses can really produce the target format',()=>{
  const doc=exampleDocument('ethanol');Object.values(doc.graph.atoms)[0].atomMap=1;
  const {root,click,choose,consent}=setup(doc);click('export');choose('cdxml');
  expect(root.querySelector('.export-status')!.textContent).toBe('需要确认信息损失');
  expect(consent.disabled).toBe(false);expect(root.querySelector<HTMLElement>('.lossy-option')!.hidden).toBe(false);
  expect(root.querySelector<HTMLButtonElement>('[data-action="download-export"]')!.disabled).toBe(true);
  consent.checked=true;consent.dispatchEvent(new Event('change',{bubbles:true}));
  expect(root.querySelector('.export-status')!.textContent).toBe('已确认有损导出');
  expect(root.querySelector<HTMLButtonElement>('[data-action="download-export"]')!.disabled).toBe(false);
 });

 it('keeps unsupported query conversion blocked, removes misleading consent and offers a complete JSON save',()=>{
  const doc=exampleDocument('ethanol');Object.values(doc.graph.atoms)[0].queryConstraints={substituentsUpTo:3};
  const {editor,root,click,choose,consent}=setup(doc);click('export');choose('mol');
  expect(root.querySelector('.export-status')!.textContent).toBe('暂不支持此转换');
  expect(consent.disabled).toBe(true);expect(root.querySelector<HTMLElement>('.lossy-option')!.hidden).toBe(true);
  expect(root.querySelector('.export-message')!.textContent).toContain('不能通过允许有损导出解除');
  expect(root.querySelector<HTMLButtonElement>('[data-action="download-export"]')!.disabled).toBe(true);
  click('export-json');
  expect(root.querySelector<HTMLSelectElement>('.export-format')!.value).toBe('json');
  expect(JSON.parse(root.querySelector<HTMLTextAreaElement>('.export-source')!.value)).toEqual(editor.getDocument());
  expect(root.querySelector<HTMLButtonElement>('[data-action="download-export"]')!.disabled).toBe(false);
 });

 it('opens the current conversion report without losing the export and provides a safe source-format action',()=>{
  const bytes=new Uint8Array(readFileSync(resolve('tests/fixtures/cdx/dimethylamine-styled.cdx')));
  const doc=importDocument({data:bytes,name:'styled.cdx'}).document;
  Object.values(doc.graph.atoms)[0].isotope=13;
  const {root,click,choose}=setup(doc);click('export');choose('cdxml');
  expect(root.querySelector('.export-message')!.textContent).toContain('目标格式暂不能完整保留');
  expect(root.querySelector('.export-message')!.textContent).not.toContain('0x3');
  expect(root.querySelector<HTMLButtonElement>('[data-action="export-source-format"]')!.hidden).toBe(false);
  click('export-issues');
  expect(root.querySelector<HTMLDialogElement>('.issues-dialog')!.open).toBe(true);
  expect(root.querySelector('.issue-list')!.textContent).toContain('0x3');
  root.querySelector<HTMLButtonElement>('.issues-dialog [data-action="close-dialog"]')!.click();
  expect(root.querySelector<HTMLDialogElement>('.export-dialog')!.open).toBe(true);
  expect(root.querySelector<HTMLSelectElement>('.export-format')!.value).toBe('cdxml');
  click('export-source-format');
  expect(root.querySelector<HTMLSelectElement>('.export-format')!.value).toBe('source');
  expect(root.querySelector('.export-status')!.textContent).toBe('可保留保存');
  expect(root.querySelector<HTMLButtonElement>('[data-action="download-export"]')!.disabled).toBe(false);
 });

 it('translates replacement, hard-limit feedback and recommended actions in English',()=>{
  const doc=exampleDocument('ethanol');Object.values(doc.graph.atoms)[0].queryConstraints={substituentsUpTo:3};
  const {root,click,choose}=setup(doc,'en');click('import');
  expect(root.querySelector('.import-replacement-notice')!.textContent).toContain('replaces the entire');
  expect(root.querySelector('[data-action="apply-import"]')!.textContent).toBe('Replace current document');
  root.querySelector<HTMLButtonElement>('.import-dialog [data-action="close-dialog"]')!.click();
  click('export');choose('mol');
  for(const selector of ['.export-status','.export-message','[data-action="export-json"]','[data-action="export-issues"]'])expect(root.querySelector(selector)!.textContent).not.toMatch(/[\u3400-\u9fff]/u);
 });
});
