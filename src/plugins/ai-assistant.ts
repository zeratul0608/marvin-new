import type { EditorPlugin, PluginContext } from '../editor/api-types';
import type { AiAssistantOptions, AiMessage, AiModelConfig, AiProtocol } from '../ai/types';
import { runAiAssistant } from '../ai/assistant';
import { createAiClient } from '../ai/client';
import { AI_PROMPT_PRESETS, BUILTIN_AI_PROMPT } from '../ai/prompts';
import { getAiEditorContext } from '../ai/context';
import styles from '../ai/ai.css?inline';

const INSTRUCTIONS_KEY = 'molecule-ai:instructions:v1';

interface PanelControls { open(settings?: boolean): void }

/** Optional, trusted plugin. Model credentials stay in the local proxy session. */
export function createAiAssistantPlugin(options: AiAssistantOptions = {}): EditorPlugin {
  return {
    id: 'ai-assistant', name: 'AI 助手', version: '1.0.0', apiVersion: 1,
    description: '通过自然语言读取、编辑和导出当前结构，支持自定义模型与编辑提示词。',
    activate(context) {
      const mounted = new Set<PanelControls>();
      let requestedSettings = false;
      const open = (settings: boolean) => {
        requestedSettings = settings;
        for (const panel of mounted) panel.open(settings);
      };
      const cleanups = [
        context.registerCommand({ id: 'open', title: '打开 AI 助手', execute: () => open(false) }),
        context.registerCommand({ id: 'settings', title: 'AI 模型设置', execute: () => open(true) }),
        context.addPanel({
          id: 'assistant', title: 'AI 助手',
          mount(container) {
            const panel = mountPanel(container, context, options);
            mounted.add(panel);
            if (requestedSettings) panel.open(true);
            return () => { mounted.delete(panel); panel.destroy(); };
          },
        }),
      ];
      return () => { for (const cleanup of cleanups.reverse()) cleanup(); mounted.clear(); };
    },
  };
}

function mountPanel(container: HTMLElement, context: PluginContext, options: AiAssistantOptions) {
  const doc = container.ownerDocument;
  const client = createAiClient(options.endpoint);
  const transport = options.transport ?? client.transport;
  const root = doc.createElement('div');
  root.className = 'ai-assistant';
  const sheet = doc.createElement('style'); sheet.textContent = styles;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
    const element = doc.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const button = (text: string, action: string) => {
    const element = make('button', text); element.type = 'button'; element.dataset.aiAction = action; return element;
  };
  const label = (text: string, field: HTMLElement) => {
    const element = make('label', undefined, 'ai-field'); element.append(make('span', text), field); return element;
  };
  const header = make('div', undefined, 'ai-header');
  const chatTab = button('对话', 'chat'), settingsTab = button('模型设置', 'settings');
  header.append(chatTab, settingsTab);
  const privacy = make('p', '', 'ai-privacy');
  const contextView = make('details', undefined, 'ai-context');
  const contextSummary = make('summary', '当前编辑器上下文');
  const contextStatus = make('p', '', 'ai-note'); contextStatus.setAttribute('aria-live', 'polite');
  const contextPreview = make('pre'); contextPreview.setAttribute('aria-label', '发送给 AI 的编辑器上下文');
  contextView.append(contextSummary, contextStatus, contextPreview);
  const chatView = make('section'); chatView.dataset.aiView = 'chat';
  const settingsView = make('section'); settingsView.dataset.aiView = 'settings'; settingsView.hidden = true;
  const log = make('div', undefined, 'ai-log'); log.setAttribute('role', 'log'); log.setAttribute('aria-label', 'AI 对话记录');
  const welcome = make('p', '描述你要完成的操作。AI 会读取当前结构和选区，通过编辑器工具完成修改；所有结构修改都可以撤销。', 'ai-welcome');
  log.append(welcome);
  const presets = make('div', undefined, 'ai-presets');
  const composer = make('form', undefined, 'ai-composer');
  const message = make('textarea'); message.rows = 3; message.placeholder = '例如：把选中的原子改成氮，然后检查结构';
  message.setAttribute('aria-label', '发送给 AI 的指令'); message.dataset.aiField = 'message'; message.maxLength = 16000;
  const allowEdits = make('input'); allowEdits.type = 'checkbox'; allowEdits.checked = true; allowEdits.dataset.aiField = 'allow-edits';
  const editLabel = label('允许 AI 修改结构', allowEdits); editLabel.classList.add('ai-checkbox');
  const actions = make('div', undefined, 'ai-actions');
  const send = button('发送', 'send'); send.type = 'submit'; send.className = 'ai-primary';
  const stop = button('停止', 'stop'); stop.disabled = true;
  const clear = button('清空对话', 'clear'); actions.append(send, stop, clear);
  const runStatus = make('p', '', 'ai-status'); runStatus.setAttribute('role', 'status');
  composer.append(message, editLabel, actions, make('small', 'Ctrl + Enter 发送。选区和结构以执行时的当前画布为准。'), runStatus);
  chatView.append(log, presets, composer);

  const configForm = make('form', undefined, 'ai-config'); configForm.autocomplete = 'off';
  const protocol = make('select'); protocol.dataset.aiField = 'protocol';
  for (const [value, text] of [['responses', 'OpenAI Responses API'], ['chat-completions', 'OpenAI 兼容 Chat Completions']]) {
    const option = make('option', text); option.value = value; protocol.append(option);
  }
  const baseUrl = make('input'); baseUrl.type = 'url'; baseUrl.required = true; baseUrl.placeholder = 'https://api.openai.com/v1'; baseUrl.dataset.aiField = 'base-url';
  const model = make('input'); model.required = true; model.placeholder = '服务支持的模型 ID'; model.dataset.aiField = 'model';
  const thinking = make('select'); thinking.dataset.aiField = 'thinking';
  for (const [value, text] of [['default', '使用服务默认值'], ['false', '关闭思考模式'], ['true', '开启思考模式']]) {
    const option = make('option', text); option.value = value; thinking.append(option);
  }
  const thinkingField = label('兼容服务思考模式（vLLM / Qwen）', thinking);
  thinkingField.append(make('small', '仅适用于支持 chat_template_kwargs 的服务；其他服务保持默认。'));
  const apiKey = make('input'); apiKey.type = 'password'; apiKey.autocomplete = 'off'; apiKey.placeholder = '未设置密钥'; apiKey.dataset.aiField = 'api-key';
  const clearKey = make('input'); clearKey.type = 'checkbox'; clearKey.dataset.aiField = 'clear-key';
  const clearKeyLabel = label('删除已保存的密钥', clearKey); clearKeyLabel.classList.add('ai-checkbox');
  const configActions = make('div', undefined, 'ai-actions');
  const save = button('保存设置', 'save'); save.type = 'submit'; save.className = 'ai-primary';
  const test = button('测试连接', 'test'); configActions.append(save, test);
  const configStatus = make('p', '', 'ai-status'); configStatus.setAttribute('role', 'status');
  const keyNote = make('p', '密钥仅保存在本地服务的会话内存中；服务重启后需重新填写。留空只在同一服务来源下保留密钥，切换来源将自动清除。', 'ai-note');
  const testNote = make('p', '测试连接会先保存当前填写的设置，再验证模型能否调用编辑工具。测试不会发送画布内容。', 'ai-note');
  configForm.append(label('接口协议', protocol), label('服务 Base URL', baseUrl), label('模型', model), thinkingField, label('API 密钥（留空保留已有密钥）', apiKey), clearKeyLabel, keyNote, configActions, testNote, configStatus);

  const instructions = make('textarea'); instructions.rows = 4; instructions.maxLength = 12000; instructions.placeholder = '例如：用中文回复；修改前先说明目标；不要改动未选中的原子。'; instructions.dataset.aiField = 'instructions';
  try { instructions.value = localStorage.getItem(INSTRUCTIONS_KEY) ?? ''; } catch { /* Storage is optional. */ }
  const instructionStatus = make('p', '', 'ai-note');
  instructions.addEventListener('input', () => {
    try { localStorage.setItem(INSTRUCTIONS_KEY, instructions.value); instructionStatus.textContent = '自定义提示词已保存在此浏览器。'; }
    catch { instructionStatus.textContent = '浏览器存储不可用，提示词在本次使用中有效。'; }
  });
  const builtin = make('details', undefined, 'ai-prompt');
  builtin.append(make('summary', '查看内置编辑规则'), make('pre', BUILTIN_AI_PROMPT));
  settingsView.append(configForm, label('自定义工作提示词', instructions), instructionStatus, builtin);
  root.append(sheet, header, privacy, contextView, chatView, settingsView); container.append(root);

  let destroyed = false;
  let history: AiMessage[] = [];
  let activeRun: AbortController | undefined;
  let generation = 0;
  let config: AiModelConfig | undefined;
  let configBusy = false;
  let configGeneration = 0;
  const configController = new AbortController();
  const artifactUrls = new Set<string>();
  const hasCustomTransport = options.transport !== undefined;

  const refreshContext = () => {
    if (destroyed) return;
    try {
      const current = getAiEditorContext(context.editor);
      const { snapshot, summary, diagnostics } = current;
      const selected = snapshot.selection.atomIds.length;
      contextSummary.textContent = `当前上下文 · ${summary.atomCount} 个原子 · ${summary.bondCount} 条键 · ${snapshot.selection.bondId ? '已选 1 条键' : `已选 ${selected} 个原子`}`;
      contextStatus.textContent = `${snapshot.document.title || '未命名结构'} · ${summary.formula || '空结构'} · 版本 ${snapshot.revision} · ${diagnostics.length} 条诊断。发送时自动读取最新画布。`;
      contextPreview.textContent = contextView.open ? JSON.stringify(current, null, 2) : '';
    } catch (error) {
      contextStatus.textContent = error instanceof Error ? error.message : '无法读取当前上下文';
      contextPreview.textContent = '';
    }
  };
  contextView.addEventListener('toggle', refreshContext);
  const contextCleanups = [context.on('change', refreshContext), context.on('selectionchange', refreshContext)];
  refreshContext();

  const showTab = (settings: boolean) => {
    chatView.hidden = settings; settingsView.hidden = !settings;
    contextView.hidden = settings;
    chatTab.setAttribute('aria-pressed', String(!settings)); settingsTab.setAttribute('aria-pressed', String(settings));
  };
  const refreshPrivacy = () => {
    let domain = '尚未配置';
    try { if (config?.baseUrl) domain = new URL(config.baseUrl).host; } catch { /* Invalid config stays visible in the form. */ }
    privacy.textContent = hasCustomTransport
      ? '当前使用宿主应用提供的 AI 服务。发送当前结构、选区和本次对话，不发送原始导入文件。'
      : `模型：${config?.model || '未配置'} · 服务：${domain}。发送当前结构、选区和本次对话，不自动发送原始导入文件。`;
    send.disabled = !!activeRun || configBusy || (!hasCustomTransport && !config?.model);
  };
  const applyConfig = (value: AiModelConfig) => {
    config = value;
    protocol.value = value.protocol; baseUrl.value = value.baseUrl; model.value = value.model;
    thinking.value = value.enableThinking === undefined ? 'default' : String(value.enableThinking);
    thinkingField.hidden = value.protocol !== 'chat-completions';
    apiKey.value = ''; clearKey.checked = false;
    apiKey.placeholder = value.hasApiKey ? '已设置，留空保留' : '未设置密钥（无密钥服务可留空）';
    refreshPrivacy();
  };
  const setConfigBusy = (value: boolean) => {
    configBusy = value;
    for (const field of [protocol, baseUrl, model, thinking, apiKey, clearKey, save, test]) field.disabled = value || !!activeRun || hasCustomTransport;
    if (clearKey.checked) apiKey.disabled = true;
    refreshPrivacy();
  };
  const addMessage = (speaker: '你' | 'AI' | '提示', text: string) => {
    const item = make('article', undefined, `ai-message ai-message-${speaker === '你' ? 'user' : 'assistant'}`);
    item.append(make('strong', speaker), make('p', text)); log.append(item); log.scrollTop = log.scrollHeight;
  };
  const revokeArtifacts = () => { for (const url of artifactUrls) URL.revokeObjectURL(url); artifactUrls.clear(); };
  const setRunning = (running: boolean) => {
    stop.disabled = !running; send.textContent = running ? '处理中…' : '发送';
    setConfigBusy(configBusy);
  };
  const stopRun = (clearing = false) => {
    if (!activeRun) return;
    const previous = activeRun; activeRun = undefined; generation++;
    previous.abort(); setRunning(false);
    if (!clearing) {
      history = [];
      addMessage('提示', '已停止。本轮可能已执行部分修改，可在编辑器中撤销。为避免未完成的工具记录影响后续操作，下次将开启新的上下文。');
      runStatus.textContent = '已停止';
    }
  };
  const submit = async () => {
    const text = message.value.trim();
    if (!text || activeRun || configBusy || destroyed) return;
    if (!hasCustomTransport && !config?.model) { showTab(true); configStatus.textContent = '请先保存模型设置。'; return; }
    const controller = new AbortController(); activeRun = controller;
    const token = ++generation;
    const current = () => !destroyed && token === generation && !controller.signal.aborted;
    const traces = make('ol', undefined, 'ai-trace');
    const traceItems = new Map<string, HTMLLIElement>();
    let lastAssistantText = '';
    addMessage('你', text); message.value = ''; log.append(traces); setRunning(true); runStatus.textContent = '正在读取当前结构…';
    try {
      const result = await runAiAssistant(context.editor, transport, {
        message: text, history, instructions: instructions.value, allowEdits: allowEdits.checked, signal: controller.signal,
        onEvent(event) {
          if (!current()) return;
          if (event.type === 'status') runStatus.textContent = event.message;
          if (event.type === 'assistant' && event.text) { addMessage('AI', event.text); lastAssistantText = event.text; }
          if (event.type === 'tool-start') {
            const item = make('li', `执行 ${event.name}…`); traces.append(item); traceItems.set(event.id, item);
          }
          if (event.type === 'tool-end') {
            const item = traceItems.get(event.id) ?? make('li');
            item.textContent = `${event.ok ? '✓' : '未完成'} ${event.name}：${event.summary}`;
            if (!item.parentElement) traces.append(item);
          }
          if (event.type === 'artifact') {
            const url = URL.createObjectURL(new Blob([event.artifact.data], { type: event.artifact.mimeType })); artifactUrls.add(url);
            const link = make('a', `下载 ${event.artifact.name}`, 'ai-download'); link.href = url; link.download = event.artifact.name; log.append(link);
          }
          log.scrollTop = log.scrollHeight;
        },
      });
      if (!current()) return;
      history = result.messages;
      if (result.text && result.text !== lastAssistantText) addMessage('AI', result.text);
      runStatus.textContent = result.completed === false ? `已达到执行上限 · ${result.toolCount} 次操作，请检查结果` : `本轮已结束 · ${result.toolCount} 次工具操作`;
    } catch (error) {
      if (!current()) return;
      history = [];
      addMessage('提示', `请求失败：${error instanceof Error ? error.message : String(error)}。本轮可能已执行部分修改，可在编辑器中撤销。下次将开启新的上下文。`);
      runStatus.textContent = '请求未完成';
    } finally {
      if (!destroyed && token === generation) { activeRun = undefined; setRunning(false); message.focus(); }
    }
  };

  for (const preset of AI_PROMPT_PRESETS) {
    const choice = button(preset.title, 'preset');
    choice.addEventListener('click', () => { message.value = preset.message; message.focus(); }); presets.append(choice);
  }
  chatTab.addEventListener('click', () => showTab(false)); settingsTab.addEventListener('click', () => showTab(true));
  clearKey.addEventListener('change', () => { if (clearKey.checked) apiKey.value = ''; setConfigBusy(configBusy); });
  protocol.addEventListener('change', () => { thinkingField.hidden = protocol.value !== 'chat-completions'; });
  composer.addEventListener('submit', event => { event.preventDefault(); void submit(); });
  message.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void submit(); } });
  stop.addEventListener('click', () => stopRun());
  clear.addEventListener('click', () => {
    stopRun(true); history = []; log.replaceChildren(welcome); revokeArtifacts(); runStatus.textContent = '已清空对话';
  });
  const saveSettings = async (testConnection: boolean) => {
    if (configBusy || activeRun || destroyed || hasCustomTransport) return;
    if (!model.value.trim() || !baseUrl.value.trim()) { configStatus.textContent = '请填写服务地址和模型。'; return; }
    if (!configForm.reportValidity()) return;
    const token = ++configGeneration; setConfigBusy(true); configStatus.textContent = '正在保存…';
    const input = { protocol: protocol.value as AiProtocol, baseUrl: baseUrl.value.trim(), model: model.value.trim(), ...(protocol.value === 'chat-completions' && thinking.value !== 'default' ? { enableThinking: thinking.value === 'true' } : {}), ...(!clearKey.checked && apiKey.value ? { apiKey: apiKey.value } : {}), ...(clearKey.checked ? { clearKey: true } : {}) };
    apiKey.value = '';
    try {
      const saved = await client.saveConfig(input, configController.signal);
      if (destroyed || token !== configGeneration) return;
      history = [];
      applyConfig(saved); configStatus.textContent = '设置已保存。后续对话将使用新的上下文；可以开始对话或测试连接。';
      if (testConnection) {
        configStatus.textContent = '设置已保存，正在验证工具调用…';
        try {
          const result = await client.test(configController.signal);
          if (!destroyed && token === configGeneration) configStatus.textContent = `${result.ok ? '连接成功' : '连接失败'}：${result.message}`;
        } catch (error) {
          if (!destroyed && token === configGeneration) configStatus.textContent = `设置已保存，连接失败：${error instanceof Error ? error.message : String(error)}`;
        }
      }
    } catch (error) {
      if (!destroyed && token === configGeneration) configStatus.textContent = `保存失败：${error instanceof Error ? error.message : String(error)}`;
    } finally { if (!destroyed && token === configGeneration) setConfigBusy(false); }
  };
  configForm.addEventListener('submit', event => { event.preventDefault(); void saveSettings(false); });
  test.addEventListener('click', () => { void saveSettings(true); });
  thinkingField.hidden = protocol.value !== 'chat-completions';
  showTab(false); refreshPrivacy();
  if (hasCustomTransport) {
    setConfigBusy(false); configStatus.textContent = 'AI 连接由宿主应用配置；此处的提示词仍然有效。';
  } else {
    const token = ++configGeneration; setConfigBusy(true); configStatus.textContent = '正在读取模型设置…';
    void client.getConfig(configController.signal).then(value => {
      if (destroyed || token !== configGeneration) return;
      applyConfig(value);
      configStatus.textContent = value.model ? '已读取本地服务中的设置。' : '请配置服务地址、模型和密钥。';
      if (!value.model) showTab(true);
    }).catch(error => {
      if (destroyed || token !== configGeneration) return;
      configStatus.textContent = `无法读取设置：${error instanceof Error ? error.message : String(error)}。请确认本地 AI 代理服务已启动。`;
      showTab(true);
    }).finally(() => { if (!destroyed && token === configGeneration) setConfigBusy(false); });
  }

  return {
    open(settings = false) {
      if (destroyed) return;
      showTab(settings);
      root.scrollIntoView?.({ block: 'nearest' });
      (settings ? model : message).focus();
    },
    destroy() {
      destroyed = true; generation++; configGeneration++;
      for (const cleanup of contextCleanups) cleanup();
      activeRun?.abort(); activeRun = undefined; configController.abort(); history = [];
      revokeArtifacts(); root.remove();
    },
  };
}
