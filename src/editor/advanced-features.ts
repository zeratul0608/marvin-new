import type { Atom, Bond, ChemicalDocument, DrawingObject } from '../core/types';
import { chemicalSymbol, queryLabel } from '../core/query';
import type { EditorSelection } from './api-types';
import type { AdvancedEditorSection } from './advanced-inspector';

export interface AdvancedFeature {
  id: string;
  section: AdvancedEditorSection;
  title: string;
  description: string;
  keywords: string;
  /** A control to focus after opening the category; searching never executes an edit. */
  selector?: string;
}

/** Discoverable routes into existing advanced controls, independent of editor state. */
export const advancedFeatures: readonly AdvancedFeature[] = [
  { id: 'advanced-properties', section: 'properties', title: '高级化学属性', description: '查看映射、自由基、立体连接顺序与化学注释', keywords: '高级 属性 advanced chemistry annotation' },
  { id: 'atom-map', section: 'properties', title: '原子映射编号', description: '选择一个原子，编辑反应中的原子映射编号', keywords: '高级 原子 映射 atom map mapping', selector: '[data-property="atomMap"]' },
  { id: 'atom-radical', section: 'properties', title: '自由基自旋态', description: '选择一个原子，设置单重态、双重态或三重态', keywords: '高级 自由基 自旋 radical spin', selector: '[data-property="radical"]' },
  { id: 'atom-stereo', section: 'properties', title: '原子立体连接顺序', description: '查看已记录的四面体或轴手性顺序；普通原子可记录四面体顺序', keywords: '高级 立体 四面体 手性 轴 几何 tetrahedral axial stereo geometry', selector: '[data-stereo-kind="atom"], [data-action="record-atom-geometry"]' },
  { id: 'bond-stereo', section: 'properties', title: '双键立体连接顺序', description: '选择双键，记录或调整连接顺序', keywords: '高级 双键 立体 反转 构型 double stereo ordering', selector: '[data-stereo-kind="bond"], [data-action="record-bond-ordering"]' },
  { id: 'chemical-annotations', section: 'properties', title: '增强立体与化学注释', description: '查看来源 CIP 标签、立体分组、残基和连接类型', keywords: '高级 注释 分组 残基 来源 CIP enhanced stereo residue', selector: '[data-property="enhancedStereo"]' },
  { id: 'atom-query', section: 'queries', title: '元素列表与通用查询', description: '选择查询原子，编辑元素列表、名称或 NOT 条件', keywords: '高级 查询 元素 列表 排除 通配 NOT generic query', selector: '[data-query-property="kind"]' },
  { id: 'query-substituents', section: 'queries', title: '非氢取代数查询', description: '选择一个原子，限制非氢取代数为恰好或最多', keywords: '高级 查询 非氢 取代数 邻接 atoms substituents neighbors', selector: '[data-query-constraint="substituentsExactly"]' },
  { id: 'query-rings', section: 'queries', title: '环键数量与不饱和查询', description: '选择一个原子，编辑环键数量和不饱和条件', keywords: '高级 查询 环键 数量 不饱和 ring unsaturated', selector: '[data-query-constraint="ringBondCount"]' },
  { id: 'query-reaction', section: 'queries', title: '反应变化与立体查询', description: '选择一个原子，设置反应变化或反应立体条件', keywords: '高级 查询 反应 变化 保留 反转 reaction change retention inversion', selector: '[data-query-constraint="reactionChange"]' },
  { id: 'bond-topology', section: 'queries', title: '化学键环链拓扑查询', description: '选择一条化学键，设置环键、链键或环链要求', keywords: '高级 查询 化学键 环 链 拓扑 bond topology ring chain', selector: '[data-bond-topology]' },
  { id: 'fragment-editor', section: 'fragments', title: '编辑内部化学片段', description: '选择缩写或命名片段，打开内部结构编辑入口', keywords: '高级 片段 缩写 内部 化学 编辑 abbreviation fragment nickname', selector: '[data-action="edit-substructure"]' },
  { id: 'fragment-view', section: 'fragments', title: '展开缩写结构视图', description: '选择已有内部结构的片段，查看展开视图入口', keywords: '高级 片段 缩写 展开 收起 显示 expanded display', selector: '[data-action="toggle-substructure-display"]' },
  { id: 'fragment-expand', section: 'fragments', title: '缩写转为主图原子', description: '选择缩写片段，查看单层或递归提升原子的入口', keywords: '高级 片段 缩写 主图 原子 提升 递归 expand recursive', selector: '[data-action="expand-substructure"]' },
  { id: 'fragment-collapse', section: 'fragments', title: '将选中片段收起为缩写', description: '选择原子并填写名称，再确认收起为可编辑缩写', keywords: '高级 片段 缩写 收起 选择 自定义 collapse abbreviation', selector: '[data-collapse-label]' },
  { id: 'multicenter', section: 'fragments', title: '多中心连接目标', description: '选择多中心连接节点，编辑其目标原子', keywords: '高级 片段 多中心 配位 连接 multicenter attachment', selector: '[data-property="multiAttachment"]' },
  { id: 'document-objects', section: 'document', title: '文档文字箭头与图形', description: '选择文档对象，编辑文字、箭头、图形和坐标', keywords: '高级 文档 对象 文字 箭头 图形 坐标 text arrow drawing', selector: '[data-document-object]' },
  { id: 'polymer-unit', section: 'document', title: '聚合物与重复单元', description: '选择聚合物括号组，编辑类型、成员、标签和连接方式', keywords: '高级 文档 聚合物 重复 单元 括号 SRU polymer bracket repeat', selector: '[data-polymer-field="usage"]' },
  { id: 'reaction-roles', section: 'document', title: '反应步骤与角色', description: '编辑反应物、产物、箭头和反应条件的归属', keywords: '高级 文档 反应 步骤 角色 反应物 产物 条件 reaction reactants products', selector: '[data-reaction-role="reactants"]' },
  { id: 'extension-tools', section: 'extensions', title: '扩展插件与快捷操作', description: '使用结构审阅、排版、化学计算或 AI 助手', keywords: '高级 扩展 插件 工具 计算 排版 AI plugin extension calculation' },
] as const;

export interface AdvancedSectionSummary {
  /** Number of selected objects carrying information in this category, not number of fields. */
  count: number;
  description: string;
}

export interface AdvancedSelectionSummary {
  label: string;
  sections: Partial<Record<AdvancedEditorSection, AdvancedSectionSummary>>;
}

const atomPropertyFields = ['atomMap', 'radical', 'geometry', 'sourceNumber', 'attachmentIndex', 'connectionType', 'residueId', 'cipLabel', 'enhancedStereo', 'spatial'] as const;
const bondPropertyFields = ['circularOrdering', 'cipLabel', 'reactionParticipation', 'sequenceConnectivity', 'externalNumbers'] as const;

function atomLabel(atom: Atom): string {
  if (atom.substructure) return `${atom.substructure.kind === 'alternatives' ? '备选片段' : '缩写片段'} · ${atom.substructure.label}`;
  if (atom.namedFragment) return `未展开片段 · ${atom.namedFragment.label}`;
  if (atom.multiAttachment) return `多中心连接 · ${atom.multiAttachment.length} 个目标`;
  if (atom.attachment) return `外部连接点${atom.attachmentIndex !== undefined ? ` · ${atom.attachmentIndex}` : ''}`;
  if (atom.query) return `查询原子 · ${queryLabel(atom.query)}`;
  return `原子 · ${atom.element}`;
}

function bondLabel(doc: ChemicalDocument, bond: Bond): string {
  const order = { 1: '单键', 2: '双键', 2.5: '2.5 键', 3: '三键', aromatic: '芳香键', any: '任意查询键' }[bond.order];
  const endpoints = bond.atoms.map(id => doc.graph.atoms[id] ? chemicalSymbol(doc.graph.atoms[id]) : '?').join('—');
  return `${order} · ${endpoints}`;
}

function drawingLabel(object: DrawingObject): string {
  const names: Partial<Record<DrawingObject['tag'], string>> = { page: '页面', group: '分组', t: '文字', arrow: '箭头', graphic: '图形', curve: '曲线', bracketedgroup: '聚合物／重复单元', bioshape: '生物图形', table: '表格' };
  const text = object.runs?.map(run => run.text).join('').trim();
  return `${names[object.tag] ?? '文档对象'}${text ? ` · ${text.slice(0, 100)}${text.length > 100 ? '…' : ''}` : ''}`;
}

/** Plain text metadata for the current selection; never mutates or evaluates chemistry. */
export function advancedSelectionSummary(doc: ChemicalDocument, selection: EditorSelection): AdvancedSelectionSummary {
  const atoms = [...new Set(selection.atomIds)].flatMap(id => doc.graph.atoms[id] ? [doc.graph.atoms[id]] : []);
  const bond = selection.bondId ? doc.graph.bonds[selection.bondId] : undefined;
  const drawing = selection.objectId ? doc.depiction.objects?.[selection.objectId] : undefined;
  const sections: AdvancedSelectionSummary['sections'] = {};
  const propertyCount = atoms.filter(atom => atom.attachment || atomPropertyFields.some(field => atom[field] !== undefined)).length
    + (bond && bondPropertyFields.some(field => bond[field] !== undefined) ? 1 : 0);
  const queryCount = atoms.filter(atom => atom.query || (atom.queryConstraints && Object.values(atom.queryConstraints).some(value => value !== undefined))).length
    + (bond && (bond.order === 'any' || bond.topology !== undefined) ? 1 : 0);
  const fragmentCount = atoms.filter(atom => atom.substructure || atom.namedFragment || atom.multiAttachment).length;
  if (propertyCount) sections.properties = { count: propertyCount, description: `当前选区 ${propertyCount} 个对象含高级属性或化学注释` };
  if (queryCount) sections.queries = { count: queryCount, description: `当前选区 ${queryCount} 个对象含查询条件` };
  if (fragmentCount) sections.fragments = { count: fragmentCount, description: `当前选区 ${fragmentCount} 个节点含片段或多中心连接信息` };
  // Page navigation remains in the basic inspector, so a page alone is not an advanced document object.
  const objectCount = Object.values(doc.depiction.objects ?? {}).filter(object => object.tag !== 'page').length;
  const reactionCount = Object.keys(doc.graph.reactions ?? {}).length;
  if (objectCount || reactionCount) sections.document = { count: objectCount + reactionCount, description: `当前文档含 ${objectCount} 个图文对象、${reactionCount} 个反应步骤` };

  return {
    label: atoms.length > 1 ? `已选择 ${atoms.length} 个化学节点` : atoms.length ? atomLabel(atoms[0]) : bond ? bondLabel(doc, bond) : drawing ? drawingLabel(drawing) : '未选择对象',
    sections,
  };
}
