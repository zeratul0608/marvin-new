import { addAtom, addBond, clone, connectedComponents, emptyDocument, findBond, hydrogenCount, molecularFormula, neighbors, removeAtom, removeBond, validateDocument, ELEMENTS } from '../core/model';
import { DocumentStore } from '../core/store';
import { BrowserDraftStore, type DraftRecord } from './drafts';
import { applyDocumentEdits, type EditOperation } from '../core/edits';
import { circularOrderingFromDrawing } from '../core/stereochemistry';
import { queryLabel } from '../core/query';
import {changedQueryConstraint} from './query-inspector';
import { documentPage, moveDrawing, removeDrawing } from '../core/drawing';
import { advancedEditorSections, advancedInspectorContent, type AdvancedEditorSection } from './advanced-inspector';
import { advancedFeatures, advancedSelectionSummary, type AdvancedFeature } from './advanced-features';
import { EditorI18n, normalizeEditorLocale, type EditorLocale } from './i18n';
import { translateEnglish } from './i18n-en';
import { EDITOR_API_VERSION, RevisionConflictError } from './api-types';
import type { EditRequest, EditResult, EditorApi, EditorEvents, EditorPlugin, EditorRequest, EditorSelection, EditorSnapshot, PluginPanel } from './api-types';
import { PluginRegistry } from './plugins';
import { transformAtoms, type StructureTransform } from '../core/geometry';
import { layoutActions, type LayoutAction } from '../core/layout';
import { exampleDocument, insertRing } from '../core/templates';
import {getPolymerGroup,type PolymerChanges} from '../core/polymers';
import type { AtomId, BondOrder, ChemicalDocument, Diagnostic, ExportResult, Format, ImportInput, ImportResult, Point, SourceFileExportResult, StereoBondOrdering } from '../core/types';
import { decodeCdx, encodeCdx, isCdx } from '../formats/cdx';
import { exportDocument, exportOriginalSource, exportSourceFile, formats, FormatError, importDocument } from '../formats';
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
  kind: 'bond' | 'move' | 'box' | 'pan' | 'drawing';
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
  private selectedDrawing?: string;
  private viewPage?:string;
  private camera = { x: -9, y: -6, width: 18, height: 12 };
  private gesture?: Gesture;
  private space = false;
  private toastTimer?: ReturnType<typeof setTimeout>;
  private lastIssues: Diagnostic[] = [];
  private pendingImport?: { name?: string; data: string };
  private exportResult?: ExportResult | SourceFileExportResult;
  private exportRevision = -1;
  private previousFocus?: HTMLElement;
  private root!: ShadowRoot;
  private svg!: SVGSVGElement;
  private drawing!: SVGGElement;
  private overlay!: SVGGElement;
  private storageKey?: string;
  private drafts?: BrowserDraftStore;
  private draftSaveSequence = 0;
  private draftListSequence = 0;
  private draftRecords = new Map<string, DraftRecord>();
  private notifiedDraftConflict = false;
  private ribbonTab = 'draw';
  private gridVisible = false;
  private inspectorVisible = false;
  private activePluginId?: string;
  private advancedVisible = false;
  private advancedSection: AdvancedEditorSection = 'properties';
  private inspectorMode: 'basic' | 'advanced' = 'basic';
  private locale: EditorLocale = 'zh-CN';
  private i18n?: EditorI18n;
  private inspectorFocusTarget?: HTMLElement;
  private committingField?: HTMLElement;
  private fieldCommitError?: string;
  private inspectorContentKey?: string;
  private inspectorContextKey?: string;
  private inspectorNeedsScrollRestore = false;
  private inspectorScrollPositions = new Map<string, number>();
  private visibleInspectorView?: string;
  private pluginTabsKey = '';
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

  static get observedAttributes() { return ['lang']; }
  attributeChangedCallback(name: string, previous: string | null, value: string | null): void {
    if (name === 'lang' && value !== previous && !this.destroyed) this.setLocale(value === null ? 'zh-CN' : normalizeEditorLocale(value));
  }
  getLocale(): EditorLocale { return this.locale; }
  setLocale(locale: EditorLocale): void {
    this.assertLive();
    const next = normalizeEditorLocale(locale), changed = next !== this.locale;
    this.locale = next;
    if (this.getAttribute('lang') !== next) this.setAttribute('lang',next);
    if (this.initialized) {
      this.query<HTMLSelectElement>('.locale-select').value = next;
      this.i18n?.setLocale(next);
      for (const nested of this.root.querySelectorAll<ChemicalEditorElement>('chemical-editor')) nested.setLocale(next);
      this.setAttribute('aria-label', next === 'en' ? 'Chemical structure editor' : '化学结构编辑器');
      if (this.query<HTMLDialogElement>('.search-dialog').open) this.renderSearch();
      this.renderInspectorTabs();
    }
    if (changed) this.dispatchEvent(new CustomEvent('localechange', {detail:{locale:next},bubbles:true,composed:true}));
  }
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
    this.setAttribute('aria-label', this.locale === 'en' ? 'Chemical structure editor' : '化学结构编辑器');
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
          <button class="advanced-toggle" data-action="toggle-advanced" aria-label="高级编辑" aria-expanded="false" aria-controls="advanced-tools" title="展开高级编辑栏">${icon('settings', 16)}<span>高级编辑</span>${icon('plus', 14)}</button>
          <div class="separator"></div>
          <button data-action="import" aria-label="导入">${icon('import', 16)}<span class="button-label">导入</span></button>
          <button class="primary" data-action="export" aria-label="导出">${icon('export', 16)}<span class="button-label">导出</span></button>
        </div>
        <div class="ribbon">
          <div class="ribbon-tabs" role="tablist" aria-label="编辑功能"><button role="tab" id="draw-tab" aria-controls="draw-panel" data-tab="draw">绘制</button><button role="tab" id="structure-tab" aria-controls="structure-panel" data-tab="structure">结构</button><button role="tab" id="view-tab" aria-controls="view-panel" data-tab="view">视图</button></div>
          <div class="ribbon-panel" id="draw-panel" role="tabpanel" aria-labelledby="draw-tab" data-panel="draw"><span class="ribbon-caption">开始绘制</span><button data-tool="bond">${icon('bond', 17)}单键</button><button data-tool="benzene">${icon('benzene', 17)}苯环</button><span class="separator"></span><button data-action="templates">${icon('templates', 16)}结构模板</button><button data-action="elements">${icon('plus', 16)}全部元素</button></div>
          <div class="ribbon-panel" id="structure-panel" role="tabpanel" aria-labelledby="structure-tab" data-panel="structure" hidden><button data-action="select-all">${icon('select', 17)}全选</button><span class="separator"></span><button data-transform="rotate-left">${icon('rotate-left', 17)}左转 30°</button><button data-transform="rotate-right">${icon('rotate-right', 17)}右转 30°</button><button data-transform="mirror-horizontal">${icon('mirror-horizontal', 17)}水平镜像</button><button data-transform="mirror-vertical">${icon('mirror-vertical', 17)}垂直镜像</button></div>
          <div class="ribbon-panel" id="view-panel" role="tabpanel" aria-labelledby="view-tab" data-panel="view" hidden><button data-action="fit">${icon('fit', 17)}适应画布</button><button data-action="grid" aria-pressed="false">${icon('grid', 17)}网格</button><button data-action="svg">${icon('export', 17)}导出 SVG</button><button data-action="shortcuts">${icon('keyboard', 17)}快捷键</button></div>
          <button class="inspector-toggle icon-button" data-action="inspector" aria-label="结构属性面板" aria-pressed="true" title="结构属性面板">${icon('panel', 18)}</button>
        </div>
        <div class="advanced-tools" id="advanced-tools" aria-label="高级编辑栏" hidden>
          <span class="advanced-tools-label">高级编辑</span><div class="advanced-section-tabs" role="toolbar" aria-label="高级编辑分类">${advancedEditorSections.map(section => `<button data-advanced-section="${section.id}" aria-pressed="false">${section.label}<span class="advanced-count" hidden></span></button>`).join('')}</div>
          <div class="advanced-toolbar-actions"><button class="icon-button ghost" data-action="plugins" aria-label="插件管理" title="插件管理">${icon('plugins', 17)}</button><button class="icon-button ghost" data-action="source" aria-label="查看结构数据" title="查看结构数据">${icon('code', 17)}</button><button class="icon-button ghost" data-action="close-advanced" aria-label="收起高级编辑栏" title="收起高级编辑栏">${icon('close', 17)}</button></div>
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
          <aside class="inspector" aria-label="结构与属性" hidden><div class="inspector-tabs" aria-label="侧栏内容"><button data-inspector-plugin="" aria-pressed="true">基本属性</button><button data-action="advanced-inspector" aria-pressed="false" hidden>高级属性</button></div><div class="advanced-inspector-heading" hidden><div><strong></strong><p></p></div><button class="icon-button ghost" data-action="inspector" aria-label="收起属性面板">${icon('close', 16)}</button></div><div class="advanced-selection-summary" aria-live="polite" hidden></div><div class="inspector-content"></div><div class="advanced-content" hidden></div><div class="extensions-content" hidden><div class="extension-tabs" aria-label="扩展插件面板"></div><details class="extension-commands"><summary>快捷操作</summary><div class="plugin-toolbar" role="toolbar" aria-label="插件操作"></div></details><p class="plugin-empty">启用扩展插件，或从上方选择插件面板。</p></div><div class="plugin-panels" hidden></div></aside>
        </div>
        <div class="footer"><span class="active-tool"></span><span class="live-status"></span><span class="spacer"></span><span class="draft-status"></span><select class="locale-select" aria-label="界面语言"><option value="zh-CN" data-i18n-skip>中文</option><option value="en" data-i18n-skip>English</option></select><button data-action="zoom-out" aria-label="缩小">−</button><span class="zoom-label">100%</span><button data-action="zoom-in" aria-label="放大">+</button><button data-action="fit" aria-label="适应画布" title="适应画布 (Enter)">${icon('fit', 14)}</button></div>
      </div>
      <dialog class="plugins-dialog" aria-label="插件管理"><div class="dialog-header"><div><h2>工作台插件</h2><p>启用所需扩展，为结构编辑添加操作和属性面板。</p></div><button class="icon-button ghost" data-action="close-dialog" aria-label="关闭插件管理">${icon('close', 20)}</button></div><div class="plugin-list"></div><div class="dialog-footer"><span class="plugin-manager-hint">插件仅在当前编辑器实例中生效</span><button data-action="close-dialog">完成</button></div></dialog>
      <dialog class="search-dialog" aria-label="工具搜索"><div class="search-field">${icon('search', 21)}<input class="command-search" aria-label="搜索命令" placeholder="搜索工具、元素或结构模板…" autocomplete="off" role="combobox" aria-autocomplete="list" aria-controls="command-results" aria-expanded="true"/><button class="icon-button ghost" data-action="close-dialog" aria-label="关闭搜索">${icon('close', 16)}</button></div><div class="search-results" id="command-results" role="listbox" aria-label="搜索结果"></div><div class="search-help"><span><kbd>↑</kbd> <kbd>↓</kbd> 选择　<kbd>Enter</kbd> 执行</span><span><kbd>Esc</kbd> 关闭</span></div></dialog>
      <dialog class="templates-dialog" aria-label="结构模板库"><div class="dialog-header"><div><h2>结构模板</h2><p>选择一个分子开始编辑；可通过撤销恢复当前结构。</p></div><button class="icon-button ghost" data-action="close-dialog" aria-label="关闭模板库">${icon('close', 20)}</button></div><div class="template-grid">${samples.map(s => `<button class="template-card" data-sample="${s.id}"><span class="template-category">${s.category}</span><span class="template-preview"><img src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(exportSvg(exampleDocument(s.id)))}" alt="${s.name}结构预览"/></span><span class="template-name">${s.name}<small>${s.english}</small></span><span class="template-formula">${molecularFormula(exampleDocument(s.id))}</span></button>`).join('')}</div></dialog>
      <dialog class="shortcuts-dialog" aria-label="键盘快捷键"><div class="dialog-header"><div><h2>让绘制更顺手</h2><p>在画布获得焦点时使用快捷键</p></div><button class="icon-button ghost" data-action="close-dialog" aria-label="关闭快捷键">${icon('close', 20)}</button></div><div class="dialog-body shortcut-grid">${[['搜索工具','Ctrl / ⌘ K'],['选择 / 单键','V / B'],['双键 / 三键','2 / 3'],['苯环 / 六元环','6 / R'],['实楔 / 虚楔','W / D'],['全选','Ctrl / ⌘ A'],['撤销','Ctrl / ⌘ Z'],['重做','Ctrl / ⌘ Shift Z'],['导出','Ctrl / ⌘ S'],['适应画布','Enter'],['取消选择','Esc'],['删除所选','Delete'],['平移画布','空格 + 拖动'],['自由成键角度','Alt + 拖动']].map(([name, key]) => `<div><span>${name}</span><kbd>${key}</kbd></div>`).join('')}</div></dialog>
      <input type="file" class="file-input" accept=".mol,.mrv,.cdxml,.json,.cdx,.rxn" aria-label="选择结构文件"/>
      <dialog class="import-dialog" aria-label="导入化学结构"><div class="dialog-header"><div><h2>导入结构</h2><p>从 ChemDraw、Marvin JS 或结构文件继续编辑</p></div><button class="icon-button ghost" data-action="close-dialog" aria-label="关闭导入">${icon('close')}</button></div><div class="dialog-body"><p class="dialog-message import-replacement-notice">导入将替换当前整份文档，不会追加到画布。导入后可通过撤销恢复原文档。</p><div class="file-row"><button data-action="choose-file">${icon('import', 15)}选择文件</button><span class="import-filename">支持 CDXML/MRV/MOL 20 MB · CDX 2 MB · JSON 80 MB</span></div><textarea class="source-input import-source" aria-label="结构源数据" spellcheck="false" placeholder="也可以在这里粘贴 CDXML、MRV、MOL 或原生 JSON 源数据…"></textarea><div class="dialog-message import-message">普通分子可导入编辑。暂不支持的复杂化学语义会明确报告。</div></div><div class="dialog-footer"><button data-action="close-dialog">取消</button><button class="primary" data-action="apply-import">替换当前文档</button></div></dialog>
      <dialog class="export-dialog" aria-label="导出化学结构"><div class="dialog-header"><div><h2>导出结构</h2><p>选择目标应用的格式，并检查转换结果</p></div><button class="icon-button ghost" data-action="close-dialog" aria-label="关闭导出">${icon('close')}</button></div><div class="dialog-body"><select class="export-format" aria-label="导出格式">${formats.map(f => `<option value="${f.format}">${f.name} (${f.extension})</option>`).join('')}<option value="source">源格式保留保存（CDX / CDXML）</option><option value="original">下载导入时的原始文件</option><option value="svg">SVG 矢量图片 (.svg)</option></select><p class="export-status" role="status"></p><textarea class="source-input export-source" readonly aria-label="导出数据预览" spellcheck="false"></textarea><label class="lossy-option" hidden><input type="checkbox" class="allow-lossy" disabled/>允许有损导出（接受报告中列出的信息损失）</label><div class="dialog-message export-message"></div><div class="export-guidance"><button data-action="export-issues" hidden>查看本次转换报告</button><button data-action="export-source-format" hidden>改用源格式保留保存</button><button data-action="export-json" hidden>改用 JSON 完整保存</button></div></div><div class="dialog-footer"><span class="spacer"></span><button data-action="copy-export">复制源码</button><button class="primary" data-action="download-export">${icon('export', 15)}下载文件</button></div></dialog>
      <dialog class="issues-dialog" aria-label="兼容报告"><div class="dialog-header"><div><h2>兼容与结构检查</h2><p>查看当前结构和最近一次转换的诊断信息</p></div><button class="icon-button ghost" data-action="close-dialog" aria-label="关闭报告">${icon('close')}</button></div><div class="dialog-body issue-list"></div><div class="dialog-footer"><button data-action="close-dialog">完成</button></div></dialog>
      <dialog class="clear-dialog" aria-label="清空确认"><div class="dialog-header"><h2>清空当前画布？</h2><button class="icon-button ghost" data-action="close-dialog" aria-label="关闭确认">${icon('close')}</button></div><div class="dialog-body">清空后可以通过撤销恢复当前结构。</div><div class="dialog-footer"><button data-action="close-dialog">取消</button><button class="primary" data-action="confirm-clear">清空画布</button></div></dialog>`;
    const draftButton = document.createElement('button');
    draftButton.className = 'draft-versions-toggle'; draftButton.dataset.action = 'draft-versions'; draftButton.hidden = true;
    draftButton.setAttribute('aria-label', '草稿版本'); draftButton.title = '本机草稿与恢复';
    draftButton.innerHTML = `${icon('undo', 14)}<span>草稿版本</span>`;
    this.query('.draft-status').after(draftButton);
    const draftDialog = document.createElement('dialog'); draftDialog.className = 'draft-versions-dialog'; draftDialog.setAttribute('aria-label', '本机草稿与恢复');
    draftDialog.innerHTML = `<div class="dialog-header"><div><h2>本机草稿与恢复</h2><p>每个页面的修改分别保留。恢复历史版本会替换当前画布，可通过撤销恢复。</p></div><button class="icon-button ghost" data-action="close-dialog" aria-label="关闭">${icon('close')}</button></div><div class="dialog-body draft-versions-list" role="status"></div><div class="dialog-footer"><button data-action="close-dialog">关闭</button></div>`;
    this.root.append(draftDialog);
    this.i18n = new EditorI18n(this.root,this.locale);
    this.query<HTMLSelectElement>('.locale-select').value = this.locale;
    if (!this.hasAttribute('lang')) this.setAttribute('lang',this.locale);
    this.svg = this.query('.canvas'); this.drawing = this.query('.drawing'); this.overlay = this.query('.overlay');
    this.root.addEventListener('click', e => this.uiEdit(() => this.onClick(e)));
    this.root.addEventListener('change', e => this.onChange(e));
    this.root.addEventListener('input', e => { if ((e.target as Element).classList.contains('command-search')) this.renderSearch(); });
    this.query('.command-search').addEventListener('keydown', e => this.searchKey(e as KeyboardEvent));
    this.query('.ribbon-tabs').addEventListener('keydown', e => {
      const event = e as KeyboardEvent;
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const tabs = ['draw', 'structure', 'view'], index = tabs.indexOf(this.ribbonTab);
      this.ribbonTab = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      this.render(); this.query<HTMLButtonElement>(`[data-tab="${this.ribbonTab}"]`).focus();
    });
    this.query('.advanced-section-tabs').addEventListener('keydown', e => this.toolbarKey(e as KeyboardEvent));
    this.query('.extension-tabs').addEventListener('keydown', e => this.toolbarKey(e as KeyboardEvent));
    this.addEventListener('keydown', e => this.uiEdit(() => this.onKey(e)));
    this.addEventListener('keyup', e => { if (e.key === ' ') this.space = false; });
    this.addEventListener('focusout', () => { this.space = false; });
    this.svg.addEventListener('pointerdown', e => this.uiEdit(() => this.pointerDown(e)));
    this.svg.addEventListener('pointermove', e => this.pointerMove(e));
    this.svg.addEventListener('pointerup', e => this.uiEdit(() => this.pointerUp(e)));
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
      this.query<HTMLButtonElement>('.draft-versions-toggle').hidden = false;
      try {
        this.drafts = new BrowserDraftStore({ storageKey: this.storageKey });
        const saved = this.drafts.restore();
        if (saved) {
          const result = importDocument({ data: JSON.stringify(saved.record.document), format: 'json' });
          this.store = new DocumentStore(result.document); this.lastIssues = result.issues;
          this.restored = true; this.draftStatus = '本地草稿已恢复'; this.fit();
          if (saved.legacy) this.persistDraft(result.document);
        }
        if (this.drafts.restoreWarning) this.notify(saved ? '部分本地草稿无法读取，原始记录已保留' : '草稿恢复失败，原记录已保留');
      } catch { this.draftStatus = '草稿恢复失败，原记录已保留'; this.notify(this.draftStatus); }
    }
  }
  private query<T extends Element>(selector: string): T { return this.root.querySelector(selector)! as T; }
  private async openDraftVersions(): Promise<void> {
    if (!this.drafts) return;
    const sequence = ++this.draftListSequence, host = this.query<HTMLElement>('.draft-versions-list');
    host.textContent = '正在读取草稿…'; this.showDialog('.draft-versions-dialog');
    try {
      const records = await this.drafts.list();
      if (this.destroyed || sequence !== this.draftListSequence) return;
      this.draftRecords = new Map(records.map(record => [record.saveId, record]));
      host.replaceChildren();
      if (!records.length) host.textContent = '没有可恢复的草稿';
      for (const record of records) {
        const row = document.createElement('div'); row.className = 'draft-version';
        const detail = document.createElement('div'), title = document.createElement('strong');
        title.textContent = record.document.title; title.dataset.i18nSkip = '';
        const time = document.createElement('small'); time.dataset.i18nSkip = '';
        time.textContent = new Date(record.savedAt).toLocaleString(this.locale === 'en' ? 'en-US' : 'zh-CN', {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3});
        const atoms = Object.values(record.document.graph.atoms), charge = atoms.reduce((total, atom) => total + atom.charge, 0);
        const isotopes = [...new Set(atoms.filter(atom => atom.isotope !== undefined).map(atom => `${atom.isotope}${atom.element}`))];
        const summary = document.createElement('small');
        summary.innerHTML = `<span>原子</span> <span data-i18n-skip>${atoms.length}</span> · <span>形式电荷</span> <span data-i18n-skip>${charge > 0 ? '+' : ''}${charge}</span>${isotopes.length ? ` · <span>同位素标记原子</span> <span data-i18n-skip>${esc(isotopes.slice(0, 8).join(', '))}${isotopes.length > 8 ? '…' : ''}</span>` : ''}`;
        detail.append(title, time, summary);
        const restore = document.createElement('button'); restore.dataset.draftRestore = record.saveId; restore.textContent = '恢复此版本';
        row.append(detail, restore); host.append(row);
      }
      this.i18n?.translate();
    } catch {
      if (!this.destroyed && sequence === this.draftListSequence) host.textContent = '读取草稿失败，请导出当前文档';
    }
  }
  private restoreDraftVersion(saveId: string): void {
    const record = this.draftRecords.get(saveId); if (!record || !this.drafts) return;
    // Validate before changing either the document or the recovery pointer.
    const result = importDocument({ data: JSON.stringify(record.document), format: 'json' });
    this.drafts.restoreRecord(record);
    const revision = this.store.revision;
    this.setDocument(result.document);
    if (this.store.revision === revision) this.persistDraft(result.document);
    this.query<HTMLDialogElement>('.draft-versions-dialog').close();
    this.notify('本地草稿已恢复');
  }
  private assertLive() { if (this.destroyed) throw new Error('编辑器已销毁'); }
  private transact(change:(doc:ChemicalDocument)=>void):void{
    this.store.transact(doc=>{
      const existing=new Set(Object.keys(doc.graph.atoms));change(doc);
      const page=this.viewPage?doc.depiction.objects?.[this.viewPage]:undefined;
      if(page)for(const id of Object.keys(doc.graph.atoms))if(!existing.has(id)&&!page.atomIds.includes(id))page.atomIds.push(id);
    });
  }
  getDocument(): ChemicalDocument { return this.store.document; }
  getSnapshot(): EditorSnapshot {
    return { apiVersion: EDITOR_API_VERSION, revision: this.store.revision, document: this.getDocument(), selection: this.getSelection(), canUndo: this.store.canUndo, canRedo: this.store.canRedo };
  }
  getSelection(): EditorSelection { return { atomIds: [...this.selection], ...(this.selectedBond ? { bondId: this.selectedBond } : {}), ...(this.selectedDrawing ? { objectId: this.selectedDrawing } : {}) }; }
  setSelection(selection: EditorSelection): void {
    this.assertLive(); this.assertFields(selection, ['atomIds', 'bondId', 'objectId'], '选区');
    const document = this.getDocument();
    if (!Array.isArray(selection.atomIds) || selection.atomIds.some(id => typeof id !== 'string' || !Object.hasOwn(document.graph.atoms, id))) throw new Error('选区引用了不存在的原子');
    if (selection.bondId !== undefined && (typeof selection.bondId !== 'string' || !Object.hasOwn(document.graph.bonds, selection.bondId))) throw new Error('选区引用了不存在的键');
    if (selection.bondId !== undefined && selection.atomIds.length) throw new Error('原子选区与单键选区不能同时设置');
    if (selection.objectId !== undefined && (!Object.hasOwn(document.depiction.objects ?? {}, selection.objectId) || selection.atomIds.length || selection.bondId)) throw new Error('图元选区无效或与化学选区冲突');
    this.cancelGesture(); this.selection = new Set(selection.atomIds); this.selectedBond = selection.bondId;
    this.selectedDrawing = selection.objectId;
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
    if (pluginId !== undefined) this.activePluginId = pluginId;
    if (pluginId) { this.showAdvancedEditor('extensions'); return; }
    this.inspectorMode = 'basic'; this.inspectorVisible = true; this.render();
  }
  /** Opens advanced controls without changing the document or edit history. */
  showAdvancedEditor(section?: AdvancedEditorSection): void {
    this.assertLive();
    if (section !== undefined && !advancedEditorSections.some(item => item.id === section)) throw new Error('未知高级编辑分类');
    if (section) this.advancedSection = section;
    this.advancedVisible = true; this.inspectorMode = 'advanced'; this.inspectorVisible = true;
    if (this.advancedSection === 'extensions' && !this.activePluginId) {
      const panels = [...this.root.querySelectorAll<HTMLElement>('[data-plugin-panel]')];
      this.activePluginId = this.getPlugins().find(plugin => plugin.enabled && panels.some(panel => panel.dataset.pluginPanel?.startsWith(`${plugin.id}.`)))?.id;
    }
    this.render();
  }
  /** Hides advanced controls while retaining plugin state and chemical data. */
  hideAdvancedEditor(): void {
    this.assertLive();
    const active = this.root.activeElement;
    const restoreFocus = active instanceof Element && !!active.closest('.advanced-tools, .advanced-content, .extensions-content, .plugin-panels, .advanced-inspector-heading, .inspector-tabs');
    this.advancedVisible = false; this.inspectorMode = 'basic'; this.render();
    if (restoreFocus) this.query<HTMLButtonElement>('[data-action="toggle-advanced"]').focus();
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
      case 'export_source': {
        this.assertFields(request.params, ['original'], '源文档导出');
        if (request.params.original !== undefined && typeof request.params.original !== 'boolean') throw new Error('original 必须为布尔值');
        return request.params.original ? exportOriginalSource(this.getDocument()) : exportSourceFile(this.getDocument());
      }
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
  private renderInspectorTabs(scrollCaptured = false) {
    if (!this.initialized || this.destroyed) return;
    if (!scrollCaptured && !this.inspectorNeedsScrollRestore) this.captureInspectorScroll();
    const panels = [...this.root.querySelectorAll<HTMLElement>('[data-plugin-panel]')];
    const plugins = this.getPlugins().filter(plugin => plugin.enabled && panels.some(panel => panel.dataset.pluginPanel?.startsWith(`${plugin.id}.`)));
    if (this.activePluginId && !plugins.some(plugin => plugin.id === this.activePluginId)) this.activePluginId = plugins[0]?.id;
    const advanced = this.advancedVisible && this.inspectorMode === 'advanced';
    const extensions = advanced && this.advancedSection === 'extensions';
    const section = advancedEditorSections.find(item => item.id === this.advancedSection)!;
    this.query('.editor').classList.toggle('advanced-open', this.advancedVisible);
    this.query<HTMLElement>('#advanced-tools').hidden = !this.advancedVisible;
    const toggle = this.query<HTMLButtonElement>('[data-action="toggle-advanced"]');
    toggle.setAttribute('aria-expanded', String(this.advancedVisible));
    toggle.title = this.advancedVisible ? '收起高级编辑栏' : '展开高级编辑栏';
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-advanced-section]')) button.setAttribute('aria-pressed', String(advanced && button.dataset.advancedSection === this.advancedSection));
    const basicTab = this.query<HTMLButtonElement>('.inspector-tabs [data-inspector-plugin]');
    basicTab.setAttribute('aria-pressed', String(!advanced));
    const advancedTab = this.query<HTMLButtonElement>('.inspector-tabs [data-action="advanced-inspector"]');
    advancedTab.hidden = !this.advancedVisible; advancedTab.textContent = section.label; advancedTab.setAttribute('aria-pressed', String(advanced));
    this.query<HTMLElement>('.inspector-content').hidden = advanced;
    const heading = this.query<HTMLElement>('.advanced-inspector-heading'); heading.hidden = !advanced;
    heading.querySelector('strong')!.textContent = section.label;
    heading.querySelector('p')!.textContent = ({properties:'映射、立体顺序与化学注释',queries:'原子条件与键拓扑',fragments:'内部结构、连接映射与缩写',document:'文字、图形、聚合物与反应',extensions:'按需使用计算、排版与 AI 工具'} satisfies Record<AdvancedEditorSection,string>)[this.advancedSection];
    this.query<HTMLElement>('.advanced-content').hidden = !advanced || extensions;
    for (const panel of this.root.querySelectorAll<HTMLElement>('[data-advanced-panel]')) panel.hidden = !advanced || panel.dataset.advancedPanel !== this.advancedSection;
    this.query<HTMLElement>('.extensions-content').hidden = !extensions;
    const pluginTabs = this.query<HTMLElement>('.extension-tabs');
    const pluginKey = JSON.stringify(plugins.map(plugin => [plugin.id, plugin.name]));
    if (pluginKey !== this.pluginTabsKey) {
      const hadFocus = this.root.activeElement?.parentElement === pluginTabs;
      pluginTabs.innerHTML = plugins.map(plugin => `<button data-inspector-plugin="${esc(plugin.id)}" aria-pressed="false">${esc(plugin.name)}</button>`).join('');
      this.pluginTabsKey = pluginKey;
      if (hadFocus && extensions) pluginTabs.querySelector<HTMLButtonElement>('button')?.focus({preventScroll:true});
    }
    for (const button of pluginTabs.querySelectorAll<HTMLButtonElement>('button')) button.setAttribute('aria-pressed', String(button.dataset.inspectorPlugin === this.activePluginId));
    this.query<HTMLElement>('.extensions-content .plugin-empty').hidden = plugins.length > 0;
    this.query<HTMLElement>('.plugin-panels').hidden = !extensions;
    for (const panel of panels) panel.hidden = !extensions || !this.activePluginId || !panel.dataset.pluginPanel?.startsWith(`${this.activePluginId}.`);
    this.query('.editor').classList.toggle('ai-panel-open', this.inspectorVisible && extensions && this.activePluginId === 'ai-assistant');
    this.renderAdvancedContext();
    this.i18n?.translate();
    this.updateToolbarFocus(this.query('.advanced-section-tabs'));
    this.updateToolbarFocus(pluginTabs);
    const categories = this.query<HTMLElement>('.advanced-section-tabs');
    const focused = this.root.activeElement;
    if (this.advancedVisible) this.revealToolbarButton(focused instanceof HTMLButtonElement && focused.parentElement === categories ? focused : this.query<HTMLButtonElement>(`[data-advanced-section="${this.advancedSection}"]`));
    if (extensions) this.revealToolbarButton(focused instanceof HTMLButtonElement && focused.parentElement === pluginTabs ? focused : pluginTabs.querySelector<HTMLButtonElement>('[aria-pressed="true"]'));
    const view = this.inspectorVisible ? advanced ? extensions ? `plugin:${this.activePluginId ?? ''}` : `advanced:${this.advancedSection}` : 'basic' : undefined;
    if (view && (view !== this.visibleInspectorView || this.inspectorNeedsScrollRestore)) this.inspectorScroller(view).scrollTop = this.inspectorScrollPositions.get(view) ?? 0;
    this.visibleInspectorView = view; this.inspectorNeedsScrollRestore = false;
    if (this.inspectorFocusTarget?.isConnected && !this.inspectorFocusTarget.closest('[hidden]')) this.inspectorFocusTarget.focus({preventScroll:true});
    this.inspectorFocusTarget = undefined;
    this.i18n?.translate();
  }
  private inspectorScroller(view: string): HTMLElement {
    return this.query(view === 'basic' ? '.inspector-content' : view.startsWith('plugin:') ? '.plugin-panels' : '.advanced-content');
  }
  private captureInspectorScroll() {
    if (this.visibleInspectorView) this.inspectorScrollPositions.set(this.visibleInspectorView, this.inspectorScroller(this.visibleInspectorView).scrollTop);
  }
  private revealToolbarButton(button: HTMLButtonElement | null) {
    if (!button?.parentElement) return;
    const parent = button.parentElement, viewport = parent.getBoundingClientRect(), bounds = button.getBoundingClientRect();
    if (bounds.left < viewport.left) parent.scrollLeft -= viewport.left - bounds.left + 3;
    else if (bounds.right > viewport.right) parent.scrollLeft += bounds.right - viewport.right + 3;
  }
  private updateToolbarFocus(toolbar: Element) {
    const buttons = [...toolbar.querySelectorAll<HTMLButtonElement>('button')];
    const current = buttons.find(button => button === this.root.activeElement) ?? buttons.find(button => button.getAttribute('aria-pressed') === 'true') ?? buttons[0];
    for (const button of buttons) button.tabIndex = button === current ? 0 : -1;
  }
  private toolbarKey(event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    const toolbar = event.currentTarget as HTMLElement, buttons = [...toolbar.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    const next = buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (Math.max(0,index) + (event.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length];
    for (const button of buttons) button.tabIndex = button === next ? 0 : -1;
    next.focus({preventScroll:true}); this.revealToolbarButton(next);
  }
  private renderAdvancedContext() {
    const summary = advancedSelectionSummary(this.getDocument(), this.getSelection());
    const container = this.query<HTMLElement>('.advanced-selection-summary');
    container.hidden = !this.advancedVisible || this.inspectorMode !== 'advanced';
    if (container.textContent !== summary.label) container.textContent = summary.label;
    container.title = summary.label;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-advanced-section]')) {
      const section = button.dataset.advancedSection as AdvancedEditorSection;
      const info = summary.sections[section], name = advancedEditorSections.find(item => item.id === section)!.label;
      const badge = button.querySelector<HTMLElement>('.advanced-count')!;
      button.dataset.advancedCount = String(info?.count ?? 0);
      badge.hidden = !info; badge.textContent = String(info?.count ?? ''); badge.setAttribute('aria-hidden','true');
      button.title = info?.description ?? name;
      button.setAttribute('aria-label', info ? `${name}，${info.description}` : name);
    }
  }
  private openAdvancedFeature(feature: AdvancedFeature) {
    this.showAdvancedEditor(feature.section);
    const scope = feature.section === 'extensions' ? this.query<HTMLElement>('.extensions-content') : this.query<HTMLElement>(`[data-advanced-panel="${feature.section}"]`);
    const control = feature.selector ? scope.querySelector<HTMLElement>(feature.selector) : undefined;
    if (control) {
      for (let parent = control.parentElement; parent && parent !== scope; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
      control.focus({preventScroll:true});
      const scroller = this.inspectorScroller(`advanced:${feature.section}`), viewport = scroller.getBoundingClientRect(), bounds = control.getBoundingClientRect();
      if (bounds.top < viewport.top) scroller.scrollTop -= viewport.top - bounds.top + 8;
      else if (bounds.bottom > viewport.bottom) scroller.scrollTop += bounds.bottom - viewport.bottom + 8;
    } else this.query<HTMLButtonElement>(`[data-advanced-section="${feature.section}"]`).focus({preventScroll:true});
  }
  private subscribeApiEvent<K extends keyof EditorEvents>(type: K, listener: (detail: EditorEvents[K]) => void): () => void {
    if (!['change', 'selectionchange'].includes(type) || typeof listener !== 'function') throw new Error('插件事件订阅参数无效');
    const handler = (event: Event) => listener(clone((event as CustomEvent<EditorEvents[K]>).detail));
    this.addEventListener(type, handler); return () => this.removeEventListener(type, handler);
  }
  setDocument(doc: ChemicalDocument): void {
    this.assertLive(); validateDocument(doc); this.cancelGesture(); this.inspectorContentKey = undefined;
    this.selection.clear(); this.selectedBond = undefined; this.lastIssues = doc.source?.issues ?? [];
    this.store.replace(doc); if (this.initialized) { this.render(); this.fit(); }
  }
  import(input: ImportInput): ImportResult {
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
    this.plugins.destroy(); this.destroyed = true; this.i18n?.destroy();
    this.unsubscribe?.(); this.unsubscribe = undefined; this.observer?.disconnect();
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.drafts?.destroy();
    this.remove();
  }
  setTool(tool: Tool): void { this.assertLive(); if (!Object.hasOwn(toolInfo, tool)) throw new Error('未知绘图工具'); this.cancelGesture(); this.tool = tool; if (this.initialized) this.render(); }
  private persistDraft(doc: ChemicalDocument): void {
    if (this.drafts) {
      const saveSequence = ++this.draftSaveSequence;
      this.draftStatus = '正在保存草稿…';
      const pendingToggle = this.query<HTMLButtonElement>('.draft-versions-toggle');
      pendingToggle.dataset.state = 'saving'; pendingToggle.title = this.draftStatus;
      void this.drafts.save(doc).then(result => {
        if (this.destroyed || saveSequence !== this.draftSaveSequence) return;
        this.draftStatus = result.status === 'saved' ? (result.recoverySaved ? '草稿已保存' : '草稿已保存；此页恢复副本不可用')
          : result.status === 'conflict' ? '此页副本已保存；检测到其他页面修改'
          : result.status === 'recovery-only' ? '仅保存此页恢复副本'
          : '本地草稿保存失败，请导出 JSON 文件保留结构';
        const toggle = this.query<HTMLButtonElement>('.draft-versions-toggle');
        toggle.dataset.state = !result.recoverySaved && result.status !== 'error' ? 'recovery-unavailable' : result.status; toggle.title = this.draftStatus;
        this.query('.draft-status').textContent = this.draftStatus;
        if (result.status === 'conflict' && !this.notifiedDraftConflict) {
          this.notifiedDraftConflict = true;
          this.notify('检测到其他页面修改，已保留此页副本。可打开草稿版本查看。');
        } else if (result.status === 'error') this.notify(this.draftStatus);
        if (!result.recoverySaved) this.notify('此页恢复副本不可用，请立即导出 JSON 文件');
        this.i18n?.translate();
      }).catch(() => {
        if (this.destroyed || saveSequence !== this.draftSaveSequence) return;
        this.draftStatus = '本地草稿保存失败，请导出 JSON 文件保留结构';
        this.query('.draft-status').textContent = this.draftStatus; this.notify(this.draftStatus);
      });
    }
  }
  private changed() {
    const doc = this.getDocument(), revision = this.store.revision;
    this.selection = new Set([...this.selection].filter(id => !!doc.graph.atoms[id]));
    if (this.selectedBond && !doc.graph.bonds[this.selectedBond]) this.selectedBond = undefined;
    if (this.selectedDrawing && !doc.depiction.objects?.[this.selectedDrawing]) this.selectedDrawing = undefined;
    if(this.viewPage&&!doc.depiction.objects?.[this.viewPage])this.viewPage=undefined;
    this.persistDraft(doc);
    this.render();
    // Selection listeners may synchronously commit a newer document during render.
    if (this.store.revision !== revision) return;
    if (this.query<HTMLDialogElement>('.export-dialog').open) {
      this.query<HTMLInputElement>('.allow-lossy').checked = false;
      this.updateExport();
    }
    if (this.store.revision !== revision) return;
    this.dispatchEvent(new CustomEvent('change', { detail: { document: doc, revision }, bubbles: true, composed: true }));
  }
  private diagnostics(): Diagnostic[] {
    const doc = this.getDocument();
    const issues = [...this.lastIssues, ...validateDocument(doc)];
    if (Object.keys(doc.depiction.bonds).some(b => ['wedge', 'hashed', 'wavy'].includes(doc.depiction.bonds[b].style))) issues.push({ severity: 'info', code: 'STEREO_DEPICTION', message: '保留二维楔线描绘及已记录的立体连接约束；来源 CIP 标签不代表重新计算结果。' });
    return issues;
  }
  private render() {
    if (!this.initialized) return;
    this.captureInspectorScroll();
    const doc = this.getDocument();
    this.drawing.innerHTML = moleculeMarkup(documentPage(doc,this.viewPage), this.selection, this.selectedBond, this.selectedDrawing);
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
    this.query<HTMLButtonElement>('[data-action="clear"]').disabled = Object.keys(doc.graph.atoms).length === 0 && !Object.keys(doc.depiction.objects ?? {}).length;
    const title = this.query<HTMLInputElement>('.document-title'); if (this.root.activeElement !== title) title.value = doc.title;
    this.query<HTMLElement>('.live-status').textContent = toolInfo[this.tool].hint;
    this.renderInspector(doc);
    this.renderInspectorTabs(true);
    const selection = this.getSelection(), signature = JSON.stringify(selection);
    if (signature !== this.lastSelection) {
      this.lastSelection = signature;
      this.dispatchEvent(new CustomEvent('selectionchange', { detail: { selection, revision: this.store.revision }, bubbles: true, composed: true }));
    }
  }
  private renderInspector(doc: ChemicalDocument) {
    const contextKey = JSON.stringify([[...this.selection].sort(), this.selectedBond, this.selectedDrawing, this.viewPage]);
    const contentKey = `${this.store.revision}:${contextKey}:${JSON.stringify(this.lastIssues)}`;
    if (contentKey === this.inspectorContentKey) {
      const hint = this.root.querySelector<HTMLElement>('.inspector-tool-hint');
      if (hint) { hint.querySelector('strong')!.textContent = `${toolInfo[this.tool].name}工具`; hint.querySelector('span')!.textContent = toolInfo[this.tool].hint; }
      return;
    }
    const sameContext = contextKey === this.inspectorContextKey;
    const detailsKey = (details: HTMLDetailsElement) => details.dataset.disclosureKey!;
    const opened = new Map([...this.root.querySelectorAll<HTMLDetailsElement>('.advanced-content details')].map(details => [detailsKey(details),details.open]));
    if (!sameContext) this.inspectorScrollPositions.clear();
    const active = this.root.activeElement;
    const focusedControl = sameContext && active instanceof HTMLElement && active.matches('input, select, textarea, button') && active.closest('.advanced-content, .inspector-content') ? active : undefined;
    const focusAttributes = focusedControl ? [...focusedControl.attributes].filter(attribute => attribute.name === 'id' || attribute.name.startsWith('data-')).map(attribute => [attribute.name,attribute.value]) : [];
    this.inspectorFocusTarget = undefined;
    this.inspectorContentKey = contentKey; this.inspectorContextKey = contextKey; this.inspectorNeedsScrollRestore = true;
    const atoms = Object.values(doc.graph.atoms), bonds = Object.values(doc.graph.bonds), issues = this.diagnostics();
    const [composition,...formulaNotes]=molecularFormula(doc).split(' · ');
    const formula = esc(composition).replace(/(\d+)/g, '<sub>$1</sub>')+(formulaNotes.length?`<small>${esc(formulaNotes.join(' · '))}</small>`:'');
    const entry = (section: AdvancedEditorSection, label: string) => `<button class="advanced-entry" data-open-advanced="${section}">${label}<span>→</span></button>`;
    let properties = `<h3>结构属性</h3><p>选择原子或化学键，在这里查看并修改属性。</p><div class="hint-card inspector-tool-hint"><strong>${esc(toolInfo[this.tool].name)}工具</strong><span>${esc(toolInfo[this.tool].hint)}</span></div>`;
    if (this.selection.size === 1) {
      const a = doc.graph.atoms[[...this.selection][0]], h = hydrogenCount(doc, a.id);
      const basicAtomFields = `<div class="field-row"><div><label for="atom-charge">形式电荷</label><input id="atom-charge" data-property="charge" type="number" step="1" value="${a.charge}"/></div><div><label for="atom-isotope">同位素质量数</label><input id="atom-isotope" data-property="isotope" type="number" min="1" step="1" placeholder="自然丰度" value="${a.isotope ?? ''}"/></div></div><label for="atom-hydrogens">氢数策略</label><select id="atom-hydrogens" data-property="hydrogens"><option value="auto"${a.hydrogens.mode === 'auto' ? ' selected' : ''}>自动推导${h === null ? ' · 待校验' : ` · ${h} H`}</option><option value="fixed"${a.hydrogens.mode === 'fixed' ? ' selected' : ''}>明确指定</option></select>${a.hydrogens.mode === 'fixed' ? `<label for="atom-h-count">非图氢数</label><input id="atom-h-count" data-property="hydrogenCount" type="number" min="0" step="1" value="${a.hydrogens.count}"/>` : ''}`;
      const fragment = a.substructure || a.namedFragment;
      if (fragment) properties = `<div class="selection-name"><span data-i18n-skip>${esc(fragment.label)}</span><small>${a.substructure?.kind === 'alternatives' ? '备选化学片段' : '缩写化学片段'}</small></div><p>${a.substructure ? `内部含 ${a.substructure.fragments.length} 个片段、${a.substructure.connections.length} 个外部连接映射。` : '来源文件未提供内部原子图，可补全内部结构。'}</p>${entry('fragments', '编辑片段与内部结构')}`;
      else if (a.attachment) properties = `<div class="selection-name">◆ 外部连接点<small>基团模板边界</small></div><p>此对象是外部连接点，可移动、连接或删除。</p>${entry('properties', '编辑连接点属性')}`;
      else if (a.multiAttachment) properties = `<div class="selection-name">多中心连接<small>虚拟连接中心</small></div><p>已记录 ${a.multiAttachment.length} 个连接目标。</p>${entry('fragments', '编辑多中心连接')}`;
      else {
        properties = `<div class="selection-name"><span data-i18n-skip>${esc(a.query ? queryLabel(a.query) : a.element)}</span><small>${a.query ? '查询原子' : '已选择原子'}</small></div><label for="atom-element">元素</label><select id="atom-element" data-property="element">${a.query ? '<option value="*" disabled selected>查询原子（可替换为元素）</option>' : ''}${ELEMENTS.map(e => `<option value="${e}"${!a.query && e === a.element ? ' selected' : ''}>${e}</option>`).join('')}</select>${basicAtomFields}`;
        if (a.query || a.queryConstraints) properties += entry('queries', '编辑查询条件');
        properties += entry('properties', '映射、立体与高级属性');
      }
      if (!a.substructure && !a.attachment && (a.namedFragment || a.multiAttachment)) properties += basicAtomFields;
    } else if (this.selection.size > 1) properties = `<div class="selection-name">${icon('select', 16)}${this.selection.size} 个原子<small>批量编辑</small></div><p>更改属性将应用到全部选中原子。</p><label for="batch-element">元素</label><select id="batch-element" data-property="element"><option value="" disabled selected>选择要应用的元素</option>${ELEMENTS.map(e => `<option value="${e}">${e}</option>`).join('')}</select><label for="batch-charge">形式电荷</label><input id="batch-charge" data-property="charge" type="number" step="1" placeholder="输入统一电荷"/>${entry('fragments', '收起为可编辑缩写')}<button class="wide-button" data-action="delete-selection">${icon('clear', 15)}删除所选结构</button>`;
    else if (this.selectedBond) {
      const b = doc.graph.bonds[this.selectedBond], d = doc.depiction.bonds[b.id];
      properties = `<div class="selection-name">化学键<small>已选择</small></div><label for="bond-order">键类型</label><select id="bond-order" data-bond-property="order">${[['1','单键'],['2','双键'],['3','三键'],['2.5','2.5 键'],['aromatic','芳香键'],['any','任意查询键']].map(([v,t]) => `<option value="${v}"${String(b.order) === v ? ' selected' : ''}>${t}</option>`).join('')}</select>${b.order === 1 ? `<label for="bond-style">二维描绘</label><select id="bond-style" data-bond-property="style">${[['plain','普通'],['wedge','实楔键'],['hashed','虚楔键'],['wavy','波浪键'],['dashed','虚线'],['bold','粗线'],['hash','等宽哈线']].map(([v,t]) => `<option value="${v}"${(d?.style ?? 'plain') === v ? ' selected' : ''}>${t}</option>`).join('')}</select>${d && d.style !== 'plain' ? '<button data-action="flip-bond" style="margin-top:12px;width:100%">交换描绘锚点</button>' : ''}` : ''}`;
      if (b.order === 2) properties += `<label for="bond-double-position">双键第二条线位置</label><select id="bond-double-position" data-bond-property="doublePosition">${[['','默认'],['center','居中'],['left','左侧'],['right','右侧']].map(([v,t]) => `<option value="${v}"${(d?.doublePosition ?? '') === v ? ' selected' : ''}>${t}</option>`).join('')}</select>`;
      properties += entry('properties', '立体与高级属性') + entry('queries', '编辑键拓扑查询');
    } else if (this.selectedDrawing) {
      const object = doc.depiction.objects?.[this.selectedDrawing];
      properties = `<h3>已选择文档对象</h3><p data-i18n-skip>${esc(object?.runs?.map(run => run.text).join('') || object?.tag || '')}</p>${entry('document', '编辑文档与反应属性')}`;
    }
    const pages = Object.values(doc.depiction.objects ?? {}).filter(object => object.tag === 'page');
    const pageSelector = pages.length > 1 ? `<section class="property-section"><label>当前页面<select data-document-page><option value="">所有页面</option>${pages.map((page,i) => `<option value="${esc(page.id)}"${page.id === this.viewPage ? ' selected' : ''}>第 ${i+1} 页</option>`).join('')}</select></label></section>` : '';
    const advanced = advancedInspectorContent(doc, { atomIds: [...this.selection], bondId: this.selectedBond, drawingId: this.selectedDrawing, pageId: this.viewPage, queryExpanded: sameContext && (this.root.querySelector<HTMLDetailsElement>('.advanced-query-controls')?.open ?? false), bondQueryExpanded: sameContext && (this.root.querySelector<HTMLDetailsElement>('.bond-query-controls')?.open ?? false), orderingFields: (refs,kind,candidates) => this.orderingFields(doc,refs,kind,candidates) });
    this.renderInspectorContent(this.query('.advanced-content'), Object.entries(advanced).map(([section,content]) => `<section class="property-section" data-advanced-panel="${section}" hidden>${content}</section>`).join(''), sameContext && !!this.committingField);
    this.renderInspectorContent(this.query('.inspector-content'), `<div class="inspector-heading"><strong>结构与属性</strong><button class="icon-button ghost" data-action="inspector" aria-label="收起属性面板">${icon('close', 16)}</button></div><section class="overview-card"><div class="section-label">分子概览<span>2D STRUCTURE</span></div><div class="formula">${formula}<small>分子式 · 基础价态规则估算</small></div><div class="metrics"><div class="metric"><b>${atoms.length}</b><span>原子</span></div><div class="metric"><b>${bonds.length}</b><span>化学键</span></div><div class="metric"><b>${connectedComponents(doc).length}</b><span>片段</span></div></div></section>${pageSelector}<section class="property-section">${properties}</section><section class="advanced-entry-card"><strong>更多编辑工具</strong><p>查询、片段、文档反应与扩展插件</p><button data-action="advanced-inspector">${icon('settings', 15)}打开高级编辑</button></section><section class="property-section"><div class="section-label">文件与兼容<span>本地转换</span></div><div class="format-badges"><span class="format-badge">CDX</span><span class="format-badge">CDXML</span><span class="format-badge">MRV</span><span class="format-badge">MOL</span><span class="format-badge">JSON</span></div><button class="compatibility${issues.some(i => i.severity !== 'info') ? ' has-issues' : ''}" data-action="issues"><span>${icon(issues.length ? 'info' : 'check', 14)}${issues.length ? `${issues.length} 项提示` : '基础检查通过'}</span>查看报告 →</button></section><button class="shortcut-link" data-action="shortcuts">${icon('keyboard', 17)}键盘快捷键<span>?</span></button>`, sameContext);
    for (const panel of this.root.querySelectorAll<HTMLElement>('[data-advanced-panel]')) [...panel.querySelectorAll<HTMLDetailsElement>('details')].forEach((details,index) => { details.dataset.disclosureKey = `${panel.dataset.advancedPanel}:${index}`; });
    if (sameContext) for (const details of this.root.querySelectorAll<HTMLDetailsElement>('.advanced-content details')) if (opened.has(detailsKey(details))) details.open = opened.get(detailsKey(details))!;
    if (focusAttributes.length && !focusedControl?.isConnected) {
      const controls = [...this.root.querySelectorAll<HTMLElement>('.advanced-content input, .advanced-content select, .advanced-content textarea, .advanced-content button, .inspector-content input, .inspector-content select')];
      this.inspectorFocusTarget = controls.find(control => focusAttributes.every(([name,value]) => control.getAttribute(name) === value));
    }
  }
  /** Keep live form controls in place while a blur/change event chooses its next focus target. */
  private renderInspectorContent(container: HTMLElement, html: string, preserveControls: boolean): void {
    if (!preserveControls) { container.innerHTML = html; return; }
    const template = this.ownerDocument.createElement('template'); template.innerHTML = html;
    const patch = (current: Node, next: Node): void => {
      if (current.nodeType === Node.TEXT_NODE) { if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue; return; }
      if (current instanceof Element && next instanceof Element) {
        for (const attribute of [...current.attributes]) if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
        for (const attribute of [...next.attributes]) if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
      }
      const children = [...next.childNodes];
      children.forEach((child, index) => {
        const existing = current.childNodes[index];
        const matches = existing && existing.nodeType === child.nodeType && existing.nodeName === child.nodeName && (!(existing instanceof Element) || !(child instanceof Element) || existing.id === child.id);
        if (!existing) current.appendChild(child.cloneNode(true));
        else if (!matches) current.replaceChild(child.cloneNode(true), existing);
        else patch(existing, child);
      });
      while (current.childNodes.length > children.length) current.removeChild(current.lastChild!);
      if (current instanceof HTMLInputElement && next instanceof HTMLInputElement) {
        if (current.value !== next.value) current.value = next.value;
        current.checked = next.checked;
      } else if ((current instanceof HTMLSelectElement && next instanceof HTMLSelectElement) || (current instanceof HTMLTextAreaElement && next instanceof HTMLTextAreaElement)) {
        if (current.value !== next.value) current.value = next.value;
      }
    };
    patch(container, template.content);
  }
  private orderingFields(doc: ChemicalDocument, refs: StereoBondOrdering, kind: 'atom' | 'bond', candidates: string[]): string {
    return refs.map((ref, slot) => `<label for="${kind}-stereo-${slot}">连接 ${slot + 1}</label><select id="${kind}-stereo-${slot}" data-stereo-kind="${kind}" data-stereo-slot="${slot}"><option value=""${ref === null ? ' selected' : ''}>虚配体／空位</option>${candidates.map(id => { const b = doc.graph.bonds[id]; return `<option value="${esc(id)}"${ref === id ? ' selected' : ''}>${b.atoms.map(a => esc(doc.graph.atoms[a].element)).join('—')} · ${esc(id.slice(-8))}</option>`; }).join('')}</select>`).join('');
  }
  private uiEdit(action: () => void): void {
    try { action(); }
    catch (error) { this.cancelGesture(); this.render(); this.notify((error as Error).message); }
  }
  private stereoAction(action: string): void {
    const doc = this.getDocument(), atomId = [...this.selection][0], bondId = this.selectedBond!;
    let operation: EditOperation;
    switch (action) {
      case 'record-atom-geometry': {
        const refs = Object.values(doc.graph.bonds).filter(b => b.atoms.includes(atomId)).map(b => b.id) as (string | null)[];
        if (refs.length < 3 || refs.length > 4) throw new Error('四面体几何需要三条或四条单键');
        while (refs.length < 4) refs.push(null);
        operation = { type: 'set-atom-geometry', atomId, bondOrdering: refs as StereoBondOrdering }; break;
      }
      case 'clear-atom-geometry': operation = { type: 'set-atom-geometry', atomId, bondOrdering: null }; break;
      case 'invert-atom-stereo': operation = { type: 'invert-atom-stereo', atomId }; break;
      case 'record-bond-ordering': operation = { type: 'set-bond-ordering', bondId, bondOrdering: circularOrderingFromDrawing(doc, bondId) }; break;
      case 'clear-bond-ordering': operation = { type: 'set-bond-ordering', bondId, bondOrdering: null }; break;
      case 'invert-double-stereo': operation = { type: 'invert-double-stereo', bondId }; break;
      default: return;
    }
    this.applyEdits({ operations: [operation] });
  }
  private editSubstructure(focus?:{path:{atomId:string;fragment:number}[];atomId?:string;bondId?:string}): void {
    const snapshot = this.getSnapshot(), atomId = focus?.path[0]?.atomId ?? [...this.selection][0], atom = snapshot.document.graph.atoms[atomId];
    if(!atom)throw new Error('请选择含内部结构的片段');
    const rootGroup = atom.substructure ? clone(atom.substructure) : (()=>{
      if(!atom.namedFragment)throw new Error('请选择命名片段');
      const document=emptyDocument(atom.namedFragment.label),bonds=Object.values(snapshot.document.graph.bonds).filter(b=>b.atoms.includes(atomId));
      const attachmentOrder=bonds.map((_b,i)=>addAtom(document,'*',{x:i*2,y:0},{attachment:'external',attachmentIndex:i+1,hydrogens:{mode:'fixed',count:0}}));
      return {kind:'abbreviation' as const,label:atom.namedFragment.label,fragments:[{document,attachmentOrder}],connections:bonds.map((b,i)=>({bondId:b.id,fragment:0,atomId:attachmentOrder[i]}))};
    })();
    let group=rootGroup,initialFragment=0;
    if(focus){
      if(!focus.path.length||focus.path.length>16)throw new Error('内部编辑路径无效');
      for(const [index,scope]of focus.path.entries()){
        if(!Number.isInteger(scope.fragment)||!group.fragments[scope.fragment])throw new Error('内部片段分支不存在');
        initialFragment=scope.fragment;
        const next=focus.path[index+1];
        if(next){const nested=group.fragments[scope.fragment].document.graph.atoms[next.atomId]?.substructure;if(!nested)throw new Error('内部片段路径不存在');group=nested;}
      }
    }
    const dialog = document.createElement('dialog'); dialog.setAttribute('aria-label', '编辑内部化学片段');
    dialog.style.cssText = 'width:95vw;max-width:1280px;height:92vh;max-height:1000px;padding:16px';
    dialog.innerHTML = '<div class="dialog-header"><h2>编辑内部化学片段</h2><select aria-label="内部片段"></select><button type="button" data-nested-close>取消</button><button type="button" class="primary" data-nested-save>保存到主文档</button></div><div data-nested-editor style="height:calc(100% - 110px);min-height:400px"></div><div data-nested-ports></div><p data-nested-message role="status"></p>';
    const select = dialog.querySelector<HTMLSelectElement>('select')!, container = dialog.querySelector<HTMLElement>('[data-nested-editor]')!;
    group.fragments.forEach((_fragment, i) => { const option = document.createElement('option'); option.value = String(i); option.textContent = `${group.kind === 'alternatives' ? '备选' : '片段'} ${i + 1}`; select.append(option); });
    let active = initialFragment, child: ChemicalEditorElement;select.value=String(active);
    dialog.querySelector('h2')!.textContent=`编辑 ${group.label}${group.kind==='alternatives'?' · 候选结构':''}`;
    const keep = () => { if (child) group.fragments[active].document = child.getDocument(); };
    const ports = () => {
      const host = dialog.querySelector<HTMLElement>('[data-nested-ports]')!; host.replaceChildren();
      group.connections.forEach((connection, index) => {
        const label = document.createElement('label'); label.textContent = `外部键 ${index + 1} 的内部连接点 `;
        const control = document.createElement('select'); control.setAttribute('aria-label', `连接点映射 ${index + 1}`);
        group.fragments.forEach((fragment, f) => Object.values(fragment.document.graph.atoms).filter(a => a.attachment).forEach(atom => {
          const option = document.createElement('option'); option.value = JSON.stringify({ fragment: f, atomId: atom.id }); option.textContent = `片段 ${f + 1} · 连接点 ${atom.attachmentIndex ?? atom.id.slice(-8)}`; option.selected = connection.fragment === f && connection.atomId === atom.id; control.append(option);
        }));
        control.addEventListener('change', () => { Object.assign(connection, JSON.parse(control.value)); }); label.append(control); host.append(label);
      });
    };
    const mount = () => {
      child?.destroy(); child = createChemicalEditor({ container, document: group.fragments[active].document, locale: this.locale });
      child.addEventListener('keydown', event => event.stopPropagation());
      child.addEventListener('localechange', event => event.stopPropagation());
      child.addEventListener('change', () => { keep(); ports(); }); ports(); child.fit();
      if(active===initialFragment&&focus){
        if(focus.atomId&&group.fragments[active].document.graph.atoms[focus.atomId])child.setSelection({atomIds:[focus.atomId]});
        else if(focus.bondId&&group.fragments[active].document.graph.bonds[focus.bondId])child.setSelection({atomIds:[],bondId:focus.bondId});
      }
    };
    select.addEventListener('change', () => { keep(); active = Number(select.value); mount(); });
    dialog.querySelector('[data-nested-close]')!.addEventListener('click', () => dialog.close());
    dialog.querySelector('[data-nested-save]')!.addEventListener('click', () => {
      try {
        keep();
        for (const fragment of group.fragments) fragment.attachmentOrder = [...fragment.attachmentOrder.filter(id => fragment.document.graph.atoms[id]?.attachment), ...Object.values(fragment.document.graph.atoms).filter(a => a.attachment && !fragment.attachmentOrder.includes(a.id)).map(a => a.id)];
        this.applyEdits({ expectedRevision: snapshot.revision, operations: [{ type: 'set-substructure', atomId, substructure: rootGroup }] }); dialog.close();
      } catch (error) { dialog.querySelector('[data-nested-message]')!.textContent = (error as Error).message; }
    });
    dialog.addEventListener('close', () => { child?.destroy(); dialog.remove(); });
    this.root.append(dialog); dialog.showModal(); mount();
  }
  private showDialog(selector: string) {
    this.previousFocus = this.root.activeElement as HTMLElement || this;
    this.query<HTMLDialogElement>(selector).showModal();
  }
  private selectAll() {
    this.cancelGesture(); this.selection = new Set(Object.keys(documentPage(this.getDocument(),this.viewPage).graph.atoms));
    this.selectedDrawing=undefined;this.selectedBond = undefined; this.setTool('select'); this.svg.focus();
  }
  private deleteSelection() {
    this.cancelGesture();
    this.transact(doc => { for (const a of this.selection) removeAtom(doc, a); if (this.selectedBond) removeBond(doc, this.selectedBond); if (this.selectedDrawing) removeDrawing(doc, this.selectedDrawing); });
    this.svg.focus();
  }
  private transformSelection(transform: StructureTransform) {
    this.cancelGesture();
    const doc = this.getDocument(), ids = this.selection.size ? [...this.selection] : Object.keys(documentPage(doc,this.viewPage).graph.atoms);
    if (ids.length < 2) { this.notify('请选择至少两个原子，或取消选择后变换整个结构'); return; }
    this.transact(draft => transformAtoms(draft, ids, transform));
    this.svg.focus();
  }
  private layoutSelection(action: LayoutAction) {
    try {
      const snapshot = this.getSnapshot();
      this.applyEdits({ expectedRevision: snapshot.revision, operations: [{ type: 'layout', action, atomIds: snapshot.selection.atomIds.length?snapshot.selection.atomIds:Object.keys(documentPage(snapshot.document,this.viewPage).graph.atoms) }] });
      this.fit(); this.notify(`${layoutActions[action]}完成，可撤销`);
    } catch (error) { this.notify((error as Error).message); }
  }
  private useElement(element: string) {
    this.cancelGesture(); this.element = element;
    if (this.selection.size) this.transact(doc => { for (const a of this.selection) doc.graph.atoms[a].element = element; });
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
      ...advancedFeatures.map(feature => ({ name: feature.title, detail: `高级编辑 · ${advancedEditorSections.find(section => section.id === feature.section)!.label} · ${feature.description}`, keywords: feature.keywords, icon: 'settings', run: () => this.openAdvancedFeature(feature) })),
      ...this.getCommands().filter(command => !command.running).map(command => ({ name: command.title, detail: `插件 · ${command.pluginId}`, keywords: `${command.id} ${command.description ?? ''}`, icon: 'plugins', run: () => { void this.runPluginCommand(command.id); } })),
      ...(Object.keys(toolInfo) as Tool[]).map(tool => ({ name: toolInfo[tool].name, detail: `绘图工具 · ${toolInfo[tool].key}`, keywords: `${tool} ${toolInfo[tool].hint}`, icon: tool, run: () => { this.setTool(tool); this.svg.focus(); } })),
      ...ELEMENTS.map((element, index) => ({ name: `元素 ${element}`, detail: `原子序数 ${index + 1} · 应用于所选原子或下一次绘制`, keywords: `element 元素 ${element}`, icon: 'plus', run: () => this.useElement(element) })),
      ...Object.entries(layoutActions).map(([action, name]) => ({ name, detail: '结构排版 · 完整片段；可撤销', keywords: `${action} 排版 排列 键长`, icon: 'templates', run: () => this.layoutSelection(action as LayoutAction) })),
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
    this.searchResults = query ? commands.filter(c => `${c.name} ${c.detail} ${c.keywords} ${translateEnglish(c.name)} ${translateEnglish(c.detail)}`.toLowerCase().includes(query)) : commands.filter(c => !c.name.startsWith('元素 '));
    this.searchIndex = 0; this.renderSearchResults();
  }
  private renderSearchResults() {
    this.query('.search-results').innerHTML = this.searchResults.length ? this.searchResults.map((command, index) => `<button id="command-${index}" role="option" tabindex="-1" aria-selected="${index === this.searchIndex}" data-command="${index}"><span class="command-icon">${icon(command.icon, 19)}</span><span><strong>${esc(command.name)}</strong><small>${esc(command.detail)}</small></span><span class="command-enter">↵</span></button>`).join('') : '<div class="search-empty">没有找到匹配项，试试“苯环”、“查询”、“内部结构”或“原子映射”。</div>';
    const input = this.query('.command-search');
    if (this.searchResults.length) input.setAttribute('aria-activedescendant', `command-${this.searchIndex}`);
    else input.removeAttribute('aria-activedescendant');
    this.root.querySelector<HTMLElement>(`#command-${this.searchIndex}`)?.scrollIntoView({ block: 'nearest' });
    this.i18n?.translate();
  }
  private runSearch(index: number) {
    const command = this.searchResults[index]; if (!command) return;
    this.previousFocus = undefined; this.query<HTMLDialogElement>('.search-dialog').close(); command.run();
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
    if (target.dataset.draftRestore) { this.restoreDraftVersion(target.dataset.draftRestore); return; }
    if (target.dataset.advancedSection || target.dataset.openAdvanced) { this.showAdvancedEditor((target.dataset.advancedSection || target.dataset.openAdvanced) as AdvancedEditorSection); return; }
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
    if (['record-atom-geometry', 'clear-atom-geometry', 'invert-atom-stereo', 'record-bond-ordering', 'clear-bond-ordering', 'invert-double-stereo'].includes(target.dataset.action ?? '')) { this.stereoAction(target.dataset.action!); return; }
    switch (target.dataset.action) {
      case 'toggle-advanced': this.advancedVisible ? this.hideAdvancedEditor() : this.showAdvancedEditor(); break;
      case 'close-advanced': this.hideAdvancedEditor(); break;
      case 'advanced-inspector': this.showAdvancedEditor(); break;
      case 'plugins': this.renderPlugins(); this.showDialog('.plugins-dialog'); break;
      case 'search': this.openSearch(); break;
      case 'elements': this.openSearch('元素 '); break;
      case 'templates': this.showDialog('.templates-dialog'); break;
      case 'shortcuts': this.showDialog('.shortcuts-dialog'); break;
      case 'draft-versions': void this.openDraftVersions(); break;
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
      case 'import': this.pendingImport = undefined; this.query<HTMLTextAreaElement>('.import-source').readOnly = false; this.query<HTMLTextAreaElement>('.import-source').value = ''; this.query('.import-filename').textContent = '支持 CDXML/MRV/MOL 20 MB · CDX 2 MB · JSON 80 MB'; this.importMessage('普通分子可导入编辑。复杂化学语义会明确报告。'); this.showDialog('.import-dialog'); break;
      case 'choose-file': this.query<HTMLInputElement>('.file-input').click(); break;
      case 'apply-import': this.applyImport(); break;
      case 'export': case 'source': this.query<HTMLInputElement>('.allow-lossy').checked = false; this.updateExport(); this.showDialog('.export-dialog'); break;
      case 'download-export': this.downloadExport(); break;
      case 'copy-export': void this.copyExport(); break;
      case 'export-issues': this.showIssues(this.exportResult?.issues ?? this.lastIssues); break;
      case 'export-json': case 'export-source-format': this.query<HTMLSelectElement>('.export-format').value = target.dataset.action === 'export-json' ? 'json' : 'source'; this.query<HTMLInputElement>('.allow-lossy').checked = false; this.updateExport(); break;
      case 'close-dialog': this.closeDialog(target); break;
      case 'issues': this.showIssues(); break;
      case 'flip-bond': this.transact(doc => { const b = doc.graph.bonds[this.selectedBond!], d = doc.depiction.bonds[b.id]; if (d) d.from = d.from === b.atoms[0] ? b.atoms[1] : b.atoms[0]; }); break;
      case 'edit-substructure': this.editSubstructure(); break;
      case 'clear-query-constraints': {
        const snapshot=this.getSnapshot();if(snapshot.selection.atomIds.length!==1)throw new Error('请选择一个原子');
        this.applyEdits({expectedRevision:snapshot.revision,operations:[{type:'update-atom',atomId:snapshot.selection.atomIds[0],changes:{queryConstraints:null}}]});break;
      }
      case 'toggle-substructure-display':case 'show-substructure-recursive': {
        const snapshot=this.getSnapshot(),atomId=snapshot.selection.atomIds[0],group=snapshot.document.graph.atoms[atomId]?.substructure;
        if(snapshot.selection.atomIds.length!==1||!group)throw new Error('请选择一个已定义的内部片段');
        this.applyEdits({expectedRevision:snapshot.revision,operations:[{type:'set-substructure-display',atomId,expanded:target.dataset.action==='show-substructure-recursive'||group.display!=='expanded',recursive:target.dataset.action==='show-substructure-recursive'}]});
        this.fit();this.notify(group.display==='expanded'&&target.dataset.action==='toggle-substructure-display'?'内部结构视图已收起':'内部结构已展开；点击内部原子或键进行编辑。');break;
      }
      case 'expand-substructure':case 'expand-substructure-recursive': {
        const snapshot=this.getSnapshot(),atomId=snapshot.selection.atomIds[0];if(snapshot.selection.atomIds.length!==1)throw new Error('请选择一个已定义的缩写节点');
        this.applyEdits({expectedRevision:snapshot.revision,operations:[{type:'expand-substructure',atomId,recursive:target.dataset.action==='expand-substructure-recursive'}]});
        this.setSelection({atomIds:Object.keys(this.getDocument().graph.atoms).filter(id=>!snapshot.document.graph.atoms[id])});this.fit();this.notify('缩写已展开为主画布上的真实原子和键，可一步撤销。');break;
      }
      case 'collapse-substructure': {
        const snapshot=this.getSnapshot(),label=this.query<HTMLInputElement>('[data-collapse-label]').value;
        const result=this.applyEdits({expectedRevision:snapshot.revision,operations:[{type:'collapse-substructure',atomIds:snapshot.selection.atomIds,label,ref:'$collapsed'}]});
        this.setSelection({atomIds:[result.created.atoms.$collapsed]});this.fit();this.notify('选中片段已收起为可编辑缩写，可展开或一步撤销。');break;
      }
    }
  }
  private onChange(event: Event) {
    const previous = this.committingField;
    this.committingField = event.target instanceof HTMLElement ? event.target : undefined;
    this.fieldCommitError = undefined;
    try { this.applyFieldChange(event); }
    finally { this.committingField = previous; }
  }
  private applyFieldChange(event: Event) {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    if (target.classList.contains('locale-select')) { this.setLocale(normalizeEditorLocale(target.value)); return; }
    if (target.classList.contains('document-title')) { this.transact(doc => { doc.title = target.value.trim() || '未命名结构'; }); return; }
    if (target.classList.contains('sample-select')) { if (target.value) { this.setDocument(exampleDocument(target.value as 'aspirin')); this.notify('示例已载入，可通过撤销恢复之前的结构'); } target.value = ''; return; }
    if (target.classList.contains('file-input')) { const file = (target as HTMLInputElement).files?.[0]; if (file) void this.openFile(file); target.value = ''; return; }
    if (target.classList.contains('export-format') || target.classList.contains('allow-lossy')) {
      if (target.classList.contains('export-format')) this.query<HTMLInputElement>('.allow-lossy').checked = false;
      this.updateExport(); return;
    }
    const property = target.dataset.property;
    if(target.hasAttribute('data-document-page')){this.viewPage=target.value||undefined;this.selection.clear();this.selectedBond=undefined;this.selectedDrawing=undefined;this.render();this.fit();return;}
    try {
      if(target.hasAttribute('data-document-object')){this.setSelection({atomIds:[],...(target.value?{objectId:target.value}:{})});return;}
      if(this.selectedDrawing&&(target.dataset.polymerField||target.hasAttribute('data-polymer-members')||target.dataset.polymerCrossing)){
        if(target.dataset.polymerCrossing){
          const doc=this.getDocument(),group=getPolymerGroup(doc,this.selectedDrawing),bond=doc.graph.bonds[target.value],inner=bond?.atoms.filter(id=>group.atomIds.includes(id));if(inner?.length!==1)throw new Error('请选择恰好连接一个组内原子的边界键');
          this.applyEdits({operations:[{type:'update-polymer-crossing',objectId:target.dataset.polymerCrossing,bondId:bond.id,innerAtomId:inner[0]}]});return;
        }
        let changes:PolymerChanges;
        if(target.hasAttribute('data-polymer-members'))changes={atomIds:[...(target as HTMLSelectElement).selectedOptions].map(o=>o.value)};
        else{const key=target.dataset.polymerField!,numeric=['repeatCount','componentOrder'].includes(key),value=target.value===''?key==='usage'?'Unspecified':null:numeric?Number(target.value):target.value;changes={[key]:value};}
        this.applyEdits({operations:[{type:'update-polymer',objectId:this.selectedDrawing,changes}]});return;
      }
      if(this.selectedDrawing&&(target.hasAttribute('data-drawing-text')||target.dataset.drawingCoordinate||target.dataset.drawingAttribute)){
        const object=this.getDocument().depiction.objects![this.selectedDrawing];
        const changes:import('../core/drawing').DrawingChanges={};
        if(target.hasAttribute('data-drawing-text')){
          const runs=clone(object.runs??[{text:'',attributes:{}}]),old=runs.map(r=>r.text).join(''),next=target.value;
          let start=0,end=0;while(start<old.length&&start<next.length&&old[start]===next[start])start++;
          while(end<old.length-start&&end<next.length-start&&old[old.length-end-1]===next[next.length-end-1])end++;
          let offset=0,inserted=false;
          for(const run of runs){const lo=offset,hi=offset+run.text.length;offset=hi;if(hi<start||lo>old.length-end)continue;const prefix=run.text.slice(0,Math.max(0,start-lo)),suffix=run.text.slice(Math.min(run.text.length,Math.max(0,old.length-end-lo)));run.text=prefix+(!inserted?next.slice(start,next.length-end):'')+suffix;inserted=true;}
          changes.runs=runs;
        }else if(target.dataset.drawingCoordinate)changes.geometry={...object.geometry,[target.dataset.drawingCoordinate]:target.value.trim().split(/\s+/).map(Number)};
        else changes.attributes={...object.attributes,[target.dataset.drawingAttribute!]:target.value};
        this.applyEdits({operations:[{type:'update-drawing',objectId:object.id,changes}]});return;
      }
      if(target.dataset.reactionRole&&target.dataset.reactionStep){
        const refs=[...(target as HTMLSelectElement).selectedOptions].map(option=>JSON.parse(option.value));
        this.applyEdits({operations:[{type:'update-reaction',stepId:target.dataset.reactionStep,changes:{[target.dataset.reactionRole]:refs}}]});return;
      }
      if(target.dataset.bondAnnotation&&this.selectedBond){
        const key=target.dataset.bondAnnotation,value=key==='externalNumbers'?(target.value.trim()?target.value.trim().split(/\s+/).map(n=>Number(n)||null):null):target.value||null;
        this.applyEdits({operations:[{type:'set-bond-annotations',bondId:this.selectedBond,changes:{[key]:value}}]});return;
      }
      if(target.dataset.queryConstraint&&this.selection.size===1){
        const snapshot=this.getSnapshot(),atomId=snapshot.selection.atomIds[0],atom=snapshot.document.graph.atoms[atomId];
        const queryConstraints=changedQueryConstraint(atom,target.dataset.queryConstraint,target.value,(target as HTMLInputElement).checked);
        this.applyEdits({expectedRevision:snapshot.revision,operations:[{type:'update-atom',atomId,changes:{queryConstraints}}]});return;
      }
      if(target.hasAttribute('data-bond-topology')&&this.selectedBond){
        this.applyEdits({operations:[{type:'set-bond-annotations',bondId:this.selectedBond,changes:{topology:(target.value||null) as import('../core/types').Bond['topology']|null}}]});return;
      }
      if (target.dataset.queryProperty && this.selection.size === 1) {
        const atomId = [...this.selection][0], old = this.getDocument().graph.atoms[atomId].query!;
        let query = clone(old);
        if (target.dataset.queryProperty === 'kind') query = target.value === 'elements' ? { kind: 'elements', elements: ['C', 'N'] } : target.value === 'generic' ? { kind: 'generic', label: 'R' } : { kind: 'any' };
        else if (target.dataset.queryProperty === 'exclude' && query.kind === 'elements') { if ((target as HTMLInputElement).checked) query.exclude = true; else delete query.exclude; }
        else if (query.kind === 'elements') query.elements = target.value.trim().split(/[,，\s]+/).filter(Boolean);
        else if (query.kind === 'generic') query.label = target.value.trim();
        else { if (target.value.trim()) query.label = target.value.trim(); else delete query.label; }
        this.applyEdits({ operations: [{ type: 'update-atom', atomId, changes: { query } }] }); return;
      }
      if (target.dataset.stereoKind) {
        const doc = this.getDocument(), kind = target.dataset.stereoKind, slot = Number(target.dataset.stereoSlot), atomId = [...this.selection][0], bondId = this.selectedBond!;
        const refs = clone(kind === 'atom' ? doc.graph.atoms[atomId].geometry!.bondOrdering : doc.graph.bonds[bondId].circularOrdering!);
        const next = target.value || null, previous = refs[slot], duplicate = refs.findIndex((id, i) => id === next && i !== slot);
        if (duplicate !== -1) refs[duplicate] = previous;
        refs[slot] = next;
        this.applyEdits({ operations: [kind === 'atom' ? { type: 'set-atom-geometry', atomId, bondOrdering: refs } : { type: 'set-bond-ordering', bondId, bondOrdering: refs }] });
        return;
      }
      if (property && this.selection.size) {
        this.transact(doc => {
          for (const id of this.selection) {
          const atom = doc.graph.atoms[id];
          if (property === 'element') { atom.element = target.value; delete atom.query; }
          else if (property === 'charge') atom.charge = Number(target.value);
          else if (property === 'radical') { if (target.value === '') delete atom.radical; else atom.radical = Number(target.value) as 1 | 2 | 3; }
          else if (property === 'isotope') { if (target.value === '') delete atom.isotope; else atom.isotope = Number(target.value); }
          else if (property === 'atomMap') { if (target.value === '') delete atom.atomMap; else atom.atomMap = Number(target.value); }
          else if (property === 'sourceNumber') { if (target.value === '') delete atom.sourceNumber; else atom.sourceNumber = Number(target.value); }
          else if (property === 'attachmentIndex') { if (target.value === '') delete atom.attachmentIndex; else atom.attachmentIndex = Number(target.value); }
          else if (property === 'substructureLabel' && atom.substructure) atom.substructure.label = target.value.trim();
          else if (property === 'namedFragmentLabel' && atom.namedFragment) atom.namedFragment.label = target.value.trim();
          else if (property === 'spatial') atom.spatial = target.value.trim().split(/\s+/).map(Number) as [number,number,number];
          else if (property === 'multiAttachment') atom.multiAttachment = target.value.trim().split(/\s+/);
          else if (property === 'residueId') { if(target.value)atom.residueId=Number(target.value);else delete atom.residueId; }
          else if (property === 'connectionType') { if(target.value)atom.connectionType=target.value as typeof atom.connectionType;else delete atom.connectionType; }
          else if (property === 'cipLabel') { if(target.value)atom.cipLabel=target.value as typeof atom.cipLabel;else delete atom.cipLabel; }
          else if (property === 'enhancedStereo') { if(target.value)atom.enhancedStereo={type:target.value as 'And'|'Or'|'Absolute',...(target.value!=='Absolute'?{group:atom.enhancedStereo?.group??1}:{})};else delete atom.enhancedStereo; }
          else if (property === 'enhancedStereoGroup' && atom.enhancedStereo) atom.enhancedStereo.group=Number(target.value);
          else if (property === 'hydrogens') atom.hydrogens = target.value === 'auto' ? { mode: 'auto' } : { mode: 'fixed', count: hydrogenCount(doc, atom.id) ?? 0 };
          else if (property === 'hydrogenCount') atom.hydrogens = { mode: 'fixed', count: Number(target.value) };
          }
        });
      }
      if (target.dataset.bondProperty && this.selectedBond) {
        this.transact(doc => {
          const b = doc.graph.bonds[this.selectedBond!];
          if (target.dataset.bondProperty === 'order') { b.order = target.value === 'aromatic' ? 'aromatic' : target.value==='any'?'any':Number(target.value) as BondOrder; if (b.order !== 1 || doc.depiction.bonds[b.id]?.doublePosition) delete doc.depiction.bonds[b.id]; }
          else if (target.dataset.bondProperty === 'doublePosition') { if (!target.value) delete doc.depiction.bonds[b.id]; else doc.depiction.bonds[b.id] = { style: 'plain', from: doc.depiction.bonds[b.id]?.from ?? b.atoms[0], doublePosition: target.value as 'left' | 'right' | 'center' }; }
          else if (target.value === 'plain') delete doc.depiction.bonds[b.id];
          else doc.depiction.bonds[b.id] = { style: target.value as 'wedge', from: doc.depiction.bonds[b.id]?.from ?? b.atoms[0] };
        });
      }
    } catch (error) { this.fieldCommitError = (error as Error).message; this.inspectorContentKey = undefined; this.notify(this.fieldCommitError); this.render(); }
  }
  private commitFocusedField(): boolean {
    const control = this.root.activeElement;
    if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)) return true;
    if (!control.matches('.document-title') && !control.closest('.inspector-content, .advanced-content')) return true;
    if (!control.checkValidity()) { this.notify('请修正当前字段后再导出'); control.reportValidity(); return false; }
    try { this.onChange({ target: control } as unknown as Event); }
    catch (error) { this.fieldCommitError = (error as Error).message; this.notify(this.fieldCommitError); }
    return !this.fieldCommitError;
  }
  private importMessage(message: string, error = false) { const el = this.query('.import-message'); el.textContent = message; el.classList.toggle('error', error); }
  private async openFile(file: File, apply = false) {
    const limit=/\.json$/i.test(file.name)?80_000_000:/\.cdx$/i.test(file.name)?2_000_000:20_000_000;
    if(file.size>limit){this.notify(`文件大小超过 ${limit/1_000_000} MB`);return;}
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const binary = /\.cdx$/i.test(file.name) || isCdx(bytes);
      // CDX stays binary until converted to a lossless printable transport for this text-based dialog.
      const data = binary ? encodeCdx(bytes) : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      this.pendingImport = { name: file.name, data };
      if (apply && !this.query<HTMLDialogElement>('.import-dialog').open) this.showDialog('.import-dialog');
      const preview = this.query<HTMLTextAreaElement>('.import-source');
      preview.readOnly = binary;
      preview.value = binary ? this.locale === 'en' ? `CDX file selected: ${file.name}\nFile size: ${file.size} bytes\n\nClick Replace current document to parse the file. Compatibility details are shown after import; native JSON keeps the original file.` : `已选择 CDX 文件：${file.name}\n文件大小：${file.size} 字节\n\n点击“替换当前文档”解析文件。兼容提示将在导入后显示；原始文件随 JSON 文档保留。` : data;
      this.query('.import-filename').textContent = file.name;
      this.importMessage(binary ? 'CDX 文件已就绪。导入后可选择源格式保留保存，或导出 JSON、CDXML、MRV、MOL。' : '文件已读取，点击“替换当前文档”确认导入。');
    } catch (error) { this.lastIssues = error instanceof FormatError ? error.issues : [{ severity: 'error', code: 'FILE_READ', message: (error as Error).message }]; if (apply) this.showIssues(); else this.importMessage((error as Error).message, true); }
  }
  private applyImport() {
    try {
      const preview = this.query<HTMLTextAreaElement>('.import-source');
      const data = preview.readOnly && this.pendingImport ? this.pendingImport.data : preview.value;
      const result = this.import({ data, name: this.pendingImport?.data === data ? this.pendingImport.name : undefined });
      this.query<HTMLDialogElement>('.import-dialog').close();
      this.notify(result.issues.length ? `已导入结构，另有 ${result.issues.length} 项兼容提示` : '结构已导入');
    } catch (error) {
      this.lastIssues = error instanceof FormatError ? error.issues : [];
      this.importMessage((error as Error).message, true); this.render();
    }
  }
  private updateExport() {
    this.exportRevision = this.store.revision;
    const format = this.query<HTMLSelectElement>('.export-format').value;
    const preview = this.query<HTMLTextAreaElement>('.export-source'), message = this.query<HTMLElement>('.export-message');
    const consent = this.query<HTMLInputElement>('.allow-lossy'), option = this.query<HTMLElement>('.lossy-option');
    const status = this.query<HTMLElement>('.export-status');
    this.exportResult = undefined; message.classList.remove('error');
    consent.disabled = true; option.hidden = true;
    let issues: Diagnostic[] = [], blocked = false;
    try {
      if (format === 'svg') {
        preview.value = this.exportSvg(); message.textContent = 'SVG 是矢量图片。需要继续编辑化学数据时，请选择 JSON、MRV 或 CDXML。';
        status.textContent = '仅导出图片';
      } else if (format === 'source' || format === 'original') {
        const result = format === 'original' ? exportOriginalSource(this.getDocument()) : exportSourceFile(this.getDocument());
        this.exportResult = result; issues = result.issues;
        preview.value = result.format === 'cdx' ? `CDX 二进制文件 · ${decodeCdx(result.data).length} 字节\n点击“下载文件”保存 .cdx 文件。` : result.data;
        message.textContent = format === 'original' ? '下载导入时的原始文件，字节保持一致；之后的编辑不包含在此文件中。' : result.passthrough ? '当前文档未修改，原样保存源文件。' : '在源文档上保存已支持的修改，保留其余对象、属性和文档信息。';
        status.textContent = format === 'original' ? '原始文件（不含后续编辑）' : '可保留保存';
      } else {
        const result = this.export({ format: format as Format, allowLossy: consent.checked });
        this.exportResult = result; issues = result.issues;
        preview.value = result.format === 'cdx' ? `CDX 二进制文件 · ${decodeCdx(result.data).length} 字节\n点击“下载文件”保存 .cdx 文件。` : result.data;
        const acceptedLoss = result.issues.length > 0 && result.preservation === 'rebuilt';
        consent.disabled = !acceptedLoss; option.hidden = !acceptedLoss;
        status.textContent = acceptedLoss ? '已确认有损导出' : '可保留保存';
        message.textContent = result.preservation === 'preserved' ? '在原 CDXML 文档上更新已支持的字段，其余对象、属性与文档信息保留。' : result.preservation === 'converted' ? 'CDX 对象与属性均已映射为 CDXML，并已复核分子内容；未丢弃未解释字段。' : result.passthrough ? '结构与布局尚未修改，将原样返回源文件。源文件中未解释的内容仍保留。' : result.issues.length ? this.exportIssueSummary(result.issues) : formats.find(f => f.format === format)!.description;
        message.classList.toggle('error', acceptedLoss);
      }
      this.query<HTMLButtonElement>('[data-action="download-export"]').disabled = false;
      this.query<HTMLButtonElement>('[data-action="copy-export"]').disabled = this.exportResult?.format === 'cdx';
    } catch (error) {
      blocked = true; preview.value = ''; message.classList.add('error');
      issues = error instanceof FormatError ? error.issues : [];
      let confirmable = false;
      // Consent is meaningful only if the actual adapter can complete the conversion.
      if (issues.some(issue => issue.code === 'LOSSY_EXPORT_BLOCKED') && formats.some(item => item.format === format)) {
        try { this.export({ format: format as Format, allowLossy: true }); confirmable = true; }
        catch (hardError) {
          if (hardError instanceof FormatError) issues = [...issues.filter(issue => issue.code !== 'LOSSY_EXPORT_BLOCKED'), ...hardError.issues];
        }
      }
      consent.disabled = !confirmable; option.hidden = !confirmable; consent.checked = false;
      status.textContent = confirmable ? '需要确认信息损失' : '暂不支持此转换';
      const detail = this.exportIssueSummary(issues) || (error as Error).message;
      message.textContent = confirmable ? detail : `${detail}\n此限制不能通过允许有损导出解除，请改用推荐保存方式。`;
      this.query<HTMLButtonElement>('[data-action="download-export"]').disabled = true;
      this.query<HTMLButtonElement>('[data-action="copy-export"]').disabled = true;
    }
    if (consent.disabled) consent.checked = false;
    this.lastIssues = issues;
    this.query<HTMLButtonElement>('[data-action="export-issues"]').hidden = issues.length === 0;
    this.query<HTMLButtonElement>('[data-action="export-json"]').hidden = format === 'json' || (!blocked && issues.length === 0);
    let sourceAvailable = false;
    if (format !== 'source' && format !== 'original' && (blocked || issues.length > 0) && ['cdx', 'cdxml'].includes(this.getDocument().source?.format ?? '')) {
      try { exportSourceFile(this.getDocument()); sourceAvailable = true; } catch { /* A recommendation must preserve the current edits. */ }
    }
    this.query<HTMLButtonElement>('[data-action="export-source-format"]').hidden = !sourceAvailable;
    const lines = (message.textContent ?? '').split('\n');
    message.replaceChildren();
    lines.forEach((line,index) => { if (index) message.append(document.createElement('br')); message.append(document.createTextNode(line)); });
    this.i18n?.translate();
  }
  private exportIssueSummary(issues: Diagnostic[]): string {
    return [...new Set(issues.filter(issue => issue.code !== 'LOSSY_EXPORT_BLOCKED').map(issue => issue.message.includes('当前文档没有原始文件') ? '当前文档没有原始文件，请选择 JSON 或其他导出格式。' : issue.code === 'DOCUMENT_PRESERVATION_UNAVAILABLE' || /CDX.*0x[\da-f]+.*CDXML/i.test(issue.message) ? '目标格式暂不能完整保留源文件的全部文档信息。' : issue.message))].join('\n');
  }
  private downloadExport() {
    if (this.exportRevision !== this.store.revision) { this.query<HTMLInputElement>('.allow-lossy').checked = false; this.updateExport(); this.notify('文档已更新，请检查新的导出内容后再次下载'); return; }
    const format = this.query<HTMLSelectElement>('.export-format').value;
    const data = this.query<HTMLTextAreaElement>('.export-source').value;
    if (!data || (format !== 'svg' && !this.exportResult)) return;
    const actualFormat = this.exportResult?.format ?? format;
    const extension = actualFormat === 'cdx' ? '.cdx' : actualFormat === 'svg' ? '.svg' : formats.find(f => f.format === actualFormat)!.extension;
    const payload = actualFormat === 'cdx' ? decodeCdx(this.exportResult!.data).slice().buffer as ArrayBuffer : this.exportResult?.data ?? data;
    const blob = new Blob([payload], { type: actualFormat === 'cdx' ? 'application/octet-stream' : format === 'svg' ? 'image/svg+xml;charset=utf-8' : actualFormat === 'json' ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = format === 'original' && this.getDocument().source?.name ? 'original-' + this.getDocument().source!.name!.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') : (this.getDocument().title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'structure') + extension; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (this.exportResult) { this.lastIssues = this.exportResult.issues; this.render(); }
    this.notify('文件已导出');
  }
  private async copyExport() {
    if (this.exportRevision !== this.store.revision) { this.query<HTMLInputElement>('.allow-lossy').checked = false; this.updateExport(); this.notify('文档已更新，请检查新的导出内容后再次复制'); return; }
    if (this.exportResult?.format === 'cdx' || !this.query<HTMLTextAreaElement>('.export-source').value) return;
    try { await navigator.clipboard.writeText(this.query<HTMLTextAreaElement>('.export-source').value); this.notify('结构源码已复制'); }
    catch { this.notify('浏览器未允许复制，请选择预览中的源码手动复制'); }
  }
  private showIssues(issues = this.diagnostics()) {
    this.query('.issue-list').innerHTML = issues.length ? issues.map(i => `<div class="issue ${i.severity}">${esc(i.message)}<small>${esc(i.code)}</small></div>`).join('') : '<div class="issue">当前基础结构检查未发现问题。完整 CIP 计算、通用聚合物和专用 BioDraw 精确绘制尚未实现。</div>';
    this.showDialog('.issues-dialog');
  }
  fit(): void {
    this.assertLive();
    if (!this.initialized) return;
    const box = documentBounds(documentPage(this.getDocument(),this.viewPage)), rect = this.svg.getBoundingClientRect();
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
    for (const a of Object.keys(documentPage(doc,this.viewPage).graph.atoms)) {
      const p = doc.depiction.positions[a], d = Math.hypot(p.x - point.x, p.y - point.y);
      if (a !== exclude && d < distance) { nearest = a; distance = d; }
    }
    return nearest;
  }
  private pointerDown(event: PointerEvent) {
    if (this.gesture || (event.button !== 0 && event.button !== 1)) return;
    event.preventDefault(); this.svg.focus();
    const expanded=(event.target as Element).closest('[data-expanded-path]');
    if(expanded&&!this.space&&event.button===0){
      const path=JSON.parse(expanded.getAttribute('data-expanded-path')!);
      if(!Array.isArray(path)||!path.length)throw new Error('内部编辑路径无效');
      const atomId=expanded.getAttribute('data-expanded-atom')??undefined,bondId=expanded.getAttribute('data-expanded-bond')??undefined;
      this.selection=new Set([path[0].atomId]);this.selectedBond=undefined;this.selectedDrawing=undefined;this.render();
      this.editSubstructure({path,atomId,bondId});return;
    }
    const point = this.point(event), doc = this.getDocument();
    const atom = (event.target as Element).closest('[data-atom]')?.getAttribute('data-atom') ?? this.nearest(point, doc);
    const bond = (event.target as Element).closest('[data-bond]')?.getAttribute('data-bond') ?? undefined;
    const drawing = (event.target as Element).closest('[data-drawing]')?.getAttribute('data-drawing') ?? undefined;
    const active = this.space || event.button === 1 ? 'pan' : this.tool;
    if (active === 'erase') {
      if (atom || bond || drawing) this.transact(d => { if (atom) removeAtom(d, atom); else if (bond) removeBond(d, bond); else if (drawing) removeDrawing(d, drawing); });
      return;
    }
    if (active === 'ring' || active === 'benzene') {
      this.selection.clear(); this.selectedBond = undefined;
      this.transact(d => {
        const p = atom ? d.depiction.positions[atom] : point;
        const ring = insertRing(d, atom ? { x: p.x + 2.8, y: p.y - .75 } : p, active === 'benzene');
        if (atom) addBond(d, atom, ring[2]);
      }); return;
    }
    let kind: Gesture['kind'] = active === 'pan' ? 'pan' : 'bond';
    if (active === 'select') {
      this.selectedBond = undefined;
      this.selectedDrawing = undefined;
      if (atom) {
        if (event.shiftKey && this.selection.has(atom)) this.selection.delete(atom);
        else if (event.shiftKey) this.selection.add(atom);
        else if (!this.selection.has(atom)) this.selection = new Set([atom]);
        kind = 'move';
      } else if (bond) { this.selection.clear(); this.selectedBond = bond; this.render(); return; }
      else if (drawing) { this.selection.clear(); this.selectedDrawing = drawing; kind = 'drawing'; }
      else { if (!event.shiftKey) this.selection.clear(); kind = 'box'; }
      this.render();
    } else if (active !== 'pan' && bond && !atom) {
      this.selectedBond = bond; this.selection.clear();
      this.transact(d => {
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
    } else if (g.kind === 'drawing') {
      const draft = clone(g.base); moveDrawing(draft, this.selectedDrawing!, {x:g.current.x-g.point.x,y:g.current.y-g.point.y});
      this.drawing.innerHTML = moleculeMarkup(documentPage(draft,this.viewPage), this.selection, this.selectedBond, this.selectedDrawing);
    } else if (g.kind === 'move') {
      const draft = clone(g.base);
      for (const a of this.selection) { const p = draft.depiction.positions[a]; p.x += g.current.x - g.point.x; p.y += g.current.y - g.point.y; }
      this.drawing.innerHTML = moleculeMarkup(documentPage(draft,this.viewPage), this.selection);
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
    if (g.kind === 'drawing') { if (g.moved) this.transact(doc => moveDrawing(doc, this.selectedDrawing!, {x:g.current.x-g.point.x,y:g.current.y-g.point.y})); else this.render(); return; }
    if (g.kind === 'move') {
      if (g.moved) this.transact(doc => { for (const a of this.selection) { doc.depiction.positions[a].x += g.current.x - g.point.x; doc.depiction.positions[a].y += g.current.y - g.point.y; } });
      else this.render();
      return;
    }
    if (g.kind === 'box') {
      if (g.moved) {
        for (const [a, p] of Object.entries(documentPage(g.base,this.viewPage).depiction.positions)) if (p.x >= Math.min(g.point.x, g.current.x) && p.x <= Math.max(g.point.x, g.current.x) && p.y >= Math.min(g.point.y, g.current.y) && p.y <= Math.max(g.point.y, g.current.y)) this.selection.add(a);
      }
      this.render(); return;
    }
    const end = this.bondEndpoint(g, event);
    this.selectedBond = undefined;
    this.transact(doc => {
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
    if (this.initialized) { this.overlay.innerHTML = ''; this.drawing.innerHTML = moleculeMarkup(documentPage(this.getDocument(),this.viewPage), this.selection, this.selectedBond, this.selectedDrawing); }
  }
  private onKey(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing) return;
    const input = event.composedPath()[0] as HTMLElement;
    if (input !== this && input.getRootNode() !== this.root) return;
    const modifier = event.ctrlKey || event.metaKey;
    const modalOpen = !!this.root.querySelector('dialog[open]');
    if (modifier && event.key.toLowerCase() === 's' && !modalOpen) {
      event.preventDefault();
      if (!this.commitFocusedField()) return;
      this.query<HTMLInputElement>('.allow-lossy').checked = false;
      this.updateExport(); this.showDialog('.export-dialog'); return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !this.root.querySelector('dialog[open]')) { event.preventDefault(); this.openSearch(); return; }
    const textInput = input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color'].includes(input.type);
    if (textInput || input.isContentEditable || input.closest('[contenteditable]:not([contenteditable="false"])') || modalOpen) return;
    if (event.ctrlKey || event.metaKey) {
      const key = event.key.toLowerCase();
      if (key === 'z') { event.preventDefault(); event.shiftKey ? this.redo() : this.undo(); }
      else if (key === 'y') { event.preventDefault(); this.redo(); }
      else if (key === 'a') { event.preventDefault(); this.selectAll(); }
      return;
    }
    if (['INPUT', 'SELECT', 'BUTTON', 'SUMMARY', 'A'].includes(input.tagName)) return;
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
      this.transact(doc => { for (const a of this.selection) doc.graph.atoms[a].charge += event.key === '-' ? -1 : 1; }); return;
    }
    const key = event.key.toUpperCase();
    if (['C', 'N', 'O', 'S', 'P', 'F', 'H', 'I'].includes(key)) {
      this.element = key;
      if (this.selection.size) this.transact(doc => { for (const a of this.selection) doc.graph.atoms[a].element = key; });
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
export interface ChemicalEditorOptions { container: HTMLElement; document?: ChemicalDocument; storageKey?: string; plugins?: EditorPlugin[]; locale?: EditorLocale }
export function createChemicalEditor(options: ChemicalEditorOptions): ChemicalEditorElement {
  if (options.locale !== undefined) normalizeEditorLocale(options.locale);
  registerChemicalEditor();
  const element = document.createElement('chemical-editor') as ChemicalEditorElement;
  if (options.locale) element.setLocale(options.locale);
  if (options.storageKey) element.setAttribute('storage-key', options.storageKey);
  options.container.append(element);
  if (options.document && !element.restored) element.setDocument(options.document);
  try { for (const plugin of options.plugins ?? []) element.registerPlugin(plugin); }
  catch (error) { element.destroy(); throw error; }
  return element;
}
