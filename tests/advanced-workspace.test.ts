import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChemicalEditor, type ChemicalEditorElement } from '../src/editor/chemical-editor';
import type { EditorPlugin } from '../src/editor/api-types';
import { exampleDocument } from '../src/core/templates';

const editors: ChemicalEditorElement[] = [];
const nativeShadowActiveElement = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, 'activeElement')!.get!;
beforeEach(() => {
  // happy-dom 20 does not stop at Document when inspecting unrelated shadow roots.
  // Match the browser's focus chain without adding error handling to the editor.
  vi.spyOn(ShadowRoot.prototype, 'activeElement', 'get').mockImplementation(function (this: ShadowRoot) {
    let focused: Element | null = this.ownerDocument.activeElement;
    while (focused) {
      const root = focused === this.host ? this : focused.shadowRoot;
      if (!root) return null;
      const active = nativeShadowActiveElement.call(root) as Element | null;
      if (root === this) return active;
      focused = active;
    }
    return null;
  });
});
afterEach(() => {
  editors.splice(0).forEach(editor => editor.destroy());
  document.body.replaceChildren(); vi.restoreAllMocks();
});
function mount(plugins: EditorPlugin[] = []) {
  const editor = createChemicalEditor({ container: document.body, document: exampleDocument('ethanol'), plugins });
  editors.push(editor); editor.setSelection({ atomIds: [Object.keys(editor.getDocument().graph.atoms)[0]] });
  editor.showPluginPanel(); return editor;
}
function element<T extends HTMLElement = HTMLElement>(editor: ChemicalEditorElement, selector: string): T {
  const result = editor.shadowRoot!.querySelector<T>(selector);
  expect(result, selector).not.toBeNull(); return result!;
}
function key(target: HTMLElement, value: string) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, composed: true }));
}

describe('advanced workspace navigation and drafts', () => {
  it('retains form nodes, unsubmitted drafts and disclosure state while navigating the same selection', () => {
    const editor = mount(), before = editor.getSnapshot();
    const isotope = element<HTMLInputElement>(editor, '#atom-isotope'); isotope.value = '17';
    editor.showAdvancedEditor('fragments');
    const collapse = element<HTMLInputElement>(editor, '[data-collapse-label]'); collapse.value = 'Draft label';
    const collapseDetails = element<HTMLDetailsElement>(editor, '.collapse-controls'); collapseDetails.open = true;
    editor.showAdvancedEditor('properties');
    const annotation = element<HTMLDetailsElement>(editor, '[data-advanced-panel="properties"] details'); annotation.open = true;
    editor.showAdvancedEditor('queries'); editor.showPluginPanel(); editor.hideAdvancedEditor();
    expect(element(editor, '#atom-isotope')).toBe(isotope); expect(isotope.value).toBe('17');
    editor.showAdvancedEditor('properties');
    expect(element(editor, '[data-advanced-panel="properties"] details')).toBe(annotation);
    expect(annotation.open).toBe(true);
    editor.showAdvancedEditor('fragments');
    expect(element(editor, '[data-collapse-label]')).toBe(collapse); expect(collapse.value).toBe('Draft label');
    expect(collapseDetails.open).toBe(true); expect(editor.getSnapshot()).toEqual(before);
  });

  it('keeps a separate advanced scroll position for each category', () => {
    const editor = mount(); editor.showAdvancedEditor('properties');
    const content = element(editor, '.advanced-content'); content.scrollTop = 170;
    editor.showAdvancedEditor('queries'); content.scrollTop = 55;
    editor.showAdvancedEditor('fragments'); content.scrollTop = 24;
    editor.showAdvancedEditor('properties'); expect(content.scrollTop).toBe(170);
    editor.showAdvancedEditor('queries'); expect(content.scrollTop).toBe(55);
    editor.hideAdvancedEditor(); editor.showAdvancedEditor('queries'); expect(content.scrollTop).toBe(55);
    editor.showAdvancedEditor('fragments'); expect(content.scrollTop).toBe(24);
  });

  it('invalidates old form drafts when the selected object or document revision changes', () => {
    const editor = mount(), ids = Object.keys(editor.getDocument().graph.atoms);
    editor.showAdvancedEditor('fragments');
    const first = element<HTMLInputElement>(editor, '[data-collapse-label]'); first.value = 'Only first atom';
    editor.setSelection({ atomIds: [ids[1]] });
    const second = element<HTMLInputElement>(editor, '[data-collapse-label]');
    expect(second).not.toBe(first); expect(second.value).toBe('');
    second.value = 'Uncommitted second atom';
    editor.applyEdits({ operations: [{ type: 'update-atom', atomId: ids[1], changes: { isotope: 13 } }] });
    const revised = element<HTMLInputElement>(editor, '[data-collapse-label]');
    expect(revised).not.toBe(second); expect(revised.value).toBe('');
    editor.showPluginPanel(); expect(element<HTMLInputElement>(editor, '#atom-isotope').value).toBe('13');
    editor.undo(); expect(element<HTMLInputElement>(editor, '#atom-isotope').value).toBe('');
  });

  it('moves category focus with arrows, Home and End without changing the selected category', () => {
    const editor = mount(); editor.showAdvancedEditor('properties');
    const categories = [...editor.shadowRoot!.querySelectorAll<HTMLButtonElement>('[data-advanced-section]')];
    expect(categories.filter(button => button.tabIndex === 0)).toHaveLength(1);
    categories[0].focus(); key(categories[0], 'ArrowRight');
    expect(editor.shadowRoot!.activeElement).toBe(categories[1]);
    expect(categories.filter(button => button.tabIndex === 0)).toEqual([categories[1]]);
    expect(categories[0].getAttribute('aria-pressed')).toBe('true');
    expect(categories[1].getAttribute('aria-pressed')).toBe('false');
    key(categories[1], 'End'); expect(editor.shadowRoot!.activeElement).toBe(categories.at(-1));
    key(categories.at(-1)!, 'Home'); expect(editor.shadowRoot!.activeElement).toBe(categories[0]);
    key(categories[0], 'ArrowLeft'); expect(editor.shadowRoot!.activeElement).toBe(categories.at(-1));
    categories[1].click(); expect(categories[1].getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps keyboard focus on the selected basic inspector button', () => {
    const editor = mount(); editor.showAdvancedEditor('queries');
    const basic = element<HTMLButtonElement>(editor, '.inspector-tabs [data-inspector-plugin=""]');
    basic.focus(); basic.click();
    expect(editor.shadowRoot!.activeElement?.getAttribute('data-inspector-plugin')).toBe('');
    expect(element(editor, '.inspector-content').hidden).toBe(false);
    expect(element(editor, '#advanced-tools').hidden).toBe(false);
  });

  it('uses the same roving keyboard navigation for plugin panels', () => {
    const plugin = (id: string): EditorPlugin => ({ id, name: id, version: '1.0.0', apiVersion: 1, activate(context) {
      context.addPanel({ id: 'view', title: id, mount(container) { container.textContent = id; } });
    } });
    const editor = mount([plugin('first-panel'), plugin('second-panel')]); editor.showPluginPanel('first-panel');
    const tabs = [...editor.shadowRoot!.querySelectorAll<HTMLButtonElement>('.extension-tabs button')];
    expect(tabs.filter(button => button.tabIndex === 0)).toHaveLength(1);
    tabs[0].focus(); key(tabs[0], 'ArrowRight');
    expect(editor.shadowRoot!.activeElement).toBe(tabs[1]); expect(tabs[0].getAttribute('aria-pressed')).toBe('true');
    expect(tabs.filter(button => button.tabIndex === 0)).toEqual([tabs[1]]);
    tabs[1].click(); expect(element(editor, '[data-plugin-panel="second-panel.view"]').hidden).toBe(false);
  });

  it.each([
    ['原子映射', 'properties'], ['聚合物', 'document'], ['内部结构', 'fragments'], ['查询', 'queries'],
  ])('discovers %s through Ctrl K and opens the corresponding advanced category', (query, section) => {
    const editor = mount(), before = editor.getSnapshot();
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, composed: true }));
    expect(element<HTMLDialogElement>(editor, '.search-dialog').open).toBe(true);
    const search = element<HTMLInputElement>(editor, '.command-search'); search.value = query;
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const result = element<HTMLButtonElement>(editor, '.search-results [data-command]'); result.click();
    expect(element<HTMLDialogElement>(editor, '.search-dialog').open).toBe(false);
    expect(element(editor, `[data-advanced-section="${section}"]`).getAttribute('aria-pressed')).toBe('true');
    expect(element(editor, `[data-advanced-panel="${section}"]`).hidden).toBe(false);
    expect(editor.getSnapshot()).toEqual(before);
  });
});
