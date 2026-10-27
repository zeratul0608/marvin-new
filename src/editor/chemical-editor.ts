import { addAtom, addBond, clone, connectedComponents, emptyDocument, findBond, hydrogenCount, molecularFormula, neighbors, removeAtom, removeBond, validateDocument, ELEMENTS } from '../core/model';
import { DocumentStore } from '../core/store';
import { applyDocumentEdits } from '../core/edits';
import { EDITOR_API_VERSION, RevisionConflictError } from './api-types';
import type { EditRequest, EditResult, EditorApi, EditorEvents, EditorPlugin, EditorRequest, EditorSelection, EditorSnapshot, PluginPanel } from './api-types';
import { PluginRegistry } from './plugins';
import { transformAtoms, type StructureTransform } from '../core/geometry';
import { exampleDocument, insertRing } from '../core/templates';
import type { AtomId, BondOrder, ChemicalDocument, Diagnostic, ExportResult, Format, ImportResult, Point } from '../core/types';
import { exportDocument, formats, FormatError, importDocument } from '../formats';
import { escapeXml as esc } from '../formats/shared';
import { icon } from './icons';
import { documentBounds, exportSvg, moleculeMarkup, svgDrawingStyle } from './render';
import styles from './editor.css?inline';

export type Tool = 'select' | 'bond' | 'double' | 'triple' | 'wedge' | 'hashed' | 'ring' | 'benzene' | 'erase' | 'pan';
const toolInfo: Record<Tool, { name: string; key: string; hint: string }> = {
  select: { name: '选择', key: 'V', hint: '点击选择，拖动原子移动；拖动空白区域框选' },
  bond: { name: '单键', key: 'B', hint: '点击或拖动绘制单键；靠近已有原子时自动连接' },
  double: { name: '双键', key: '2', hint: '绘制双键，或点击已有键修改键级' },
  triple: { name: '三键', key: '3', hint: '绘制三键，或点击已有键修改键级' },
  wedge: { name: '实楔键', key: 'W', hint: '从尖端原子拖向宽端，绘制二维立体键' },
  hashed: { name: '虚楔键', key: 'D', hint: '从尖端原子拖向宽端，绘制二维立体键' },
  ring: { name: '六元环', key: 'R', hint: '点击放置六元环；点击原子可连接新环' },
  benzene: { name: '苯环', key: '6', hint: '点击放置交替单双键的苯环模板' },
  erase: { name: '删除', key: 'E', hint: '点击删除原子或键；删除原子会移除相连的键' },
  pan: { name: '平移', key: '空格', hint: '拖动画布平移；滚轮缩放视图' },
};
const samples = [
  { id: 'aspirin', name: '阿司匹林', english: 'Aspirin', category: '常用分子' },
  { id: 'caffeine', name: '咖啡因', english: 'Caffeine', category: '杂环结构' },
  { id: 'ethanol', name: '乙醇', english: 'Ethanol', category: '基础结构' },
  { id: 'benzene', name: '苯', english: 'Benzene', category: '芳香结构' },
] as const;
interface SearchCommand { name: string; detail: string; keywords: string; icon: string; run: () => void }
interface Gesture {
  kind: 'bond' | 'move' | 'box' | 'pan';
  point: Point;
  current: Point;
  origin?: AtomId;
  base: ChemicalDocument;
  camera: { x: number; y: number; width: number; height: number };
  clientX: number;
  clientY: number;
  moved: boolean;
}
const HTMLElementBase = globalThis.HTMLElement ?? class {} as typeof HTMLElement;
export class ChemicalEditorElement extends HTMLElementBase {
  private store = new DocumentStore(emptyDocument());
  private unsubscribe?: () => void;
  private initialized = false;
  private observer?: ResizeObserver;
  private tool: Tool = 'bond';
  private element = 'C';
  private selection = new Set<AtomId>();
  private selectedBond?: string;
  private camera = { x: -9, y: -6, width: 18, height: 12 };
  private gesture?: Gesture;
  private space = false;
  private toastTimer?: ReturnType<typeof setTimeout>;
  private lastIssues: Diagnostic[] = [];
  private pendingImport?: { name?: string; data: string };
  private exportResult?: ExportResult;
  private previousFocus?: HTMLElement;
  private root!: ShadowRoot;
  private svg!: SVGSVGElement;
  private drawing!: SVGGElement;
  private overlay!: SVGGElement;
  private storageKey?: string;
  private ribbonTab = 'draw';
  private gridVisible = false;
  private inspectorVisible = false;
  private activePluginId?: string;
  private searchResults: SearchCommand[] = [];
  private searchIndex = 0;
  private draftStatus = '会话内编辑';
  private destroyed = false;
  private lastSelection = JSON.stringify({ atomIds: [] });
  private plugins = new PluginRegistry({
    api: this.pluginApi(),
    mountPanel: (id, panel) => this.mountPluginPanel(id, panel),
    on: (type, listener) => this.subscribeApiEvent(type, listener),
    notify: message => this.notify(message),
    changed: () => this.pluginsChanged(),
    error: (pluginId, error) => this.reportPluginError(pluginId, error),
  });
  /** True if this instance restored a valid browser-local draft. */
  restored = false;

  connectedCallback(): void {
    if (this.destroyed) return;
    if (!this.initialized) this.initialize();
    this.unsubscribe ??= this.store.subscribe(() => this.changed());
    this.observer = new ResizeObserver(() => this.resizeCamera());
    this.observer.observe(this.svg);
    this.render();
  }
  disconnectedCallback(): void {
    this.observer?.disconnect();
    if (this.toastTimer) clearTimeout(this.toastTimer);
  }
  private initialize() {
    this.initialized = true;
    this.tabIndex = 0;
    this.setAttribute('aria-label', '化学结构编辑器');
    this.root = this.attachShadow({ mode: 'open' });
    this.inspectorVisible = typeof matchMedia === 'function' ? matchMedia('(min-width: 1001px)').matches : true;
    const toolButtons = (Object.keys(toolInfo) as Tool[]).map((t, i) => `${[0, 1, 6, 8].includes(i) ? `<span class="rail-label">${({ 0: '选择', 1: '化学键', 6: '环模板', 8: '编辑' } as Record<number, string>)[i]}</span>` : ''}<button type="button" data-tool="${t}" aria-label="${toolInfo[t].name}工具" title="${toolInfo[t].name} (${toolInfo[t].key})">${icon(t, 21)}</button>`).join('');
    this.root.innerHTML = `<style>${styles}\n${svgDrawingStyle}</style>
      <div class="editor">
        <div class="commandbar">
          <span class="doc-icon">${icon('molecule', 20)}</span>
          <input class="document-title" aria-label="文档名称" maxlength="120" value="未命名结构"/>
          <span class="saved-dot" title="结构保存在当前编辑器中"></span>
          <div class="separator"></div>
          <button class="icon-button ghost" data-action="undo" aria-label="撤销" title="撤销 (Ctrl+Z)">${icon('undo')}</button>
          <button class="icon-button ghost" data-action="redo" aria-label="重做" title="重做 (Ctrl+Shift+Z)">${icon('redo')}</button>
          <button class="icon-button ghost" data-action="clear" aria-label="清空画布" title="清空画布">${icon('clear', 17)}</button>
          <span class="spacer"></span>
          <button class="search-trigger" data-action="search" aria-label="搜索工具与元素">${icon('search', 15)}<span>搜索工具、元素、模板…</span><kbd>Ctrl K</kbd></button>
          <button class="icon-button ghost" data-action="plugins" aria-label="插件管理" title="插件管理">${icon('plugins')}</button>
          <button class="icon-button ghost" data-action="source" aria-label="查看结构数据" title="查看结构数据">${icon('code')}</button>
          <div class="separator"></div>
          <button data-action="import" aria-label="导入">${icon('import', 16)}<span class="button-label">导入</span></button>
          <button class="primary" data-action="export" aria-label="导出">${icon('export', 16)}<span class="button-label">导出</span></button>
        </div>
        <div class="ribbon">
          <div class="ribbon-tabs" role="tablist" aria-label="编辑功能"><button role="tab" id="draw-tab" aria-controls="draw-panel" data-tab="draw">绘制</button><button role="tab" id="structure-tab" aria-controls="structure-panel" data-tab="structure">结构</button><button role="tab" id="view-tab" aria-controls="view-panel" data-tab="view">视图</button><button role="tab" id="extensions-tab" aria-controls="extensions-panel" data-tab="extensions">扩展</button></div>
          <div class="ribbon-panel" id="draw-panel" role="tabpanel" aria-labelledby="draw-tab" data-panel="draw"><span class="ribbon-caption">开始绘制</span><button data-tool="bond">${icon('bond', 17)}单键</button><button data-tool="benzene">${icon('benzene', 17)}苯环</button><span class="separator"></span><button data-action="templates">${icon('templates', 16)}结构模板</button><button data-action="elements">${icon('plus', 16)}全部元素</button></div>
          <div class="ribbon-panel" id="structure-panel" role="tabpanel" aria-labelledby="structure-tab" data-panel="structure" hidden><button data-action="select-all">${icon('select', 17)}全选</button><span class="separator"></span><button data-transform="rotate-left">${icon('rotate-left', 17)}左转 30°</button><button data-transform="rotate-right">${icon('rotate-right', 17)}右转 30°</button><button data-transform="mirror-horizontal">${icon('mirror-horizontal', 17)}水平镜像</button><button data-transform="mirror-vertical">${icon('mirror-vertical', 17)}垂直镜像</button></div>
          <div class="ribbon-panel" id="view-panel" role="tabpanel" aria-labelledby="view-tab" data-panel="view" hidden><button data-action="fit">${icon('fit', 17)}适应画布</button><button data-action="grid" aria-pressed="false">${icon('grid', 17)}网格</button><button data-action="svg">${icon('export', 17)}导出 SVG</button><button data-action="shortcuts">${icon('keyboard', 17)}快捷键</button></div>
          <div class="ribbon-panel" id="extensions-panel" role="tabpanel" aria-labelledby="extensions-tab" data-panel="extensions" hidden><button data-action="plugins">${icon('plugins', 16)}插件管理</button><span class="separator"></span><div class="plugin-toolbar" role="toolbar" aria-label="插件操作"></div></div>
          <button class="inspector-toggle icon-button" data-action="inspector" aria-label="结构属性面板" aria-pressed="true" title="结构属性面板">${icon('panel', 18)}</button>
        </div>
        <div class="body">
          <div class="toolrail" role="toolbar" aria-label="绘图工具">${toolButtons}</div>
          <div class="canvas-area">
            <div class="elements" role="toolbar" aria-label="常用元素"><span>元素</span>${['C', 'N', 'O', 'S', 'P', 'F', 'Cl', 'Br'].map(e => `<button data-element="${e}" aria-label="选择元素 ${e}" style="${e === 'O' ? 'color:#d34f56' : e === 'N' ? 'color:#4273bf' : ''}">${e}</button>`).join('')}<button data-action="elements" aria-label="更多元素" title="全部元素">${icon('plus', 14)}</button></div>
            <span class="canvas-mode">二维结构</span>
            <svg class="canvas" tabindex="0" role="application" aria-label="分子绘图画布"><g class="drawing"></g><g class="overlay" pointer-events="none"></g></svg>
            <div class="empty-state" hidden>${icon('molecule', 50)}<strong>从第一根化学键开始</strong><span>点击画布绘制，或拖入结构文件<br/>也可以从右上角打开示例</span></div>
            <div class="canvas-label">${icon('molecule', 14)} MOLECULE WORKBENCH</div>
            <div class="selection-toolbar" role="toolbar" aria-label="所选结构操作" hidden><span class="selection-count"></span><button data-transform="rotate-left" aria-label="所选结构左转 30°" title="左转 30°">${icon('rotate-left', 16)}</button><button data-transform="rotate-right" aria-label="所选结构右转 30°" title="右转 30°">${icon('rotate-right', 16)}</button><button data-transform="mirror-horizontal" aria-label="所选结构水平镜像" title="水平镜像">${icon('mirror-horizontal', 16)}</button><button data-transform="mirror-vertical" aria-label="所选结构垂直镜像" title="垂直镜像">${icon('mirror-vertical', 16)}</button><button data-action="delete-selection" aria-label="删除所选结构" title="删除所选结构">${icon('clear', 16)}</button></div>
            <div class="toast" role="status" hidden></div>
          </div>
          <aside class="inspector" aria-label="结构与属性" hidden><div class="inspector-tabs" role="tablist" aria-label="侧栏内容"></div><div class="inspector-content"></div><div class="plugin-panels"></div></aside>
        </div>
        <div class="footer"><span class="active-tool"></span><span class="live-status"></span><span class="spacer"></span><span class="draft-status"></span><button data-action="zoom-out" aria-label="缩小">−</button><span class="zoom-label">100%</span><button data-action="zoom-in" aria-label="放大">+</button><button data-action="fit" aria-label="适应画布" title="适应画布 (Enter)">${icon('fit', 14)}</button></div>
      </div>
      <dialog class="plugins-dialog" aria-label="插件管理"><div class="dialog-header"><div><h2>工作台插件</h2><p>启用所需扩展，为结构编辑添加操作和属性面板。</p></div><button class="icon-button ghost" data-action="close-dialog" aria-label="关闭插件管理">${icon('close', 20)}</button></div><div class="plugin-list"></div><div class="dialog-footer"><span class="plugin-manager-hint">插件仅在当前编辑器实例中生效</span><button data-action="close-dialog">完成</button></div></dialog>
      <dialog class="search-dialog" aria-label="工具搜索"><div class="search-field">${icon('search', 21)}<input class="command-search" aria-label="搜索命令" placeholder="搜索工具、元素或结构模板…" autocomplete="off" role="combobox" aria-autocomplete="list" aria-controls="command-results" aria-expanded="true"/><button class="icon-button ghost" data-action="close-dialog" aria-label="关闭搜索">${icon('close', 16)}</button></div><div class="search-results" id="command-results" role="listbox" aria-label="搜索结果"></div><div class="search-help"><span><kbd>↑</kbd> <kbd>↓</kbd> 选择　<kbd>Enter</kbd> 执行</span><span><kbd>Esc</kbd> 关闭</span></div></dialog>
      <dialog class="templates-dialog" aria-label="结构模板库"><div class="dialog-header"><div><h2>结构模板</h2><p>选择一个分子开始编辑；可通过撤销恢复当前结构。</p></div><button class="icon-button ghost" data-action="close-dialog" aria-label="关闭模板库">${icon('close', 20)}</button></div><div class="template-grid">${samples.map(s => `<button class="template-card" data-sample="${s.id}"><span class="template-category">${s.category}</span><span class="template-preview"><img src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(exportSvg(exampleDocument(s.id)))}" alt="${s.name}结构预览"/></span><span class="template-name">${s.name}<small>${s.english}</small></span><span class="template-formula">${molecularFormula(exampleDocument(s.id))}</span></button>`).join('')}</div></dialog>
      <dialog class="shortcuts-dialog" aria-label="键盘快捷键"><div class="dialog-header"><div><h2>让绘制更顺手</h2><p>在画布获得焦点时使用快捷键</p></div><button class="icon-button ghost" data-action="close-dialog" aria-label="关闭快捷键">${icon('close', 20)}</button></div><div class="dialog-body shortcut-grid">${[['搜索工具','Ctrl / ⌘ K'],['选择 / 单键','V / B'],['双键 / 三键','2 / 3'],['苯环 / 六元环','6 / R'],['实楔 / 虚楔','W / D'],['全选','Ctrl / ⌘ A'],['撤销','Ctrl / ⌘ Z'],['重做','Ctrl / ⌘ Shift Z'],['导出','Ctrl / ⌘ S'],['适应画布','Enter'],['取消选择','Esc'],['删除所选','Delete'],['平移画布','空格 + 拖动'],['自由成键角度','Alt + 拖动']].map(([name, key]) => `<div><span>${name}</span><kbd>${key}</kbd></div>`).join('')}</div></dialog>
      <input type="file" class="file-input" accept=".mol,.mrv,.cdxml,.json,.cdx" aria-label="选择结构文件"/>
      <dialog class="import-dialog" aria-label="导入化学结构"><div class="dialog-header"><div><h2>导入结构</h2><p>从 ChemDraw、Marvin JS 或结构文件继续编辑</p></div><button class="icon-button ghost" data-action="close-dialog" aria-label="关闭导入">${icon('close')}</button></div><div class="dialog-body"><div class="file-row"><button data-action="choose-file">${icon('import', 15)}选择文件</button><span class="import-filename">支持 CDXML、MRV、MOL、JSON · 最大 2 MB</span></div><textarea class="source-input import-source" aria-label="结构源数据" spellcheck="false" placeholder="也可以在这里粘贴 CDXML、MRV、MOL 或原生 JSON 源数据…"></textarea><div class="dialog-message import-message">普通分子可导入编辑。暂不支持的复杂化学语义会明确报告。</div></div><div class="dialog-footer"><button data-action="close-dialog">取消</button><button class="primary" data-action="apply-import">导入画布</button></div></dialog>
      <dialog class="export-dialog" aria-label="导出化学结构"><div class="dialog-header"><div><h2>导出结构</h2><p>选择目标应用的格式，并检查转换结果</p></div><button class="icon-button ghost" data-action="close-dialog" aria-label="关闭导出">${icon('close')}</button></div><div class="dialog-body"><select class="export-format" aria-label="导出格式">${formats.map(f => `<option value="${f.format}">${f.name} (${f.extension})</option>`).join('')}<option value="svg">SVG 矢量图片 (.svg)</option></select><textarea class="source-input export-source" readonly aria-label="导出数据预览" spellcheck="false"></textarea><label class="lossy-option"><input type="checkbox" class="allow-lossy"/>允许有损导出（接受报告中列出的信息损失）</label><div class="dialog-message export-message"></div></div><div class="dialog-footer"><span class="spacer"></span><button data-action="copy-export">复制源码</button><button class="primary" data-action="download-export">${icon('export', 15)}下载文件</button></div></dialog>
      <dialog class="issues-dialog" aria-label="兼容报告"><div class="dialog-header"><div><h2>兼容与结构检查</h2><p>查看当前结构和最近一次转换的诊断信息</p></div><button class="icon-button ghost" data-action="close-dialog" aria-label="关闭报告">${icon('close')}</button></div><div class="dialog-body issue-list"></div><div class="dialog-footer"><button data-action="close-dialog">完成</button></div></dialog>
      <dialog class="clear-dialog" aria-label="清空确认"><div class="dialog-header"><h2>清空当前画布？</h2><button class="icon-button ghost" data-action="close-dialog" aria-label="关闭确认">${icon('close')}</button></div><div class="dialog-body">清空后可以通过撤销恢复当前结构。</div><div class="dialog-footer"><button data-action="close-dialog">取消</button><button class="primary" data-action="confirm-clear">清空画布</button></div></dialog>`;
    this.svg = this.query('.canvas'); this.drawing = this.query('.drawing'); this.overlay = this.query('.overlay');
    this.root.addEventListener('click', e => this.onClick(e));
    this.root.addEventListener('change', e => this.onChange(e));
    this.root.addEventListener('input', e => { if ((e.target as Element).classList.contains('command-search')) this.renderSearch(); });
    this.query('.command-search').addEventListener('keydown', e => this.searchKey(e as KeyboardEvent));
    this.query('.ribbon-tabs').addEventListener('keydown', e => {
      const event = e as KeyboardEvent;
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const tabs = ['draw', 'structure', 'view', 'extensions'], index = tabs.indexOf(this.ribbonTab);
      this.ribbonTab = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      this.render(); this.query<HTMLButtonElement>(`[data-tab="${this.ribbonTab}"]`).focus();
    });
    this.addEventListener('keydown', e => this.onKey(e));
    this.addEventListener('keyup', e => { if (e.key === ' ') this.space = false; });
    this.addEventListener('focusout', () => { this.space = false; });
    this.svg.addEventListener('pointerdown', e => this.pointerDown(e));
    this.svg.addEventListener('pointermove', e => this.pointerMove(e));
    this.svg.addEventListener('pointerup', e => this.pointerUp(e));
    this.svg.addEventListener('pointercancel', () => this.cancelGesture());
    this.svg.addEventListener('lostpointercapture', () => this.cancelGesture());
    this.svg.addEventListener('wheel', e => { e.preventDefault(); this.zoom(e.deltaY > 0 ? 1.12 : 1 / 1.12); }, { passive: false });
    this.svg.addEventListener('contextmenu', e => e.preventDefault());
    const area = this.query<HTMLElement>('.canvas-area');
    area.addEventListener('dragover', e => { e.preventDefault(); area.classList.add('drag-over'); });
    area.addEventListener('dragleave', () => area.classList.remove('drag-over'));
    area.addEventListener('drop', e => { e.preventDefault(); area.classList.remove('drag-over'); const file = e.dataTransfer?.files[0]; if (file) void this.openFile(file, true); });
    for (const dialog of this.root.querySelectorAll('dialog')) dialog.addEventListener('close', () => this.previousFocus?.focus());
    this.storageKey = this.getAttribute('storage-key') || undefined;
    if (this.storageKey) {
      this.draftStatus = '本地草稿已启用';
      try { const saved = localStorage.getItem(this.storageKey); if (saved) { const result = importDocument({ data: saved, format: 'json' }); this.store = new DocumentStore(result.document); this.lastIssues = result.issues; this.restored = true; this.fit(); } }
      catch { this.notify('本地草稿无法读取，已打开空白画布'); }
    }
  }
  private query<T extends Element>(selector: string): T { return this.root.querySelector(selector)! as T; }
  private assertLive() { if (this.destroyed) throw new Error('编辑器已销毁'); }
  getDocument(): ChemicalDocument { return this.store.document; }
  getSnapshot(): EditorSnapshot {
    return { apiVersion: EDITOR_API_VERSION, revision: this.store.revision, document: this.getDocument(), selection: this.getSelection(), canUndo: this.store.canUndo, canRedo: this.store.canRedo };
  }
  getSelection(): EditorSelection { return { atomIds: [...this.selection], ...(this.selectedBond ? { bondId: this.selectedBond } : {}) }; }
  setSelection(selection: EditorSelection): void {
    this.assertLive(); this.assertFields(selection, ['atomIds', 'bondId'], '选区');
    const document = this.getDocument();
    if (!Array.isArray(selection.atomIds) || selection.atomIds.some(id => typeof id !== 'string' || !Object.hasOwn(document.graph.atoms, id))) throw new Error('选区引用了不存在的原子');
    if (selection.bondId !== undefined && (typeof selection.bondId !== 'string' || !Object.hasOwn(document.graph.bonds, selection.bondId))) throw new Error('选区引用了不存在的键');
    if (selection.bondId !== undefined && selection.atomIds.length) throw new Error('原子选区与单键选区不能同时设置');
    this.cancelGesture(); this.selection = new Set(selection.atomIds); this.selectedBond = selection.bondId;
    this.tool = 'select'; this.render();
  }
  getDiagnostics(): Diagnostic[] { return clone(this.diagnostics()); }
  applyEdits(request: EditRequest): EditResult {
    this.assertLive(); this.assertFields(request, ['operations', 'expectedRevision'], '编辑请求');
    if (request.expectedRevision !== undefined) {
      if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) throw new Error('版本号必须是非负整数');
      if (request.expectedRevision !== this.store.revision) throw new RevisionConflictError(request.expectedRevision, this.store.revision);
    }
    const result = applyDocumentEdits(this.getDocument(), request.operations);
    this.cancelGesture(); this.store.replace(result.document);
    return { snapshot: this.getSnapshot(), created: result.created };
  }
  registerPlugin(plugin: EditorPlugin, options: { enabled?: boolean } = {}): () => void {
    this.assertLive();
    this.assertFields(options, ['enabled'], '插件选项');
    if (options.enabled !== undefined && typeof options.enabled !== 'boolean') throw new Error('插件启用状态必须为布尔值');
    if (!this.initialized) throw new Error('请在编辑器挂载后注册插件');
    return this.plugins.install(plugin, options.enabled ?? true);
  }
  unregisterPlugin(id: string): void { this.plugins.remove(id); }
  setPluginEnabled(id: string, enabled: boolean): void {
    this.assertLive(); if (typeof enabled !== 'boolean') throw new Error('插件启用状态必须为布尔值');
    this.plugins.setEnabled(id, enabled);
  }
  getPlugins() { return this.plugins.list(); }
  getCommands() { return this.plugins.commands(); }
  executeCommand(id: string, input?: unknown): Promise<unknown> {
    this.assertLive();
    const pluginId = this.getCommands().find(command => command.id === id)?.pluginId;
    if (pluginId && [...this.root.querySelectorAll<HTMLElement>('[data-plugin-panel]')].some(panel => panel.dataset.pluginPanel?.startsWith(`${pluginId}.`))) this.showPluginPanel(pluginId);
    return this.plugins.runCommand(id, input);
  }
  /** Selects a mounted extension panel without reaching into the editor DOM. */
  showPluginPanel(pluginId?: string): void {
    this.assertLive();
    if (pluginId !== undefined && !this.getPlugins().some(plugin => plugin.id === pluginId && plugin.enabled)) throw new Error('插件尚未启用');
    this.activePluginId = pluginId; this.inspectorVisible = true; this.render();
  }
  /** Transport-neutral JSON command API; the host may wrap it in MCP or HTTP. */
  async execute(request: EditorRequest): Promise<unknown> {
    this.assertLive(); this.assertFields(request, ['method', 'params'], 'API 请求');
    const noParams = ['get_snapshot', 'get_selection', 'get_diagnostics', 'export_svg', 'undo', 'redo', 'fit', 'list_plugins', 'list_commands'];
    if (noParams.includes(request.method) && Object.hasOwn(request, 'params')) throw new Error('此方法不接受 params');
    switch (request.method) {
      case 'get_snapshot': return this.getSnapshot();
      case 'get_selection': return this.getSelection();
      case 'set_selection': this.setSelection(request.params); return this.getSelection();
      case 'apply_edits': return this.applyEdits(request.params);
      case 'get_diagnostics': return this.getDiagnostics();
      case 'import': return this.import(request.params);
      case 'export': return this.export(request.params);
      case 'export_svg': return this.exportSvg();
      case 'undo': this.undo(); return this.getSnapshot();
      case 'redo': this.redo(); return this.getSnapshot();
      case 'fit': this.fit(); return { ok: true };
      case 'list_plugins': return this.getPlugins();
      case 'list_commands': return this.getCommands();
      case 'execute_command': this.assertFields(request.params, ['id', 'input'], '插件命令'); return this.executeCommand(request.params.id, request.params.input);
      default: throw new Error(`未知 API 方法：${String((request as { method?: unknown }).method)}`);
    }
  }
  private assertFields(value: unknown, allowed: string[], label: string): asserts value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${label}字段无效`);
  }
  private pluginApi(): EditorApi {
    return {
      getSnapshot: () => this.getSnapshot(), getDocument: () => this.getDocument(),
      getSelection: () => this.getSelection(), setSelection: value => this.setSelection(value),
      getDiagnostics: () => this.getDiagnostics(), applyEdits: value => this.applyEdits(value),
      import: value => this.import(value), export: value => this.export(value), exportSvg: () => this.exportSvg(),
      undo: () => this.undo(), redo: () => this.redo(), fit: () => this.fit(),
    };
  }
  private mountPluginPanel(pluginId: string, panel: PluginPanel): () => void {
    const section = document.createElement('section'); section.className = 'plugin-panel property-section';
    section.dataset.pluginPanel = `${pluginId}.${panel.id}`;
    const heading = document.createElement('h3'); heading.textContent = panel.title;
    const content = document.createElement('div'); content.className = 'plugin-panel-content';
    section.append(heading, content); this.query('.plugin-panels').append(section);
    try {
      const cleanup: unknown = panel.mount(content);
      if (cleanup !== undefined && typeof cleanup !== 'function') {
        void Promise.resolve(cleanup).catch(error => this.reportPluginError(pluginId, error));
        throw new Error('插件面板 mount 必须同步返回清理函数或 undefined');
      }
      this.renderInspectorTabs();
      return () => { try { return cleanup?.(); } finally { section.remove(); this.renderInspectorTabs(); } };
    } catch (error) { section.remove(); throw error; }
  }
  private reportPluginError(pluginId: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.notify(`插件 ${pluginId}：${message}`);
    this.dispatchEvent(new CustomEvent('pluginerror', { detail: { pluginId, message } }));
  }
  private pluginsChanged() {
    if (this.initialized && !this.destroyed) {
      this.renderPlugins();
      this.renderInspectorTabs();
      if (this.root.querySelector('.search-dialog[open]')) this.renderSearch();
    }
    this.dispatchEvent(new CustomEvent('pluginschange', { detail: { plugins: this.getPlugins(), commands: this.getCommands() } }));
  }
  private renderPlugins() {
    const plugins = this.getPlugins(), commands = this.getCommands();
    this.query('.plugin-list').innerHTML = plugins.length ? plugins.map(plugin => `<div class="plugin-card"><span class="plugin-card-icon">${icon('plugins', 23)}</span><div class="plugin-card-info"><strong>${esc(plugin.name)}<small>v${esc(plugin.version)}</small></strong><p>${esc(plugin.description ?? '')}</p><span>${plugin.enabled ? '已启用' : '已停用'} · ${commands.filter(c => c.pluginId === plugin.id).length} 个操作</span></div><button data-plugin-toggle="${esc(plugin.id)}" aria-pressed="${plugin.enabled}" aria-label="${plugin.enabled ? '停用' : '启用'} ${esc(plugin.name)}">${plugin.enabled ? '停用' : '启用'}</button></div>`).join('') : '<div class="plugin-empty">还没有注册插件。接入扩展后，可在这里管理。</div>';
    this.query('.plugin-toolbar').innerHTML = commands.length ? commands.map(command => `<button data-plugin-command="${esc(command.id)}"${command.running ? ' disabled' : ''} title="${esc(command.description ?? command.title)}">${icon('plugins', 15)}${esc(command.title)}${command.running ? '…' : ''}</button>`).join('') : '<span class="plugin-toolbar-empty">启用插件后，这里会显示扩展操作</span>';
  }
  private async runPluginCommand(id: string) {
    try { await this.executeCommand(id); } catch { /* The registry reports errors through pluginerror and the workbench toast. */ }
  }
  private renderInspectorTabs() {
    if (!this.initialized || this.destroyed) return;
    const panels = [...this.root.querySelectorAll<HTMLElement>('[data-plugin-panel]')];
    const plugins = this.getPlugins().filter(plugin => plugin.enabled && panels.some(panel => panel.dataset.pluginPanel?.startsWith(`${plugin.id}.`)));
    if (this.activePluginId && !plugins.some(plugin => plugin.id === this.activePluginId)) this.activePluginId = undefined;
    this.query('.inspector-tabs').innerHTML = `<button role="tab" data-inspector-plugin="" aria-selected="${!this.activePluginId}">结构</button>${plugins.map(plugin => `<button role="tab" data-inspector-plugin="${esc(plugin.id)}" aria-selected="${this.activePluginId === plugin.id}">${esc(plugin.name)}</button>`).join('')}`;
    this.query<HTMLElement>('.inspector-content').hidden = !!this.activePluginId;
    for (const panel of panels) panel.hidden = !this.activePluginId || !panel.dataset.pluginPanel?.startsWith(`${this.activePluginId}.`);
    this.query('.editor').classList.toggle('ai-panel-open', this.inspectorVisible && this.activePluginId === 'ai-assistant');
  }
  private subscribeApiEvent<K extends keyof EditorEvents>(type: K, listener: (detail: EditorEvents[K]) => void): () => void {
    if (!['change', 'selectionchange'].includes(type) || typeof listener !== 'function') throw new Error('插件事件订阅参数无效');
    const handler = (event: Event) => listener(clone((event as CustomEvent<EditorEvents[K]>).detail));
    this.addEventListener(type, handler); return () => this.removeEventListener(type, handler);
  }
  setDocument(doc: ChemicalDocument): void {
    this.assertLive(); validateDocument(doc); this.cancelGesture();
    this.selection.clear(); this.selectedBond = undefined; this.lastIssues = doc.source?.issues ?? [];
    this.store.replace(doc); if (this.initialized) { this.render(); this.fit(); }
  }
  import(input: { data: string; format?: Format; name?: string }): ImportResult {
    this.assertLive(); this.assertFields(input, ['data', 'format', 'name'], '导入请求');
    if (input.name !== undefined && typeof input.name !== 'string') throw new Error('文件名必须为字符串');
    const result = importDocument(input); this.setDocument(result.document);
    this.lastIssues = result.issues; this.render(); return result;
  }
  export(input: { format: Format; allowLossy?: boolean }): ExportResult {
    this.assertFields(input, ['format', 'allowLossy'], '导出请求');
    if (input.allowLossy !== undefined && typeof input.allowLossy !== 'boolean') throw new Error('allowLossy 必须为布尔值');
    return exportDocument(this.getDocument(), input);
  }
  exportSvg(): string { return exportSvg(this.getDocument()); }
  undo(): void { this.assertLive(); this.cancelGesture(); this.store.undo(); }
  redo(): void { this.assertLive(); this.cancelGesture(); this.store.redo(); }
  destroy(): void {
    if (this.destroyed) return;
    this.plugins.destroy(); this.destroyed = true;
    this.unsubscribe?.(); this.unsubscribe = undefined; this.observer?.disconnect();
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.remove();
  }
  setTool(tool: Tool): void { this.assertLive(); if (!Object.hasOwn(toolInfo, tool)) throw new Error('未知绘图工具'); this.cancelGesture(); this.tool = tool; if (this.initialized) this.render(); }
  private changed() {
    const doc = this.getDocument(), revision = this.store.revision;
    this.selection = new Set([...this.selection].filter(id => !!doc.graph.atoms[id]));
    if (this.selectedBond && !doc.graph.bonds[this.selectedBond]) this.selectedBond = undefined;
    if (this.storageKey) {
      try { localStorage.setItem(this.storageKey, JSON.stringify(doc)); this.draftStatus = '已保存到本机'; }
      catch { this.draftStatus = '草稿保存失败'; this.notify('本地草稿保存失败，请导出 JSON 文件保留结构'); }
    }
    this.render();
    // Selection listeners may synchronously commit a newer document during render.
    if (this.store.revision !== revision) return;
    this.dispatchEvent(new CustomEvent('change', { detail: { document: doc, revision }, bubbles: true, composed: true }));
  }
  private diagnostics(): Diagnostic[] {
    const doc = this.getDocument();
    const issues = [...this.lastIssues, ...validateDocument(doc)];
    if (Object.keys(doc.depiction.bonds).some(b => doc.depiction.bonds[b].style !== 'plain')) issues.push({ severity: 'info', code: 'STEREO_DEPICTION', message: '当前保留二维楔线描绘与锚点；尚未实现 CIP 标签计算或编辑过程的拓扑立体约束。' });
    return issues;
  }
  private render() {
    if (!this.initialized) return;
    const doc = this.getDocument();
    this.drawing.innerHTML = moleculeMarkup(doc, this.selection, this.selectedBond);
    this.updateViewBox();
    this.svg.dataset.tool = this.tool;
    this.query('.editor').classList.toggle('inspector-open', this.inspectorVisible);
    this.query<HTMLElement>('.inspector').hidden = !this.inspectorVisible;
    this.query('[data-action="inspector"]').setAttribute('aria-pressed', String(this.inspectorVisible));
    this.query('.canvas-area').classList.toggle('show-grid', this.gridVisible);
    this.query('[data-action="grid"]').setAttribute('aria-pressed', String(this.gridVisible));
    for (const tab of this.root.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
      const active = tab.dataset.tab === this.ribbonTab;
      tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
    }
    for (const panel of this.root.querySelectorAll<HTMLElement>('[data-panel]')) panel.hidden = panel.dataset.panel !== this.ribbonTab;
    this.query<HTMLElement>('.selection-toolbar').hidden = this.selection.size < 2;
    this.query('.selection-count').textContent = `${this.selection.size} 个原子`;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-transform]')) button.disabled = Object.keys(doc.graph.atoms).length < 2 || (this.selection.size === 1);
    this.query('.active-tool').textContent = ['bond', 'double', 'triple', 'wedge', 'hashed'].includes(this.tool) ? `${toolInfo[this.tool].name} · ${this.element}` : toolInfo[this.tool].name;
    this.query('.draft-status').textContent = this.draftStatus;
    this.query<HTMLElement>('.empty-state').hidden = Object.keys(doc.graph.atoms).length !== 0;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('button[data-tool]')) { const active = button.dataset.tool === this.tool; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('button[data-element]')) { const active = button.dataset.element === this.element; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }
    this.query<HTMLButtonElement>('[data-action="undo"]').disabled = !this.store.canUndo;
    this.query<HTMLButtonElement>('[data-action="redo"]').disabled = !this.store.canRedo;
    this.query<HTMLButtonElement>('[data-action="clear"]').disabled = Object.keys(doc.graph.atoms).length === 0;
    const title = this.query<HTMLInputElement>('.document-title'); if (this.root.activeElement !== title) title.value = doc.title;
    this.query<HTMLElement>('.live-status').textContent = toolInfo[this.tool].hint;
    this.renderInspector(doc);
    this.renderInspectorTabs();
    const selection = this.getSelection(), signature = JSON.stringify(selection);
    if (signature !== this.lastSelection) {
      this.lastSelection = signature;
      this.dispatchEvent(new CustomEvent('selectionchange', { detail: { selection, revision: this.store.revision }, bubbles: true, composed: true }));
    }
  }
  private renderInspector(doc: ChemicalDocument) {
    const atoms = Object.values(doc.graph.atoms), bonds = Object.values(doc.graph.bonds), issues = this.diagnostics();
    const formula = molecularFormula(doc).replace(/(\d+)/g, '<sub>$1</sub>');
    let properties = `<h3>结构属性</h3><p>选择原子或化学键，在这里查看并修改属性。</p><div class="hint-card"><strong>${esc(toolInfo[this.tool].name)}工具</strong>${esc(toolInfo[this.tool].hint)}</div>`;
    if (this.selection.size === 1) {
      const a = doc.graph.atoms[[...this.selection][0]], h = hydrogenCount(doc, a.id);
      properties = `<div class="selection-name"><span>${esc(a.element)}</span><small>已选择原子</small></div><label for="atom-element">元素</label><select id="atom-element" data-property="element">${ELEMENTS.map(e => `<option value="${e}"${e === a.element ? ' selected' : ''}>${e}</option>`).join('')}</select><div class="field-row"><div><label for="atom-charge">形式电荷</label><input id="atom-charge" data-property="charge" type="number" step="1" value="${a.charge}"/></div><div><label for="atom-isotope">同位素质量数</label><input id="atom-isotope" data-property="isotope" type="number" min="1" step="1" placeholder="自然丰度" value="${a.isotope ?? ''}"/></div></div><label for="atom-hydrogens">氢数策略</label><select id="atom-hydrogens" data-property="hydrogens"><option value="auto"${a.hydrogens.mode === 'auto' ? ' selected' : ''}>自动推导${h === null ? ' · 待校验' : ` · ${h} H`}</option><option value="fixed"${a.hydrogens.mode === 'fixed' ? ' selected' : ''}>明确指定</option></select>${a.hydrogens.mode === 'fixed' ? `<label for="atom-h-count">非图氢数</label><input id="atom-h-count" data-property="hydrogenCount" type="number" min="0" step="1" value="${a.hydrogens.count}"/>` : ''}<label for="atom-map">原子映射编号</label><input id="atom-map" data-property="atomMap" type="number" min="1" step="1" placeholder="未指定" value="${a.atomMap ?? ''}"/>`;
    } else if (this.selection.size > 1) properties = `<div class="selection-name">${icon('select', 16)}${this.selection.size} 个原子<small>批量编辑</small></div><p>更改属性将应用到全部选中原子。</p><label for="batch-element">元素</label><select id="batch-element" data-property="element"><option value="" disabled selected>选择要应用的元素</option>${ELEMENTS.map(e => `<option value="${e}">${e}</option>`).join('')}</select><label for="batch-charge">形式电荷</label><input id="batch-charge" data-property="charge" type="number" step="1" placeholder="输入统一电荷"/><button class="wide-button" data-action="delete-selection">${icon('clear', 15)}删除所选结构</button>`;
    else if (this.selectedBond) {
      const b = doc.graph.bonds[this.selectedBond], d = doc.depiction.bonds[b.id];
      properties = `<div class="selection-name">化学键<small>已选择</small></div><label for="bond-order">键类型</label><select id="bond-order" data-bond-property="order">${[['1','单键'],['2','双键'],['3','三键'],['aromatic','芳香键']].map(([v,t]) => `<option value="${v}"${String(b.order) === v ? ' selected' : ''}>${t}</option>`).join('')}</select>${b.order === 1 ? `<label for="bond-style">二维描绘</label><select id="bond-style" data-bond-property="style">${[['plain','普通'],['wedge','实楔键'],['hashed','虚楔键'],['wavy','波浪键']].map(([v,t]) => `<option value="${v}"${(d?.style ?? 'plain') === v ? ' selected' : ''}>${t}</option>`).join('')}</select>${d && d.style !== 'plain' ? '<button data-action="flip-bond" style="margin-top:12px;width:100%">交换描绘锚点</button>' : ''}` : ''}`;
    }
    this.query('.inspector-content').innerHTML = `<div class="inspector-heading"><strong>结构与属性</strong><button class="icon-button ghost" data-action="inspector" aria-label="收起属性面板">${icon('close', 16)}</button></div><section class="overview-card"><div class="section-label">分子概览<span>2D STRUCTURE</span></div><div class="formula">${formula}<small>分子式 · 基础价态规则估算</small></div><div class="metrics"><div class="metric"><b>${atoms.length}</b><span>原子</span></div><div class="metric"><b>${bonds.length}</b><span>化学键</span></div><div class="metric"><b>${connectedComponents(doc).length}</b><span>片段</span></div></div></section><section class="property-section">${properties}</section><section class="property-section"><div class="section-label">文件与兼容<span>本地转换</span></div><div class="format-badges"><span class="format-badge">CDXML</span><span class="format-badge">MRV</span><span class="format-badge">MOL</span><span class="format-badge">JSON</span></div><button class="compatibility${issues.some(i => i.severity !== 'info') ? ' has-issues' : ''}" data-action="issues"><span>${icon(issues.length ? 'info' : 'check', 14)}${issues.length ? `${issues.length} 项提示` : '基础检查通过'}</span>查看报告 →</button></section><button class="shortcut-link" data-action="shortcuts">${icon('keyboard', 17)}键盘快捷键<span>?</span></button>`;
  }
  private showDialog(selector: string) {
    this.previousFocus = this.root.activeElement as HTMLElement || this;
    this.query<HTMLDialogElement>(selector).showModal();
  }
  private selectAll() {
    this.cancelGesture(); this.selection = new Set(Object.keys(this.getDocument().graph.atoms));
    this.selectedBond = undefined; this.setTool('select'); this.svg.focus();
  }
  private deleteSelection() {
    this.cancelGesture();
    this.store.transact(doc => { for (const a of this.selection) removeAtom(doc, a); if (this.selectedBond) removeBond(doc, this.selectedBond); });
    this.svg.focus();
  }
  private transformSelection(transform: StructureTransform) {
    this.cancelGesture();
    const doc = this.getDocument(), ids = this.selection.size ? [...this.selection] : Object.keys(doc.graph.atoms);
    if (ids.length < 2) { this.notify('请选择至少两个原子，或取消选择后变换整个结构'); return; }
    this.store.transact(draft => transformAtoms(draft, ids, transform));
    this.svg.focus();
  }
  private useElement(element: string) {
    this.cancelGesture(); this.element = element;
    if (this.selection.size) this.store.transact(doc => { for (const a of this.selection) doc.graph.atoms[a].element = element; });
    else { if (['select', 'erase', 'pan'].includes(this.tool)) this.tool = 'bond'; this.render(); }
    this.svg.focus();
  }
  private loadSample(sample: typeof samples[number]['id']) {
    this.setDocument(exampleDocument(sample)); this.notify('结构模板已载入，可通过撤销恢复之前的结构');
    this.svg.focus();
  }
  private openSearch(value = '') {
    this.cancelGesture(); this.showDialog('.search-dialog');
    const input = this.query<HTMLInputElement>('.command-search'); input.value = value;
    this.renderSearch(); input.focus();
  }
  private commands(): SearchCommand[] {
    return [
      ...this.getCommands().filter(command => !command.running).map(command => ({ name: command.title, detail: `插件 · ${command.pluginId}`, keywords: `${command.id} ${command.description ?? ''}`, icon: 'plugins', run: () => { void this.runPluginCommand(command.id); } })),
      ...(Object.keys(toolInfo) as Tool[]).map(tool => ({ name: toolInfo[tool].name, detail: `绘图工具 · ${toolInfo[tool].key}`, keywords: `${tool} ${toolInfo[tool].hint}`, icon: tool, run: () => { this.setTool(tool); this.svg.focus(); } })),
      ...ELEMENTS.map((element, index) => ({ name: `元素 ${element}`, detail: `原子序数 ${index + 1} · 应用于所选原子或下一次绘制`, keywords: `element 元素 ${element}`, icon: 'plus', run: () => this.useElement(element) })),
      ...samples.map(sample => ({ name: sample.name, detail: `结构模板 · ${sample.english}`, keywords: `${sample.english} 模板 ${sample.category}`, icon: 'templates', run: () => this.loadSample(sample.id) })),
      ...(['rotate-left', 'rotate-right', 'mirror-horizontal', 'mirror-vertical'] as const).map((action, index) => ({ name: ['左转 30°', '右转 30°', '水平镜像', '垂直镜像'][index], detail: '变换所选结构；未选择时作用于整个分子', keywords: `${action} 旋转 镜像`, icon: action, run: () => this.transformSelection(action) })),
      ...([
        ['全选结构', 'select', () => this.selectAll()], ['适应画布', 'fit', () => this.fit()],
        ['结构模板库', 'templates', () => this.showDialog('.templates-dialog')], ['切换网格', 'grid', () => { this.gridVisible = !this.gridVisible; this.render(); }],
        ['结构属性面板', 'panel', () => { this.inspectorVisible = !this.inspectorVisible; this.render(); }],
        ['键盘快捷键', 'keyboard', () => this.showDialog('.shortcuts-dialog')],
      ] as [string, string, () => void][]).map(([name, icon, run]) => ({ name, detail: '工作台操作', keywords: name, icon, run })),
    ];
  }
  private renderSearch() {
    const query = this.query<HTMLInputElement>('.command-search').value.trim().toLowerCase();
    const commands = this.commands();
    this.searchResults = query ? commands.filter(c => `${c.name} ${c.detail} ${c.keywords}`.toLowerCase().includes(query)) : commands.filter(c => !c.name.startsWith('元素 '));
    this.searchIndex = 0; this.renderSearchResults();
  }
  private renderSearchResults() {
    this.query('.search-results').innerHTML = this.searchResults.length ? this.searchResults.map((command, index) => `<button id="command-${index}" role="option" tabindex="-1" aria-selected="${index === this.searchIndex}" data-command="${index}"><span class="command-icon">${icon(command.icon, 19)}</span><span><strong>${esc(command.name)}</strong><small>${esc(command.detail)}</small></span><span class="command-enter">↵</span></button>`).join('') : '<div class="search-empty">没有找到匹配项，试试“苯环”、“O”或“镜像”。</div>';
    const input = this.query('.command-search');
    if (this.searchResults.length) input.setAttribute('aria-activedescendant', `command-${this.searchIndex}`);
    else input.removeAttribute('aria-activedescendant');
    this.root.querySelector<HTMLElement>(`#command-${this.searchIndex}`)?.scrollIntoView({ block: 'nearest' });
  }
  private runSearch(index: number) {
    const command = this.searchResults[index]; if (!command) return;
    this.query<HTMLDialogElement>('.search-dialog').close(); command.run();
  }
  private searchKey(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === 'Enter') { event.preventDefault(); this.runSearch(this.searchIndex); }
    else if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      if (!this.searchResults.length) return;
      this.searchIndex = (this.searchIndex + (event.key === 'ArrowDown' ? 1 : this.searchResults.length - 1)) % this.searchResults.length;
      this.renderSearchResults();
    }
  }
  private closeDialog(target: Element) { target.closest('dialog')?.close(); }
  private notify(message: string) {
    if (!this.initialized || this.destroyed) return;
    const toast = this.query<HTMLElement>('.toast'); toast.textContent = message; toast.hidden = false;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { toast.hidden = true; }, 4000);
  }
  private onClick(event: Event) {
    const target = (event.target as Element).closest<HTMLElement>('button'); if (!target) return;
    if (target.dataset.inspectorPlugin !== undefined) { this.showPluginPanel(target.dataset.inspectorPlugin || undefined); return; }
    if (target.dataset.pluginToggle) {
      const plugin = this.getPlugins().find(plugin => plugin.id === target.dataset.pluginToggle);
      if (plugin) { try { this.setPluginEnabled(plugin.id, !plugin.enabled); } catch { /* Registry emits a visible plugin error. */ } }
      return;
    }
    if (target.dataset.pluginCommand) { void this.runPluginCommand(target.dataset.pluginCommand); return; }
    if (target.dataset.tab) { this.ribbonTab = target.dataset.tab; this.render(); return; }
    if (target.dataset.transform) { this.transformSelection(target.dataset.transform as StructureTransform); return; }
    if (target.dataset.command !== undefined) { this.runSearch(Number(target.dataset.command)); return; }
    if (target.dataset.sample) { this.closeDialog(target); this.loadSample(target.dataset.sample as typeof samples[number]['id']); return; }
    const tool = target.dataset.tool as Tool | undefined;
    if (tool) { this.setTool(tool); this.svg.focus(); return; }
    const element = target.dataset.element;
    if (element) {
      this.useElement(element); return;
    }
    switch (target.dataset.action) {
      case 'plugins': this.renderPlugins(); this.showDialog('.plugins-dialog'); break;
      case 'search': this.openSearch(); break;
      case 'elements': this.openSearch('元素 '); break;
      case 'templates': this.showDialog('.templates-dialog'); break;
      case 'shortcuts': this.showDialog('.shortcuts-dialog'); break;
      case 'select-all': this.selectAll(); break;
      case 'delete-selection': this.deleteSelection(); break;
      case 'grid': this.gridVisible = !this.gridVisible; this.render(); break;
      case 'inspector': this.inspectorVisible = !this.inspectorVisible; this.render(); break;
      case 'svg': this.query<HTMLSelectElement>('.export-format').value = 'svg'; this.updateExport(); this.showDialog('.export-dialog'); break;
      case 'undo': this.undo(); break;
      case 'redo': this.redo(); break;
      case 'fit': this.fit(); break;
      case 'zoom-in': this.zoom(1 / 1.2); break;
      case 'zoom-out': this.zoom(1.2); break;
      case 'clear': this.showDialog('.clear-dialog'); break;
      case 'confirm-clear': this.closeDialog(target); this.setDocument(emptyDocument()); break;
      case 'import': this.pendingImport = undefined; this.query<HTMLTextAreaElement>('.import-source').value = ''; this.query('.import-filename').textContent = '支持 CDXML、MRV、MOL、JSON · 最大 2 MB'; this.importMessage('普通分子可导入编辑。复杂化学语义会明确报告。'); this.showDialog('.import-dialog'); break;
      case 'choose-file': this.query<HTMLInputElement>('.file-input').click(); break;
      case 'apply-import': this.applyImport(); break;
      case 'export': case 'source': this.query<HTMLInputElement>('.allow-lossy').checked = false; this.updateExport(); this.showDialog('.export-dialog'); break;
      case 'download-export': this.downloadExport(); break;
      case 'copy-export': void this.copyExport(); break;
      case 'close-dialog': this.closeDialog(target); break;
      case 'issues': this.showIssues(); break;
      case 'flip-bond': this.store.transact(doc => { const b = doc.graph.bonds[this.selectedBond!], d = doc.depiction.bonds[b.id]; if (d) d.from = d.from === b.atoms[0] ? b.atoms[1] : b.atoms[0]; }); break;
    }
  }
  private onChange(event: Event) {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    if (target.classList.contains('document-title')) { this.store.transact(doc => { doc.title = target.value.trim() || '未命名结构'; }); return; }
    if (target.classList.contains('sample-select')) { if (target.value) { this.setDocument(exampleDocument(target.value as 'aspirin')); this.notify('示例已载入，可通过撤销恢复之前的结构'); } target.value = ''; return; }
    if (target.classList.contains('file-input')) { const file = (target as HTMLInputElement).files?.[0]; if (file) void this.openFile(file); target.value = ''; return; }
    if (target.classList.contains('export-format') || target.classList.contains('allow-lossy')) { this.updateExport(); return; }
    const property = target.dataset.property;
    try {
      if (property && this.selection.size) {
        this.store.transact(doc => {
          for (const id of this.selection) {
          const atom = doc.graph.atoms[id];
          if (property === 'element') atom.element = target.value;
          else if (property === 'charge') atom.charge = Number(target.value);
          else if (property === 'isotope') { if (target.value === '') delete atom.isotope; else atom.isotope = Number(target.value); }
          else if (property === 'atomMap') { if (target.value === '') delete atom.atomMap; else atom.atomMap = Number(target.value); }
          else if (property === 'hydrogens') atom.hydrogens = target.value === 'auto' ? { mode: 'auto' } : { mode: 'fixed', count: hydrogenCount(doc, atom.id) ?? 0 };
          else if (property === 'hydrogenCount') atom.hydrogens = { mode: 'fixed', count: Number(target.value) };
          }
        });
      }
      if (target.dataset.bondProperty && this.selectedBond) {
        this.store.transact(doc => {
          const b = doc.graph.bonds[this.selectedBond!];
          if (target.dataset.bondProperty === 'order') { b.order = target.value === 'aromatic' ? 'aromatic' : Number(target.value) as BondOrder; if (b.order !== 1) delete doc.depiction.bonds[b.id]; }
          else if (target.value === 'plain') delete doc.depiction.bonds[b.id];
          else doc.depiction.bonds[b.id] = { style: target.value as 'wedge', from: doc.depiction.bonds[b.id]?.from ?? b.atoms[0] };
        });
      }
    } catch (error) { this.notify((error as Error).message); this.render(); }
  }
  private importMessage(message: string, error = false) { const el = this.query('.import-message'); el.textContent = message; el.classList.toggle('error', error); }
  private async openFile(file: File, apply = false) {
    if (file.size > 2_000_000) { this.notify('文件大小超过 2 MB'); return; }
    if (/\.cdx$/i.test(file.name)) { this.notify('CDX 二进制适配尚未实现，请先从 ChemDraw 另存为 CDXML'); return; }
    try {
      const data = await file.text(); this.pendingImport = { name: file.name, data };
      if (apply) { this.import({ data, name: file.name }); this.notify(`已导入 ${file.name}`); return; }
      this.query<HTMLTextAreaElement>('.import-source').value = data;
      this.query('.import-filename').textContent = file.name;
      this.importMessage('文件已读取，点击“导入画布”完成导入。');
    } catch (error) { this.lastIssues = error instanceof FormatError ? error.issues : [{ severity: 'error', code: 'FILE_READ', message: (error as Error).message }]; if (apply) this.showIssues(); else this.importMessage((error as Error).message, true); }
  }
  private applyImport() {
    try {
      const data = this.query<HTMLTextAreaElement>('.import-source').value;
      const result = this.import({ data, name: this.pendingImport?.data === data ? this.pendingImport.name : undefined });
      this.query<HTMLDialogElement>('.import-dialog').close();
      this.notify(result.issues.length ? `已导入结构，另有 ${result.issues.length} 项兼容提示` : '结构已导入');
    } catch (error) {
      this.lastIssues = error instanceof FormatError ? error.issues : [];
      this.importMessage((error as Error).message, true); this.render();
    }
  }
  private updateExport() {
    const format = this.query<HTMLSelectElement>('.export-format').value;
    const preview = this.query<HTMLTextAreaElement>('.export-source'), message = this.query<HTMLElement>('.export-message');
    this.exportResult = undefined; message.classList.remove('error');
    try {
      if (format === 'svg') {
        preview.value = this.exportSvg(); message.textContent = 'SVG 是矢量图片。需要继续编辑化学数据时，请选择 JSON、MRV 或 CDXML。';
      } else {
        const result = this.export({ format: format as Format, allowLossy: this.query<HTMLInputElement>('.allow-lossy').checked });
        this.exportResult = result; preview.value = result.data;
        message.textContent = result.passthrough ? '结构与布局尚未修改，将原样返回源文件。源文件中未解释的内容仍保留。' : result.issues.length ? result.issues.map(i => i.message).join(' ') : formats.find(f => f.format === format)!.description;
        message.classList.toggle('error', result.issues.length > 0 && !result.passthrough);
      }
      this.query<HTMLButtonElement>('[data-action="download-export"]').disabled = false;
      this.query<HTMLButtonElement>('[data-action="copy-export"]').disabled = false;
    } catch (error) {
      preview.value = ''; message.classList.add('error');
      this.lastIssues = error instanceof FormatError ? error.issues : [];
      message.textContent = `${(error as Error).message} ${this.lastIssues.filter(i => i.code !== 'LOSSY_EXPORT_BLOCKED').map(i => i.message).join(' ')}`;
      this.query<HTMLButtonElement>('[data-action="download-export"]').disabled = true;
      this.query<HTMLButtonElement>('[data-action="copy-export"]').disabled = true;
    }
  }
  private downloadExport() {
    const format = this.query<HTMLSelectElement>('.export-format').value;
    const data = this.query<HTMLTextAreaElement>('.export-source').value;
    if (!data || (format !== 'svg' && !this.exportResult)) return;
    const extension = format === 'svg' ? '.svg' : formats.find(f => f.format === format)!.extension;
    const blob = new Blob([data], { type: format === 'svg' ? 'image/svg+xml;charset=utf-8' : format === 'json' ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = (this.getDocument().title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'structure') + extension; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (this.exportResult) { this.lastIssues = this.exportResult.issues; this.render(); }
    this.notify('文件已导出');
  }
  private async copyExport() {
    try { await navigator.clipboard.writeText(this.query<HTMLTextAreaElement>('.export-source').value); this.notify('结构源码已复制'); }
    catch { this.notify('浏览器未允许复制，请选择预览中的源码手动复制'); }
  }
  private showIssues() {
    const issues = this.diagnostics();
    this.query('.issue-list').innerHTML = issues.length ? issues.map(i => `<div class="issue ${i.severity}">${esc(i.message)}<small>${esc(i.code)}</small></div>`).join('') : '<div class="issue">当前基础结构检查未发现问题。完整立体化学、Markush、反应及聚合物尚未实现。</div>';
    this.showDialog('.issues-dialog');
  }
  fit(): void {
    this.assertLive();
    if (!this.initialized) return;
    const box = documentBounds(this.getDocument()), rect = this.svg.getBoundingClientRect();
    const aspect = Math.max(.5, rect.width / (rect.height || 500));
    const width = Math.max(12, box.width + 3, (box.height + 3) * aspect);
    const height = width / aspect;
    this.camera = { x: box.x + box.width / 2 - width / 2, y: box.y + box.height / 2 - height / 2, width, height };
    this.updateViewBox();
  }
  private resizeCamera() {
    const rect = this.svg.getBoundingClientRect(); if (!rect.width || !rect.height) return;
    const cy = this.camera.y + this.camera.height / 2;
    this.camera.height = this.camera.width * rect.height / rect.width;
    this.camera.y = cy - this.camera.height / 2; this.updateViewBox();
  }
  private updateViewBox() {
    this.svg.setAttribute('viewBox', `${this.camera.x} ${this.camera.y} ${this.camera.width} ${this.camera.height}`);
    this.query('.zoom-label').textContent = `${Math.round(18 / this.camera.width * 100)}%`;
  }
  private zoom(factor: number) {
    const width = Math.min(150, Math.max(4, this.camera.width * factor)), ratio = width / this.camera.width;
    const height = this.camera.height * ratio;
    this.camera = { x: this.camera.x + (this.camera.width - width) / 2, y: this.camera.y + (this.camera.height - height) / 2, width, height };
    this.updateViewBox();
  }
  private point(event: PointerEvent): Point {
    const matrix = this.svg.getScreenCTM();
    if (!matrix) return { x: 0, y: 0 };
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: p.x, y: -p.y };
  }
  private nearest(point: Point, doc: ChemicalDocument, exclude?: string): AtomId | undefined {
    const radius = Math.max(.25, this.camera.width / Math.max(200, this.svg.clientWidth) * 13);
    let nearest: string | undefined, distance = radius;
    for (const a of Object.keys(doc.graph.atoms)) {
      const p = doc.depiction.positions[a], d = Math.hypot(p.x - point.x, p.y - point.y);
      if (a !== exclude && d < distance) { nearest = a; distance = d; }
    }
    return nearest;
  }
  private pointerDown(event: PointerEvent) {
    if (this.gesture || (event.button !== 0 && event.button !== 1)) return;
    event.preventDefault(); this.svg.focus();
    const point = this.point(event), doc = this.getDocument();
    const atom = (event.target as Element).closest('[data-atom]')?.getAttribute('data-atom') ?? this.nearest(point, doc);
    const bond = (event.target as Element).closest('[data-bond]')?.getAttribute('data-bond') ?? undefined;
    const active = this.space || event.button === 1 ? 'pan' : this.tool;
    if (active === 'erase') {
      if (atom || bond) this.store.transact(d => { if (atom) removeAtom(d, atom); else if (bond) removeBond(d, bond); });
      return;
    }
    if (active === 'ring' || active === 'benzene') {
      this.selection.clear(); this.selectedBond = undefined;
      this.store.transact(d => {
        const p = atom ? d.depiction.positions[atom] : point;
        const ring = insertRing(d, atom ? { x: p.x + 2.8, y: p.y - .75 } : p, active === 'benzene');
        if (atom) addBond(d, atom, ring[2]);
      }); return;
    }
    let kind: Gesture['kind'] = active === 'pan' ? 'pan' : 'bond';
    if (active === 'select') {
      this.selectedBond = undefined;
      if (atom) {
        if (event.shiftKey && this.selection.has(atom)) this.selection.delete(atom);
        else if (event.shiftKey) this.selection.add(atom);
        else if (!this.selection.has(atom)) this.selection = new Set([atom]);
        kind = 'move';
      } else if (bond) { this.selection.clear(); this.selectedBond = bond; this.render(); return; }
      else { if (!event.shiftKey) this.selection.clear(); kind = 'box'; }
      this.render();
    } else if (active !== 'pan' && bond && !atom) {
      this.selectedBond = bond; this.selection.clear();
      this.store.transact(d => {
        const b = d.graph.bonds[bond];
        if (active === 'wedge' || active === 'hashed') { b.order = 1; d.depiction.bonds[bond] = { style: active === 'wedge' ? 'wedge' : 'hashed', from: b.atoms[0] }; }
        else { b.order = active === 'double' ? 2 : active === 'triple' ? 3 : b.order === 1 ? 2 : b.order === 2 ? 3 : 1; delete d.depiction.bonds[bond]; }
      }); return;
    }
    this.gesture = { kind, point, current: point, origin: atom, base: doc, camera: { ...this.camera }, clientX: event.clientX, clientY: event.clientY, moved: false };
    this.svg.setPointerCapture(event.pointerId);
  }
  private bondEndpoint(gesture: Gesture, event?: PointerEvent): { point: Point; target?: AtomId } {
    const doc = gesture.base, origin = gesture.origin ? doc.depiction.positions[gesture.origin] : gesture.point;
    const target = this.nearest(gesture.current, doc, gesture.origin);
    if (target) return { point: doc.depiction.positions[target], target };
    const dx = gesture.current.x - origin.x, dy = gesture.current.y - origin.y;
    let angle: number;
    if (Math.hypot(dx, dy) < .25 && gesture.origin) {
      const near = neighbors(doc, gesture.origin);
      if (near.length === 1) { const p = doc.depiction.positions[near[0]]; angle = -Math.atan2(origin.y - p.y, origin.x - p.x); if (Math.abs(Math.sin(angle)) < .1) angle += Math.PI / 6; }
      else if (near.length > 1) {
        const candidates = Array.from({ length: 12 }, (_, i) => i * Math.PI / 6);
        angle = candidates.sort((a, b) => {
          const score = (v: number) => Math.min(...near.map(n => { const p = doc.depiction.positions[n]; return Math.hypot(origin.x + 1.5 * Math.cos(v) - p.x, origin.y + 1.5 * Math.sin(v) - p.y); }));
          return score(b) - score(a);
        })[0];
      } else angle = Math.PI / 6;
    } else angle = Math.hypot(dx, dy) < .25 ? Math.PI / 6 : Math.atan2(dy, dx);
    if (!event?.altKey) angle = Math.round(angle / (Math.PI / 6)) * Math.PI / 6;
    const point = { x: origin.x + 1.5 * Math.cos(angle), y: origin.y + 1.5 * Math.sin(angle) };
    const snapped = this.nearest(point, doc, gesture.origin);
    return snapped ? { point: doc.depiction.positions[snapped], target: snapped } : { point };
  }
  private pointerMove(event: PointerEvent) {
    const g = this.gesture; if (!g) return;
    g.current = this.point(event);
    g.moved ||= Math.hypot(event.clientX - g.clientX, event.clientY - g.clientY) > 4;
    if (g.kind === 'pan') {
      const rect = this.svg.getBoundingClientRect();
      this.camera.x = g.camera.x - (event.clientX - g.clientX) * g.camera.width / rect.width;
      this.camera.y = g.camera.y - (event.clientY - g.clientY) * g.camera.height / rect.height;
      this.updateViewBox();
    } else if (g.kind === 'move') {
      const draft = clone(g.base);
      for (const a of this.selection) { const p = draft.depiction.positions[a]; p.x += g.current.x - g.point.x; p.y += g.current.y - g.point.y; }
      this.drawing.innerHTML = moleculeMarkup(draft, this.selection);
    } else if (g.kind === 'box') {
      this.overlay.innerHTML = `<rect x="${Math.min(g.point.x, g.current.x)}" y="${-Math.max(g.point.y, g.current.y)}" width="${Math.abs(g.current.x - g.point.x)}" height="${Math.abs(g.current.y - g.point.y)}" fill="#449b7b12" stroke="#62a68c" stroke-width=".025" stroke-dasharray=".1 .1"/>`;
    } else {
      const origin = g.origin ? g.base.depiction.positions[g.origin] : g.point;
      const end = this.bondEndpoint(g, event);
      this.overlay.innerHTML = `<line x1="${origin.x}" y1="${-origin.y}" x2="${end.point.x}" y2="${-end.point.y}" stroke="#4f9c85" stroke-width=".05" stroke-dasharray=".13 .1"/>${end.target ? `<circle cx="${end.point.x}" cy="${-end.point.y}" r=".35" fill="#a4d1bf38" stroke="#5d9c83" stroke-width=".025"/>` : ''}`;
    }
  }
  private pointerUp(event: PointerEvent) {
    const g = this.gesture; if (!g) return;
    g.current = this.point(event);
    g.moved ||= Math.hypot(event.clientX - g.clientX, event.clientY - g.clientY) > 4;
    this.gesture = undefined;
    if (this.svg.hasPointerCapture(event.pointerId)) this.svg.releasePointerCapture(event.pointerId);
    this.overlay.innerHTML = '';
    if (g.kind === 'pan') return;
    if (g.kind === 'move') {
      if (g.moved) this.store.transact(doc => { for (const a of this.selection) { doc.depiction.positions[a].x += g.current.x - g.point.x; doc.depiction.positions[a].y += g.current.y - g.point.y; } });
      else this.render();
      return;
    }
    if (g.kind === 'box') {
      if (g.moved) {
        for (const [a, p] of Object.entries(g.base.depiction.positions)) if (p.x >= Math.min(g.point.x, g.current.x) && p.x <= Math.max(g.point.x, g.current.x) && p.y >= Math.min(g.point.y, g.current.y) && p.y <= Math.max(g.point.y, g.current.y)) this.selection.add(a);
      }
      this.render(); return;
    }
    const end = this.bondEndpoint(g, event);
    this.selectedBond = undefined;
    this.store.transact(doc => {
      if (!g.origin && !g.moved) {
        const a = addAtom(doc, this.element, g.point); this.selection = new Set([a]); return;
      }
      const start = g.origin ?? addAtom(doc, 'C', g.point), finish = end.target ?? addAtom(doc, this.element, end.point);
      if (start === finish) return;
      const order = this.tool === 'double' ? 2 : this.tool === 'triple' ? 3 : 1;
      const existing = findBond(doc, start, finish);
      const bond = addBond(doc, start, finish, order);
      if (this.tool === 'wedge' || this.tool === 'hashed') doc.depiction.bonds[bond] = { style: this.tool === 'wedge' ? 'wedge' : 'hashed', from: start };
      else if (existing) delete doc.depiction.bonds[bond];
      this.selection = new Set([finish]);
    });
  }
  private cancelGesture() {
    this.gesture = undefined;
    if (this.initialized) { this.overlay.innerHTML = ''; this.drawing.innerHTML = moleculeMarkup(this.getDocument(), this.selection, this.selectedBond); }
  }
  private onKey(event: KeyboardEvent) {
    if (event.isComposing) return;
    const input = event.composedPath()[0] as HTMLElement;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !this.root.querySelector('dialog[open]')) { event.preventDefault(); this.openSearch(); return; }
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(input.tagName) || this.root.querySelector('dialog[open]')) return;
    if (event.ctrlKey || event.metaKey) {
      const key = event.key.toLowerCase();
      if (key === 'z') { event.preventDefault(); event.shiftKey ? this.redo() : this.undo(); }
      else if (key === 'y') { event.preventDefault(); this.redo(); }
      else if (key === 'a') { event.preventDefault(); this.selectAll(); }
      else if (key === 's') { event.preventDefault(); this.updateExport(); this.showDialog('.export-dialog'); }
      return;
    }
    if (event.key === ' ') { event.preventDefault(); this.space = true; return; }
    if (event.key === '?') { event.preventDefault(); this.showDialog('.shortcuts-dialog'); return; }
    if (event.key === 'Escape') { this.selection.clear(); this.selectedBond = undefined; this.setTool('select'); return; }
    if (event.key === 'Enter') { event.preventDefault(); this.fit(); return; }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      this.deleteSelection();
      return;
    }
    if (['+', '-', '='].includes(event.key) && this.selection.size) {
      event.preventDefault();
      this.store.transact(doc => { for (const a of this.selection) doc.graph.atoms[a].charge += event.key === '-' ? -1 : 1; }); return;
    }
    const key = event.key.toUpperCase();
    if (['C', 'N', 'O', 'S', 'P', 'F', 'H', 'I'].includes(key)) {
      this.element = key;
      if (this.selection.size) this.store.transact(doc => { for (const a of this.selection) doc.graph.atoms[a].element = key; });
      else this.render();
      return;
    }
    const tool = (Object.keys(toolInfo) as Tool[]).find(t => toolInfo[t].key === key);
    if (tool) { event.preventDefault(); this.setTool(tool); }
  }
}

export function registerChemicalEditor(tagName = 'chemical-editor'): void {
  if (!globalThis.customElements) throw new Error('化学编辑器需要浏览器环境');
  if (!customElements.get(tagName)) customElements.define(tagName, tagName === 'chemical-editor' ? ChemicalEditorElement : class extends ChemicalEditorElement {});
}
export interface ChemicalEditorOptions { container: HTMLElement; document?: ChemicalDocument; storageKey?: string; plugins?: EditorPlugin[] }
export function createChemicalEditor(options: ChemicalEditorOptions): ChemicalEditorElement {
  registerChemicalEditor();
  const element = document.createElement('chemical-editor') as ChemicalEditorElement;
  if (options.storageKey) element.setAttribute('storage-key', options.storageKey);
  options.container.append(element);
  if (options.document && !element.restored) element.setDocument(options.document);
  try { for (const plugin of options.plugins ?? []) element.registerPlugin(plugin); }
  catch (error) { element.destroy(); throw error; }
  return element;
}
