import { describe, expect, it } from 'vitest';
import { addAtom, addBond, clone, emptyDocument } from '../src/core/model';
import type { ChemicalDocument } from '../src/core/types';
import { importDocument } from '../src/formats';
import { documentBounds, exportSvg, moleculeMarkup } from '../src/editor/render';
import { expandedSubstructureLayout } from '../src/editor/expanded-substructures';
import { abbreviationXml, recursiveAbbreviationXml, twoPortXml } from './fixtures/abbreviation-fixture';

const load = (raw = abbreviationXml) => importDocument({ data: raw }).document;
const wrapper = (doc: ChemicalDocument) => Object.values(doc.graph.atoms).find(a => a.substructure)!;
const svg = (doc: ChemicalDocument) => new DOMParser().parseFromString(exportSvg(doc), 'image/svg+xml');
const cards = (doc: ChemicalDocument) => [...svg(doc).querySelectorAll('[data-expanded-card]')];

describe('editable expanded child-graph rendering', () => {
  it('renders the actual graph, annotations and hit targets while retaining the root wrapper', () => {
    const doc = load(), atom = wrapper(doc), group = atom.substructure!;
    group.display = 'expanded'; atom.residueId = 17; atom.charge = 1; atom.atomMap = 9;
    const child = group.fragments[0].document, oxygen = Object.values(child.graph.atoms).find(a => a.element === 'O')!;
    oxygen.element = 'S'; oxygen.isotope = 34; oxygen.charge = -1;
    const before = clone(doc), root = svg(doc), card = root.querySelector('[data-expanded-card]')!;
    expect(root.querySelectorAll('[data-atom]')).toHaveLength(Object.keys(doc.graph.atoms).length);
    expect(root.querySelector(`[data-atom="${atom.id}"]`)).not.toBeNull();
    expect(card.querySelectorAll('[data-expanded-atom]')).toHaveLength(Object.keys(child.graph.atoms).length);
    expect(card.querySelectorAll('[data-expanded-bond]')).toHaveLength(Object.keys(child.graph.bonds).length);
    expect(card.querySelectorAll('.atom-hit')).toHaveLength(Object.keys(child.graph.atoms).length);
    expect(card.querySelectorAll('.bond-hit')).toHaveLength(Object.keys(child.graph.bonds).length);
    expect(card.querySelector('[data-atom], [data-bond], [data-drawing]')).toBeNull();
    expect(card.textContent).toContain('残基 17'); expect(card.textContent).toContain('整体电荷 +1'); expect(card.textContent).toContain('整体映射 [9]');
    expect(card.querySelector(`[data-expanded-atom="${oxygen.id}"]`)!.textContent).toContain('S');
    expect(card.querySelector(`[data-expanded-atom="${oxygen.id}"]`)!.textContent).toContain('34');
    expect(card.querySelector('image')).toBeNull(); expect(doc).toEqual(before);
  });

  it('shows every alternative separately, with numbered external bonds and real diamond ports', () => {
    const doc = load(twoPortXml), atom = wrapper(doc), group = atom.substructure!;
    group.display = 'expanded'; group.kind = 'alternatives'; group.fragments.push(clone(group.fragments[0]));
    const second = group.fragments[1].document, carbon = Object.values(second.graph.atoms).find(a => a.element === 'C')!;
    carbon.element = 'N';
    const root = svg(doc), panels = [...root.querySelectorAll('[data-expanded-card]')];
    expect(panels).toHaveLength(2);
    expect(panels[0].textContent).toContain('备选 1/2'); expect(panels[1].textContent).toContain('备选 2/2');
    expect(panels[0].textContent).toContain('外键 B1 → 端口 P1'); expect(panels[0].textContent).toContain('外键 B2 → 端口 P2');
    expect(panels[1].textContent).toContain('未绑定端口 P1、P2');
    expect(root.querySelectorAll('[data-expanded-boundary]')).toHaveLength(2);
    for (const panel of panels) {
      expect(panel.querySelectorAll('[data-expanded-port]')).toHaveLength(2);
      expect(panel.textContent).toContain('◆');
      expect(panel.querySelectorAll('[data-expanded-atom]')).toHaveLength(4);
    }
    expect(panels[1].querySelector(`[data-expanded-atom="${carbon.id}"]`)!.textContent).toContain('N');
  });

  it('wraps multiple cards into disjoint rows and includes their full rectangles in exported bounds', () => {
    const template = wrapper(load()).substructure!, doc = emptyDocument();
    for (let i = 0; i < 7; i++) addAtom(doc, '*', { x: i * 1.5, y: 0 }, { hydrogens: { mode: 'fixed', count: 0 }, substructure: { ...clone(template), display: 'expanded', connections: [] } });
    const root = svg(doc), boxes = [...root.querySelectorAll('.expanded-card-background')].map(el => ({ x: Number(el.getAttribute('x')), y: Number(el.getAttribute('y')), width: Number(el.getAttribute('width')), height: Number(el.getAttribute('height')) }));
    expect(boxes).toHaveLength(7); expect(new Set(boxes.map(box => box.y)).size).toBeGreaterThan(1);
    expect(boxes[0].y).toBe(boxes[1].y);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
    }
    const box = documentBounds(doc), view = root.documentElement.getAttribute('viewBox')!.split(' ').map(Number);
    expect(view).toEqual([box.x, box.y, box.width, box.height]);
    for (const card of boxes) { expect(card.x).toBeGreaterThanOrEqual(box.x); expect(card.y).toBeGreaterThanOrEqual(box.y); expect(card.x + card.width).toBeLessThan(box.x + box.width); expect(card.y + card.height).toBeLessThan(box.y + box.height); }
  });

  it('routes nested hits by full fragment paths even when child-local IDs collide', () => {
    const doc = load(recursiveAbbreviationXml), outer = wrapper(doc), group = outer.substructure!, first = group.fragments[0].document, inner = wrapper(first);
    group.display = 'expanded'; inner.substructure!.display = 'expanded';
    // Reuse a top-level ID inside the leaf document. This is legal namespace data.
    const leaf = inner.substructure!.fragments[0].document, old = Object.values(leaf.graph.atoms).find(a => a.element === 'O')!, collision = outer.id;
    leaf.graph.atoms[collision] = { ...old, id: collision }; delete leaf.graph.atoms[old.id]; leaf.depiction.positions[collision] = leaf.depiction.positions[old.id]; delete leaf.depiction.positions[old.id];
    for (const bond of Object.values(leaf.graph.bonds)) bond.atoms = bond.atoms.map(id => id === old.id ? collision : id) as [string, string];
    const root = svg(doc), panels = [...root.querySelectorAll('[data-expanded-card]')], hit = panels[1].querySelector(`[data-expanded-atom="${collision}"]`)!;
    expect(panels).toHaveLength(2);
    expect(JSON.parse(hit.getAttribute('data-expanded-path')!)).toEqual([{ atomId: outer.id, fragment: 0 }, { atomId: inner.id, fragment: 0 }]);
    expect(hit.getAttribute('data-expanded-wrapper')).toBe(outer.id); expect(hit.getAttribute('data-expanded-fragment')).toBe('0');
    expect(hit.hasAttribute('data-atom')).toBe(false); expect(root.querySelectorAll(`[data-atom="${collision}"]`)).toHaveLength(1);
    for (const panel of panels) for (const target of panel.querySelectorAll('[data-expanded-atom], [data-expanded-bond]')) expect(target.getAttribute('data-expanded-path')).toBe(panel.getAttribute('data-expanded-path'));
  });

  it('retargets native child drawing hits and safely escapes source labels', () => {
    const doc = load(), atom = wrapper(doc), group = atom.substructure!, child = group.fragments[0].document;
    group.display = 'expanded'; group.label = '<script>" & residue';
    child.depiction.objects = { note: { id: 'note', tag: 't', attributes: {}, geometry: { p: [0, 0] }, references: {}, atomIds: [], children: [], runs: [{ text: '<svg onload=alert(1)>', attributes: {} }] } };
    const output = exportSvg(doc), root = svg(doc), card = root.querySelector('[data-expanded-card]')!;
    expect(output).not.toContain('<script>'); expect(root.querySelector('script')).toBeNull();
    expect(card.querySelector('[data-expanded-drawing="note"]')).not.toBeNull(); expect(card.querySelector('[data-drawing]')).toBeNull();
    expect(card.textContent).toContain('<svg onload=alert(1)>');
    expect(JSON.parse(card.getAttribute('data-expanded-path')!)).toEqual([{ atomId: atom.id, fragment: 0 }]);
  });

  it('keeps collapsed documents compact and retains hit targets for coincident bond endpoints', () => {
    const doc = load(), atom = wrapper(doc), before = documentBounds(doc);
    expect(cards(doc)).toHaveLength(0); expect(moleculeMarkup(doc)).not.toContain('data-expanded-atom');
    const child = atom.substructure!.fragments[0].document, positions = Object.keys(child.depiction.positions);
    child.depiction.positions[positions[1]] = { ...child.depiction.positions[positions[0]] };
    atom.substructure!.display = 'expanded';
    expect(cards(doc)).toHaveLength(1); expect(documentBounds(doc).height).toBeGreaterThan(before.height);
    expect(svg(doc).querySelectorAll('[data-expanded-bond]')).toHaveLength(Object.keys(child.graph.bonds).length);
  });

  it('bounds recursion for malformed cycles and deeply nested display state', () => {
    const leaf = emptyDocument(); addAtom(leaf, 'O', { x: 0, y: 0 });
    let doc = leaf;
    for (let depth = 0; depth < 20; depth++) {
      const parent = emptyDocument(); addAtom(parent, '*', { x: 0, y: 0 }, { hydrogens: { mode: 'fixed', count: 0 }, substructure: { kind: 'abbreviation', display: 'expanded', label: `Level ${depth}`, fragments: [{ document: doc, attachmentOrder: [] }], connections: [] } }); doc = parent;
    }
    expect(cards(doc)).toHaveLength(16); expect(svg(doc).documentElement.textContent).toContain('更深层展开已暂停');
    const cycle = load(), cyclic = wrapper(cycle); cyclic.substructure!.display = 'expanded'; cyclic.substructure!.fragments[0].document = cycle;
    const layout = expandedSubstructureLayout(cycle, () => ({ x: -1, y: -1, width: 3, height: 3 }));
    expect(layout.cards).toHaveLength(1); expect(layout.cards[0].limited).toBe(true);
  });

  it('reserves horizontal space for long chemical labels inside a child card', () => {
    const doc = load(), group = wrapper(doc).substructure!, child = group.fragments[0].document;
    group.display = 'expanded';
    const id = addAtom(child, '*', { x: 0, y: 1 }, { namedFragment: { type: 'Nickname', label: 'A'.repeat(160) } });
    addBond(child, id, Object.keys(child.graph.atoms)[0]);
    const card = svg(doc).querySelector('[data-expanded-card]')!, content = card.querySelector('svg')!, view = content.getAttribute('viewBox')!.split(' ').map(Number);
    expect(view[2]).toBeGreaterThan(40); expect(card.querySelector(`[data-expanded-atom="${id}"]`)!.textContent).toContain('A'.repeat(160));
    expect(Number(content.getAttribute('width'))).toBeLessThan(Number(card.querySelector('rect')!.getAttribute('width')));
  });
});
