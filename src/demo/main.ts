import { createChemicalEditor, exampleDocument, createChemistryPlugin, structureLayoutPlugin, structureReviewPlugin, createAiAssistantPlugin } from '../index';
import { EditorI18n, type EditorLocale } from '../editor/i18n';
import { icon } from '../editor/icons';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <div class="shell">
    <header class="app-header">
      <a class="brand" href="./" aria-label="Molecule 首页"><span class="brand-mark">${icon('molecule', 23)}</span><span>Molecule<span class="brand-subtitle">WORKBENCH</span></span></a>
      <div class="header-divider"></div>
      <nav aria-label="工作台导航"><button class="nav-button current" data-page="editor">工作台</button><button class="nav-button" data-page="compatibility">格式兼容</button><button class="nav-button" data-page="integration">接入文档</button></nav>
      <span class="header-spacer"></span>
      <span class="local-badge"><span></span>本地工作空间</span>
      <button class="ai-open-button" data-page="ai" aria-label="打开 AI 助手">${icon('ai', 17)}<span>AI 助手</span></button>
      <button class="ai-settings-button" data-page="ai-settings" aria-label="AI 模型设置" title="AI 模型设置">${icon('settings', 18)}<span>AI 设置</span></button>
      <button class="help-button" data-page="shortcuts" aria-label="快捷键帮助" title="快捷键帮助">${icon('keyboard', 19)}</button>
    </header>
    <main>
      <div class="workspace-bar"><div class="workspace-path"><span>工作空间</span><span>/</span><strong>分子编辑</strong><span class="workspace-version">二维结构</span></div><span class="workspace-hint">从结构出发，专注每一次发现。</span></div>
      <div id="editor-container"></div>
      <div class="workspace-footnote"><span>${icon('check', 12)}手动编辑在本地完成 · AI 按配置连接模型服务</span><span class="workspace-footnote-right"><button data-page="templates">${icon('templates', 13)}打开结构模板</button><span class="footnote-divider"></span><button data-page="compatibility">查看格式支持范围${icon('chevron', 12)}</button></span></div>
    </main>
  </div>
  <dialog id="compatibility-dialog" class="app-dialog" aria-label="格式兼容范围"><header><div><span class="eyebrow">FORMAT COMPATIBILITY</span><h2>清晰的兼容边界</h2></div><button class="close" aria-label="关闭格式兼容">${icon('close', 20)}</button></header><div class="dialog-content"><p>当前版本支持普通分子、查询、内部片段、反应及文档对象的解析编辑。部分专用图元仍使用轮廓显示，跨格式转换会检查信息损失。</p><table><thead><tr><th>格式</th><th>可用范围</th></tr></thead><tbody><tr><td>CDX（二进制读写）</td><td>普通二维分子、自由基、连接点、键描绘、四面体几何与双键连接顺序；支持新建二进制导出及源格式保留保存</td></tr><tr><td>CDXML</td><td>普通化学图、查询、内部片段、反应角色、立体排序与文档对象；支持重建和源格式保留保存</td></tr><tr><td>MRV</td><td>普通分子、原子映射、二维坐标与楔线描绘；支持基础压缩原子数组</td></tr><tr><td>MOL V2000 / V3000</td><td>单结构、元素、电荷、同位素、原子映射与二维键描绘</td></tr><tr><td>Molecule JSON</td><td>保存当前模型、稳定 ID、文档对象、内部片段、布局与源文件记录</td></tr><tr><td>SMILES / 本地计算</td><td>单条分子输入与可复制输出；普通完整分子的二维清理、分子性质及常见 R/S/E/Z 计算，在右侧“化学计算”使用</td></tr><tr><td>SVG</td><td>矢量绘图导出；用于文档和演示</td></tr></tbody></table><div class="notice"><strong>后续模块</strong>SMARTS、SDF 批量记录、通用 Markush／聚合物求值、全部立体类别的 CIP 与名称转结构。查询、内部片段、轴／增强立体等目前不参与普通分子的自动计算。<br/>尚未在 ChemDraw / Marvin JS 实际软件中完成兼容认证；当前以规范与样例测试验证。</div><p class="muted">可导出的文本格式在文档未编辑时可原样返回源文件；CDX / CDXML 支持受限的源文档保留保存；CDX 转 CDXML 仅在字段均有映射时直接转换，否则默认阻止已知的信息损失。</p></div></dialog>
  <dialog id="integration-dialog" class="app-dialog" aria-label="组件接入文档"><header><div><span class="eyebrow">EMBEDDABLE BY DESIGN</span><h2>嵌入你的业务系统</h2></div><button class="close" aria-label="关闭接入文档">${icon('close', 20)}</button></header><div class="dialog-content"><p>组件使用 Web Component 与 Shadow DOM，样式隔离。构建后可通过 JavaScript SDK 接入 React、Vue 或普通网页。</p><pre><code>import { createChemicalEditor } from './chemical-editor.js';

const editor = createChemicalEditor({ locale: 'en',
  container: document.querySelector('#editor'),
});

editor.import({ format: 'cdxml', data: cdxmlText });

const result = editor.export({ format: 'mrv' });
console.log(result.data, result.issues);

editor.addEventListener('change', event =&gt; {
  saveDraft(event.detail.document);
});</code></pre><h3>插件与公开 API</h3><p>在「高级编辑 → 扩展插件」中管理插件。开发者可添加命令和面板，通过公开 API 读取选区、批量修改结构或接入业务系统。</p><pre><code>import { createChemicalEditor, structureReviewPlugin }
  from './chemical-editor.js';

const editor = createChemicalEditor({ locale: 'en',
  container: document.querySelector('#editor'),
  plugins: [structureReviewPlugin],
});

const snapshot = editor.getSnapshot();
editor.applyEdits({
  expectedRevision: snapshot.revision,
  operations: [{ type: 'rename', title: '工艺结构 A' }],
});

const summary = await editor.execute({
  method: 'execute_command',
  params: { id: 'structure-review.review' },
});</code></pre><p class="muted">完整开发指南：项目 docs/extensions.md。提供浏览器 SDK、JSON 命令接口及可选 AI 助手。模型连接在 AI 助手的「模型设置」中配置；MCP 可复用相同编辑能力。</p><p class="muted">核心模型与格式适配器均可独立调用。源代码入口为 src/index.ts；npm run build 会生成 dist-sdk/。</p><div class="notice">SDK 的导出默认严格检查已知损失；调用方可展示 issues，并由用户明确选择 allowLossy。此示例中的 saveDraft 由业务系统实现。</div></div></dialog>`;

const localeStorageKey = 'molecule-workbench:locale:v1';
let locale: EditorLocale = 'zh-CN';
try { if (localStorage.getItem(localeStorageKey) === 'en') locale = 'en'; } catch { /* UI preference is optional. */ }
const appI18n = new EditorI18n(app,locale);
document.documentElement.lang = locale;
const editor = createChemicalEditor({ locale, container: document.querySelector('#editor-container')!, document: exampleDocument('aspirin'), storageKey: 'molecule-workbench:v1', plugins: [structureReviewPlugin, structureLayoutPlugin, createChemistryPlugin(), createAiAssistantPlugin()] });
editor.addEventListener('localechange', event => {
  const locale = (event as CustomEvent<{locale:EditorLocale}>).detail.locale;
  appI18n.setLocale(locale); document.documentElement.lang = locale;
  try { localStorage.setItem(localeStorageKey,locale); } catch { /* UI preference is optional. */ }
});
// An explicitly exposed demo handle makes integration experiments possible in the console.
Object.assign(window, { moleculeEditor: editor });
document.addEventListener('click', event => {
  const button = (event.target as Element).closest<HTMLButtonElement>('button');
  if (!button) return;
  const page = button.dataset.page;
  if (page === 'editor') { editor.scrollIntoView({ behavior: 'smooth', block: 'center' }); editor.focus(); }
  else if (page === 'ai') { editor.showPluginPanel('ai-assistant'); void editor.executeCommand('ai-assistant.open').catch(() => undefined); }
  else if (page === 'ai-settings') { editor.showPluginPanel('ai-assistant'); void editor.executeCommand('ai-assistant.settings').catch(() => undefined); }
  else if (page === 'templates' || page === 'shortcuts') editor.shadowRoot?.querySelector<HTMLButtonElement>(`[data-action="${page}"]`)?.click();
  else if (page === 'compatibility' || page === 'integration') (document.querySelector(`#${page}-dialog`) as HTMLDialogElement).showModal();
  if (button.classList.contains('close')) button.closest('dialog')?.close();
});
