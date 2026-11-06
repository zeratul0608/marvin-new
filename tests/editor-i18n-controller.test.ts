import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorI18n, normalizeEditorLocale } from '../src/editor/i18n';

// This suite exercises the DOM controller independently of dictionary coverage.
vi.mock('../src/editor/i18n-en', () => ({ translateEnglish: (text: string) => ({
  '导出': 'Export', '导入': 'Import', '撤销': 'Undo', '重做': 'Redo',
  '绘图画布': 'Drawing canvas', '搜索命令': 'Search commands',
}[text] ?? text) }));

const controllers: EditorI18n[] = [];
function controller(root: ShadowRoot | HTMLElement, locale: 'zh-CN' | 'en' = 'zh-CN') {
  const translator = new EditorI18n(root, locale); controllers.push(translator); return translator;
}
function root(html: string): HTMLElement {
  const container = document.createElement('section'); container.innerHTML = html; document.body.append(container); return container;
}
const settled = () => new Promise<void>(resolve => setTimeout(resolve, 0));
afterEach(() => {
  controllers.splice(0).forEach(translator => translator.destroy());
  document.body.replaceChildren();
});

describe('editor UI localization controller', () => {
  it('accepts only the two supported locales', () => {
    expect(normalizeEditorLocale('zh-CN')).toBe('zh-CN');
    expect(normalizeEditorLocale('en')).toBe('en');
    for (const invalid of ['en-US', 'fr', '', undefined, null, 1]) expect(() => normalizeEditorLocale(invalid)).toThrow(RangeError);
  });

  it('switches synchronously in both directions without changing node identity, focus or listeners', () => {
    const container = root('<button title="导出" aria-label="导出"> \n 导出\t </button><span>Third-party label</span>');
    const button = container.querySelector('button')!, text = button.firstChild!;
    let clicks = 0; button.addEventListener('click', () => clicks++); button.focus();
    const translator = controller(container);
    expect(button.textContent).toBe(' \n 导出\t ');
    for (let i = 0; i < 3; i++) {
      translator.setLocale('en');
      expect(button.textContent).toBe(' \n Export\t '); expect(button.title).toBe('Export');
      expect(button.getAttribute('aria-label')).toBe('Export'); expect(button.firstChild).toBe(text);
      expect(document.activeElement).toBe(button); button.click();
      translator.setLocale('zh-CN'); expect(button.textContent).toBe(' \n 导出\t '); expect(button.title).toBe('导出');
    }
    expect(clicks).toBe(3); expect(container.querySelector('span')!.textContent).toBe('Third-party label');
  });

  it('supports a shadow root and translates only UI attributes on SVG roots', () => {
    const host = root(''), shadow = host.attachShadow({mode: 'open'});
    shadow.innerHTML = '<button placeholder="搜索命令">导入</button><svg aria-label="绘图画布">导出<text title="导出">撤销</text></svg>';
    const translator = controller(shadow, 'en');
    expect(shadow.querySelector('button')!.textContent).toBe('Import');
    expect(shadow.querySelector('button')!.getAttribute('placeholder')).toBe('Search commands');
    expect(shadow.querySelector('svg')!.getAttribute('aria-label')).toBe('Drawing canvas');
    expect(shadow.querySelector('svg')!.firstChild!.textContent).toBe('导出');
    expect(shadow.querySelector('text')!.textContent).toBe('撤销'); expect(shadow.querySelector('text')!.getAttribute('title')).toBe('导出');
    translator.setLocale('zh-CN'); expect(shadow.querySelector('svg')!.getAttribute('aria-label')).toBe('绘图画布');
  });

  it('retains runtime text and attribute updates as the latest source across immediate switches', async () => {
    const container = root('<button title="导出" aria-label="导出">导出</button>');
    const translator = controller(container, 'en'), button = container.querySelector('button')!;
    button.firstChild!.textContent = '撤销'; button.title = '重做'; button.setAttribute('aria-label', '导入');
    // A synchronous locale switch may happen before MutationObserver delivers the update.
    translator.setLocale('zh-CN');
    expect(button.textContent).toBe('撤销'); expect(button.title).toBe('重做'); expect(button.getAttribute('aria-label')).toBe('导入');
    translator.setLocale('en');
    expect(button.textContent).toBe('Undo'); expect(button.title).toBe('Redo'); expect(button.getAttribute('aria-label')).toBe('Import');
    await settled();
    translator.setLocale('zh-CN'); expect(button.textContent).toBe('撤销'); expect(button.title).toBe('重做');
  });

  it('observes new plugin nodes, replacement text and UI attributes without rebuilding controls', async () => {
    const container = root(''), translator = controller(container, 'en');
    const button = document.createElement('button'); button.textContent = '导出'; button.setAttribute('data-command', '导出');
    container.append(button);
    await vi.waitFor(() => expect(button.textContent).toBe('Export'));
    button.textContent = '导入'; button.title = '撤销'; button.setAttribute('aria-label', '重做');
    await vi.waitFor(() => {
      expect(button.textContent).toBe('Import'); expect(button.title).toBe('Undo'); expect(button.getAttribute('aria-label')).toBe('Redo');
    });
    expect(container.firstChild).toBe(button); expect(button.dataset.command).toBe('导出');
    translator.setLocale('zh-CN'); expect(button.textContent).toBe('导入'); expect(button.title).toBe('撤销');
    button.removeAttribute('title'); await settled(); translator.setLocale('en'); expect(button.hasAttribute('title')).toBe(false);
  });

  it('preserves input drafts, source code, editable content and explicitly excluded subtrees', () => {
    const container = root('<input value="导出" placeholder="搜索命令"><textarea>导出</textarea><pre title="导出">撤销<code>导入</code></pre><code>导出</code><span contenteditable="true">导入</span><div data-i18n-skip title="导出"><span>撤销</span></div><style>/* 导出 */</style><script type="application/json">"导出"</script><img alt="导入">');
    const input = container.querySelector('input')!, textarea = container.querySelector('textarea')!;
    input.value = '撤销'; textarea.value = '重做'; input.setSelectionRange(1, 2); input.focus();
    const translator = controller(container, 'en');
    expect(input.value).toBe('撤销'); expect(input.getAttribute('value')).toBe('导出'); expect(input.placeholder).toBe('Search commands');
    expect(input.selectionStart).toBe(1); expect(input.selectionEnd).toBe(2); expect(document.activeElement).toBe(input);
    expect(textarea.value).toBe('重做'); expect(textarea.textContent).toBe('导出');
    expect(container.querySelector('pre')!.textContent).toBe('撤销导入'); expect(container.querySelector('pre')!.title).toBe('导出');
    expect(container.querySelector('code')!.textContent).toBe('导入'); expect(container.querySelector('[contenteditable]')!.textContent).toBe('导入');
    expect(container.querySelector('[data-i18n-skip]')!.textContent).toBe('撤销'); expect(container.querySelector('[data-i18n-skip]')!.getAttribute('title')).toBe('导出');
    expect(container.querySelector('style')!.textContent).toBe('/* 导出 */'); expect(container.querySelector('script')!.textContent).toBe('"导出"');
    expect(container.querySelector('img')!.alt).toBe('Import');
    translator.setLocale('zh-CN'); expect(input.value).toBe('撤销'); expect(textarea.value).toBe('重做');
  });

  it('preserves explicit and implicit option values while translating their displayed labels', () => {
    const container = root('<select><option value="file-cdx" selected>导出</option><option>导入</option><option label="撤销">custom-value</option></select>');
    const select = container.querySelector('select')!, options = [...select.options], values = options.map(option => option.value), selectedIndex = select.selectedIndex, selectedValue = select.value;
    const translator = controller(container, 'en');
    expect(options[0].textContent).toBe('Export'); expect(options[1].getAttribute('label')).toBe('Import'); expect(options[2].getAttribute('label')).toBe('Undo');
    expect(options.map(option => option.value)).toEqual(values); expect(select.value).toBe(selectedValue); expect(select.selectedIndex).toBe(selectedIndex);
    translator.setLocale('zh-CN'); expect(options[0].textContent).toBe('导出'); expect(options[1].hasAttribute('label')).toBe(false);
    expect(options[2].getAttribute('label')).toBe('撤销'); expect(options.map(option => option.value)).toEqual(values);
  });

  it('updates implicit option labels after plugin text changes without changing form values', async () => {
    const container = root('<select><option>导出</option></select>'), translator = controller(container, 'en');
    const option = container.querySelector('option')!;
    option.textContent = '撤销';
    await vi.waitFor(() => expect(option.getAttribute('label')).toBe('Undo'));
    expect(option.value).toBe('撤销'); translator.setLocale('zh-CN'); expect(option.textContent).toBe('撤销'); expect(option.hasAttribute('label')).toBe(false);
  });

  it('settles its own mutations and stops observing and queued translation after cleanup', async () => {
    const container = root('<button>导出</button>'), translator = controller(container);
    let writes = 0; const observer = new MutationObserver(records => {writes += records.length;});
    observer.observe(container, {characterData:true, attributes:true, subtree:true});
    translator.setLocale('en'); await settled(); await settled(); const finishedWrites = writes;
    expect(finishedWrites).toBeGreaterThan(0); translator.translate(); await settled(); await settled(); expect(writes).toBe(finishedWrites);
    const plugin = document.createElement('button'); plugin.textContent = '撤销'; container.append(plugin);
    translator.destroy(); translator.destroy(); await settled();
    expect(plugin.textContent).toBe('撤销');
    container.querySelector('button')!.textContent = '导入'; await settled(); expect(container.querySelector('button')!.textContent).toBe('导入');
    translator.setLocale('zh-CN'); expect(container.querySelector('button')!.textContent).toBe('导入');
    observer.disconnect();
  });
  it('translates textarea interface attributes while preserving default text and edits', () => {
    const host = document.createElement('div'); host.innerHTML = '<textarea aria-label="搜索命令" placeholder="导入">导出</textarea>';
    document.body.append(host);
    const textarea = host.querySelector('textarea')!; textarea.value = '用户修改 导出';
    const controller = new EditorI18n(host,'en'); controllers.push(controller);
    expect(textarea.getAttribute('aria-label')).toBe('Search commands');
    expect(textarea.getAttribute('placeholder')).toBe('Import');
    expect(textarea.value).toBe('用户修改 导出'); expect(textarea.defaultValue).toBe('导出');
    controller.setLocale('zh-CN');
    expect(textarea.getAttribute('placeholder')).toBe('导入'); expect(textarea.value).toBe('用户修改 导出');
  });

});
