import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiModelConfig, AiRunOptions, AiRunResult } from '../src/ai/types';
import type { EditorApi, PluginCommand, PluginContext } from '../src/editor/api-types';
import { createAiAssistantPlugin } from '../src/plugins/ai-assistant';
import { exampleDocument } from '../src/core/templates';
import { getAiEditorContext } from '../src/ai/context';

const mocks = vi.hoisted(() => ({ getConfig: vi.fn(), saveConfig: vi.fn(), test: vi.fn(), run: vi.fn() }));
vi.mock('../src/ai/client', () => ({ createAiClient: () => ({ ...mocks, transport: { complete: vi.fn() } }) }));
vi.mock('../src/ai/assistant', () => ({ runAiAssistant: (...args: unknown[]) => mocks.run(...args) }));

const configured: AiModelConfig = { protocol: 'responses', baseUrl: 'https://example.com/v1', model: 'test-model', hasApiKey: true };
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function fixture(customTransport = false) {
  const container = document.createElement('div'); document.body.append(container);
  const commands = new Map<string, PluginCommand>();
  const snapshot = { apiVersion: 1 as const, revision: 0, document: exampleDocument('ethanol'), selection: { atomIds: [] as string[] }, canUndo: false, canRedo: false };
  const editor = { getSnapshot: vi.fn(() => structuredClone(snapshot)), getDiagnostics: vi.fn(() => []) } as unknown as EditorApi;
  const listeners = new Map<string, () => void>();
  let unmount: (() => void) | undefined;
  const context: PluginContext = {
    apiVersion: 1, editor, notify: vi.fn(), on: (type, listener) => {
      listeners.set(type, listener as () => void); return () => { listeners.delete(type); };
    },
    registerCommand: command => { commands.set(command.id, command); return () => { commands.delete(command.id); }; },
    addPanel: panel => { unmount = panel.mount(container) ?? undefined; return () => unmount?.(); },
  };
  const plugin = createAiAssistantPlugin(customTransport ? { transport: { complete: vi.fn() } } : undefined);
  const cleanup = plugin.activate(context);
  const field = <T extends HTMLElement>(name: string) => container.querySelector<T>(`[data-ai-field="${name}"]`)!;
  const action = (name: string) => container.querySelector<HTMLButtonElement>(`[data-ai-action="${name}"]`)!;
  const submit = () => field<HTMLTextAreaElement>('message').closest('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  const dispose = () => { if (typeof cleanup === 'function') cleanup(); };
  return { container, field, action, submit, dispose, editor, commands, snapshot, listeners };
}

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  mocks.getConfig.mockResolvedValue(configured); mocks.saveConfig.mockResolvedValue(configured);
  mocks.test.mockResolvedValue({ ok: true, message: 'ready' });
  mocks.run.mockResolvedValue({ messages: [{ role: 'user', content: 'test' }], text: '已完成', toolCount: 0 });
});
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.unstubAllGlobals(); });

describe('AI assistant plugin UI', () => {
  it('previews source-free current context and updates after manual edits and selection changes', async () => {
    const app = fixture(); await flush();
    const preview = app.container.querySelector<HTMLDetailsElement>('.ai-context')!;
    preview.open = true; preview.dispatchEvent(new Event('toggle'));
    expect(JSON.parse(preview.querySelector('pre')!.textContent!)).toEqual(getAiEditorContext(app.editor));
    app.snapshot.revision++;
    app.snapshot.document.title = '人工编辑后的分子';
    app.snapshot.document.source = { format: 'mrv', raw: 'PRIVATE SOURCE', fingerprint: '', issues: [] };
    app.listeners.get('change')!();
    app.snapshot.selection.atomIds = [Object.keys(app.snapshot.document.graph.atoms)[0]];
    app.listeners.get('selectionchange')!();
    expect(preview.textContent).toContain('人工编辑后的分子');
    expect(preview.textContent).toContain('已选 1 个原子');
    expect(preview.textContent).not.toContain('PRIVATE SOURCE');
    expect(JSON.parse(preview.querySelector('pre')!.textContent!).snapshot.revision).toBe(1);
    app.dispose(); expect(app.listeners.size).toBe(0);
  });

  it('saves the currently entered connection before testing and does not test failed saves', async () => {
    const app = fixture(); await flush();
    app.field<HTMLInputElement>('model').value = 'new-model';
    app.field<HTMLInputElement>('base-url').value = 'http://localhost:1234/v1';
    app.field<HTMLInputElement>('api-key').value = 'new-secret';
    app.action('test').click(); await flush();
    expect(mocks.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ model: 'new-model', baseUrl: 'http://localhost:1234/v1', apiKey: 'new-secret' }), expect.any(AbortSignal));
    expect(mocks.test).toHaveBeenCalledTimes(1);
    expect(mocks.saveConfig.mock.invocationCallOrder[0]).toBeLessThan(mocks.test.mock.invocationCallOrder[0]);
    expect(app.container.textContent).toContain('连接成功');
    mocks.saveConfig.mockRejectedValueOnce(new Error('invalid config'));
    app.action('test').click(); await flush();
    expect(mocks.test).toHaveBeenCalledTimes(1);
    expect(app.container.textContent).toContain('保存失败');
    app.dispose();
  });

  it('saves credentials only through the service and stores only custom instructions in the browser', async () => {
    const app = fixture(); await flush();
    expect(app.field<HTMLInputElement>('api-key').value).toBe('');
    expect(app.container.textContent).toContain('example.com');
    await app.commands.get('settings')!.execute();
    expect(app.container.querySelector<HTMLElement>('[data-ai-view="settings"]')!.hidden).toBe(false);
    app.field<HTMLInputElement>('api-key').value = 'private-session-key';
    app.field<HTMLInputElement>('model').value = 'custom-model';
    app.action('save').closest('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(app.field<HTMLInputElement>('api-key').value).toBe('');
    await flush();
    expect(mocks.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'private-session-key', model: 'custom-model' }), expect.any(AbortSignal));
    expect(app.container.textContent).not.toContain('private-session-key');
    expect(localStorage.length).toBe(0);
    app.field<HTMLInputElement>('clear-key').checked = true;
    app.field<HTMLInputElement>('clear-key').dispatchEvent(new Event('change'));
    expect(app.field<HTMLInputElement>('api-key').disabled).toBe(true);
    app.action('save').closest('form')!.dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(mocks.saveConfig.mock.calls[1][0]).toEqual(expect.objectContaining({ clearKey: true }));
    expect(mocks.saveConfig.mock.calls[1][0]).not.toHaveProperty('apiKey');
    app.field<HTMLTextAreaElement>('instructions').value = '只修改选区';
    app.field<HTMLTextAreaElement>('instructions').dispatchEvent(new Event('input'));
    expect(localStorage.getItem('molecule-ai:instructions:v1')).toBe('只修改选区');
    expect(localStorage.length).toBe(1);
    app.dispose();
  });

  it('passes edit permission, instructions and completed history while rendering model text as text', async () => {
    const app = fixture(); await flush();
    const attack = '<img src=x onerror=alert(1)>';
    mocks.run.mockImplementationOnce(async (_editor: EditorApi, _transport: unknown, options: AiRunOptions) => {
      options.onEvent?.({ type: 'tool-start', id: 't1', name: 'get_snapshot', arguments: '{"rawPayload":"PRIVATE"}' });
      options.onEvent?.({ type: 'tool-end', id: 't1', name: 'get_snapshot', ok: true, summary: '读取结构' });
      options.onEvent?.({ type: 'assistant', text: attack });
      return { messages: [{ role: 'user', content: '第一步' }, { role: 'assistant', content: attack }], text: attack, toolCount: 1 };
    });
    app.field<HTMLTextAreaElement>('message').value = '第一步';
    app.field<HTMLInputElement>('allow-edits').checked = false;
    app.field<HTMLTextAreaElement>('instructions').value = '自定义要求';
    app.submit(); await flush();
    expect(mocks.run).toHaveBeenCalledWith(app.editor, expect.anything(), expect.objectContaining({ message: '第一步', instructions: '自定义要求', allowEdits: false, history: [] }));
    expect(app.container.querySelector('img')).toBeNull();
    expect(app.container.textContent).toContain(attack);
    expect(app.container.textContent).not.toContain('rawPayload');
    expect(app.container.querySelectorAll('.ai-message-assistant')).toHaveLength(1);
    app.field<HTMLTextAreaElement>('message').value = '第二步'; app.submit(); await flush();
    expect(mocks.run.mock.calls[1][2].history).toHaveLength(2);
    app.dispose();
  });

  it('prevents duplicate sends and blocks late results after stop or disable', async () => {
    const app = fixture(); await flush();
    let resolve!: (result: AiRunResult) => void;
    let runningOptions!: AiRunOptions;
    mocks.run.mockImplementationOnce((_editor: EditorApi, _transport: unknown, options: AiRunOptions) => {
      runningOptions = options;
      return new Promise<AiRunResult>(done => { resolve = done; });
    });
    app.field<HTMLTextAreaElement>('message').value = '修改'; app.submit();
    app.field<HTMLTextAreaElement>('message').value = '重复'; app.submit();
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(app.action('save').disabled).toBe(true); expect(app.action('test').disabled).toBe(true);
    app.action('save').closest('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(mocks.saveConfig).not.toHaveBeenCalled();
    app.action('stop').click(); expect(runningOptions.signal?.aborted).toBe(true);
    runningOptions.onEvent?.({ type: 'assistant', text: '停止后的过期消息' });
    resolve({ messages: [], text: '停止后的结果', toolCount: 1 }); await flush();
    expect(app.container.textContent).not.toContain('停止后的');
    expect(app.container.textContent).toContain('已停止');
    expect(app.action('send').disabled).toBe(false);
    let disableOptions!: AiRunOptions;
    mocks.run.mockImplementationOnce((_editor: EditorApi, _transport: unknown, options: AiRunOptions) => {
      disableOptions = options; return new Promise(() => undefined);
    });
    app.field<HTMLTextAreaElement>('message').value = '继续'; app.submit(); app.dispose();
    expect(disableOptions.signal?.aborted).toBe(true);
    disableOptions.onEvent?.({ type: 'assistant', text: '销毁后追加' });
    expect(app.container.children).toHaveLength(0);
  });

  it('clears pending conversation without permitting late events and releases download URLs', async () => {
    const createObjectURL = vi.fn(() => 'blob:artifact'); const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', class extends URL { static createObjectURL = createObjectURL; static revokeObjectURL = revokeObjectURL; });
    const app = fixture(); await flush();
    let runningOptions!: AiRunOptions;
    mocks.run.mockImplementationOnce((_editor: EditorApi, _transport: unknown, options: AiRunOptions) => {
      runningOptions = options;
      options.onEvent?.({ type: 'artifact', artifact: { name: 'structure.svg', mimeType: 'image/svg+xml', data: '<svg/>' } });
      return new Promise(() => undefined);
    });
    app.field<HTMLTextAreaElement>('message').value = '导出'; app.submit();
    expect(app.container.querySelector<HTMLAnchorElement>('a.ai-download')?.download).toBe('structure.svg');
    app.action('clear').click();
    expect(runningOptions.signal?.aborted).toBe(true); expect(revokeObjectURL).toHaveBeenCalledWith('blob:artifact');
    runningOptions.onEvent?.({ type: 'assistant', text: '过期内容' });
    expect(app.container.textContent).not.toContain('过期内容');
    expect(app.container.querySelector('a.ai-download')).toBeNull();
    app.dispose();
  });

  it('keeps model settings editable when the local proxy is not available and does not fake a response', async () => {
    mocks.getConfig.mockRejectedValue(new Error('proxy unavailable'));
    const app = fixture(); await flush();
    expect(app.container.querySelector<HTMLElement>('[data-ai-view="settings"]')!.hidden).toBe(false);
    expect(app.field<HTMLInputElement>('model').disabled).toBe(false);
    expect(app.action('send').disabled).toBe(true);
    expect(app.container.textContent).toContain('proxy unavailable');
    expect(mocks.run).not.toHaveBeenCalled(); app.dispose();
  });

  it('allows host-provided transports without calling or storing proxy configuration', async () => {
    const app = fixture(true); await flush();
    expect(mocks.getConfig).not.toHaveBeenCalled(); expect(app.action('send').disabled).toBe(false);
    app.field<HTMLTextAreaElement>('message').value = '读取结构'; app.submit(); await flush();
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(app.container.textContent).toContain('宿主应用'); app.dispose();
  });

  it('starts a fresh tool history after saving a different model configuration', async () => {
    const app = fixture(); await flush();
    app.field<HTMLTextAreaElement>('message').value = '第一轮'; app.submit(); await flush();
    app.field<HTMLSelectElement>('protocol').value = 'chat-completions';
    mocks.saveConfig.mockResolvedValue({ ...configured, protocol: 'chat-completions', model: 'other' });
    app.action('save').closest('form')!.dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(app.container.textContent).toContain('新的上下文');
    app.field<HTMLTextAreaElement>('message').value = '新模型'; app.submit(); await flush();
    expect(mocks.run.mock.calls[1][2].history).toEqual([]);
    app.dispose();
  });

  it('only sends an explicit thinking preference for compatible Chat Completions services', async () => {
    const app = fixture(); await flush();
    const protocol = app.field<HTMLSelectElement>('protocol');
    const thinking = app.field<HTMLSelectElement>('thinking');
    protocol.value = 'chat-completions'; protocol.dispatchEvent(new Event('change'));
    expect(thinking.closest('label')!.hidden).toBe(false);
    thinking.value = 'false';
    app.action('save').closest('form')!.dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(mocks.saveConfig.mock.calls[0][0]).toMatchObject({ protocol: 'chat-completions', enableThinking: false });
    protocol.value = 'responses'; protocol.dispatchEvent(new Event('change'));
    thinking.value = 'false';
    expect(thinking.closest('label')!.hidden).toBe(true);
    app.action('save').closest('form')!.dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(mocks.saveConfig.mock.calls[1][0]).not.toHaveProperty('enableThinking');
    app.dispose();
  });
});
