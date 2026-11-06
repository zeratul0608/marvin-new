import type { Atom, AtomId, Bond, BondId, BondOrder, ChemicalDocument, Diagnostic, Point } from './types';
import { validateStereo } from './stereochemistry';
import { orderSubstructurePorts, validateSubstructures } from './substructure';
import { atomCipLabels, connectionTypes, reactionParticipations } from './chemistry-annotations';
import { validateDrawings } from './drawing';
import {validatePolymers,hasRepeatingChemistry,prunePolymerReferences} from './polymers';
import {atomRingBondCounts,atomUnsaturatedBonds,atomReactionStereos,bondTopologies} from './query';

export const ELEMENTS = ('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og').split(' ');
export const atomicNumber = (element: string) => ELEMENTS.indexOf(element) + 1;
export const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
export const clone = <T>(value: T): T => structuredClone(value);
export function emptyDocument(title = '未命名结构'): ChemicalDocument {
  return { schemaVersion: 1, id: id('doc'), title, graph: { atoms: {}, bonds: {} }, depiction: { positions: {}, bonds: {} } };
}
export function fingerprint(doc: ChemicalDocument): string {
  return JSON.stringify({ title: doc.title, graph: doc.graph, depiction: doc.depiction });
}
export function addAtom(doc: ChemicalDocument, element: string, point: Point, extra: Partial<Atom> = {}): AtomId {
  if (!ELEMENTS.includes(element) && !(element === '*' && (extra.attachment === 'external' || extra.query || extra.substructure || extra.multiAttachment || extra.namedFragment))) throw new Error(`未知元素：${element}`);
  const atomId = id('a');
  doc.graph.atoms[atomId] = { id: atomId, element, charge: 0, hydrogens: { mode: 'auto' }, ...extra };
  doc.graph.atoms[atomId].id = atomId;
  doc.depiction.positions[atomId] = { ...point };
  // A newly drawn atom belongs to the only page when its placement is unambiguous.
  const pages = Object.values(doc.depiction.objects ?? {}).filter(o => o.tag === 'page');
  if (pages.length === 1) pages[0].atomIds.push(atomId);
  return atomId;
}
export function findBond(doc: ChemicalDocument, a: AtomId, b: AtomId): Bond | undefined {
  return Object.values(doc.graph.bonds).find(x => x.atoms.includes(a) && x.atoms.includes(b));
}
export function addBond(doc: ChemicalDocument, a: AtomId, b: AtomId, order: BondOrder = 1): BondId {
  if (a === b) throw new Error('一个键需要两个不同的原子');
  if (!doc.graph.atoms[a] || !doc.graph.atoms[b]) throw new Error('键引用的原子不存在');
  const existing = findBond(doc, a, b);
  if (existing) { existing.order = order; return existing.id; }
  const bondId = id('b');
  doc.graph.bonds[bondId] = { id: bondId, atoms: [a, b], order };
  for (const object of Object.values(doc.depiction.objects ?? {})) if (['page','group'].includes(object.tag)) {
    if (object.atomIds.includes(a) && !object.atomIds.includes(b)) object.atomIds.push(b);
    else if (object.atomIds.includes(b) && !object.atomIds.includes(a)) object.atomIds.push(a);
  }
  for (const step of Object.values(doc.graph.reactions ?? {})) for (const role of ['reactants','products'] as const) for (const ref of step[role]) if (ref.kind === 'molecule') {
    if (ref.atomIds.includes(a) && !ref.atomIds.includes(b)) ref.atomIds.push(b);
    else if (ref.atomIds.includes(b) && !ref.atomIds.includes(a)) ref.atomIds.push(a);
  }
  return bondId;
}
export function removeBond(doc: ChemicalDocument, bondId: BondId): void {
  prunePolymerReferences(doc,'bond',bondId);
  delete doc.graph.bonds[bondId]; delete doc.depiction.bonds[bondId];
  for(const atom of Object.values(doc.graph.atoms))if(atom.substructure){atom.substructure.connections=atom.substructure.connections.filter(port=>port.bondId!==bondId);orderSubstructurePorts(atom.substructure);}
  for (const d of Object.values(doc.depiction.bonds)) if (d.crossings) { d.crossings = d.crossings.filter(id => id !== bondId); if (!d.crossings.length) delete d.crossings; }
}
export function removeAtom(doc: ChemicalDocument, atomId: AtomId): void {
  prunePolymerReferences(doc,'atom',atomId);
  for (const bond of Object.values(doc.graph.bonds)) if (bond.atoms.includes(atomId)) removeBond(doc, bond.id);
  delete doc.graph.atoms[atomId]; delete doc.depiction.positions[atomId];
  for (const object of Object.values(doc.depiction.objects ?? {})) object.atomIds = object.atomIds.filter(id => id !== atomId);
}
export function neighbors(doc: ChemicalDocument, atomId: AtomId): AtomId[] {
  return Object.values(doc.graph.bonds).filter(b => b.atoms.includes(atomId)).map(b => b.atoms[0] === atomId ? b.atoms[1] : b.atoms[0]);
}
/** Limited, explicit organic valence model. Unknown elements return null, never a fictitious H count. */
export function hydrogenCount(doc: ChemicalDocument, atomId: AtomId): number | null {
  const atom = doc.graph.atoms[atomId];
  if (atom.query || atom.queryConstraints || atom.substructure || atom.multiAttachment || atom.namedFragment) return null;
  if (atom.attachment === 'external') return 0;
  const bonds = Object.values(doc.graph.bonds).filter(b => b.atoms.includes(atomId));
  if (bonds.some(b => b.topology !== undefined)) return null;
  if (atom.hydrogens.mode === 'fixed') return atom.hydrogens.count;
  // Spin states alone do not specify a unique implicit valence. Require explicit
  // H counts rather than displaying closed-shell hydrogen estimates for radicals.
  if (atom.radical) return null;
  if (bonds.some(b => b.order === 'any')) return null;
  const order = bonds.reduce((n, b) => n + (b.order === 'aromatic' ? 1.5 : b.order === 'any' ? 0 : b.order), 0);
  if (bonds.some(b => b.order === 'aromatic') && atom.element === 'N') return atom.charge === 0 ? 0 : null;
  const valences: Record<string, Record<number, number[]>> = {
    H: { 0: [1] }, B: { 0: [3], '-1': [4] }, C: { 0: [4], 1: [3], '-1': [3] },
    N: { 0: [3], 1: [4], '-1': [2] }, O: { 0: [2], 1: [3], '-1': [1] },
    F: { 0: [1], '-1': [0] }, Cl: { 0: [1], '-1': [0] }, Br: { 0: [1], '-1': [0] }, I: { 0: [1], '-1': [0] },
    P: { 0: [3, 5] }, S: { 0: [2, 4, 6] }, Si: { 0: [4] },
  };
  const allowed = valences[atom.element]?.[atom.charge];
  if (!allowed) return null;
  const target = allowed.find(v => v >= order);
  return target === undefined || !Number.isInteger(target - order) ? null : target - order;
}
export function validateDocument(doc: ChemicalDocument, ancestors = new Set<ChemicalDocument>()): Diagnostic[] {
  if (ancestors.has(doc) || ancestors.size >= 16) throw new Error('嵌套化学片段存在循环或超过 16 层');
  ancestors = new Set([...ancestors, doc]);
  const issues: Diagnostic[] = [];
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  const fields = (value: unknown, allowed: string[], label: string) => {
    if (!record(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new Error(`${label}含未知字段或结构无效`);
  };
  fields(doc, ['schemaVersion', 'id', 'title', 'graph', 'depiction', 'source'], '文档');
  if (doc.schemaVersion !== 1) throw new Error('不支持的文档版本');
  if (typeof doc.id !== 'string' || !doc.id || typeof doc.title !== 'string' || doc.title.length > 500) throw new Error('文档 ID 或标题无效');
  if (!doc.graph?.atoms || !doc.graph?.bonds || !doc.depiction?.positions || !doc.depiction?.bonds) throw new Error('文档缺少分子图或布局');
  fields(doc.graph, ['atoms', 'bonds', 'reactions'], '分子图'); fields(doc.depiction, ['positions', 'bonds', 'objects', 'style'], '描绘');
  if (![doc.graph.atoms, doc.graph.bonds, doc.depiction.positions, doc.depiction.bonds].every(record)) throw new Error('原子、键与布局必须为对象表');
  if (Object.keys(doc.graph.atoms).length > 2000 || Object.keys(doc.graph.bonds).length > 2000) throw new Error('首版最多支持 2000 个原子／键');
  if (doc.source) {
    fields(doc.source, ['format', 'name', 'raw', 'fingerprint', 'issues'], '源文件记录');
    if (!['json', 'mol', 'mol-v3000', 'cdxml', 'mrv', 'cdx', 'rxn', 'rxn-v3000'].includes(doc.source.format) || typeof doc.source.raw !== 'string' || typeof doc.source.fingerprint !== 'string' || !Array.isArray(doc.source.issues)) throw new Error('源文件记录无效');
    if (doc.source.name !== undefined && typeof doc.source.name !== 'string') throw new Error('源文件名称无效');
    for (const issue of doc.source.issues) {
      fields(issue, ['severity', 'code', 'message', 'objectId'], '诊断');
      if (!['info', 'warning', 'error'].includes(issue.severity) || typeof issue.code !== 'string' || typeof issue.message !== 'string') throw new Error('源文件诊断无效');
    }
  }
  const pairs = new Set<string>();
  for (const [atomId, atom] of Object.entries(doc.graph.atoms)) {
    fields(atom, ['id', 'element', 'charge', 'isotope', 'atomMap', 'hydrogens', 'radical', 'attachment', 'geometry', 'query', 'queryConstraints', 'sourceNumber', 'attachmentIndex', 'substructure', 'connectionType', 'residueId', 'cipLabel', 'enhancedStereo', 'multiAttachment', 'namedFragment', 'spatial'], '原子');
    if (atom.spatial && (!Array.isArray(atom.spatial) || atom.spatial.length !== 3 || atom.spatial.some(n => !Number.isFinite(n)))) throw new Error('三维原子坐标无效');
    if (['__proto__', 'constructor', 'prototype'].includes(atomId)) throw new Error('原子 ID 无效');
    if (atom.id !== atomId || (!ELEMENTS.includes(atom.element) && !(atom.element === '*' && (atom.attachment === 'external' || atom.query || atom.substructure || atom.multiAttachment || atom.namedFragment)))) throw new Error('原子 ID 或元素无效');
    if ([atom.query, atom.attachment, atom.substructure, atom.multiAttachment, atom.namedFragment].filter(Boolean).length > 1) throw new Error('化学节点不能同时具有多种类型');
    if (atom.enhancedStereo) {
      fields(atom.enhancedStereo, ['type', 'group'], '增强立体化学');
      if (!['Absolute','Or','And'].includes(atom.enhancedStereo.type) || (atom.enhancedStereo.type !== 'Absolute' && (!Number.isSafeInteger(atom.enhancedStereo.group) || atom.enhancedStereo.group! < 1)) || (atom.enhancedStereo.type === 'Absolute' && atom.enhancedStereo.group !== undefined)) throw new Error('增强立体化学组无效');
    }
    if (atom.multiAttachment && (atom.element !== '*' || !Array.isArray(atom.multiAttachment) || !atom.multiAttachment.length || new Set(atom.multiAttachment).size !== atom.multiAttachment.length || atom.multiAttachment.some(id => id === atomId || !Object.hasOwn(doc.graph.atoms, id)))) throw new Error('多中心连接的目标原子引用无效');
    if (atom.namedFragment) {
      fields(atom.namedFragment, ['type','label'], '未展开的命名片段');
      if (atom.element !== '*' || !['Fragment','Nickname'].includes(atom.namedFragment.type) || typeof atom.namedFragment.label !== 'string' || !atom.namedFragment.label.trim() || atom.namedFragment.label.length > 500) throw new Error('命名片段定义无效');
      issues.push({ severity: 'warning', code: 'UNRESOLVED_SOURCE_FRAGMENT', objectId: atomId, message: `来源未提供 ${atom.namedFragment.label} 的内部化学图；名称与连接可编辑，内部组成不能凭名称推测。` });
    }
    if (atom.sourceNumber !== undefined && (!Number.isSafeInteger(atom.sourceNumber) || atom.sourceNumber < 1)) throw new Error('来源原子编号必须为正整数');
    if (atom.residueId !== undefined && (!Number.isSafeInteger(atom.residueId) || atom.residueId < 1)) throw new Error('残基编号必须为正整数');
    if (atom.connectionType !== undefined && !connectionTypes.includes(atom.connectionType)) throw new Error('生物／模板连接类型无效');
    if (atom.cipLabel !== undefined && !atomCipLabels.includes(atom.cipLabel)) throw new Error('来源 CIP 标签无效');
    if (atom.attachmentIndex !== undefined && (!atom.attachment || !Number.isSafeInteger(atom.attachmentIndex) || atom.attachmentIndex < 1)) throw new Error('外部连接编号必须属于连接点且为正整数');
    if (atom.queryConstraints !== undefined) {
      const q=atom.queryConstraints;
      fields(q,['substituentsExactly','substituentsUpTo','ringBondCount','unsaturatedBonds','reactionChange','reactionStereo'],'原子查询约束');
      if(!Object.values(q).some(value=>value!==undefined)||atom.attachment)throw new Error('原子查询约束必须非空且不能附加在虚拟连接点');
      for(const key of ['substituentsExactly','substituentsUpTo']as const){const count=q[key];if(count!==undefined&&(!Number.isInteger(count)||count<0||count>255))throw new Error('取代数查询必须为 0–255 的整数');}
      if(q.ringBondCount!==undefined&&!atomRingBondCounts.includes(q.ringBondCount))throw new Error('环键数查询无效');
      if(q.unsaturatedBonds!==undefined&&!atomUnsaturatedBonds.includes(q.unsaturatedBonds))throw new Error('不饱和键查询无效');
      if(q.reactionChange!==undefined&&q.reactionChange!==true)throw new Error('精确反应变化查询只允许 true；取消时应删除该约束');
      if(q.reactionStereo!==undefined&&!atomReactionStereos.includes(q.reactionStereo))throw new Error('反应立体查询无效');
      issues.push({severity:'info',code:'ATOM_QUERY_CONSTRAINTS',objectId:atomId,message:'此节点包含匹配条件，保留其元素及约束，不作为完整确定分子计算。'});
    }
    if (atom.query !== undefined) {
      const q = atom.query;
      if (!q || !['elements', 'generic', 'any'].includes(q.kind) || atom.element !== '*' || atom.attachment || atom.geometry) throw new Error('查询原子定义无效');
      fields(q, q.kind === 'elements' ? ['kind', 'elements', 'exclude'] : ['kind', 'label'], '查询条件');
      if (q.kind === 'elements') {
        if (!Array.isArray(q.elements) || !q.elements.length || q.elements.some(e => !ELEMENTS.includes(e)) || new Set(q.elements).size !== q.elements.length || (q.exclude !== undefined && typeof q.exclude !== 'boolean')) throw new Error('查询元素列表无效');
      } else if ((q.kind === 'generic' || q.label !== undefined) && (typeof q.label !== 'string' || !q.label.trim() || q.label.length > 500)) throw new Error('查询名称无效');
      issues.push({ severity: 'info', code: 'QUERY_STRUCTURE', objectId: atomId, message: '此对象是查询条件，不代表一个确定元素或可计算的完整分子式。' });
    }
    if (atom.attachment !== undefined && (atom.attachment !== 'external' || atom.element !== '*' || atom.charge !== 0 || atom.isotope !== undefined || atom.radical !== undefined || atom.atomMap !== undefined || atom.hydrogens?.mode !== 'fixed' || atom.hydrogens.count !== 0)) throw new Error('模板连接点不能包含元素、电荷、同位素、映射或氢数语义');
    if (!Number.isInteger(atom.charge)) throw new Error('形式电荷必须为整数');
    if (atom.radical !== undefined && ![1, 2, 3].includes(atom.radical)) throw new Error('自由基自旋态必须为单重态、双重态或三重态');
    if (atom.isotope !== undefined && (!Number.isInteger(atom.isotope) || atom.isotope < 1)) throw new Error('同位素质量数无效');
    if (atom.atomMap !== undefined && (!Number.isInteger(atom.atomMap) || atom.atomMap < 1)) throw new Error('原子映射编号无效');
    if (!atom.hydrogens || !['auto', 'fixed'].includes(atom.hydrogens.mode)) throw new Error('氢策略无效');
    fields(atom.hydrogens, atom.hydrogens.mode === 'auto' ? ['mode'] : ['mode', 'count'], '氢策略');
    if (atom.hydrogens.mode === 'fixed' && (!Number.isInteger(atom.hydrogens.count) || atom.hydrogens.count < 0)) throw new Error('指定氢数无效');
    const p = doc.depiction.positions[atomId];
    fields(p, ['x', 'y'], '坐标');
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error('原子坐标无效');
    if (!atom.substructure && hydrogenCount(doc, atomId) === null) issues.push({ severity: 'warning', code: 'VALENCE_UNRESOLVED', objectId: atomId, message: `${atom.element} 的氢数或价态暂无法由基础规则确定` });
  }
  for (const [bondId, bond] of Object.entries(doc.graph.bonds)) {
    fields(bond, ['id', 'atoms', 'order', 'topology', 'circularOrdering', 'cipLabel', 'reactionParticipation', 'sequenceConnectivity', 'externalNumbers'], '键');
    if (['__proto__', 'constructor', 'prototype'].includes(bondId)) throw new Error('键 ID 无效');
    if (bondId !== bond.id || !Array.isArray(bond.atoms) || bond.atoms.length !== 2 || ![1, 2, 2.5, 3, 'aromatic', 'any'].includes(bond.order)) throw new Error('键定义无效');
    if (bond.atoms[0] === bond.atoms[1] || bond.atoms.some(a => typeof a !== 'string' || !Object.hasOwn(doc.graph.atoms, a))) throw new Error('键的端点引用无效');
    if(bond.topology!==undefined){if(!bondTopologies.includes(bond.topology))throw new Error('键拓扑查询无效');issues.push({severity:'info',code:'BOND_TOPOLOGY_QUERY',objectId:bondId,message:'此键包含环／链拓扑匹配条件，不代表计算入口已验证其查询含义。'});}
    if (bond.cipLabel !== undefined && (!['E', 'Z'].includes(bond.cipLabel) || bond.order !== 2)) throw new Error('双键来源 CIP 标签无效');
    if (bond.reactionParticipation !== undefined && !reactionParticipations.includes(bond.reactionParticipation)) throw new Error('反应键条件无效');
    if (bond.sequenceConnectivity !== undefined && !['Linear', 'Bridged', 'Staggered', 'Cyclic'].includes(bond.sequenceConnectivity)) throw new Error('序列连接方式无效');
    if (bond.externalNumbers !== undefined && (!Array.isArray(bond.externalNumbers) || bond.externalNumbers.length !== 2 || bond.externalNumbers.some(n => n !== null && (!Number.isInteger(n) || n < 1)))) throw new Error('序列边界连接编号无效');
    const pair = [...bond.atoms].sort().join('|');
    if (pairs.has(pair)) throw new Error('两个原子之间存在重复键');
    pairs.add(pair);
  }
  for (const [bondId, depiction] of Object.entries(doc.depiction.bonds)) {
    fields(depiction, ['style', 'from', 'doublePosition', 'labelOffsets', 'crossings', 'layer', 'secondaryStyle'], '键描绘');
    if (depiction.secondaryStyle !== undefined && !['plain','dashed'].includes(depiction.secondaryStyle)) throw new Error('第二条键线的描绘无效');
    const bond = Object.hasOwn(doc.graph.bonds, bondId) ? doc.graph.bonds[bondId] : undefined;
    if (!bond || (!bond.atoms.includes(depiction.from) && (depiction.style !== 'plain' || depiction.doublePosition !== undefined || !Object.hasOwn(doc.graph.atoms, depiction.from))) || !['plain', 'wedge', 'hashed', 'wavy', 'dashed', 'bold', 'hash'].includes(depiction.style)) throw new Error('键的描绘引用无效');
    if (depiction.doublePosition !== undefined && (!['center', 'left', 'right'].includes(depiction.doublePosition) || bond.order !== 2 || depiction.style !== 'plain')) throw new Error('双键位置只能用于普通双键');
    if (depiction.labelOffsets !== undefined && (!Array.isArray(depiction.labelOffsets) || depiction.labelOffsets.length !== 2 || depiction.labelOffsets.some(n => !Number.isInteger(n) || n < 0 || n > 255))) throw new Error('键标签连接偏移无效');
    if (depiction.layer !== undefined && !Number.isSafeInteger(depiction.layer)) throw new Error('绘图层次无效');
    if (depiction.crossings !== undefined && (!Array.isArray(depiction.crossings) || new Set(depiction.crossings).size !== depiction.crossings.length || depiction.crossings.some(id => typeof id !== 'string' || id === bondId || !Object.hasOwn(doc.graph.bonds, id)))) throw new Error('交叉键引用无效');
  }
  for (const atom of Object.values(doc.graph.atoms)) if (atom.attachment) {
    const bonds = Object.values(doc.graph.bonds).filter(b => b.atoms.includes(atom.id));
    if (bonds.length > 1 && atom.connectionType !== 'PolymerBead') throw new Error('普通外部连接点只支持一条键；多连接载体必须明确为 PolymerBead');
    issues.push({ severity: 'info', code: 'TEMPLATE_ATTACHMENT', objectId: atom.id, message: '此对象是模板外部连接点，不是碳原子或完整分子；分子式只统计已定义部分。' });
  }
  if (Object.keys(doc.depiction.positions).some(a => !Object.hasOwn(doc.graph.atoms, a))) throw new Error('布局引用了不存在的原子');
  validateStereo(doc);
  validateSubstructures(doc, validateDocument, ancestors);
  validateDrawings(doc);
  validatePolymers(doc);
  return issues;
}
export function connectedComponents(doc: ChemicalDocument): AtomId[][] {
  const unseen = new Set(Object.keys(doc.graph.atoms));
  const result: AtomId[][] = [];
  while (unseen.size) {
    const root = unseen.values().next().value!;
    const stack = [root], component: AtomId[] = [];
    unseen.delete(root);
    while (stack.length) {
      const a = stack.pop()!; component.push(a);
      for (const n of neighbors(doc, a)) if (unseen.delete(n)) stack.push(n);
    }
    result.push(component);
  }
  return result;
}
export function molecularFormula(doc: ChemicalDocument): string {
  const counts: Record<string, number> = {};
  let unresolved = false;
  let repeating=false;
  const visit = (current: ChemicalDocument) => { if(hasRepeatingChemistry(current))repeating=true;if(Object.values(current.graph.bonds).some(b=>b.topology!==undefined))unresolved=true;for (const atom of Object.values(current.graph.atoms)) {
    if(atom.queryConstraints)unresolved=true;
    if (atom.substructure) { if (atom.substructure.kind === 'alternatives') unresolved = true; else for (const fragment of atom.substructure.fragments) visit(fragment.document); continue; }
    if (atom.query || atom.namedFragment) { unresolved = true; continue; }
    if (atom.multiAttachment) continue;
    if (atom.attachment) continue;
    counts[atom.element] = (counts[atom.element] ?? 0) + 1;
    const h = hydrogenCount(current, atom.id);
    if (h === null) unresolved = true;
    else if (h > 0) counts.H = (counts.H ?? 0) + h;
  } }; visit(doc);
  const symbols = Object.keys(counts).sort((a, b) => {
    const rank = (e: string) => counts.C ? e === 'C' ? 0 : e === 'H' ? 1 : 2 : 0;
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  return (symbols.map(e => `${e}${counts[e] > 1 ? counts[e] : ''}`).join('') || '—') + (unresolved ? ' · 待校验' : '') + (Object.values(doc.graph.atoms).some(a => a.attachment) ? ' · 含连接点' : '') + (repeating?' · 含重复／聚合物组，非整体分子式':'');
}
