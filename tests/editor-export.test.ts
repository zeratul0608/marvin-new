import { afterEach, describe, expect, it } from 'vitest';
import { createChemicalEditor } from '../src/editor/chemical-editor';
import { exampleDocument } from '../src/core/templates';

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); });
describe('export preview freshness and loss consent', () => {
  const prepare = (mapped = false) => {
    const doc = exampleDocument('ethanol'); if (mapped) Object.values(doc.graph.atoms)[0].atomMap = 1;
    const editor = createChemicalEditor({ container: document.body, document: doc });
    const root = editor.shadowRoot!;
    root.querySelector<HTMLButtonElement>('[data-action="export"]')!.click();
    const format = root.querySelector<HTMLSelectElement>('.export-format')!, lossy = root.querySelector<HTMLInputElement>('.allow-lossy')!;
    const choose = (value: string) => { format.value = value; format.dispatchEvent(new Event('change', { bubbles: true })); };
    return { editor, root, choose, lossy };
  };
  it('refreshes an open JSON preview after the API edits the structure', () => {
    const { editor, root } = prepare();
    const oxygen = Object.values(editor.getDocument().graph.atoms).find(a => a.element === 'O')!;
    editor.applyEdits({ operations: [{ type: 'update-atom', atomId: oxygen.id, changes: { isotope: 18 } }] });
    const preview = JSON.parse(root.querySelector<HTMLTextAreaElement>('.export-source')!.value);
    expect(preview.graph.atoms[oxygen.id].isotope).toBe(18);
    editor.destroy();
  });
  it('does not carry lossy consent over to a different format and back', () => {
    const { editor, root, choose, lossy } = prepare(true);
    choose('cdxml'); expect(root.querySelector<HTMLButtonElement>('[data-action="download-export"]')!.disabled).toBe(true);
    lossy.checked = true; lossy.dispatchEvent(new Event('change', { bubbles: true }));
    expect(root.querySelector<HTMLButtonElement>('[data-action="download-export"]')!.disabled).toBe(false);
    choose('mol'); choose('cdxml');
    expect(lossy.checked).toBe(false); expect(root.querySelector<HTMLButtonElement>('[data-action="download-export"]')!.disabled).toBe(true);
    editor.destroy();
  });
  it('requires fresh consent if the current document changes while a lossy preview is open', () => {
    const { editor, root, choose, lossy } = prepare(true); choose('cdxml');
    lossy.checked = true; lossy.dispatchEvent(new Event('change', { bubbles: true }));
    editor.applyEdits({ operations: [{ type: 'rename', title: 'Updated structure' }] });
    expect(lossy.checked).toBe(false);
    expect(root.querySelector<HTMLTextAreaElement>('.export-source')!.value).toBe('');
    expect(root.querySelector<HTMLButtonElement>('[data-action="download-export"]')!.disabled).toBe(true);
    editor.destroy();
  });
});
