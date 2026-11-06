import { afterEach, describe, expect, it } from 'vitest';
import { createChemicalEditor, type ChemicalEditorElement } from '../src/editor/chemical-editor';
import type { EditorPlugin } from '../src/editor/api-types';
import { emptyDocument, addAtom } from '../src/core/model';
import { exampleDocument } from '../src/core/templates';

const editors: ChemicalEditorElement[] = [];
function mount(plugins: EditorPlugin[] = []) {
  const editor = createChemicalEditor({ container: document.body, document: exampleDocument('ethanol'), plugins });
  editors.push(editor);
  return editor;
}
const element = <T extends HTMLElement = HTMLElement>(editor: ChemicalEditorElement, selector: string) => {
  const result = editor.shadowRoot!.querySelector<T>(selector);
  expect(result, selector).not.toBeNull();
  return result!;
};
const toggle = (editor: ChemicalEditorElement) => element<HTMLButtonElement>(editor, '[data-action="toggle-advanced"]');
afterEach(() => {
  editors.splice(0).forEach(editor => editor.destroy());
  document.body.replaceChildren();
});

describe('optional advanced editing workspace', () => {
  it('starts collapsed and keeps ordinary atom and bond editing in the basic inspector', () => {
    const editor = mount(), doc = editor.getDocument();
    expect(element(editor, '#advanced-tools').hidden).toBe(true);
    expect(toggle(editor).getAttribute('aria-expanded')).toBe('false');
    editor.setSelection({ atomIds: [Object.keys(doc.graph.atoms)[0]] });
    editor.showPluginPanel();
    const basic = element(editor, '.inspector-content');
    expect(basic.hidden).toBe(false);
    for (const property of ['element', 'charge', 'isotope']) expect(basic.querySelector(`[data-property="${property}"]`)).not.toBeNull();
    expect(basic.querySelector('[data-query-constraint]')).toBeNull();
    expect(basic.querySelector('[data-action="record-atom-geometry"]')).toBeNull();
    expect(element(editor, '.advanced-content').hidden).toBe(true);
    editor.setSelection({ atomIds: [], bondId: Object.keys(doc.graph.bonds)[0] });
    expect(basic.querySelector('#bond-order')).not.toBeNull();
    expect(basic.querySelector('#bond-style')).not.toBeNull();
    expect(element(editor, '#advanced-tools').hidden).toBe(true);
  });

  it('uses real toggle and category clicks to reveal exactly the chosen advanced panel', () => {
    const editor = mount();
    toggle(editor).click();
    expect(toggle(editor).getAttribute('aria-expanded')).toBe('true');
    expect(element(editor, '#advanced-tools').hidden).toBe(false);
    for (const section of ['properties', 'queries', 'fragments', 'document'] as const) {
      element<HTMLButtonElement>(editor, `[data-advanced-section="${section}"]`).click();
      expect(element(editor, '.advanced-content').hidden).toBe(false);
      expect(element(editor, '.inspector-content').hidden).toBe(true);
      for (const panel of editor.shadowRoot!.querySelectorAll<HTMLElement>('[data-advanced-panel]')) {
        expect(panel.hidden, panel.dataset.advancedPanel).toBe(panel.dataset.advancedPanel !== section);
      }
      expect(element(editor, `[data-advanced-section="${section}"]`).getAttribute('aria-pressed')).toBe('true');
    }
    element<HTMLButtonElement>(editor, '[data-advanced-section="extensions"]').click();
    expect(element(editor, '.extension-tabs').hidden).toBe(false);
    toggle(editor).click();
    expect(toggle(editor).getAttribute('aria-expanded')).toBe('false');
    expect(element(editor, '#advanced-tools').hidden).toBe(true);
    expect(element(editor, '.inspector-content').hidden).toBe(false);
    expect(element(editor, '.advanced-content').hidden).toBe(true);
  });

  it('keeps document revision, selection, chemical depiction and the redo branch unchanged by UI navigation', () => {
    const editor = mount(), atomId = Object.keys(editor.getDocument().graph.atoms)[0];
    editor.setSelection({ atomIds: [atomId] });
    const original = editor.getDocument();
    editor.applyEdits({ operations: [{ type: 'update-atom', atomId, changes: { isotope: 13 } }] });
    const edited = editor.getDocument();
    editor.undo();
    const before = editor.getSnapshot(), svg = editor.exportSvg();
    let changes = 0, selections = 0;
    editor.addEventListener('change', () => changes++);
    editor.addEventListener('selectionchange', () => selections++);
    toggle(editor).click();
    for (const section of ['queries', 'fragments', 'document', 'properties'] as const) editor.showAdvancedEditor(section);
    editor.showPluginPanel();
    expect(element(editor, '#advanced-tools').hidden).toBe(false);
    expect(element(editor, '.inspector-content').hidden).toBe(false);
    editor.hideAdvancedEditor();
    expect(editor.getSnapshot()).toEqual(before);
    expect(editor.exportSvg()).toBe(svg);
    expect(changes).toBe(0);
    expect(selections).toBe(0);
    editor.redo(); expect(editor.getDocument()).toEqual(edited);
    editor.undo(); expect(editor.getDocument()).toEqual(original);
  });

  it('opens the required panel through the public API and isolates each editor instance', () => {
    const first = mount(), second = mount();
    first.showAdvancedEditor('queries');
    expect(element(first, '[data-advanced-panel="queries"]').hidden).toBe(false);
    expect(toggle(first).getAttribute('aria-expanded')).toBe('true');
    expect(element(second, '#advanced-tools').hidden).toBe(true);
    first.hideAdvancedEditor();
    expect(element(first, '#advanced-tools').hidden).toBe(true);
    expect(element(second, '#advanced-tools').hidden).toBe(true);
  });

  it('automatically opens plugin panels and preserves their mounted state across collapse and pending commands', async () => {
    let mounts = 0, disposals = 0, complete!: () => void;
    const plugin: EditorPlugin = {
      id: 'advanced-test', name: 'Advanced state test', version: '1.0.0', apiVersion: 1,
      activate(context) {
        let output: HTMLElement;
        context.addPanel({ id: 'state', title: 'Persistent plugin', mount(container) {
          mounts++;
          const input = document.createElement('input'); input.dataset.advancedDraft = ''; input.value = 'draft';
          output = document.createElement('output'); output.textContent = 'waiting';
          container.append(input, output);
          return () => { disposals++; };
        } });
        context.registerCommand({ id: 'wait', title: 'Finish later', execute: () => new Promise<string>(resolve => {
          complete = () => { output.textContent = 'finished'; resolve('finished'); };
        }) });
      },
    };
    const editor = mount([plugin]), before = editor.getSnapshot();
    const panel = element(editor, '[data-plugin-panel="advanced-test.state"]');
    const input = element<HTMLInputElement>(editor, '[data-advanced-draft]'); input.value = 'unsaved prompt';
    editor.showPluginPanel('advanced-test');
    expect(toggle(editor).getAttribute('aria-expanded')).toBe('true');
    expect(element(editor, '[data-advanced-section="extensions"]').getAttribute('aria-pressed')).toBe('true');
    expect(panel.hidden).toBe(false);
    editor.hideAdvancedEditor();
    const pending = editor.executeCommand('advanced-test.wait');
    expect(toggle(editor).getAttribute('aria-expanded')).toBe('true');
    editor.hideAdvancedEditor(); complete();
    expect(await pending).toBe('finished');
    editor.showPluginPanel('advanced-test');
    expect(element(editor, '[data-plugin-panel="advanced-test.state"]')).toBe(panel);
    expect(element<HTMLInputElement>(editor, '[data-advanced-draft]')).toBe(input);
    expect(input.value).toBe('unsaved prompt');
    expect(panel.querySelector('output')!.textContent).toBe('finished');
    expect(mounts).toBe(1); expect(disposals).toBe(0);
    expect(editor.getSnapshot()).toEqual(before);
  });
  it('keeps supported chemical fields for named and multicenter nodes, and excludes invalid attachment controls', () => {
    const editor = mount(), doc = emptyDocument();
    const named = addAtom(doc, '*', {x:0,y:0}, {namedFragment:{type:'Nickname',label:'Custom'},hydrogens:{mode:'fixed',count:1},charge:1,isotope:13});
    const target = addAtom(doc, 'C', {x:2,y:0});
    const multi = addAtom(doc, '*', {x:1,y:0}, {multiAttachment:[target],hydrogens:{mode:'fixed',count:0}});
    const attachment = addAtom(doc, '*', {x:3,y:0}, {attachment:'external',hydrogens:{mode:'fixed',count:0}});
    editor.setDocument(doc);
    for (const id of [named,multi]) {
      editor.setSelection({atomIds:[id]}); editor.showPluginPanel();
      const basic = element(editor,'.inspector-content');
      for (const field of ['charge','isotope','hydrogens']) expect(basic.querySelector(`[data-property="${field}"]`)).not.toBeNull();
      expect(basic.querySelector('[data-property="element"]')).toBeNull();
    }
    editor.setSelection({atomIds:[attachment]}); editor.showAdvancedEditor('properties');
    const advanced = element(editor,'[data-advanced-panel="properties"]');
    expect(advanced.querySelector('[data-property="attachmentIndex"]')).not.toBeNull();
    for (const field of ['atomMap','radical']) expect(advanced.querySelector(`[data-property="${field}"]`)).toBeNull();
    expect(advanced.querySelector('[data-action="record-atom-geometry"]')).toBeNull();
  });

  it('falls back to another enabled panel and to an empty extension view when plugins are removed', () => {
    const plugin = (id:string):EditorPlugin => ({id,name:id,version:'1.0.0',apiVersion:1,activate(context){context.addPanel({id:'view',title:id,mount(container){container.textContent=id;}});}});
    const editor = mount([plugin('first-panel'),plugin('second-panel')]);
    editor.showPluginPanel('first-panel'); editor.setPluginEnabled('first-panel',false);
    expect(element(editor,'[data-plugin-panel="second-panel.view"]').hidden).toBe(false);
    expect(element(editor,'[data-inspector-plugin="second-panel"]').getAttribute('aria-pressed')).toBe('true');
    editor.unregisterPlugin('second-panel');
    expect(element(editor,'.extensions-content').hidden).toBe(false);
    expect(element(editor,'.extensions-content .plugin-empty').hidden).toBe(false);
    expect(editor.shadowRoot!.querySelector('[data-plugin-panel]')).toBeNull();
  });

});
