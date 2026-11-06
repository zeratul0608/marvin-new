import type { Atom, ChemicalDocument } from '../core/types';
import { escapeXml as esc } from '../formats/shared';

export interface SvgBounds { x: number; y: number; width: number; height: number }
export interface ExpandedFragmentLocation { atomId: string; fragment: number }
export interface ExpandedStructureCard extends SvgBounds {
  document: ChemicalDocument;
  wrapper: Atom;
  fragment: number;
  path: ExpandedFragmentLocation[];
  contentBounds: SvgBounds;
  contentHeight: number;
  header: string[];
  footer: string[];
  headerHeight: number;
  portNumbers: Map<string, number>;
  limited: boolean;
}
export interface ExpandedStructureLayout { cards: ExpandedStructureCard[]; bounds?: SvgBounds }
const gap = .6, padding = .45, lineHeight = .39, maxDepth = 16;
const expanded = (atom: Atom) => atom.substructure?.display === 'expanded';

function wrap(text: string, width: number): string[] {
  // Count full-width glyphs conservatively; long source labels must stay inside
  // their own card rather than covering the next candidate.
  const limit = Math.max(8, (width - padding * 2) / .29), result: string[] = [];
  let line = '', length = 0;
  for (const char of text) {
    const size = /[\u0000-\u00ff]/.test(char) ? .6 : 1;
    if (length + size > limit && line) { result.push(line); line = ''; length = 0; }
    line += char; length += size;
  }
  if (line || !result.length) result.push(line);
  return result;
}

/** A separate shelf of real child graphs; alternatives never share a graph. */
export function expandedSubstructureLayout(doc: ChemicalDocument, bounds: (doc: ChemicalDocument) => SvgBounds): ExpandedStructureLayout {
  const base = bounds(doc), available = Math.max(18, Math.min(36, base.width));
  const cards: ExpandedStructureCard[] = [];
  const collect = (parent: ChemicalDocument, path: ExpandedFragmentLocation[], ancestors: Set<ChemicalDocument>) => {
    for (const wrapper of Object.values(parent.graph.atoms)) {
      const group = wrapper.substructure;
      if (!group || !expanded(wrapper)) continue;
      group.fragments.forEach((fragment, index) => {
        const child = fragment.document, next = [...path, { atomId: wrapper.id, fragment: index }];
        const cyclic = ancestors.has(child), limited = cyclic || next.length >= maxDepth;
        // Invalid cyclic graphs are guarded here as well as by model validation.
        // The card remains visible, with a note instead of infinite recursion.
        const contentBounds = bounds(child), width = Math.min(available, Math.max(7.8, contentBounds.width + padding * 2));
        const scale = Math.min(1, (width - padding * 2) / contentBounds.width);
        const portNumbers = new Map(fragment.attachmentOrder.map((id, i) => [id, child.graph.atoms[id]?.attachmentIndex ?? i + 1]));
        for (const atom of Object.values(child.graph.atoms)) if (atom.attachment && !portNumbers.has(atom.id)) portNumbers.set(atom.id, atom.attachmentIndex ?? portNumbers.size + 1);
        const mappings = group.connections.filter(p => p.fragment === index).map(p => `外键 B${Object.keys(parent.graph.bonds).indexOf(p.bondId) + 1} → 端口 P${portNumbers.get(p.atomId) ?? '?'}`);
        const unbound = [...portNumbers].filter(([id]) => !group.connections.some(p => p.fragment === index && p.atomId === id)).map(([, n]) => `P${n}`);
        const annotation = [wrapper.charge ? `整体电荷 ${wrapper.charge > 0 ? '+' : ''}${wrapper.charge}` : '', wrapper.atomMap ? `整体映射 [${wrapper.atomMap}]` : '', wrapper.connectionType && wrapper.connectionType !== 'Unspecified' ? wrapper.connectionType : ''].filter(Boolean).join(' · ');
        const header = [
          ...wrap(`${group.label}${wrapper.residueId ? ` · 残基 ${wrapper.residueId}` : ''}`, width),
          ...wrap(`${group.kind === 'alternatives' ? '备选' : '片段'} ${index + 1}/${group.fragments.length}${path.length ? ` · 内层 ${next.length}` : ''} · ${Object.keys(child.graph.atoms).length} 节点 / ${Object.keys(child.graph.bonds).length} 键`, width),
          ...(annotation ? wrap(annotation, width) : []),
        ];
        const footer = [
          ...wrap(mappings.length ? mappings.join('；') : '此片段没有绑定的外部键', width),
          ...(unbound.length ? wrap(`未绑定端口 ${unbound.join('、')}（菱形保留）`, width) : []),
          ...wrap('点击结构中的原子或键编辑此片段', width),
          ...(limited && Object.values(child.graph.atoms).some(expanded) ? wrap('更深层展开已暂停；可进入片段继续编辑', width) : []),
        ];
        const headerHeight = header.length * lineHeight + padding * 1.5, contentHeight = Math.max(2.5, contentBounds.height * scale);
        cards.push({ x: 0, y: 0, width, height: headerHeight + contentHeight + footer.length * lineHeight + padding * 1.5, document: child, wrapper, fragment: index, path: next, contentBounds, contentHeight, header, footer, headerHeight, portNumbers, limited });
        if (!limited) collect(child, next, new Set([...ancestors, child]));
      });
    }
  };
  collect(doc, [], new Set([doc]));
  if (!cards.length) return { cards };
  let x = base.x, y = base.y + base.height + .8, rowHeight = 0;
  for (const card of cards) {
    if (x > base.x && x + card.width > base.x + available + 1e-8) { x = base.x; y += rowHeight + gap; rowHeight = 0; }
    card.x = x; card.y = y; x += card.width + gap; rowHeight = Math.max(rowHeight, card.height);
  }
  return { cards, bounds: { x: base.x, y: cards[0].y, width: Math.max(...cards.map(c => c.x + c.width)) - base.x, height: Math.max(...cards.map(c => c.y + c.height)) - cards[0].y } };
}

/** Number the visible parent bonds using the same B numbers shown in the cards. */
export function expandedBoundaryMarkup(doc: ChemicalDocument): string {
  const bonds = Object.keys(doc.graph.bonds), used = new Set<string>();
  return Object.values(doc.graph.atoms).filter(expanded).flatMap(atom => atom.substructure!.connections.map(port => {
    if (used.has(port.bondId)) return ''; used.add(port.bondId);
    const bond = doc.graph.bonds[port.bondId]; if (!bond) return '';
    const [a, b] = bond.atoms.map(id => doc.depiction.positions[id]);
    const x = (a.x + b.x) / 2, y = -(a.y + b.y) / 2 - .28;
    return `<text class="expanded-port-label" data-expanded-boundary="${esc(port.bondId)}" x="${x}" y="${y}">B${bonds.indexOf(port.bondId) + 1}</text>`;
  })).join('');
}

export function expandedSubstructuresMarkup(layout: ExpandedStructureLayout, renderGraph: (doc: ChemicalDocument) => string, selected = new Set<string>()): string {
  return layout.cards.map(card => {
    const root = card.path[0], route = `data-expanded-wrapper="${esc(root.atomId)}" data-expanded-fragment="${root.fragment}" data-expanded-path="${esc(JSON.stringify(card.path))}"`;
    // Child-local IDs can collide with root IDs. Strip every root event selector,
    // including native drawings, and attach the complete hierarchy to each hit.
    const graph = renderGraph(card.document).replace(/\bdata-(atom|bond|drawing)="([^"]*)"/g, (_match, kind: string, id: string) => `data-expanded-${kind}="${id}" ${route}`);
    const header = card.header.map((line, i) => `<text class="expanded-card-text${i === 0 ? ' expanded-card-title' : ''}" x="${card.x + padding}" y="${card.y + padding + .19 + i * lineHeight}">${esc(line)}</text>`).join('');
    const footerY = card.y + card.headerHeight + card.contentHeight + .3;
    const footer = card.footer.map((line, i) => `<text class="expanded-card-text" x="${card.x + padding}" y="${footerY + i * lineHeight}">${esc(line)}</text>`).join('');
    const portLabels = [...card.portNumbers].map(([id, n]) => {
      const p = card.document.depiction.positions[id]; if (!p) return '';
      return `<text class="expanded-port-label" data-expanded-port="${esc(id)}" x="${p.x + .42}" y="${-p.y - .32}">P${n}</text>`;
    }).join('');
    const box = card.contentBounds;
    return `<g data-expanded-card="true" ${route}><rect class="expanded-card-background${selected.has(root.atomId) ? ' expanded-card-selected' : ''}" x="${card.x}" y="${card.y}" width="${card.width}" height="${card.height}" rx=".16"/>${header}<svg x="${card.x + padding}" y="${card.y + card.headerHeight}" width="${card.width - padding * 2}" height="${card.contentHeight}" viewBox="${box.x} ${box.y} ${box.width} ${box.height}" preserveAspectRatio="xMidYMid meet" overflow="hidden">${graph}${expandedBoundaryMarkup(card.document)}${portLabels}</svg>${footer}</g>`;
  }).join('');
}

export const expandedSubstructureStyle = `.expanded-card-background{fill:#fbfdfd;stroke:#b5c9c8;stroke-width:.025}.expanded-card-selected{stroke:#178377;stroke-width:.045}.expanded-card-text{font:.25px Arial,sans-serif;fill:#52656c;text-anchor:start;pointer-events:none}.expanded-card-title{font-size:.29px;font-weight:600;fill:#243d46}.expanded-port-label{font:600 .21px Arial,sans-serif;fill:#267c76;text-anchor:middle;stroke:white;stroke-width:.1;paint-order:stroke;pointer-events:none}[data-expanded-atom],[data-expanded-bond],[data-expanded-drawing]{cursor:pointer}`;
