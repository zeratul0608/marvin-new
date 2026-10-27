import type { AtomId, ChemicalDocument } from './types';

export type StructureTransform = 'rotate-left' | 'rotate-right' | 'mirror-horizontal' | 'mirror-vertical';

/** Transform the selected depiction around its centroid without changing graph identities. */
export function transformAtoms(doc: ChemicalDocument, ids: Iterable<AtomId>, transform: StructureTransform): void {
  const points = [...new Set(ids)].map(id => doc.depiction.positions[id]).filter(p => p !== undefined);
  if (!points.length) return;
  const center = points.reduce((sum, p) => ({ x: sum.x + p.x / points.length, y: sum.y + p.y / points.length }), { x: 0, y: 0 });
  const angle = (transform === 'rotate-left' ? 1 : -1) * Math.PI / 6;
  for (const p of points) {
    const x = p.x - center.x, y = p.y - center.y;
    if (transform === 'mirror-horizontal') { p.x = center.x - x; }
    else if (transform === 'mirror-vertical') { p.y = center.y - y; }
    else { p.x = center.x + x * Math.cos(angle) - y * Math.sin(angle); p.y = center.y + x * Math.sin(angle) + y * Math.cos(angle); }
  }
}
