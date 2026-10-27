import { createChemicalEditor, exampleDocument, structureReviewPlugin, createAiAssistantPlugin } from '../index';
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
  <dialog id="compatibility-dialog" class="app-dialog" aria-label="格式兼容范围"><header><div><span class="eyebrow">FORMAT COMPATIBILITY</span><h2>清晰的兼容边界</h2></div><button class="close" aria-label="关闭格式兼容">${icon('close', 20)}</button></header><div class="dialog-content"><p>当前版本支持普通二维分子的基础交换。高级化学语义会阻止导入；未解释的文档排版会列入报告。</p><table><thead><tr><th>格式</th><th>可用范围</th></tr></thead><tbody><tr><td>CDXML</td><td>元素、电荷、同位素、指定氢数、普通键、二维楔线描绘与坐标</td></tr><tr><td>MRV</td><td>普通分子、原子映射、二维坐标与楔线描绘；支持基础压缩原子数组</td></tr><tr><td>MOL V2000 / V3000</td><td>单结构、元素、电荷、同位素、原子映射与二维键描绘</td></tr><tr><td>Molecule JSON</td><td>完整保存首版模型、稳定 ID、布局与源文件记录</td></tr><tr><td>SVG</td><td>矢量绘图导出；用于文档和演示</td></tr></tbody></table><div class="notice"><strong>后续模块</strong>CDX 二进制、SMILES / SMARTS、SDF 批量记录、反应、查询、Markush、聚合物、完整拓扑立体化学与 CIP 计算。<br/>尚未在 ChemDraw / Marvin JS 实际软件中完成兼容认证；当前以规范与样例测试验证。</div><p class="muted">源文件未编辑且导出格式相同时，可原样返回原文件；发生编辑或跨格式转换时，默认阻止已知的信息损失。</p></div></dialog>
  <dialog id="integration-dialog" class="app-dialog" aria-label="组件接入文档"><header><div><span class="eyebrow">EMBEDDABLE BY DESIGN</span><h2>嵌入你的业务系统</h2></div><button class="close" aria-label="关闭接入文档">${icon('close', 20)}</button></header><div class="dialog-content"><p>组件使用 Web Component 与 Shadow DOM，样式隔离。构建后可通过 JavaScript SDK 接入 React、Vue 或普通网页。</p><pre><code>import { createChemicalEditor } from './chemical-editor.js';

const editor = createChemicalEditor({
  container: document.querySelector('#editor'),
});

editor.import({ format: 'cdxml', data: cdxmlText });

const result = editor.export({ format: 'mrv' });
console.log(result.data, result.issues);

editor.addEventListener('change', event =&gt; {
  saveDraft(event.detail.document);
});</code></pre><h3>插件与公开 API</h3><p>在「扩展」中管理插件。开发者可添加命令和面板，通过公开 API 读取选区、批量修改结构或接入业务系统。</p><pre><code>import { createChemicalEditor, structureReviewPlugin }
  from './chemical-editor.js';

const editor = createChemicalEditor({
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

const editor = createChemicalEditor({ container: document.querySelector('#editor-container')!, document: exampleDocument('aspirin'), storageKey: 'molecule-workbench:v1', plugins: [structureReviewPlugin, createAiAssistantPlugin()] });
if (matchMedia('(min-width: 1001px)').matches) editor.showPluginPanel('ai-assistant');
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
