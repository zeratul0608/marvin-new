import { hydrogenCount, neighbors } from '../core/model';
import type { AtomId, ChemicalDocument } from '../core/types';
import { escapeXml } from '../formats/shared';
const sub = (n: number) => String(n).replace(/\d/g, c => '₀₁₂₃₄₅₆₇₈₉'[Number(c)]);
const colors: Record<string, string> = { O: '#d34f56', N: '#4273bf', S: '#b88a23', P: '#bc743c', F: '#32855c', Cl: '#32855c', Br: '#a24f39', I: '#8a5faa' };
export function atomLabel(doc: ChemicalDocument, atomId: AtomId): string {
  const a = doc.graph.atoms[atomId];
  if (a.element === 'C' && neighbors(doc, atomId).length > 0 && !a.charge && !a.isotope) return '';
  const h = hydrogenCount(doc, atomId);
  if (!h || a.element === 'H') return a.element;
  const suffix = `H${h > 1 ? sub(h) : ''}`;
  const p = doc.depiction.positions[atomId], near = neighbors(doc, atomId);
  const left = near.length === 1 && doc.depiction.positions[near[0]].x > p.x + .25;
  return left ? suffix + a.element : a.element + suffix;
}
export function moleculeMarkup(doc: ChemicalDocument, selection = new Set<string>(), selectedBond?: string): string {
  const bonds = Object.values(doc.graph.bonds).map(b => {
    let [aid, bid] = b.atoms;
    const depiction = doc.depiction.bonds[b.id];
    if (depiction?.from === bid) [aid, bid] = [bid, aid];
    const start = doc.depiction.positions[aid], end = doc.depiction.positions[bid];
    const dx = end.x - start.x, dy = -end.y + start.y, length = Math.hypot(dx, dy);
    if (length < .01) return '';
    const ux = dx / length, uy = dy / length, nx = -uy, ny = ux;
    const trimA = atomLabel(doc, aid) ? Math.min(.31, length * .22) : 0, trimB = atomLabel(doc, bid) ? Math.min(.31, length * .22) : 0;
    const x1 = start.x + ux * trimA, y1 = -start.y + uy * trimA, x2 = end.x - ux * trimB, y2 = -end.y - uy * trimB;
    const line = (offset: number, dashed = false) => `<line x1="${x1 + nx * offset}" y1="${y1 + ny * offset}" x2="${x2 + nx * offset}" y2="${y2 + ny * offset}"${dashed ? ' stroke-dasharray=".12 .12"' : ''}/>`;
    let shape = '';
    if (depiction?.style === 'wedge') shape = `<path d="M${x1} ${y1} L${x2 + nx * .16} ${y2 + ny * .16} L${x2 - nx * .16} ${y2 - ny * .16} Z" fill="currentColor" stroke="none"/>`;
    else if (depiction?.style === 'hashed') {
      for (let i = 1; i <= 8; i++) {
        const t = i / 9, cx = x1 + (x2 - x1) * t, cy = y1 + (y2 - y1) * t;
        shape += `<line x1="${cx - nx * .16 * t}" y1="${cy - ny * .16 * t}" x2="${cx + nx * .16 * t}" y2="${cy + ny * .16 * t}"/>`;
      }
    } else if (depiction?.style === 'wavy') {
      const count = 20;
      shape = `<path d="${Array.from({ length: count + 1 }, (_, i) => { const t = i / count, d = Math.sin(t * Math.PI * 8) * .07; return `${i ? 'L' : 'M'}${x1 + (x2 - x1) * t + nx * d} ${y1 + (y2 - y1) * t + ny * d}`; }).join(' ')}"/>`;
    } else if (b.order === 2) shape = line(-.085) + line(.085);
    else if (b.order === 3) shape = line(-.13) + line(0) + line(.13);
    else if (b.order === 'aromatic') shape = line(-.075) + line(.075, true);
    else shape = line(0);
    const selected = b.id === selectedBond || b.atoms.every(a => selection.has(a));
    return `<g data-bond="${escapeXml(b.id)}" class="bond${selected ? ' selected' : ''}" style="color:${selected ? '#178377' : '#303a43'}"><line class="bond-hit" x1="${start.x}" y1="${-start.y}" x2="${end.x}" y2="${-end.y}" stroke="transparent" stroke-width=".4"/>${shape}</g>`;
  }).join('');
  const atoms = Object.values(doc.graph.atoms).map(a => {
    const p = doc.depiction.positions[a.id], label = atomLabel(doc, a.id);
    const charge = a.charge ? `${Math.abs(a.charge) > 1 ? Math.abs(a.charge) : ''}${a.charge > 0 ? '+' : '−'}` : '';
    return `<g data-atom="${escapeXml(a.id)}" class="atom${selection.has(a.id) ? ' selected' : ''}">${selection.has(a.id) ? `<circle cx="${p.x}" cy="${-p.y}" r=".38" fill="#d8eee8" stroke="#65afa2" stroke-width=".025"/>` : ''}<circle class="atom-hit" cx="${p.x}" cy="${-p.y}" r=".27" fill="transparent" stroke="none"/>${label ? `<text x="${p.x}" y="${-p.y}" fill="${colors[a.element] ?? '#303a43'}" class="atom-label">${escapeXml(label)}</text>` : ''}${a.isotope ? `<text class="superscript" x="${p.x - .35}" y="${-p.y - .23}" text-anchor="end">${a.isotope}</text>` : ''}${charge ? `<text class="superscript" x="${p.x + (label.length > 1 ? .46 : .24)}" y="${-p.y - .28}">${charge}</text>` : ''}${a.atomMap ? `<text class="mapping" x="${p.x}" y="${-p.y + .47}">[${a.atomMap}]</text>` : ''}</g>`;
  }).join('');
  return bonds + atoms;
}
export const svgDrawingStyle = `.bond{fill:none;stroke:currentColor;stroke-width:.045;stroke-linecap:round;stroke-linejoin:round}.atom-label{font:500 .43px Arial,sans-serif;text-anchor:middle;dominant-baseline:central;stroke:#fff;stroke-width:.105;paint-order:stroke;stroke-linejoin:round;pointer-events:none}.superscript{font:500 .23px Arial,sans-serif;fill:#303a43;stroke:#fff;stroke-width:.08;paint-order:stroke;pointer-events:none}.mapping{font:.2px Arial,sans-serif;fill:#8c949c;text-anchor:middle;pointer-events:none}`;
export function documentBounds(doc: ChemicalDocument) {
  const p = Object.values(doc.depiction.positions);
  if (!p.length) return { x: -6, y: -4, width: 12, height: 8 };
  const xs = p.map(p => p.x), ys = p.map(p => -p.y);
  const minX = Math.min(...xs) - 1, minY = Math.min(...ys) - 1;
  return { x: minX, y: minY, width: Math.max(3, Math.max(...xs) - minX + 1), height: Math.max(3, Math.max(...ys) - minY + 1) };
}
export function exportSvg(doc: ChemicalDocument): string {
  const box = documentBounds(doc);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.x} ${box.y} ${box.width} ${box.height}" width="${Math.round(box.width * 70)}" height="${Math.round(box.height * 70)}" role="img" aria-label="${escapeXml(doc.title)}"><style>${svgDrawingStyle}</style>${moleculeMarkup(doc)}</svg>`;
}
