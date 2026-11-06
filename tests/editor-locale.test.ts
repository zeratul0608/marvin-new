import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChemicalEditor, type ChemicalEditorElement, type ChemicalEditorOptions } from '../src/editor/chemical-editor';
import type { EditorPlugin } from '../src/editor/api-types';
import { exampleDocument } from '../src/core/templates';
import { addAtom } from '../src/core/model';
import { importDocument } from '../src/formats';
import type { AiTransport } from '../src/ai/types';
import type { EditorLocale } from '../src/editor/i18n';
import { structureReviewPlugin } from '../src/plugins/structure-review';
import { structureLayoutPlugin } from '../src/plugins/structure-layout';
import { createAiAssistantPlugin } from '../src/plugins/ai-assistant';

const editors: ChemicalEditorElement[]=[];
const nativeShadowActiveElement=Object.getOwnPropertyDescriptor(ShadowRoot.prototype,'activeElement')!.get!;
beforeEach(()=>{
  vi.spyOn(ShadowRoot.prototype,'activeElement','get').mockImplementation(function(this:ShadowRoot){
    let focused:Element|null=this.ownerDocument.activeElement;
    while(focused){const root=focused===this.host?this:focused.shadowRoot;if(!root)return null;const active=nativeShadowActiveElement.call(root)as Element|null;if(root===this)return active;focused=active;}return null;
  });
});
afterEach(()=>{editors.splice(0).forEach(editor=>editor.destroy());document.body.replaceChildren();localStorage.clear();vi.restoreAllMocks();});
function mount(options:Partial<ChemicalEditorOptions>={}){
  const doc=exampleDocument('ethanol');doc.title='导出';
  addAtom(doc,'*',{x:5,y:0},{query:{kind:'generic',label:'高级编辑'}});
  const editor=createChemicalEditor({container:document.body,document:doc,...options});editors.push(editor);return editor;
}
function element<T extends HTMLElement=HTMLElement>(editor:ChemicalEditorElement,selector:string):T{
  const result=editor.shadowRoot!.querySelector<T>(selector);expect(result,selector).not.toBeNull();return result!;
}
const english=(value:string|null|undefined)=>expect(value).not.toMatch(/[\u3400-\u9fff]/);
const settled=async()=>{await Promise.resolve();await Promise.resolve();};

describe('editor interface locale',()=>{
  it('defaults to Chinese and accepts English through the SDK options',async()=>{
    const chinese=mount(),editor=mount({locale:'en'});await settled();
    expect(chinese.getLocale()).toBe('zh-CN');expect(chinese.lang).toBe('zh-CN');
    expect(element(chinese,'[data-action="toggle-advanced"]').textContent).toContain('高级');
    expect(editor.getLocale()).toBe('en');expect(editor.lang).toBe('en');
    expect(element(editor,'[data-action="toggle-advanced"]').textContent).toMatch(/advanced/i);
    expect(element(editor,'[data-action="import"]').getAttribute('aria-label')).toMatch(/import/i);
    expect(element(editor,'[data-action="export"]').getAttribute('aria-label')).toMatch(/export/i);
    expect(element<HTMLSelectElement>(editor,'.locale-select').value).toBe('en');
  });

  it('switches from the visible locale selector and emits a single event for each actual change',async()=>{
    const editor=mount(),events:string[]=[];
    editor.addEventListener('localechange',event=>events.push((event as CustomEvent<{locale:string}>).detail.locale));
    const select=element<HTMLSelectElement>(editor,'.locale-select');select.focus();select.value='en';select.dispatchEvent(new Event('change',{bubbles:true}));await settled();
    expect(editor.getLocale()).toBe('en');expect(editor.lang).toBe('en');expect(editor.shadowRoot!.activeElement).toBe(select);
    expect(element(editor,'.locale-select')).toBe(select);
    editor.setLocale('en');editor.setLocale('zh-CN');editor.setLocale('zh-CN');await settled();
    expect(events).toEqual(['en','zh-CN']);expect(select.value).toBe('zh-CN');
    expect(element(editor,'[data-action="toggle-advanced"]').textContent).toContain('高级');
  });

  it('preserves Chinese user data, source text, chemical SVG, selection and the redo branch',async()=>{
    const editor=mount(),atomId=Object.keys(editor.getDocument().graph.atoms)[0];
    editor.setSelection({atomIds:[atomId]});editor.applyEdits({operations:[{type:'update-atom',atomId,changes:{isotope:13}}]});
    const edited=editor.getDocument();editor.undo();const before=editor.getSnapshot(),svg=editor.exportSvg();
    editor.showAdvancedEditor('fragments');
    const label=element<HTMLInputElement>(editor,'[data-collapse-label]');label.value='高级编辑';
    const details=element<HTMLDetailsElement>(editor,'.collapse-controls');details.open=true;label.focus();
    const source=element<HTMLTextAreaElement>(editor,'.import-source');source.value='<document title="高级编辑">导出</document>';
    const originalSource=source.value;
    editor.setLocale('en');await settled();
    expect(element(editor,'[data-collapse-label]')).toBe(label);expect(label.value).toBe('高级编辑');expect(details.open).toBe(true);
    expect(editor.shadowRoot!.activeElement).toBe(label);expect(source.value).toBe(originalSource);
    expect(element<HTMLInputElement>(editor,'.document-title').value).toBe('导出');
    expect(editor.getSnapshot()).toEqual(before);expect(editor.exportSvg()).toBe(svg);expect(svg).toContain('高级编辑');
    editor.setLocale('zh-CN');await settled();expect(label.value).toBe('高级编辑');expect(source.value).toBe(originalSource);
    expect(editor.getSnapshot()).toEqual(before);editor.redo();expect(editor.getDocument()).toEqual(edited);
  });

  it('keeps each editor locale independent',async()=>{
    const first=mount({locale:'en'}),second=mount();first.setLocale('zh-CN');second.setLocale('en');await settled();
    expect(first.getLocale()).toBe('zh-CN');expect(second.getLocale()).toBe('en');
    expect(first.lang).toBe('zh-CN');expect(second.lang).toBe('en');
    expect(element(first,'[data-action="toggle-advanced"]').textContent).toContain('高级');
    expect(element(second,'[data-action="toggle-advanced"]').textContent).toMatch(/advanced/i);
  });

  it('translates new advanced content and accessibility labels after a document change',async()=>{
    const editor=mount({locale:'en'}),atomId=Object.keys(editor.getDocument().graph.atoms)[0];
    editor.setSelection({atomIds:[atomId]});editor.showAdvancedEditor('properties');await settled();
    const map=element(editor,'label[for="atom-map"]');expect(map.textContent).toMatch(/map/i);english(map.textContent);
    english(element(editor,'.advanced-selection-summary').textContent);
    editor.applyEdits({operations:[{type:'update-atom',atomId,changes:{atomMap:4}}]});await settled();
    expect(element<HTMLInputElement>(editor,'#atom-map').value).toBe('4');english(element(editor,'label[for="atom-map"]').textContent);
    english(element(editor,'[data-advanced-section="properties"]').getAttribute('aria-label'));
    english(element(editor,'[data-action="toggle-advanced"]').getAttribute('title'));
  });

  it('translates built-in plugins and model settings without calling a model',async()=>{
    const transport=vi.fn<AiTransport['complete']>().mockResolvedValue({text:'',toolCalls:[]});
    const editor=mount({locale:'en',plugins:[structureReviewPlugin,structureLayoutPlugin,createAiAssistantPlugin({transport:{complete:transport}})]});
    editor.showPluginPanel('structure-review');await settled();
    english(element(editor,'[data-plugin-panel="structure-review.summary"]').textContent);
    editor.showPluginPanel('structure-layout');await settled();english(element(editor,'[data-plugin-panel="structure-layout.layout"]').textContent);
    editor.showPluginPanel('ai-assistant');await editor.executeCommand('ai-assistant.settings');await settled();
    const view=element(editor,'[data-ai-view="settings"]');english(view.querySelector('button')!.textContent);
    expect(view.textContent).toMatch(/model|protocol|service/i);
    english(element(editor,'.ai-header').textContent);expect(transport).not.toHaveBeenCalled();
  });

  it('retains mounted plugin nodes, unsaved inputs and a pending command across locale changes',async()=>{
    let mounts=0,disposals=0,finish!:(value:string)=>void;
    const plugin:EditorPlugin={id:'locale-state',name:'Locale state',version:'1.0.0',apiVersion:1,activate(context){
      context.addPanel({id:'draft',title:'Draft',mount(container){mounts++;const input=document.createElement('input');input.dataset.localeDraft='';input.value='高级编辑';container.append(input);return()=>{disposals++;};}});
      context.registerCommand({id:'wait',title:'Wait',execute:()=>new Promise<string>(resolve=>{finish=resolve;})});
    }};
    const editor=mount({plugins:[plugin]});editor.showPluginPanel('locale-state');
    const input=element<HTMLInputElement>(editor,'[data-locale-draft]');input.focus();const before=editor.getSnapshot();
    const pending=editor.executeCommand('locale-state.wait');editor.setLocale('en');await settled();
    expect(element(editor,'[data-locale-draft]')).toBe(input);expect(input.value).toBe('高级编辑');expect(editor.shadowRoot!.activeElement).toBe(input);
    finish('用户结果');expect(await pending).toBe('用户结果');editor.setLocale('zh-CN');await settled();
    expect(mounts).toBe(1);expect(disposals).toBe(0);expect(editor.getSnapshot()).toEqual(before);
  });
  it('synchronizes a valid lang attribute and rejects unsupported SDK locales without changing state',async()=>{
    const editor=mount(),before=editor.getSnapshot();
    editor.setAttribute('lang','en');await settled();
    expect(editor.getLocale()).toBe('en');expect(element<HTMLSelectElement>(editor,'.locale-select').value).toBe('en');
    expect(element(editor,'[data-action="import"]').getAttribute('aria-label')).toMatch(/import/i);
    expect(()=>editor.setLocale('fr' as EditorLocale)).toThrow(/unsupported/i);
    expect(editor.getLocale()).toBe('en');expect(editor.lang).toBe('en');
    const count=document.querySelectorAll('chemical-editor').length;
    expect(()=>mount({locale:'fr' as EditorLocale})).toThrow(/unsupported/i);
    expect(document.querySelectorAll('chemical-editor')).toHaveLength(count);
    editor.removeAttribute('lang');await settled();
    expect(editor.getLocale()).toBe('zh-CN');expect(editor.lang).toBe('zh-CN');expect(editor.getSnapshot()).toEqual(before);
  });

  it('translates textarea interface attributes while preserving its source value and focused node',async()=>{
    const editor=mount(),source=element<HTMLTextAreaElement>(editor,'.import-source');
    element<HTMLButtonElement>(editor,'[data-action="import"]').click();
    source.value='<CDXML>导出</CDXML>';source.focus();editor.setLocale('en');await settled();
    english(source.getAttribute('aria-label'));english(source.getAttribute('placeholder'));
    expect(source.getAttribute('aria-label')).toBeTruthy();expect(source.getAttribute('placeholder')).toBeTruthy();
    expect(source.value).toBe('<CDXML>导出</CDXML>');expect(editor.shadowRoot!.activeElement).toBe(source);
    editor.setLocale('zh-CN');await settled();expect(source.getAttribute('aria-label')).toContain('结构');expect(source.value).toBe('<CDXML>导出</CDXML>');
  });

  it('finds advanced tools by their English names while retaining the search input',async()=>{
    const editor=mount({locale:'en'}),id=Object.keys(editor.getDocument().graph.atoms)[0];editor.setSelection({atomIds:[id]});const before=editor.getSnapshot();
    editor.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true,composed:true}));
    const search=element<HTMLInputElement>(editor,'.command-search');search.value='atom mapping';search.dispatchEvent(new Event('input',{bubbles:true}));
    const result=element<HTMLButtonElement>(editor,'.search-results [data-command]');expect(result.textContent).toMatch(/mapping/i);
    editor.setLocale('zh-CN');editor.setLocale('en');await settled();expect(element(editor,'.command-search')).toBe(search);expect(search.value).toBe('atom mapping');
    element<HTMLButtonElement>(editor,'.search-results [data-command]').click();
    expect(element(editor,'[data-advanced-section="properties"]').getAttribute('aria-pressed')).toBe('true');expect(editor.getSnapshot()).toEqual(before);
  });

  it('preserves user and model message bodies which coincide with translated interface words',async()=>{
    const complete=vi.fn<AiTransport['complete']>().mockResolvedValue({text:'导出',toolCalls:[]});
    const editor=mount({locale:'en',plugins:[createAiAssistantPlugin({transport:{complete}})]});
    editor.showPluginPanel('ai-assistant');const before=editor.getSnapshot();
    const message=element<HTMLTextAreaElement>(editor,'[data-ai-field="message"]');message.value='撤销';
    element<HTMLFormElement>(editor,'.ai-composer').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    await vi.waitFor(()=>expect(editor.shadowRoot!.querySelectorAll('.ai-message p')).toHaveLength(2));await settled();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0].messages.at(-1)).toEqual({role:'user',content:'撤销'});
    const bodies=[...editor.shadowRoot!.querySelectorAll('.ai-message p')];
    expect(bodies.map(node=>node.textContent)).toEqual(['撤销','导出']);
    editor.setLocale('zh-CN');editor.setLocale('en');await settled();
    expect([...editor.shadowRoot!.querySelectorAll('.ai-message p')]).toEqual(bodies);
    expect(bodies.map(node=>node.textContent)).toEqual(['撤销','导出']);expect(editor.getSnapshot()).toEqual(before);
  });

  it('keeps source-authored document and reaction labels and internal fragment names unchanged',async()=>{
    const raw='<CDXML><page id="1"><fragment id="2"><n id="3" p="0 0"/><n id="4" p="30 0" NodeType="Fragment"><fragment id="10" ConnectionOrder="13"><n id="11" p="30 0" Element="8" NumHydrogens="0"/><n id="12" p="60 0"/><n id="13" p="0 0" NodeType="ExternalConnectionPoint"/><b id="14" B="11" E="12"/><b id="15" B="11" E="13"/></fragment><t><s font="3" size="10">导出</s></t></n><b id="5" B="3" E="4"/></fragment><t id="20" p="0 40"><s font="3" size="10">导出</s></t><arrow id="21" Head3D="100 0 0" Tail3D="60 0 0" ArrowheadHead="Full"/><scheme id="22"><step id="23" ReactionStepReactants="2" ReactionStepArrows="21" ReactionStepObjectsAboveArrow="20"/></scheme></page></CDXML>';
    const doc=importDocument({data:raw}).document;
    const editor=mount({document:doc}),fragment=Object.values(doc.graph.atoms).find(atom=>atom.substructure)!;
    editor.setSelection({atomIds:[fragment.id]});editor.showPluginPanel();const before=editor.getSnapshot(),svg=editor.exportSvg();
    const sourceName=element(editor,'.selection-name [data-i18n-skip]');expect(sourceName.textContent).toBe('导出');
    editor.setLocale('en');await settled();expect(sourceName.textContent).toBe('导出');
    editor.showAdvancedEditor('fragments');expect(element(editor,'[data-advanced-panel="fragments"] .selection-name [data-i18n-skip]').textContent).toBe('导出');
    expect(element<HTMLInputElement>(editor,'[data-property="substructureLabel"]').value).toBe('导出');
    editor.showAdvancedEditor('document');
    const sourceText=Object.values(doc.depiction.objects!).find(object=>object.tag==='t'&&object.runs?.some(run=>run.text==='导出'))!;
    const objectOption=element<HTMLOptionElement>(editor,`[data-document-object] option[value="${sourceText.id}"]`);
    const reactionOptions=[...editor.shadowRoot!.querySelectorAll<HTMLOptionElement>('[data-reaction-role] option')].filter(option=>option.textContent?.includes('导出'));
    expect(objectOption.textContent).toContain('导出');expect(objectOption.getAttribute('label')??objectOption.textContent).not.toContain('Export');expect(reactionOptions.length).toBeGreaterThan(0);
    const originalLabels=reactionOptions.map(option=>option.textContent);editor.setLocale('zh-CN');editor.setLocale('en');await settled();
    expect(objectOption.textContent).toContain('导出');expect(reactionOptions.map(option=>option.textContent)).toEqual(originalLabels);
    expect(editor.getSnapshot()).toEqual(before);expect(editor.exportSvg()).toBe(svg);
  });

});
