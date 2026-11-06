import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChemicalEditor, type ChemicalEditorElement } from '../src/editor/chemical-editor';
import { createAiAssistantPlugin } from '../src/plugins/ai-assistant';
import { AI_PROMPT_PRESETS } from '../src/ai/prompts';
import type { AiCompletionRequest, AiTransport, AiTurn } from '../src/ai/types';
import type { EditorLocale } from '../src/editor/i18n';
import { exampleDocument } from '../src/core/templates';

const editors: ChemicalEditorElement[] = [];
const nativeShadowActiveElement = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, 'activeElement')!.get!;
beforeEach(() => {
  vi.spyOn(ShadowRoot.prototype, 'activeElement', 'get').mockImplementation(function (this: ShadowRoot) {
    let focused: Element | null = this.ownerDocument.activeElement;
    while (focused) { const root = focused === this.host ? this : focused.shadowRoot; if (!root) return null; const active = nativeShadowActiveElement.call(root) as Element | null; if (root === this) return active; focused = active; }
    return null;
  });
});
afterEach(() => { editors.splice(0).forEach(editor => editor.destroy()); document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); });

function mount(options: { locale?: EditorLocale; complete?: (request: AiCompletionRequest, signal?: AbortSignal) => Promise<AiTurn>; rename?: string } = {}) {
  let editor: ChemicalEditorElement, rounds = 0;
  const requests: AiCompletionRequest[] = [];
  const transport: AiTransport = { complete: vi.fn(async (request, signal) => {
    requests.push(structuredClone(request));
    if (options.complete) return options.complete(request, signal);
    rounds++;
    if (rounds === 1) {
      const oxygen = Object.values(editor.getDocument().graph.atoms).find(atom => atom.element === 'O')!.id;
      const operations = options.rename ? [{ type: 'rename', title: options.rename }] : [{ type: 'update-atom', atomId: oxygen, changes: { isotope: 18 } }];
      return { text: '', toolCalls: [{ id: 'edit-one', name: 'apply_edits', arguments: JSON.stringify({ expectedRevision: editor.getSnapshot().revision, operations }) }] };
    }
    return { text: 'Changed the requested structure.', toolCalls: [] };
  }) };
  editor = createChemicalEditor({ container: document.body, document: exampleDocument('ethanol'), locale: options.locale, plugins: [createAiAssistantPlugin({ transport })] });
  editors.push(editor); editor.showPluginPanel('ai-assistant');
  const find = <T extends HTMLElement = HTMLElement>(selector: string) => { const result = editor.shadowRoot!.querySelector<T>(selector); expect(result, selector).not.toBeNull(); return result!; };
  const field = <T extends HTMLElement = HTMLInputElement>(name: string) => find<T>(`[data-ai-field="${name}"]`);
  const action = (name: string) => find<HTMLButtonElement>(`[data-ai-action="${name}"]`);
  const submit = (text = '把氧标记为氧-18') => { field<HTMLTextAreaElement>('message').value = text; field('message').closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); };
  const finished = () => vi.waitFor(() => expect(action('stop').disabled).toBe(true));
  const pending = () => vi.waitFor(() => expect(find('.ai-edit-preview').dataset.reviewState).toBe('pending'));
  const oxygen = () => Object.values(editor.getDocument().graph.atoms).find(atom => atom.element === 'O')!;
  return { editor, find, field, action, submit, finished, pending, oxygen, requests, transport };
}

describe('AI editing upgrade with the real runner and editor', () => {
  it('keeps direct editing as the default and commits one undoable batch', async () => {
    const app = mount(), before = app.editor.getDocument();
    expect(app.field<HTMLInputElement>('preview-edits').checked).toBe(false);
    app.submit(); await app.finished();
    expect(app.oxygen().isotope).toBe(18);
    expect(app.editor.shadowRoot!.querySelector('.ai-edit-preview')).toBeNull();
    expect(app.requests).toHaveLength(2);
    app.editor.undo(); expect(app.editor.getDocument()).toEqual(before);
  });

  it('waits for visible preview approval, then applies the real batch and retains undo', async () => {
    const app = mount(), before = app.editor.getSnapshot(), svg = app.editor.exportSvg();
    app.field<HTMLInputElement>('preview-edits').checked = true; app.submit(); await app.pending();
    expect(app.editor.getSnapshot()).toEqual(before); expect(app.editor.exportSvg()).toBe(svg);
    expect(app.action('approve-edit').disabled).toBe(false);
    expect(app.field<HTMLInputElement>('allow-edits').disabled).toBe(true);
    expect(app.field<HTMLInputElement>('preview-edits').disabled).toBe(true);
    expect(app.action('send').disabled).toBe(true);
    app.action('approve-edit').click(); await app.finished();
    expect(app.oxygen().isotope).toBe(18);
    expect(app.find('.ai-edit-preview').dataset.reviewState).toBe('applied');
    expect(app.field<HTMLInputElement>('allow-edits').disabled).toBe(false);
    expect(app.field<HTMLInputElement>('preview-edits').disabled).toBe(false);
    app.editor.undo(); expect(app.editor.getDocument()).toEqual(before.document);
  });

  it('rejects a pending batch and ends the run without another model request or mutation', async () => {
    const app = mount(), before = app.editor.getSnapshot();
    app.field<HTMLInputElement>('preview-edits').checked = true; app.submit(); await app.pending();
    app.action('reject-edit').click(); await app.finished();
    expect(app.editor.getSnapshot()).toEqual(before); expect(app.requests).toHaveLength(1);
    expect(app.find('.ai-edit-preview').dataset.reviewState).toBe('rejected');
    expect(app.find('.ai-status').textContent).toContain('未应用');
  });

  it('disables approval after manual edits and never replaces the newer canvas', async () => {
    const app = mount(); app.field<HTMLInputElement>('preview-edits').checked = true; app.submit(); await app.pending();
    app.editor.applyEdits({ operations: [{ type: 'rename', title: 'New manual version' }] });
    const changed = app.editor.getSnapshot();
    expect(app.action('approve-edit').disabled).toBe(true); expect(app.find('.ai-preview-status').textContent).toContain('画布已变化');
    app.action('approve-edit').click(); expect(app.editor.getSnapshot()).toEqual(changed);
    app.action('reject-edit').click(); await app.finished();
    expect(app.editor.getSnapshot()).toEqual(changed); expect(app.oxygen().isotope).toBeUndefined();
  });

  it('stops while review is pending and does not apply or continue the model loop', async () => {
    const app = mount(), before = app.editor.getSnapshot();
    app.field<HTMLInputElement>('preview-edits').checked = true; app.submit(); await app.pending(); app.action('stop').click();
    await app.finished(); await vi.waitFor(() => expect(app.find('.ai-review-slot').hidden).toBe(true));
    expect(app.editor.getSnapshot()).toEqual(before); expect(app.requests).toHaveLength(1);
    expect(app.field<HTMLInputElement>('allow-edits').disabled).toBe(false);
    expect(app.field<HTMLTextAreaElement>('message').value).toBe('把氧标记为氧-18');
  });

  it('preserves a newer message draft when a request fails and restores the old request only when cleared', async () => {
    let fail!: (error: Error) => void;
    const app = mount({ complete: () => new Promise((_resolve, reject) => { fail = reject; }) });
    const before = app.editor.getSnapshot(); app.submit('Original request');
    await vi.waitFor(() => expect(app.requests).toHaveLength(1));
    app.field<HTMLTextAreaElement>('message').value = 'A newer unsent draft'; fail(new Error('offline'));
    await app.finished(); expect(app.field<HTMLTextAreaElement>('message').value).toBe('A newer unsent draft');
    expect(app.action('restore-request').hidden).toBe(false); app.action('restore-request').click();
    expect(app.field<HTMLTextAreaElement>('message').value).toBe('A newer unsent draft');
    app.field<HTMLTextAreaElement>('message').value = ''; app.action('restore-request').click();
    expect(app.field<HTMLTextAreaElement>('message').value).toBe('Original request'); expect(app.editor.getSnapshot()).toEqual(before);
  });

  it('uses English preset instructions and runner language when the editor locale is English', async () => {
    const app = mount({ locale: 'en', complete: async () => ({ text: 'Inspected without edits.', toolCalls: [] }) });
    app.find<HTMLButtonElement>('.ai-presets button').click();
    expect(app.field<HTMLTextAreaElement>('message').value).toBe(AI_PROMPT_PRESETS[0].messageEn);
    expect(app.field<HTMLTextAreaElement>('message').value).not.toMatch(/[\u3400-\u9fff]/u);
    app.submit(app.field<HTMLTextAreaElement>('message').value); await app.finished();
    expect(app.requests[0].systemPrompt).toContain('Reply in concise English');
    app.editor.setLocale('zh-CN'); app.find<HTMLButtonElement>('.ai-presets button').click();
    expect(app.field<HTMLTextAreaElement>('message').value).toBe(AI_PROMPT_PRESETS[0].message);
  });

  it('renders preview diagrams as inert image URLs and preserves hostile source text as text', async () => {
    const injection = '<img src=x onerror="globalThis.PREVIEW_PWNED=true"><script>globalThis.PREVIEW_PWNED=true</script>';
    const app = mount({ rename: injection }); app.field<HTMLInputElement>('preview-edits').checked = true; app.submit('Change title'); await app.pending();
    const preview = app.find('.ai-edit-preview');
    expect(preview.querySelector('svg')).toBeNull(); expect(preview.querySelector('script')).toBeNull();
    const images = [...preview.querySelectorAll('img')]; expect(images).toHaveLength(2);
    for (const image of images) expect(image.src).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(preview.textContent).toContain('<img'); expect((globalThis as Record<string, unknown>).PREVIEW_PWNED).toBeUndefined();
    app.action('reject-edit').click(); await app.finished();
    expect(app.editor.getDocument().title).toBe('乙醇');
  });
});
