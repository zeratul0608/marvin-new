import {afterEach, describe, expect, it} from 'vitest';
import {createChemicalEditor, type ChemicalEditorElement} from '../src/editor/chemical-editor';
import {exampleDocument} from '../src/core/templates';

const editors: ChemicalEditorElement[] = [];
afterEach(() => {
  editors.splice(0).forEach(editor => editor.destroy());
  document.body.replaceChildren(); localStorage.clear(); sessionStorage.clear();
});
const mount = (storageKey?: string) => {
  const editor = createChemicalEditor({container: document.body, storageKey});
  editors.push(editor); return editor;
};

describe('draft recovery UI and legacy migration', () => {
  it('does not offer persistent recovery when the host did not enable storage', () => {
    const editor = mount();
    expect(editor.shadowRoot!.querySelector<HTMLButtonElement>('.draft-versions-toggle')!.hidden).toBe(true);
  });

  it('retains the old raw draft while making it available in recovery and restoring with undo', async () => {
    const legacy = exampleDocument('ethanol'), raw = JSON.stringify(legacy);
    localStorage.setItem('legacy-draft', raw);
    const editor = mount('legacy-draft'), root = editor.shadowRoot!;
    expect(editor.restored).toBe(true); expect(editor.getDocument()).toEqual(legacy);
    const current = exampleDocument('caffeine'); editor.setDocument(current);
    root.querySelector<HTMLButtonElement>('[data-action="draft-versions"]')!.click();
    await expect.poll(() => root.querySelectorAll('[data-draft-restore]').length).toBeGreaterThanOrEqual(2);
    const version = [...root.querySelectorAll<HTMLElement>('.draft-version')].find(row => row.querySelector('strong')!.textContent === legacy.title)!;
    expect(version).toBeDefined(); version.querySelector<HTMLButtonElement>('button')!.click();
    expect(editor.getDocument()).toEqual(legacy);
    expect(root.querySelector<HTMLDialogElement>('.draft-versions-dialog')!.open).toBe(false);
    editor.undo(); expect(editor.getDocument()).toEqual(current);
    expect(localStorage.getItem('legacy-draft')).toBe(raw);
  });

  it('reports a corrupt legacy entry without removing it', () => {
    const corrupt = '{broken'; localStorage.setItem('broken-draft', corrupt);
    const editor = mount('broken-draft');
    expect(editor.restored).toBe(false);
    expect(localStorage.getItem('broken-draft')).toBe(corrupt);
    expect(editor.shadowRoot!.querySelector('.toast')!.textContent).toContain('原记录已保留');
  });
});
