import { afterEach, describe, expect, it } from 'vitest';
import { createChemicalEditor, registerChemicalEditor } from '../src/editor/chemical-editor';
import { exampleDocument } from '../src/core/templates';
import { exportDocument } from '../src/formats';

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); });
describe('embeddable editor SDK', () => {
  it('isolates DOM, document state and history between editor instances', () => {
    const first = document.createElement('div'), second = document.createElement('div');
    document.body.append(first, second);
    const a = createChemicalEditor({ container: first, document: exampleDocument('ethanol') });
    const b = createChemicalEditor({ container: second, document: exampleDocument('benzene') });
    expect(a.shadowRoot).not.toBe(b.shadowRoot);
    expect(Object.keys(a.getDocument().graph.atoms)).toHaveLength(3);
    expect(Object.keys(b.getDocument().graph.atoms)).toHaveLength(6);
    a.setDocument(exampleDocument('aspirin')); a.undo();
    expect(Object.keys(a.getDocument().graph.atoms)).toHaveLength(3);
    expect(Object.keys(b.getDocument().graph.atoms)).toHaveLength(6);
    a.destroy(); expect(first.children).toHaveLength(0);
  });
  it('emits changes once, including after detach/reconnect, and preserves state on failed import', () => {
    const container = document.createElement('div'); document.body.append(container);
    const editor = createChemicalEditor({ container });
    let events = 0; editor.addEventListener('change', () => events++);
    editor.import({ data: exportDocument(exampleDocument('ethanol'), { format: 'mrv' }).data });
    expect(events).toBe(1);
    const original = editor.getDocument();
    expect(() => editor.import({ data: '<CDXML><scheme/></CDXML>' })).toThrow();
    expect(editor.getDocument()).toEqual(original);
    editor.remove(); container.append(editor);
    editor.setDocument(exampleDocument('benzene'));
    expect(events).toBe(2);
  });
  it('restores native drafts only when storage is explicitly enabled', () => {
    const container = document.createElement('div'); document.body.append(container);
    const editor = createChemicalEditor({ container, storageKey: 'test-draft', document: exampleDocument('caffeine') });
    const original = editor.getDocument(); editor.destroy();
    const restored = createChemicalEditor({ container, storageKey: 'test-draft' });
    expect(restored.restored).toBe(true); expect(restored.getDocument()).toEqual(original);
    const fresh = createChemicalEditor({ container });
    expect(Object.keys(fresh.getDocument().graph.atoms)).toHaveLength(0);
  });
  it('supports an application-specific custom-element tag alongside the default tag', () => {
    registerChemicalEditor('business-chemical-editor');
    const custom = document.createElement('business-chemical-editor'); document.body.append(custom);
    expect(custom.shadowRoot?.querySelector('svg.canvas')).not.toBeNull();
  });
  it('applies batch property edits in one transaction and keeps another instance isolated', () => {
    const container = document.createElement('div'); document.body.append(container);
    const editor = createChemicalEditor({ container, document: exampleDocument('ethanol') });
    const second = createChemicalEditor({ container, document: exampleDocument('benzene') });
    const original = editor.getDocument(), other = second.getDocument();
    editor.shadowRoot!.querySelector<HTMLButtonElement>('[data-action="select-all"]')!.click();
    let changes = 0; editor.addEventListener('change', () => changes++);
    const charge = editor.shadowRoot!.querySelector<HTMLInputElement>('#batch-charge')!;
    charge.value = '1'; charge.dispatchEvent(new Event('change', { bubbles: true }));
    expect(Object.values(editor.getDocument().graph.atoms).every(atom => atom.charge === 1)).toBe(true);
    expect(changes).toBe(1);
    expect(second.getDocument()).toEqual(other);
    editor.undo(); expect(editor.getDocument()).toEqual(original);
  });
  it('loads preview templates through the UI and can undo back to the previous document', () => {
    const container = document.createElement('div'); document.body.append(container);
    const editor = createChemicalEditor({ container, document: exampleDocument('ethanol') });
    const original = editor.getDocument();
    editor.shadowRoot!.querySelector<HTMLButtonElement>('[data-sample="caffeine"]')!.click();
    expect(editor.getDocument().title).toBe('咖啡因');
    editor.undo(); expect(editor.getDocument()).toEqual(original);
  });
});
