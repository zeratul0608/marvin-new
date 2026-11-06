import { applyDocumentEdits, type EditOperation } from '../core/edits';
import { validateDocument } from '../core/model';
import { queryLabel } from '../core/query';
import type { Atom, Bond, ChemicalDocument, DrawingObject, ReactionStep } from '../core/types';
import type { EditorSnapshot } from '../editor/api-types';
import { exportSvg } from '../editor/render';

export type AiProposalTool = 'apply_edits' | 'import_structure' | 'load_template' | 'cleanup_molecule_2d' | 'import_smiles';
export type AiProposalChangeKind = 'atom' | 'bond' | 'drawing' | 'reaction' | 'document';
export type AiProposalAction = 'add' | 'remove' | 'update';

/** Plain text only. The UI must use textContent when displaying labels and details. */
export interface AiProposalChange {
  kind: AiProposalChangeKind;
  action: AiProposalAction;
  id: string;
  label: string;
  fields: string[];
  details: string[];
}
export interface AiProposalCount {
  label: string;
  before: number;
  after: number;
  added: number;
  removed: number;
  updated: number;
}
export interface AiEditProposal {
  /** Unique for this preview instance; unchanged while it is being reviewed. */
  id: string;
  expectedRevision: number;
  tool: AiProposalTool;
  title: string;
  summary: string;
  /** Source-free copies for local review. Never use these copies for preserved-source saving. */
  before: ChemicalDocument;
  after: ChemicalDocument;
  totals: { atoms: AiProposalCount; bonds: AiProposalCount; drawings: AiProposalCount; reactions: AiProposalCount };
  changes: AiProposalChange[];
  totalChanges: number;
  truncated: boolean;
  hasChanges: boolean;
  notes: string[];
  svg: { before: string; after: string };
}
export interface AiEditProposalRequest {
  tool: AiProposalTool;
  operations?: readonly EditOperation[];
  document?: ChemicalDocument;
  summary?: string;
}

const MAX_CHANGES = 50;
const MAX_OBJECTS = 2000;
const MAX_DOCUMENT_CHARS = 700_000;
const titles: Record<AiProposalTool, string> = { apply_edits: 'AI 修改预览', import_structure: 'AI 导入预览', load_template: 'AI 模板替换预览', cleanup_molecule_2d: 'AI 二维清理预览', import_smiles: 'AI SMILES 导入预览' };
const atomFieldLabels: Record<string, string> = {
  element: '元素', charge: '形式电荷', isotope: '同位素', atomMap: '原子映射', radical: '自由基自旋态', hydrogens: '氢数策略',
  query: '原子查询', queryConstraints: '查询约束', geometry: '立体连接顺序', sourceNumber: '来源原子编号', attachmentIndex: '连接点序号',
  connectionType: '连接类型', residueId: '残基编号', cipLabel: '来源 CIP 标签', enhancedStereo: '增强立体分组',
  multiAttachment: '多中心连接目标', namedFragment: '命名片段', spatial: '独立三维坐标', attachment: '外部连接点', substructure: '内部片段',
};
const bondFieldLabels: Record<string, string> = {
  atoms: '连接端点', order: '键类型', topology: '环链拓扑', circularOrdering: '双键连接顺序', cipLabel: '来源 CIP 标签',
  reactionParticipation: '反应键变化', sequenceConnectivity: '序列连接方式', externalNumbers: '外部连接编号',
};
const queryLabels: Record<string, string> = {
  substituentsExactly: '非氢取代数恰好', substituentsUpTo: '非氢取代数最多', ringBondCount: '环键数量', unsaturatedBonds: '不饱和条件', reactionChange: '仅允许指定反应变化', reactionStereo: '反应立体条件',
  Unspecified: '未指定', NoRingBonds: '没有环键', AsDrawn: '按当前绘制', SimpleRing: '恰好两条环键', Fusion: '恰好三条环键', SpiroOrHigher: '至少四条环键',
  MustBeAbsent: '必须不含不饱和键', MustBePresent: '必须含不饱和键', Inversion: '构型反转', Retention: '构型保留',
};
const drawingNames: Record<string, string> = { page: '页面', group: '分组', t: '文字', graphic: '图形', curve: '曲线', arrow: '箭头', bioshape: '生物图形', bracketedgroup: '聚合物／重复单元', table: '表格' };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value) ?? 'undefined';
}
const equal = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const short = (value: string, length = 100) => value.length > length ? value.slice(0, length) + '…' : value;
const changedFields = (before: object, after: object) => [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => key !== 'id' && !equal((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key]));
const changeText = (label: string, before: string, after: string) => `${label}：${before} → ${after}`;
const scalar = (value: unknown): string => value === undefined || value === null ? '未指定' : typeof value === 'boolean' ? value ? '是' : '否' : short(String(value));

/** Remove original files at every nested document boundary before producing preview data. */
function sourceFree(document: ChemicalDocument): ChemicalDocument {
  const clean = structuredClone(document), ancestry = new Set<ChemicalDocument>();
  const counts = { atoms: 0, bonds: 0, drawings: 0, reactions: 0 };
  const strip = (doc: ChemicalDocument, depth: number) => {
    if (depth > 16 || ancestry.has(doc)) throw new Error('AI 修改预览的内部片段层级或引用无效');
    ancestry.add(doc); delete doc.source;
    counts.atoms += Object.keys(doc.graph.atoms).length; counts.bonds += Object.keys(doc.graph.bonds).length;
    counts.drawings += Object.keys(doc.depiction.objects ?? {}).length; counts.reactions += Object.keys(doc.graph.reactions ?? {}).length;
    if (Object.values(counts).some(count => count > MAX_OBJECTS)) throw new Error('AI 修改预览超过上下文对象限额；结构未被截断。');
    for (const object of Object.values(doc.depiction.objects ?? {})) delete object.source;
    for (const reaction of Object.values(doc.graph.reactions ?? {})) delete reaction.source;
    for (const atom of Object.values(doc.graph.atoms)) for (const fragment of atom.substructure?.fragments ?? []) strip(fragment.document, depth + 1);
    ancestry.delete(doc);
  };
  strip(clean, 0);
  if (JSON.stringify(clean).length > MAX_DOCUMENT_CHARS) throw new Error('AI 修改预览超过上下文大小限额；结构未被截断。');
  return clean;
}

function atomLabel(atom: Atom): string {
  if (atom.substructure) return `${atom.substructure.kind === 'alternatives' ? '备选片段节点' : '缩写节点'} · ${short(atom.substructure.label)}`;
  if (atom.namedFragment) return `命名片段节点 · ${short(atom.namedFragment.label)}`;
  if (atom.multiAttachment) return '多中心连接节点';
  if (atom.attachment) return `外部连接点${atom.attachmentIndex ? ` · ${atom.attachmentIndex}` : ''}`;
  if (atom.query) return `查询节点 · ${short(queryLabel(atom.query))}`;
  return `原子 · ${atom.element}`;
}
function atomValue(field: string, atom: Atom): string {
  const value = atom[field as keyof Atom];
  if (value === undefined) return '未指定';
  if (field === 'hydrogens') return atom.hydrogens.mode === 'auto' ? '自动' : `明确指定 ${atom.hydrogens.count} H`;
  if (field === 'query') return short(queryLabel(atom.query!));
  if (field === 'queryConstraints') return Object.entries(atom.queryConstraints!).map(([key, item]) => `${queryLabels[key] ?? key} ${queryLabels[String(item)] ?? scalar(item)}`).join('；');
  if (field === 'enhancedStereo') return `${atom.enhancedStereo!.type}${atom.enhancedStereo!.group === undefined ? '' : ` ${atom.enhancedStereo!.group}`}`;
  if (field === 'namedFragment') return short(atom.namedFragment!.label);
  if (field === 'spatial') return atom.spatial!.join(', ');
  if (Array.isArray(value)) return `${value.length} 项`;
  if (typeof value === 'object') return '已定义';
  return scalar(value);
}
function atomDetails(before: Atom, after: Atom, fields: string[]): string[] {
  const details: string[] = [];
  for (const field of fields) {
    if (field === 'substructure') {
      const previous = before.substructure, next = after.substructure;
      if (previous?.label !== next?.label) details.push(changeText('片段名称', previous ? short(previous.label) : '未指定', next ? short(next.label) : '未指定'));
      if (previous?.display !== next?.display) details.push(changeText('片段视图', previous?.display === 'expanded' ? '展开' : '收起', next?.display === 'expanded' ? '展开' : '收起'));
      if (!equal(previous?.fragments, next?.fragments) || !equal(previous?.connections, next?.connections) || previous?.kind !== next?.kind) details.push('内部结构或连接映射已修改；数量仍按主画布节点统计。');
    } else details.push(changeText(atomFieldLabels[field] ?? field, atomValue(field, before), atomValue(field, after)));
  }
  return details;
}
function orderName(order: Bond['order']): string {
  return { 1: '单键', 2: '双键', 2.5: '2.5 键', 3: '三键', aromatic: '芳香键', any: '任意查询键' }[order];
}
function bondDetails(before: Bond, after: Bond, fields: string[]): string[] {
  return fields.map(field => field === 'order' ? changeText('键类型', orderName(before.order), orderName(after.order))
    : field === 'atoms' || field === 'circularOrdering' || field === 'externalNumbers' ? `${bondFieldLabels[field]}已修改`
      : changeText(bondFieldLabels[field] ?? field, scalar(before[field as keyof Bond]), scalar(after[field as keyof Bond])));
}
function drawingLabel(object: DrawingObject): string { return drawingNames[object.tag] ?? '文档图元'; }
function drawingDetails(before: DrawingObject, after: DrawingObject, fields: string[]): string[] {
  return fields.map(field => {
    if (field === 'runs') return changeText('文字', short(before.runs?.map(run => run.text).join('') ?? ''), short(after.runs?.map(run => run.text).join('') ?? ''));
    if (field === 'geometry') return `图形坐标已修改（${changedFields(before.geometry, after.geometry).join('、')}）`;
    if (field === 'attributes') return `图形属性已修改（${changedFields(before.attributes, after.attributes).slice(0, 10).join('、')}）`;
    return `${({ references: '文档引用', children: '子对象', atomIds: '成员原子', tag: '图元类型', parentId: '父对象', sourceId: '来源标识' } as Record<string, string>)[field] ?? field}已修改`;
  });
}
function reactionDetails(before: ReactionStep, after: ReactionStep, fields: string[]): string[] {
  const names: Record<string, string> = { reactants: '反应物', products: '产物', arrows: '反应箭头', above: '箭头上方条件', below: '箭头下方条件', pluses: '加号', atomMappings: '原子对应关系', schemeId: '反应方案', sourceId: '来源标识' };
  return fields.map(field => {
    const left = before[field as keyof ReactionStep], right = after[field as keyof ReactionStep];
    return Array.isArray(left) || Array.isArray(right) ? changeText(names[field] ?? field, `${Array.isArray(left) ? left.length : 0} 项`, `${Array.isArray(right) ? right.length : 0} 项`) : `${names[field] ?? field}已修改`;
  });
}

/** Pure local preview. Commit the original request only after checking expectedRevision again. */
export function createAiEditProposal(before: EditorSnapshot, request: AiEditProposalRequest): AiEditProposal {
  if (!Number.isSafeInteger(before.revision) || before.revision < 0) throw new Error('AI 修改预览需要有效文档版本');
  if (!Object.hasOwn(titles, request.tool)) throw new Error('AI 修改预览工具无效');
  if (request.summary !== undefined && (typeof request.summary !== 'string' || request.summary.length > 2000)) throw new Error('AI 修改预览说明无效');
  const cleanBefore = sourceFree(before.document); validateDocument(cleanBefore);
  let next: ChemicalDocument;
  if (request.tool === 'apply_edits' || request.tool === 'cleanup_molecule_2d') {
    if (!request.operations?.length || request.document !== undefined) throw new Error('编辑预览需要一批操作，不能同时提供替换文档');
    next = applyDocumentEdits(before.document, request.operations).document;
  } else {
    if (!request.document || request.operations !== undefined) throw new Error('替换预览需要完整文档，不能包含局部操作');
    next = request.document;
  }
  const cleanAfter = sourceFree(next); validateDocument(cleanAfter);
  const allChanges: AiProposalChange[] = [];
  const diff = <T extends { id: string }>(kind: Exclude<AiProposalChangeKind, 'document'>, label: string, left: Record<string, T>, right: Record<string, T>, name: (item: T) => string, details: (a: T, b: T, fields: string[]) => string[], extra?: (id: string) => { fields: string[]; details: string[] }): AiProposalCount => {
    const count: AiProposalCount = { label, before: Object.keys(left).length, after: Object.keys(right).length, added: 0, removed: 0, updated: 0 };
    for (const id of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      const a = left[id], b = right[id];
      if (!a || !b) {
        const action = b ? 'add' : 'remove'; count[b ? 'added' : 'removed']++;
        allChanges.push({ kind, action, id, label: name(b ?? a), fields: [], details: [b ? '新增对象' : '删除对象'] });
      } else {
        const fields = changedFields(a, b), additional = extra?.(id);
        if (fields.length || additional?.fields.length) {
          count.updated++;
          allChanges.push({ kind, action: 'update', id, label: name(b), fields: [...fields, ...additional?.fields ?? []], details: [...details(a, b, fields), ...additional?.details ?? []] });
        }
      }
    }
    return count;
  };
  const totals = {
    atoms: diff('atom', '主画布化学节点', cleanBefore.graph.atoms, cleanAfter.graph.atoms, atomLabel, atomDetails, id => {
      const a = cleanBefore.depiction.positions[id], b = cleanAfter.depiction.positions[id];
      return equal(a, b) ? { fields: [], details: [] } : { fields: ['position'], details: [changeText('二维位置', `(${a.x}, ${a.y})`, `(${b.x}, ${b.y})`)] };
    }),
    bonds: diff('bond', '主画布化学键', cleanBefore.graph.bonds, cleanAfter.graph.bonds, bond => orderName(bond.order), bondDetails, id => equal(cleanBefore.depiction.bonds[id], cleanAfter.depiction.bonds[id]) ? { fields: [], details: [] } : { fields: ['depiction'], details: ['二维键描绘已修改'] }),
    drawings: diff('drawing', '文档图元', cleanBefore.depiction.objects ?? {}, cleanAfter.depiction.objects ?? {}, drawingLabel, drawingDetails),
    reactions: diff('reaction', '反应步骤', cleanBefore.graph.reactions ?? {}, cleanAfter.graph.reactions ?? {}, () => '反应步骤', reactionDetails),
  };
  const documentFields: string[] = [], documentDetails: string[] = [];
  if (cleanBefore.title !== cleanAfter.title) { documentFields.push('title'); documentDetails.push(changeText('文档名称', short(cleanBefore.title), short(cleanAfter.title))); }
  if (!equal(cleanBefore.depiction.style, cleanAfter.depiction.style)) { documentFields.push('style'); documentDetails.push('文档绘图样式已修改'); }
  if (documentFields.length) allChanges.push({ kind: 'document', action: 'update', id: cleanBefore.id, label: '文档', fields: documentFields, details: documentDetails });
  const added = Object.values(totals).reduce((sum, count) => sum + count.added, 0), removed = Object.values(totals).reduce((sum, count) => sum + count.removed, 0), updated = Object.values(totals).reduce((sum, count) => sum + count.updated, 0) + Number(documentFields.length > 0);
  const nested = [cleanBefore, cleanAfter].some(doc => Object.values(doc.graph.atoms).some(atom => !!atom.substructure));
  const notes = nested ? ['数量按主画布化学节点统计；缩写、备选片段和多中心节点不会冒充已展开的普通原子。'] : [];
  if (allChanges.length > MAX_CHANGES) notes.push(`仅列出前 ${MAX_CHANGES} 项变更，实际修改未被截断。`);
  return {
    id: `ai-proposal-${crypto.randomUUID()}`, expectedRevision: before.revision, tool: request.tool, title: titles[request.tool],
    summary: request.summary?.trim() || (allChanges.length ? `新增 ${added} 项，修改 ${updated} 项，删除 ${removed} 项。` : '没有实际结构或文档修改。'),
    before: cleanBefore, after: cleanAfter, totals, changes: allChanges.slice(0, MAX_CHANGES), totalChanges: allChanges.length, truncated: allChanges.length > MAX_CHANGES, hasChanges: allChanges.length > 0, notes,
    svg: { before: exportSvg(cleanBefore), after: exportSvg(cleanAfter) },
  };
}
