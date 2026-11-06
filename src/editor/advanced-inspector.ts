import type { ChemicalDocument, StereoBondOrdering } from '../core/types';
import { queryLabel } from '../core/query';
import { escapeXml as esc } from '../formats/shared';
import { atomAnnotations, bondAnnotations, documentInspector } from './document-inspector';
import { atomQueryConstraintControls, bondTopologyControls } from './query-inspector';

export type AdvancedEditorSection = 'properties' | 'queries' | 'fragments' | 'document' | 'extensions';

export const advancedEditorSections = [
  { id: 'properties', label: '高级属性' },
  { id: 'queries', label: '查询条件' },
  { id: 'fragments', label: '片段与缩写' },
  { id: 'document', label: '文档与反应' },
  { id: 'extensions', label: '扩展插件' },
] as const satisfies readonly { id: AdvancedEditorSection; label: string }[];

export interface AdvancedInspectorContext {
  atomIds: string[];
  bondId?: string;
  drawingId?: string;
  pageId?: string;
  queryExpanded?: boolean;
  bondQueryExpanded?: boolean;
  orderingFields: (refs: StereoBondOrdering, kind: 'atom' | 'bond', candidates: string[]) => string;
}

export function advancedInspectorContent(
  doc: ChemicalDocument,
  context: AdvancedInspectorContext,
): Record<Exclude<AdvancedEditorSection, 'extensions'>, string> {
  const bonds = Object.values(doc.graph.bonds);
  const atom = context.atomIds.length === 1 ? doc.graph.atoms[context.atomIds[0]] : undefined;
  const bond = context.bondId ? doc.graph.bonds[context.bondId] : undefined;
  let properties = '';
  let queries = '';
  let fragments = '';

  if (atom) {
    if (!atom.attachment) {
    properties += `<h3>原子映射与立体属性</h3><label for="atom-map">原子映射编号</label><input id="atom-map" data-property="atomMap" type="number" min="1" step="1" placeholder="未指定" value="${atom.atomMap ?? ''}"/>`;
    properties += `<label for="atom-radical">自由基自旋态</label><select id="atom-radical" data-property="radical">${[['', '无'], ['1', '单重态'], ['2', '双重态'], ['3', '三重态']].map(([value, label]) => `<option value="${value}"${String(atom.radical ?? '') === value ? ' selected' : ''}>${label}</option>`).join('')}</select>${atom.radical && atom.hydrogens.mode === 'auto' ? '<p>自由基的自动氢数暂无法确定，请明确指定非图氢数。</p>' : ''}`;
    if (!atom.query && !atom.substructure && !atom.namedFragment && !atom.multiAttachment) properties += atom.geometry
      ? `<h3>${atom.geometry.type === 'axial' ? '轴手性连接顺序' : '四面体几何'}</h3><p>按键顺序定义取向；虚配体用空位表示。尚不分配 R/S。</p>${context.orderingFields(atom.geometry.bondOrdering, 'atom', (atom.geometry.type === 'axial' ? bonds : bonds.filter(b => b.atoms.includes(atom.id))).map(b => b.id))}<button class="wide-button" data-action="invert-atom-stereo">反转四面体构型</button><button class="wide-button" data-action="clear-atom-geometry">清除几何约束</button>`
      : '<button class="wide-button" data-action="record-atom-geometry">记录四面体连接顺序</button>';
    }
    if (atom.attachment) properties += `<label for="attachment-index">连接点序号</label><input id="attachment-index" data-property="attachmentIndex" type="number" min="1" value="${atom.attachmentIndex ?? ''}" placeholder="未指定"/>`;
    if (atom.sourceNumber !== undefined) properties += `<label for="source-atom-number">来源原子编号</label><input id="source-atom-number" data-property="sourceNumber" type="number" min="1" value="${atom.sourceNumber}"/><p>这是来源文件的编号，与编辑器对象 ID 分开保存。</p>`;
    properties += atomAnnotations({ ...atom, namedFragment: undefined, multiAttachment: undefined });

    if (atom.query) {
      const query = atom.query;
      queries += `<h3>查询条件 · ${esc(queryLabel(query))}</h3><label for="query-kind">条件类型</label><select id="query-kind" data-query-property="kind">${[['elements', '元素列表'], ['generic', '通用基团名称'], ['any', '任意原子／未解释标签']].map(([value, label]) => `<option value="${value}"${query.kind === value ? ' selected' : ''}>${label}</option>`).join('')}</select><label for="query-value">${query.kind === 'elements' ? '元素符号（用逗号分隔）' : '名称／标签'}</label><input id="query-value" data-query-property="value" value="${esc(query.kind === 'elements' ? query.elements.join(',') : query.label ?? '')}"/>${query.kind === 'elements' ? `<label><input type="checkbox" data-query-property="exclude"${query.exclude ? ' checked' : ''}/>排除这些元素（NOT）</label>` : ''}<p>查询条件不代表一个确定元素，不计作完整分子式。选择普通元素可将此节点替换为确定原子。</p>`;
    }
    queries += atomQueryConstraintControls(atom, context.queryExpanded ?? false);

    const group = atom.substructure;
    if (group) {
      fragments += `<div class="selection-name"><span data-i18n-skip>${esc(group.label)}</span><small>${group.kind === 'alternatives' ? '备选化学片段' : '缩写化学片段'}</small></div><p>内部含 ${group.fragments.length} 个独立解析的片段、${group.connections.length} 个外部连接映射。</p><label for="substructure-label">显示名称</label><input id="substructure-label" data-property="substructureLabel" value="${esc(group.label)}"/><button class="wide-button" data-action="edit-substructure">打开并编辑内部结构</button>${group.kind === 'abbreviation' ? '<button class="wide-button" data-action="expand-substructure">转为主图原子（单层）</button><button class="wide-button" data-action="expand-substructure-recursive">转为主图原子（递归）</button><p>按已有端口连接真实原子，修改可一步撤销。未绑定端口会保留；整体电荷、生物序列等不能可靠转移的注释会阻止原子级提升，仍可在展开视图中编辑。</p>' : ''}<p>内部原子和键使用同一套编辑器。保存后作为一步修改进入主文档历史；删除已绑定的连接点前需要重新绑定边界。</p>`;
      fragments += `<h3>展开视图</h3><button class="wide-button" data-action="toggle-substructure-display">${group.display === 'expanded' ? '收起结构视图' : '展开结构并编辑'}</button><button class="wide-button" data-action="show-substructure-recursive">展开全部内部层级</button><p>保留片段注释和所有候选。展开后点击内部原子或键进行编辑，保存后可在主文档中一步撤销。</p>`;
      if (group.connections.length) {
        const order = (value: unknown) => value === 'aromatic' ? '芳香' : value === 'any' ? '查询' : String(value ?? '未指定');
        fragments += '<details><summary>内外连接映射</summary>' + group.connections.map((connection, index) => {
          const inner = group.fragments[connection.fragment]?.document;
          const edge = inner && Object.values(inner.graph.bonds).find(b => b.atoms.includes(connection.atomId));
          const outer = doc.graph.bonds[connection.bondId];
          return `<p>连接 ${index + 1}：外部键 ${order(outer?.order)} ↔ 候选 ${connection.fragment + 1} 内部键 ${order(edge?.order)}${edge && outer && edge.order !== outer.order ? ' · 键型不同，保留原始连接供编辑校验' : ''}</p>`;
        }).join('') + '</details>';
      }
    }
    if (atom.namedFragment) fragments += `<h3>来源未展开的片段</h3><label>片段名称<input data-property="namedFragmentLabel" value="${esc(atom.namedFragment.label)}"/></label><p>原文件未提供内部原子图。名称及外部连接可编辑；内部组成尚未定义。</p>${group ? '' : '<button data-action="edit-substructure" class="wide-button">补全并编辑内部结构</button>'}`;
    if (atom.multiAttachment) fragments += `<h3>多中心连接</h3><label>目标原子<input data-property="multiAttachment" value="${esc(atom.multiAttachment.join(' '))}"/></label><p>虚拟中心独立保存连接目标，不计作碳原子。</p>`;
  }

  if (bond) {
    if (bond.order === 2) properties += bond.circularOrdering
      ? `<h3>双键连接顺序</h3><p>前两项属于起点，后两项属于终点。空位用虚配体表示；尚不分配 E/Z。</p>${context.orderingFields(bond.circularOrdering, 'bond', bonds.filter(other => other.id !== bond.id && other.atoms.some(id => bond.atoms.includes(id))).map(other => other.id))}<button class="wide-button" data-action="invert-double-stereo">反转双键构型</button><button class="wide-button" data-action="clear-bond-ordering">清除连接顺序</button>`
      : '<button class="wide-button" data-action="record-bond-ordering">从画布记录双键连接顺序</button>';
    properties += bondAnnotations(bond);
    queries += bondTopologyControls(bond, context.bondQueryExpanded ?? false);
  }

  if (context.atomIds.length) fragments += '<details class="collapse-controls"><summary>收起为缩写</summary><label>显示名称<input data-collapse-label maxlength="500" placeholder="例如 OMe、Ph 或自定义名称"/></label><button class="wide-button" data-action="collapse-substructure">将选中片段收起</button><p>只改变表示方式，内部原子和键仍可编辑、展开和撤销。边界须为单键；跨页面、聚合物范围或单原子引用的选区会受到保护。</p></details>';

  return {
    properties: properties || '<h3>高级属性</h3><p>选择一个原子或化学键，编辑映射、立体顺序和化学注释。</p>',
    queries: queries || '<h3>查询条件</h3><p>选择一个原子或化学键，编辑原子条件或键拓扑查询。</p>',
    fragments: fragments || '<h3>片段与缩写</h3><p>选择化学片段以编辑内部结构、连接映射，或将所选原子收起为缩写。</p>',
    document: documentInspector(doc, context.drawingId, context.pageId, { showPages: false }) || '<h3>文档与反应</h3><p>当前文档没有文字、图形、聚合物或反应步骤。</p>',
  };
}
