import type { Atom, AtomId, Bond, BondId, BondOrder, ChemicalDocument, Diagnostic, Point } from './types';

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
  if (!ELEMENTS.includes(element)) throw new Error(`未知元素：${element}`);
  const atomId = id('a');
  doc.graph.atoms[atomId] = { id: atomId, element, charge: 0, hydrogens: { mode: 'auto' }, ...extra };
  doc.graph.atoms[atomId].id = atomId;
  doc.depiction.positions[atomId] = { ...point };
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
  return bondId;
}
export function removeBond(doc: ChemicalDocument, bondId: BondId): void {
  delete doc.graph.bonds[bondId]; delete doc.depiction.bonds[bondId];
}
export function removeAtom(doc: ChemicalDocument, atomId: AtomId): void {
  for (const bond of Object.values(doc.graph.bonds)) if (bond.atoms.includes(atomId)) removeBond(doc, bond.id);
  delete doc.graph.atoms[atomId]; delete doc.depiction.positions[atomId];
}
export function neighbors(doc: ChemicalDocument, atomId: AtomId): AtomId[] {
  return Object.values(doc.graph.bonds).filter(b => b.atoms.includes(atomId)).map(b => b.atoms[0] === atomId ? b.atoms[1] : b.atoms[0]);
}
/** Limited, explicit organic valence model. Unknown elements return null, never a fictitious H count. */
export function hydrogenCount(doc: ChemicalDocument, atomId: AtomId): number | null {
  const atom = doc.graph.atoms[atomId];
  if (atom.hydrogens.mode === 'fixed') return atom.hydrogens.count;
  const bonds = Object.values(doc.graph.bonds).filter(b => b.atoms.includes(atomId));
  const order = bonds.reduce((n, b) => n + (b.order === 'aromatic' ? 1.5 : b.order), 0);
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
export function validateDocument(doc: ChemicalDocument): Diagnostic[] {
  const issues: Diagnostic[] = [];
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  const fields = (value: unknown, allowed: string[], label: string) => {
    if (!record(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new Error(`${label}含未知字段或结构无效`);
  };
  fields(doc, ['schemaVersion', 'id', 'title', 'graph', 'depiction', 'source'], '文档');
  if (doc.schemaVersion !== 1) throw new Error('不支持的文档版本');
  if (typeof doc.id !== 'string' || !doc.id || typeof doc.title !== 'string' || doc.title.length > 500) throw new Error('文档 ID 或标题无效');
  if (!doc.graph?.atoms || !doc.graph?.bonds || !doc.depiction?.positions || !doc.depiction?.bonds) throw new Error('文档缺少分子图或布局');
  fields(doc.graph, ['atoms', 'bonds'], '分子图'); fields(doc.depiction, ['positions', 'bonds'], '描绘');
  if (![doc.graph.atoms, doc.graph.bonds, doc.depiction.positions, doc.depiction.bonds].every(record)) throw new Error('原子、键与布局必须为对象表');
  if (Object.keys(doc.graph.atoms).length > 2000 || Object.keys(doc.graph.bonds).length > 2000) throw new Error('首版最多支持 2000 个原子／键');
  if (doc.source) {
    fields(doc.source, ['format', 'name', 'raw', 'fingerprint', 'issues'], '源文件记录');
    if (!['json', 'mol', 'mol-v3000', 'cdxml', 'mrv'].includes(doc.source.format) || typeof doc.source.raw !== 'string' || typeof doc.source.fingerprint !== 'string' || !Array.isArray(doc.source.issues)) throw new Error('源文件记录无效');
    if (doc.source.name !== undefined && typeof doc.source.name !== 'string') throw new Error('源文件名称无效');
    for (const issue of doc.source.issues) {
      fields(issue, ['severity', 'code', 'message', 'objectId'], '诊断');
      if (!['info', 'warning', 'error'].includes(issue.severity) || typeof issue.code !== 'string' || typeof issue.message !== 'string') throw new Error('源文件诊断无效');
    }
  }
  const pairs = new Set<string>();
  for (const [atomId, atom] of Object.entries(doc.graph.atoms)) {
    fields(atom, ['id', 'element', 'charge', 'isotope', 'atomMap', 'hydrogens'], '原子');
    if (['__proto__', 'constructor', 'prototype'].includes(atomId)) throw new Error('原子 ID 无效');
    if (atom.id !== atomId || !ELEMENTS.includes(atom.element)) throw new Error('原子 ID 或元素无效');
    if (!Number.isInteger(atom.charge)) throw new Error('形式电荷必须为整数');
    if (atom.isotope !== undefined && (!Number.isInteger(atom.isotope) || atom.isotope < 1)) throw new Error('同位素质量数无效');
    if (atom.atomMap !== undefined && (!Number.isInteger(atom.atomMap) || atom.atomMap < 1)) throw new Error('原子映射编号无效');
    if (!atom.hydrogens || !['auto', 'fixed'].includes(atom.hydrogens.mode)) throw new Error('氢策略无效');
    fields(atom.hydrogens, atom.hydrogens.mode === 'auto' ? ['mode'] : ['mode', 'count'], '氢策略');
    if (atom.hydrogens.mode === 'fixed' && (!Number.isInteger(atom.hydrogens.count) || atom.hydrogens.count < 0)) throw new Error('指定氢数无效');
    const p = doc.depiction.positions[atomId];
    fields(p, ['x', 'y'], '坐标');
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error('原子坐标无效');
    if (hydrogenCount(doc, atomId) === null) issues.push({ severity: 'warning', code: 'VALENCE_UNRESOLVED', objectId: atomId, message: `${atom.element} 的氢数或价态暂无法由基础规则确定` });
  }
  for (const [bondId, bond] of Object.entries(doc.graph.bonds)) {
    fields(bond, ['id', 'atoms', 'order'], '键');
    if (['__proto__', 'constructor', 'prototype'].includes(bondId)) throw new Error('键 ID 无效');
    if (bondId !== bond.id || !Array.isArray(bond.atoms) || bond.atoms.length !== 2 || ![1, 2, 3, 'aromatic'].includes(bond.order)) throw new Error('键定义无效');
    if (bond.atoms[0] === bond.atoms[1] || bond.atoms.some(a => typeof a !== 'string' || !Object.hasOwn(doc.graph.atoms, a))) throw new Error('键的端点引用无效');
    const pair = [...bond.atoms].sort().join('|');
    if (pairs.has(pair)) throw new Error('两个原子之间存在重复键');
    pairs.add(pair);
  }
  for (const [bondId, depiction] of Object.entries(doc.depiction.bonds)) {
    fields(depiction, ['style', 'from'], '键描绘');
    const bond = Object.hasOwn(doc.graph.bonds, bondId) ? doc.graph.bonds[bondId] : undefined;
    if (!bond || !bond.atoms.includes(depiction.from) || !['plain', 'wedge', 'hashed', 'wavy'].includes(depiction.style)) throw new Error('键的描绘引用无效');
    if (depiction.style !== 'plain' && bond.order !== 1) throw new Error('当前版本只支持单键的立体描绘');
  }
  if (Object.keys(doc.depiction.positions).some(a => !Object.hasOwn(doc.graph.atoms, a))) throw new Error('布局引用了不存在的原子');
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
  for (const atom of Object.values(doc.graph.atoms)) {
    counts[atom.element] = (counts[atom.element] ?? 0) + 1;
    const h = hydrogenCount(doc, atom.id);
    if (h === null) unresolved = true;
    else if (h > 0) counts.H = (counts.H ?? 0) + h;
  }
  const symbols = Object.keys(counts).sort((a, b) => {
    const rank = (e: string) => counts.C ? e === 'C' ? 0 : e === 'H' ? 1 : 2 : 0;
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  return (symbols.map(e => `${e}${counts[e] > 1 ? counts[e] : ''}`).join('') || '—') + (unresolved ? ' · 待校验' : '');
}
