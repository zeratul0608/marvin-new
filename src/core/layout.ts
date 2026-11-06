import { connectedComponents } from './model';
import type { ChemicalDocument } from './types';

export type LayoutAction = 'arrange-row' | 'arrange-column' | 'arrange-circle' | 'normalize-bond-length';
export const layoutActions: Record<LayoutAction, string> = {
  'arrange-row': '片段横向排列', 'arrange-column': '片段纵向排列',
  'arrange-circle': '片段环形排列', 'normalize-bond-length': '统一键长（等比例）',
};

/** Translate whole connected fragments or scale each uniformly. Never alter chemistry or ring angles. */
export function layoutAtoms(doc: ChemicalDocument, atomIds: string[], action: LayoutAction): void {
  if (!Object.hasOwn(layoutActions, action)) throw new Error('结构排版方式无效');
  if (!Array.isArray(atomIds) || atomIds.some(id => !Object.hasOwn(doc.graph.atoms, id))) throw new Error('结构排版选区无效');
  const selected = new Set(atomIds.length ? atomIds : Object.keys(doc.graph.atoms));
  const components = connectedComponents(doc).filter(ids => ids.some(id => selected.has(id)));
  if (components.some(ids => ids.some(id => !selected.has(id)))) throw new Error('请选中完整片段后排版，避免拉断相连的结构；清空选区可作用于全部片段');
  const groups = components.map(ids => {
    const points = ids.map(id => doc.depiction.positions[id]);
    const minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x));
    const minY = Math.min(...points.map(p => p.y)), maxY = Math.max(...points.map(p => p.y));
    return { ids, points, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, width: maxX - minX, height: maxY - minY, radius: Math.hypot(maxX - minX, maxY - minY) / 2 };
  });
  if (!groups.length) return;
  if (action === 'normalize-bond-length') {
    for (const group of groups) {
      const ids = new Set(group.ids);
      const lengths = Object.values(doc.graph.bonds).filter(b => ids.has(b.atoms[0])).map(b => { const a = doc.depiction.positions[b.atoms[0]], c = doc.depiction.positions[b.atoms[1]]; return Math.hypot(a.x - c.x, a.y - c.y); }).sort((a, b) => a - b);
      if (!lengths.length) continue;
      if (lengths[0] < 1e-8) throw new Error('存在重合的成键原子，请先分开后再统一键长');
      const median = (lengths[Math.floor((lengths.length - 1) / 2)] + lengths[Math.floor(lengths.length / 2)]) / 2;
      const scale = 1.5 / median;
      for (const p of group.points) { p.x = group.cx + (p.x - group.cx) * scale; p.y = group.cy + (p.y - group.cy) * scale; }
    }
    return;
  }
  if (groups.length === 1) return;
  const cx = groups.reduce((n, g) => n + g.cx / groups.length, 0), cy = groups.reduce((n, g) => n + g.cy / groups.length, 0);
  const vertical = action === 'arrange-column';
  const total = groups.reduce((n, g) => n + (vertical ? g.height : g.width), 0) + (groups.length - 1) * 2;
  let offset = (vertical ? cy : cx) - total / 2;
  const radius = (Math.max(...groups.map(g => g.radius)) + 1) / Math.sin(Math.PI / groups.length);
  groups.forEach((g, i) => {
    const angle = 2 * Math.PI * i / groups.length;
    const x = action === 'arrange-circle' ? cx + radius * Math.cos(angle) : vertical ? cx : offset + g.width / 2;
    const y = action === 'arrange-circle' ? cy + radius * Math.sin(angle) : vertical ? offset + g.height / 2 : cy;
    for (const p of g.points) { p.x += x - g.cx; p.y += y - g.cy; }
    offset += (vertical ? g.height : g.width) + 2;
  });
}
