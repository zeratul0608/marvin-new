import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChemicalEditor, type ChemicalEditorElement } from '../src/editor/chemical-editor';
import { exampleDocument } from '../src/core/templates';

const editors: ChemicalEditorElement[] = [];
const nativeShadowActiveElement = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, 'activeElement')!.get!;
beforeEach(() => {
  // Match the browser focus chain; happy-dom otherwise inspects unrelated shadow roots.
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
function mount() {
  const editor = createChemicalEditor({ container: document.body, document: exampleDocument('ethanol') });
  editors.push(editor);
  const oxygen = Object.values(editor.getDocument().graph.atoms).find(atom => atom.element === 'O')!.id;
  editor.setSelection({ atomIds: [oxygen] }); editor.showPluginPanel();
  const root = editor.shadowRoot!;
  const field = <T extends HTMLElement = HTMLInputElement>(selector: string) => root.querySelector<T>(selector)!;
  return { editor, oxygen, root, field };
}
function change(control: HTMLInputElement | HTMLSelectElement, value: string) {
  control.value = value; control.dispatchEvent(new Event('change', { bubbles: true }));
}
function shortcut(target: HTMLElement, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, composed: true, cancelable: true, ...options });
  target.dispatchEvent(event); return event;
}

describe('property field focus and save shortcuts', () => {
  it('keeps neighboring controls attached through title and isotope blur commits', () => {
    const { editor, oxygen, field } = mount();
    const isotope = field<HTMLInputElement>('#atom-isotope');
    const charge = field<HTMLInputElement>('#atom-charge');
    const hydrogen = field<HTMLSelectElement>('#atom-hydrogens');
    change(field('.document-title'), 'Process ethanol');
    expect(field('#atom-isotope')).toBe(isotope); expect(field('#atom-charge')).toBe(charge);
    isotope.focus(); change(isotope, '18');
    expect(editor.getDocument().graph.atoms[oxygen].isotope).toBe(18);
    expect(field('#atom-isotope')).toBe(isotope); expect(field('#atom-hydrogens')).toBe(hydrogen);
    hydrogen.focus(); change(isotope, '19');
    expect(editor.shadowRoot!.activeElement).toBe(hydrogen);
    charge.focus(); change(charge, '-1');
    expect(editor.getDocument().graph.atoms[oxygen].charge).toBe(-1);
    expect(editor.getDocument().title).toBe('Process ethanol');
  });

  it('commits a focused title before opening the export preview', () => {
    const { editor, field } = mount(); const title = field<HTMLInputElement>('.document-title');
    title.focus(); title.value = 'Unblurred process title';
    const event = shortcut(title, 's');
    expect(event.defaultPrevented).toBe(true);
    expect(editor.getDocument().title).toBe('Unblurred process title');
    expect(field<HTMLDialogElement>('.export-dialog').open).toBe(true);
    expect(JSON.parse(field<HTMLTextAreaElement>('.export-source').value).title).toBe('Unblurred process title');
  });

  it('commits a focused isotope before exporting and keeps native text undo scoped to the field', () => {
    const { editor, oxygen, field } = mount(); const isotope = field<HTMLInputElement>('#atom-isotope');
    isotope.focus(); isotope.value = '18';
    const undo = shortcut(isotope, 'z');
    expect(undo.defaultPrevented).toBe(false); expect(editor.getDocument().graph.atoms[oxygen].isotope).toBeUndefined();
    expect(shortcut(isotope, 's').defaultPrevented).toBe(true);
    expect(editor.getDocument().graph.atoms[oxygen].isotope).toBe(18);
    expect(JSON.parse(field<HTMLTextAreaElement>('.export-source').value).graph.atoms[oxygen].isotope).toBe(18);
  });

  it('does not export the old document when the focused value fails native or model validation', () => {
    const { editor, oxygen, field } = mount(); const isotope = field<HTMLInputElement>('#atom-isotope');
    isotope.focus(); isotope.value = '0'; shortcut(isotope, 's');
    expect(field<HTMLDialogElement>('.export-dialog').open).toBe(false);
    expect(editor.getDocument().graph.atoms[oxygen].isotope).toBeUndefined();
    expect(field('.toast').textContent).toContain('请修正');
    const charge = field<HTMLInputElement>('#atom-charge'); charge.focus(); charge.value = '0.5'; shortcut(charge, 's');
    expect(field<HTMLDialogElement>('.export-dialog').open).toBe(false);
    expect(editor.getDocument().graph.atoms[oxygen].charge).toBe(0);
  });

  it('uses document undo from select and button focus while respecting an open modal and IME', () => {
    const { editor, oxygen, field } = mount(); change(field('#atom-isotope'), '18');
    const hydrogen = field<HTMLSelectElement>('#atom-hydrogens'); hydrogen.focus();
    expect(shortcut(hydrogen, 'z').defaultPrevented).toBe(true);
    expect(editor.getDocument().graph.atoms[oxygen].isotope).toBeUndefined();
    const redo = field<HTMLButtonElement>('[data-action="redo"]'); redo.focus(); shortcut(redo, 'y');
    expect(editor.getDocument().graph.atoms[oxygen].isotope).toBe(18);
    const title = field<HTMLInputElement>('.document-title'); title.focus(); title.value = 'IME draft';
    expect(shortcut(title, 's', { isComposing: true }).defaultPrevented).toBe(false);
    expect(field<HTMLDialogElement>('.export-dialog').open).toBe(false);
    field<HTMLButtonElement>('[data-action="import"]').click();
    const source = field<HTMLTextAreaElement>('.import-source'); source.focus();
    expect(shortcut(source, 's').defaultPrevented).toBe(false);
    expect(field<HTMLDialogElement>('.export-dialog').open).toBe(false);
  });
});
