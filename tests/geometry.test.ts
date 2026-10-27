import { describe, expect, it } from 'vitest';
import { transformAtoms } from '../src/core/geometry';
import { exampleDocument } from '../src/core/templates';
import { DocumentStore } from '../src/core/store';
import { exportDocument, importDocument } from '../src/formats';

describe('structure depiction transforms', () => {
  it('rotates selected coordinates while preserving identities, bond lengths and unselected atoms', () => {
    const doc = exampleDocument('aspirin'), before = structuredClone(doc);
    const ids = Object.keys(doc.graph.atoms).slice(0, 6), selected = new Set(ids);
    transformAtoms(doc, ids, 'rotate-left');
    expect(doc.graph).toEqual(before.graph);
    const center = (document: typeof doc) => ids.reduce((p, id) => ({ x: p.x + document.depiction.positions[id].x / ids.length, y: p.y + document.depiction.positions[id].y / ids.length }), { x: 0, y: 0 });
    expect(center(doc).x).toBeCloseTo(center(before).x);
    expect(center(doc).y).toBeCloseTo(center(before).y);
    for (const id of Object.keys(doc.graph.atoms)) if (!selected.has(id)) expect(doc.depiction.positions[id]).toEqual(before.depiction.positions[id]);
    for (const bond of Object.values(doc.graph.bonds).filter(b => b.atoms.every(id => selected.has(id)))) {
      const length = (document: typeof doc) => { const [a, b] = bond.atoms.map(id => document.depiction.positions[id]); return Math.hypot(a.x - b.x, a.y - b.y); };
      expect(length(doc)).toBeCloseTo(length(before));
    }
    expect(doc.depiction.positions[ids[0]]).not.toEqual(before.depiction.positions[ids[0]]);
  });
  it.each(['mirror-horizontal', 'mirror-vertical'] as const)('restores the same coordinates after two %s operations', transform => {
    const doc = exampleDocument('ethanol'), before = structuredClone(doc);
    transformAtoms(doc, Object.keys(doc.graph.atoms), transform);
    transformAtoms(doc, Object.keys(doc.graph.atoms), transform);
    for (const id of Object.keys(doc.graph.atoms)) {
      expect(doc.depiction.positions[id].x).toBeCloseTo(before.depiction.positions[id].x);
      expect(doc.depiction.positions[id].y).toBeCloseTo(before.depiction.positions[id].y);
    }
    expect(doc.graph).toEqual(before.graph);
  });
  it('records a transform as one undoable edit and invalidates source passthrough', () => {
    const raw = exportDocument(exampleDocument('ethanol'), { format: 'mrv' }).data;
    const original = importDocument({ data: raw }).document, store = new DocumentStore(original);
    let changes = 0; store.subscribe(() => changes++);
    store.transact(doc => transformAtoms(doc, Object.keys(doc.graph.atoms), 'rotate-right'));
    const rotated = store.document;
    expect(changes).toBe(1);
    expect(exportDocument(rotated, { format: 'mrv' }).passthrough).toBe(false);
    store.undo(); expect(store.document).toEqual(original);
    expect(exportDocument(store.document, { format: 'mrv' }).data).toBe(raw);
    store.redo(); expect(store.document).toEqual(rotated);
  });
});
