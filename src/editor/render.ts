import { hydrogenCount, neighbors } from '../core/model';
import type { AtomId, ChemicalDocument } from '../core/types';
import { escapeXml } from '../formats/shared';
import { queryLabel, chemicalSymbol } from '../core/query';
import { drawingMarkup, drawingPoints } from './drawing-render';
import { expandedBoundaryMarkup, expandedSubstructureLayout, expandedSubstructuresMarkup, expandedSubstructureStyle } from './expanded-substructures';
import {queryConstraintMarkup,queryConstraintStyle} from './query-inspector';
const sub = (n: number) => String(n).replace(/\d/g, c => '₀₁₂₃₄₅₆₇₈₉'[Number(c)]);
const colors: Record<string, string> = { O: '#d34f56', N: '#4273bf', S: '#b88a23', P: '#bc743c', F: '#32855c', Cl: '#32855c', Br: '#a24f39', I: '#8a5faa' };
export function atomLabel(doc: ChemicalDocument, atomId: AtomId): string {
  const a = doc.graph.atoms[atomId];
  if (a.namedFragment || a.multiAttachment) return chemicalSymbol(a);
  if (a.substructure) return a.substructure.label;
  if (a.query) return queryLabel(a.query);
  if (a.attachment) return chemicalSymbol(a);
  if (a.element === 'C' && neighbors(doc, atomId).length > 0 && !a.charge && !a.isotope && !a.radical) return '';
  const h = hydrogenCount(doc, atomId);
  if (!h || a.element === 'H') return a.element;
  const suffix = `H${h > 1 ? sub(h) : ''}`;
  const p = doc.depiction.positions[atomId], near = neighbors(doc, atomId);
  const left = near.length === 1 && doc.depiction.positions[near[0]].x > p.x + .25;
  return left ? suffix + a.element : a.element + suffix;
}
function baseMoleculeMarkup(doc: ChemicalDocument, selection = new Set<string>(), selectedBond?: string, selectedDrawing?: string): string {
  const orderedBonds = Object.values(doc.graph.bonds).sort((a, b) => (doc.depiction.bonds[a.id]?.layer ?? 0) - (doc.depiction.bonds[b.id]?.layer ?? 0));
  const bonds = orderedBonds.map((b, index) => {
    let [aid, bid] = b.atoms;
    const depiction = doc.depiction.bonds[b.id];
    if (depiction?.from === bid) [aid, bid] = [bid, aid];
    const start = doc.depiction.positions[aid], end = doc.depiction.positions[bid];
    const dx = end.x - start.x, dy = -end.y + start.y, length = Math.hypot(dx, dy);
    if (length < .01) return `<g data-bond="${escapeXml(b.id)}" class="bond${b.id === selectedBond ? ' selected' : ''}" style="color:#303a43"><circle class="bond-hit" cx="${start.x}" cy="${-start.y}" r=".2" fill="transparent" stroke="transparent"/><circle cx="${start.x}" cy="${-start.y}" r=".06" fill="currentColor" stroke="none"><title>重合端点的键</title></circle></g>`;
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
    } else if (depiction?.style === 'hash') {
      for (let i = 1; i <= 8; i++) { const t = i / 9, cx = x1 + (x2 - x1) * t, cy = y1 + (y2 - y1) * t; shape += `<line x1="${cx - nx * .12}" y1="${cy - ny * .12}" x2="${cx + nx * .12}" y2="${cy + ny * .12}"/>`; }
    } else if (depiction?.style === 'dashed') shape = line(0, true);
    else if (depiction?.style === 'bold') shape = `<g stroke-width=".13">${line(0)}</g>`;
    else if (b.order === 2) shape = depiction?.doublePosition === 'left' ? line(0) + line(-.17) : depiction?.doublePosition === 'right' ? line(0) + line(.17) : line(-.085) + line(.085);
    else if (b.order === 3) shape = line(-.13) + line(0) + line(.13);
    else if (b.order === 'aromatic') shape = line(-.075) + line(.075, true);
    else if (b.order === 2.5) shape = line(-.13) + line(0) + line(.13, true);
    else if (b.order === 'any') shape = `<path d="M${x1} ${y1} L${x2} ${y2}" stroke-dasharray=".04 .1"/><text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - .12}" class="mapping">?</text>`;
    else shape = line(0);
    // Resolve actual segment intersections in drawing order. Crossing is not an atom.
    let bridges = '';
    for (const lower of orderedBonds.slice(0, index)) {
      if (lower.atoms.some(id => b.atoms.includes(id))) continue;
      const [c, d] = lower.atoms.map(id => doc.depiction.positions[id]);
      const rx = end.x - start.x, ry = end.y - start.y, sx = d.x - c.x, sy = d.y - c.y, determinant = rx * sy - ry * sx;
      if (Math.abs(determinant) < 1e-10) continue;
      const qx = c.x - start.x, qy = c.y - start.y, t = (qx * sy - qy * sx) / determinant, u = (qx * ry - qy * rx) / determinant;
      if (t > .01 && t < .99 && u > .01 && u < .99) bridges += `<circle data-crossing="${escapeXml(lower.id)}" cx="${start.x + rx * t}" cy="${-start.y - ry * t}" r=".115" fill="white" stroke="none"/>`;
    }
    const selected = b.id === selectedBond || b.atoms.every(a => selection.has(a));
    return `<g data-bond="${escapeXml(b.id)}" class="bond${selected ? ' selected' : ''}" style="color:${selected ? '#178377' : '#303a43'}"><line class="bond-hit" x1="${start.x}" y1="${-start.y}" x2="${end.x}" y2="${-end.y}" stroke="transparent" stroke-width=".4"/>${bridges}${shape}</g>`;
  }).join('');
  const atoms = Object.values(doc.graph.atoms).map(a => {
    const p = doc.depiction.positions[a.id], label = atomLabel(doc, a.id);
    const charge = a.charge ? `${Math.abs(a.charge) > 1 ? Math.abs(a.charge) : ''}${a.charge > 0 ? '+' : '−'}` : '';
    return `<g data-atom="${escapeXml(a.id)}" class="atom${selection.has(a.id) ? ' selected' : ''}">${selection.has(a.id) ? `<circle cx="${p.x}" cy="${-p.y}" r=".38" fill="#d8eee8" stroke="#65afa2" stroke-width=".025"/>` : ''}<circle class="atom-hit" cx="${p.x}" cy="${-p.y}" r=".27" fill="transparent" stroke="none"/>${label ? `<text x="${p.x}" y="${-p.y}" fill="${colors[a.element] ?? '#303a43'}" class="atom-label">${escapeXml(label)}</text>` : ''}${a.isotope ? `<text class="superscript" x="${p.x - .35}" y="${-p.y - .23}" text-anchor="end">${a.isotope}</text>` : ''}${charge ? `<text class="superscript" x="${p.x + (label.length > 1 ? .46 : .24)}" y="${-p.y - .28}">${charge}</text>` : ''}${a.atomMap ? `<text class="mapping" x="${p.x}" y="${-p.y + .47}">[${a.atomMap}]</text>` : ''}</g>`;
  }).join('');
  // Radical indicators are separate from charge and isotope labels.
  const radicals = Object.values(doc.graph.atoms).filter(a => a.radical).map(a => {
    const p = doc.depiction.positions[a.id];
    return `<text class="superscript" data-radical="${a.radical}" x="${p.x + .28}" y="${-p.y - .5}"><title>${['', '单重态', '双重态', '三重态'][a.radical!]}</title>${a.radical === 2 ? '•' : a.radical === 1 ? ':' : '••'}</text>`;
  }).join('');
  const stereoLabels = Object.values(doc.graph.atoms).filter(a => a.cipLabel).map(a => {
    const p = doc.depiction.positions[a.id];
    const angles = neighbors(doc,a.id).map(id=>{const q=doc.depiction.positions[id];return (Math.atan2(q.y-p.y,q.x-p.x)+2*Math.PI)%(2*Math.PI);}).sort((a,b)=>a-b);
    let direction=Math.PI/2,gap=0;
    angles.forEach((angle,i)=>{const next=angles[(i+1)%angles.length]+(i===angles.length-1?2*Math.PI:0);if(next-angle>gap){gap=next-angle;direction=(angle+next)/2;}});
    const radius=atomLabel(doc,a.id)?.68:.46;
    return `<text class="cip-label" data-cip-atom="${escapeXml(a.id)}" x="${p.x+radius*Math.cos(direction)}" y="${-p.y-radius*Math.sin(direction)}">(${escapeXml(a.cipLabel!)})</text>`;
  }).join('') + Object.values(doc.graph.bonds).filter(b => b.cipLabel).map(b => {
    const [a,c]=b.atoms.map(id=>doc.depiction.positions[id]),dx=c.x-a.x,dy=c.y-a.y,length=Math.hypot(dx,dy)||1;
    return `<text class="cip-label" data-cip-bond="${escapeXml(b.id)}" x="${(a.x+c.x)/2-dy/length*.32}" y="${-(a.y+c.y)/2-dx/length*.32}">(${escapeXml(b.cipLabel!)})</text>`;
  }).join('');
  return drawingMarkup(doc, selectedDrawing) + bonds + atoms + radicals + stereoLabels + queryConstraintMarkup(doc);
}
export function moleculeMarkup(doc: ChemicalDocument, selection = new Set<string>(), selectedBond?: string, selectedDrawing?: string): string {
  return baseMoleculeMarkup(doc, selection, selectedBond, selectedDrawing) + expandedBoundaryMarkup(doc) + expandedSubstructuresMarkup(expandedSubstructureLayout(doc, baseDocumentBounds), baseMoleculeMarkup, selection);
}
export const svgDrawingStyle = `.bond{fill:none;stroke:currentColor;stroke-width:.045;stroke-linecap:round;stroke-linejoin:round}.atom-label{font:500 .43px Arial,sans-serif;text-anchor:middle;dominant-baseline:central;stroke:#fff;stroke-width:.105;paint-order:stroke;stroke-linejoin:round;pointer-events:none}.superscript{font:500 .23px Arial,sans-serif;fill:#303a43;stroke:#fff;stroke-width:.08;paint-order:stroke;pointer-events:none}.mapping{font:.2px Arial,sans-serif;fill:#8c949c;text-anchor:middle;pointer-events:none}.cip-label{font:italic .21px Arial,sans-serif;fill:#51677d;text-anchor:middle;dominant-baseline:central;stroke:white;stroke-width:.07;paint-order:stroke;pointer-events:none}` + expandedSubstructureStyle + queryConstraintStyle;
function baseDocumentBounds(doc: ChemicalDocument) {
  const p = [...Object.values(doc.depiction.positions), ...Object.values(doc.depiction.objects ?? {}).flatMap(o => drawingPoints(o).map(p => ({x:p.x,y:-p.y})))];
  if (!p.length) return { x: -6, y: -4, width: 12, height: 8 };
  // Long nested labels are chemical content too. Include their full text extent
  // before placing adjacent cards or fitting a child SVG viewport.
  for (const atom of Object.values(doc.graph.atoms)) {
    const label = atomLabel(doc, atom.id), position = doc.depiction.positions[atom.id];
    if (label.length > 4) {
      const radius = Array.from(label).reduce((width, char) => width + (/[\u0000-\u00ff]/.test(char) ? .22 : .24), 0);
      p.push({x:position.x-radius,y:position.y}, {x:position.x+radius,y:position.y});
    }
  }
  for (const object of Object.values(doc.depiction.objects ?? {})) if (object.tag === 't' && object.runs?.length) {
    const anchor = object.geometry.p ?? object.geometry.xyz ?? object.geometry.BoundingBox?.slice(0, 2);
    if (!anchor) continue;
    let width = 0, height = 0, firstLine = 0;
    for (const run of object.runs) {
      const size = Number(run.attributes.size ?? doc.depiction.style?.attributes.CaptionSize ?? 10) / 20;
      const lines = run.text.split(/\r\n|\r|\n/);
      width += Math.max(...lines.map(line => Array.from(line).length)) * size;
      height += (lines.length - 1) * size * 1.25; firstLine = Math.max(firstLine, size);
    }
    p.push({x:anchor[0]/20,y:-anchor[1]/20+firstLine}, {x:anchor[0]/20+width,y:-anchor[1]/20-height});
  }
  const xs = p.map(p => p.x), ys = p.map(p => -p.y);
  const minX = Math.min(...xs) - 1, minY = Math.min(...ys) - 1;
  return { x: minX, y: minY, width: Math.max(3, Math.max(...xs) - minX + 1), height: Math.max(3, Math.max(...ys) - minY + 1) };
}
export function documentBounds(doc: ChemicalDocument) {
  const base = baseDocumentBounds(doc), expanded = expandedSubstructureLayout(doc, baseDocumentBounds).bounds;
  if (!expanded) return base;
  const x = Math.min(base.x, expanded.x - .2), y = Math.min(base.y, expanded.y - .2);
  return { x, y, width: Math.max(base.x + base.width, expanded.x + expanded.width + .2) - x, height: Math.max(base.y + base.height, expanded.y + expanded.height + .2) - y };
}
export function exportSvg(doc: ChemicalDocument): string {
  const box = documentBounds(doc);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.x} ${box.y} ${box.width} ${box.height}" width="${Math.round(box.width * 70)}" height="${Math.round(box.height * 70)}" role="img" aria-label="${escapeXml(doc.title)}"><style>${svgDrawingStyle}</style>${moleculeMarkup(doc)}</svg>`;
}
