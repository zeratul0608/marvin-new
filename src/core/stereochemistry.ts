import type { ChemicalDocument, StereoBondOrdering } from './types';

const own = (record: object, key: string) => Object.hasOwn(record, key);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function fail(message: string): never { throw new Error(message); }

function ordering(value: unknown, doc: ChemicalDocument): asserts value is StereoBondOrdering {
  if (!Array.isArray(value) || value.length !== 4 || value.some(b => b !== null && (typeof b !== 'string' || !own(doc.graph.bonds, b)))) fail('立体连接顺序必须为四个有效键 ID 或 null');
  const ids = value.filter(b => b !== null);
  if (new Set(ids).size !== ids.length) fail('立体连接顺序含重复键引用');
}

/** A cumulene/atropisomer axis connects the two pairs of terminal ligands. */
export function axialAtoms(doc: ChemicalDocument, atomId: string, refs: StereoBondOrdering): Set<string> | undefined {
  const real = refs.filter((id): id is string => id !== null); if (real.length !== 4) return;
  const axis = new Set([atomId]), stack = [atomId], bonds = Object.values(doc.graph.bonds).filter(b => !real.includes(b.id));
  while (stack.length) { const id = stack.pop()!; for (const b of bonds) if (b.atoms.includes(id)) for (const next of b.atoms) if (!axis.has(next)) { axis.add(next); stack.push(next); } }
  if (axis.size < 2 || bonds.filter(b => b.atoms.every(id => axis.has(id))).length !== axis.size - 1) return;
  const ends = [...axis].filter(id => bonds.filter(b => b.atoms.includes(id)).length === 1);
  if (ends.length !== 2 || [...axis].some(id => bonds.filter(b => b.atoms.includes(id)).length > 2)) return;
  for (const ref of real) if (doc.graph.bonds[ref].atoms.filter(id => axis.has(id)).length !== 1 || !doc.graph.bonds[ref].atoms.some(id => ends.includes(id))) return;
  if (ends.some(id => real.filter(ref => doc.graph.bonds[ref].atoms.includes(id)).length !== 2)) return;
  return axis;
}
export function geometryFromOrdering(doc: ChemicalDocument, atomId: string, bondOrdering: StereoBondOrdering) {
  return { type: axialAtoms(doc, atomId, bondOrdering) ? 'axial' as const : 'tetrahedral' as const, bondOrdering };
}

/** Validate semantic references, not just opaque source attributes. */
export function validateStereo(doc: ChemicalDocument): void {
  for (const atom of Object.values(doc.graph.atoms)) if (atom.geometry !== undefined) {
    const g = atom.geometry;
    if (!g || typeof g !== 'object' || Array.isArray(g) || Object.keys(g).some(k => !['type', 'bondOrdering'].includes(k)) || !['tetrahedral','axial'].includes(g.type) || atom.attachment) fail('原子几何定义无效');
    ordering(g.bondOrdering, doc);
    if (g.type === 'axial') { if (!axialAtoms(doc, atom.id, g.bondOrdering)) fail('轴手性顺序必须完整引用同一非分支轴两端的四条外部配体键'); continue; }
    const bonds = Object.values(doc.graph.bonds).filter(b => b.atoms.includes(atom.id));
    const real = g.bondOrdering.filter(b => b !== null);
    if (bonds.length < 3 || bonds.length > 4 || real.length !== bonds.length || bonds.some(b => !real.includes(b.id) || b.order !== 1)) fail('四面体连接顺序必须覆盖该原子的全部三条或四条单键；请先更新或清除几何约束');
  }
  for (const bond of Object.values(doc.graph.bonds)) if (bond.circularOrdering !== undefined) {
    ordering(bond.circularOrdering, doc);
    if (![2, 2.5, 'aromatic'].includes(bond.order)) fail('环周连接顺序只适用于双键或部分双键；请先清除该约束再改变键级');
    for (let side = 0; side < 2; side++) {
      const adjacent = Object.values(doc.graph.bonds).filter(b => b.id !== bond.id && b.atoms.includes(bond.atoms[side]));
      const refs = bond.circularOrdering.slice(side * 2, side * 2 + 2).filter(b => b !== null);
      if (adjacent.length > 2 || refs.length !== adjacent.length || adjacent.some(b => !refs.includes(b.id))) fail('双键连接顺序必须完整引用各端点的相邻键；请先更新或清除该约束');
    }
  }
}

const other = (doc: ChemicalDocument, bondId: string, atomId: string) => {
  const b = doc.graph.bonds[bondId]; return b.atoms[0] === atomId ? b.atoms[1] : b.atoms[0];
};
const determinant = (a: number[], b: number[], c: number[]) => a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);

/** Relative drawing handedness only. Does not rank ligands or assign R/S. */
function tetrahedralSign(doc: ChemicalDocument, atomId: string, refs: StereoBondOrdering): number {
  const center = doc.depiction.positions[atomId];
  const axis = doc.graph.atoms[atomId].geometry?.type === 'axial' ? axialAtoms(doc, atomId, refs) : undefined;
  const vectors = refs.map(ref => {
    if (ref === null) return null;
    const owner = axis ? doc.graph.bonds[ref].atoms.find(id => axis.has(id))! : atomId;
    const neighbor = doc.depiction.positions[other(doc, ref, owner)];
    const d = doc.depiction.bonds[ref];
    const z = d?.style === 'wedge' ? 1 : d?.style === 'hashed' ? -1 : 0;
    return [neighbor.x - center.x, neighbor.y - center.y, z * (d?.from === owner ? 1 : -1)];
  });
  const sum = [0, 0, 0];
  for (const v of vectors) if (v) for (let i = 0; i < 3; i++) sum[i] += v[i];
  const points = vectors.map(v => v ?? sum.map(n => -n));
  const [a, b, c] = points.slice(1).map(p => p.map((n, i) => n - points[0][i]));
  const value = determinant(a, b, c);
  // Scale the tolerance so changing document units cannot itself remove a stereo sign.
  const scale = Math.max(...points.map(v => Math.hypot(v[0], v[1])), 1e-12);
  return Math.abs(value) < 1e-9 * scale * scale ? 0 : Math.sign(value);
}

function doubleSign(doc: ChemicalDocument, bondId: string, refs: StereoBondOrdering): number {
  const bond = doc.graph.bonds[bondId], a = doc.depiction.positions[bond.atoms[0]], b = doc.depiction.positions[bond.atoms[1]];
  const dx = b.x - a.x, dy = b.y - a.y;
  const signs: number[] = [];
  for (let side = 0; side < 2; side++) {
    const ref = refs.slice(side * 2, side * 2 + 2).find(id => id !== null);
    if (!ref) return 0;
    const p = doc.depiction.positions[other(doc, ref, bond.atoms[side])], center = side ? b : a;
    const cross = dx * (p.y - center.y) - dy * (p.x - center.x);
    const tolerance = 1e-9 * Math.max(Math.hypot(dx, dy) * Math.hypot(p.x - center.x, p.y - center.y), 1e-12);
    if (Math.abs(cross) <= tolerance) return 0;
    signs.push(Math.sign(cross));
  }
  return signs[0] * signs[1];
}

/** Compare configurations when an embedding replaces virtual ports or a label
 * with real atoms. Includes depicted configurations without cached CIP labels. */
export function assertMappedStereo(before:ChemicalDocument,after:ChemicalDocument,atoms:ReadonlyMap<string,string>,bonds:ReadonlyMap<string,string>):void{
  const remap=(refs:StereoBondOrdering)=>refs.map(id=>id===null?null:bonds.get(id)??fail('展开时立体配体键映射缺失'))as StereoBondOrdering;
  const adjacent=new Map(Object.keys(before.graph.atoms).map(id=>[id,[]as typeof before.graph.bonds[string][]]));
  for(const bond of Object.values(before.graph.bonds))for(const id of bond.atoms)adjacent.get(id)!.push(bond);
  for(const atom of Object.values(before.graph.atoms)){
    const id=atoms.get(atom.id);if(!id||!after.graph.atoms[id])continue;
    const edges=adjacent.get(atom.id)!;
    const depicted=edges.some(b=>['wedge','hashed'].includes(before.depiction.bonds[b.id]?.style));
    const refs=atom.geometry?.bondOrdering??(depicted&&edges.length>=3&&edges.length<=4&&edges.every(b=>b.order===1)?[...edges.map(b=>b.id),...Array(4-edges.length).fill(null)]as StereoBondOrdering:undefined);
    if(refs&&tetrahedralSign(before,atom.id,refs)!==tetrahedralSign(after,id,remap(refs)))fail('展开会改变或压平原子构型；请先调整外部布局或内部端口，原文档未修改');
  }
  for(const bond of Object.values(before.graph.bonds)){
    const id=bonds.get(bond.id);if(!id||!after.graph.bonds[id]||bond.order!==2||before.depiction.bonds[bond.id]?.style==='wavy')continue;
    const pairs=bond.atoms.map(atom=>adjacent.get(atom)!.filter(b=>b.id!==bond.id).map(b=>b.id));
    const refs=bond.circularOrdering??(pairs.every(p=>p.length>=1&&p.length<=2)?pairs.flatMap(p=>[...p,...Array(2-p.length).fill(null)])as StereoBondOrdering:undefined);
    if(refs&&doubleSign(before,bond.id,refs)!==doubleSign(after,id,remap(refs)))fail('展开会改变或压平双键构型；请先调整布局，原文档未修改');
  }
}

/** Protect an existing, visible configuration during ordinary edits and drags. */
export function assertStereoEdit(before: ChemicalDocument, after: ChemicalDocument): void {
  for (const atom of Object.values(before.graph.atoms)) {
    if (!atom.geometry || !after.graph.atoms[atom.id]?.geometry || !same(atom.geometry, after.graph.atoms[atom.id].geometry)) continue;
    if (atom.geometry.bondOrdering.some(ref => ref !== null && (!after.graph.bonds[ref] || !same(before.graph.bonds[ref].atoms, after.graph.bonds[ref].atoms)))) continue;
    const old = tetrahedralSign(before, atom.id, atom.geometry.bondOrdering);
    if (old && tetrahedralSign(after, atom.id, atom.geometry.bondOrdering) !== old) fail('此编辑会改变或压平已记录的四面体构型；请使用“反转构型”，或先清除几何约束');
  }
  for (const bond of Object.values(before.graph.bonds)) {
    const now = after.graph.bonds[bond.id];
    if (!bond.circularOrdering || !now?.circularOrdering || !same(bond.circularOrdering, now.circularOrdering) || !same(bond.atoms, now.atoms)) continue;
    if (bond.circularOrdering.some(ref => ref !== null && !after.graph.bonds[ref])) continue;
    const old = doubleSign(before, bond.id, bond.circularOrdering);
    if (old && doubleSign(after, bond.id, bond.circularOrdering) !== old) fail('此编辑会改变或压平已记录的双键构型；请使用“反转双键构型”，或先清除连接顺序');
  }
}

/** Invert geometry and owned wedge depiction as one atomic operation. */
export function invertAtomStereo(doc: ChemicalDocument, atomId: string): void {
  const atom = doc.graph.atoms[atomId];
  if (!atom.geometry) fail('该原子没有四面体几何约束');
  if (atom.geometry.type === 'axial') fail('轴手性可编辑配体顺序；自动轴反转尚未实现');
  const wedges = Object.entries(doc.depiction.bonds).filter(([, d]) => d.from === atomId && ['wedge', 'hashed'].includes(d.style));
  if (!wedges.length) fail('需要至少一条以该原子为尖端的实／虚楔键，才能同步反转二维构型');
  if (wedges.some(([id]) => doc.graph.atoms[other(doc, id, atomId)].geometry)) fail('共享立体键的自动反转尚未实现，请改用非共享楔键');
  const list = atom.geometry.bondOrdering; [list[2], list[3]] = [list[3], list[2]];
  for (const [, d] of wedges) d.style = d.style === 'wedge' ? 'hashed' : 'wedge';
}

/** Reflect one acyclic side of a double bond and update its circular ordering. */
export function invertDoubleStereo(doc: ChemicalDocument, bondId: string): void {
  const bond = doc.graph.bonds[bondId];
  if (bond.order !== 2) fail('只有普通双键可以执行此构型反转；部分双键的环周顺序可单独编辑');
  if (!bond.circularOrdering || !bond.circularOrdering.slice(0, 2).some(Boolean) || !bond.circularOrdering.slice(2).some(Boolean)) fail('双键两端必须有已记录的连接顺序');
  const seen = new Set([bond.atoms[1]]), stack = [bond.atoms[1]];
  while (stack.length) {
    const id = stack.pop()!;
    for (const b of Object.values(doc.graph.bonds)) if (b.id !== bondId && b.atoms.includes(id)) {
      const next = other(doc, b.id, id);
      if (next === bond.atoms[0]) fail('环内双键不能通过局部镜像反转，需要专门的环布局处理');
      if (!seen.has(next)) { seen.add(next); stack.push(next); }
    }
  }
  const a = doc.depiction.positions[bond.atoms[0]], b = doc.depiction.positions[bond.atoms[1]], dx = b.x - a.x, dy = b.y - a.y;
  const length2 = dx * dx + dy * dy; if (length2 < 1e-16) fail('双键端点重合，不能反转构型');
  for (const id of seen) { const p = doc.depiction.positions[id], x = p.x - b.x, y = p.y - b.y, t = (x * dx + y * dy) / length2; p.x = b.x + 2 * t * dx - x; p.y = b.y + 2 * t * dy - y; }
  reflectWedges(doc, seen);
  const refs = bond.circularOrdering; [refs[2], refs[3]] = [refs[3], refs[2]];
}

/** A complete reflection with swapped wedge depth retains the original 3D handedness. */
export function reflectWedges(doc: ChemicalDocument, atomIds: Set<string>): void {
  for (const [id, d] of Object.entries(doc.depiction.bonds)) {
    if (doc.graph.bonds[id].atoms.every(a => atomIds.has(a)) && ['wedge', 'hashed'].includes(d.style)) d.style = d.style === 'wedge' ? 'hashed' : 'wedge';
  }
}

/** Define a clockwise circular sequence from the current 2D drawing. */
export function circularOrderingFromDrawing(doc: ChemicalDocument, bondId: string): StereoBondOrdering {
  const bond = doc.graph.bonds[bondId]; if (!bond || bond.order !== 2) return fail('请选择双键');
  const [a, b] = bond.atoms.map(id => doc.depiction.positions[id]), dx = b.x - a.x, dy = b.y - a.y;
  if (Math.hypot(dx, dy) < 1e-8) fail('双键端点重合，无法确定连接顺序');
  const result: StereoBondOrdering = [null, null, null, null];
  for (let side = 0; side < 2; side++) {
    const center = side ? b : a;
    for (const otherBond of Object.values(doc.graph.bonds)) if (otherBond.id !== bondId && otherBond.atoms.includes(bond.atoms[side])) {
      const p = doc.depiction.positions[other(doc, otherBond.id, bond.atoms[side])], cross = dx * (p.y - center.y) - dy * (p.x - center.x);
      if (Math.abs(cross) < 1e-9) fail('相邻键与双键共线，无法确定连接顺序');
      const slot = side * 2 + ((cross > 0) === (side === 0) ? 0 : 1);
      if (result[slot]) fail('同一侧相邻键重叠，请先调整布局');
      result[slot] = otherBond.id;
    }
  }
  return result;
}
