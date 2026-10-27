import { describe, expect, it } from 'vitest';
import { applyDocumentEdits, type EditOperation } from '../src/core/edits';
import { addAtom, addBond, clone, emptyDocument, validateDocument } from '../src/core/model';
import { exampleDocument } from '../src/core/templates';

describe('document edit batches', () => {
  it('creates and connects atoms through temporary references in a single batch', () => {
    const original = emptyDocument(), before = clone(original);
    const operations: EditOperation[] = [
      { type: 'add-atom', ref: '$carbon', element: 'C', position: { x: 0, y: 0 } },
      { type: 'add-atom', ref: '$oxygen', element: 'O', position: { x: 1, y: 0 }, properties: { isotope: 18 } },
      { type: 'add-bond', ref: '$co', atoms: ['$carbon', '$oxygen'], depiction: { style: 'wedge', from: '$carbon' } },
      { type: 'update-atom', atomId: '$carbon', changes: { atomMap: 7 } },
      { type: 'rename', title: 'Labelled methanol' },
    ];
    const { document, created } = applyDocumentEdits(original, operations);
    const carbon = created.atoms.$carbon, oxygen = created.atoms.$oxygen, bond = created.bonds.$co;
    expect(document.id).toBe(original.id);
    expect(document.title).toBe('Labelled methanol');
    expect(Object.keys(document.graph.atoms)).toEqual([carbon, oxygen]);
    expect(document.graph.atoms[carbon]).toMatchObject({ element: 'C', atomMap: 7 });
    expect(document.graph.atoms[oxygen]).toMatchObject({ element: 'O', isotope: 18 });
    expect(document.graph.bonds[bond]).toEqual({ id: bond, atoms: [carbon, oxygen], order: 1 });
    expect(document.depiction.bonds[bond]).toEqual({ style: 'wedge', from: carbon });
    expect(validateDocument(document)).toEqual([]);
    expect(original).toEqual(before);
  });

  it('updates atom properties and uses null to remove isotope and atom-map annotations', () => {
    const original = emptyDocument();
    const atomId = addAtom(original, 'C', { x: 0, y: 0 }, { isotope: 13, atomMap: 2 });
    const { document } = applyDocumentEdits(original, [
      { type: 'update-atom', atomId, changes: { element: 'N', charge: 1, hydrogens: { mode: 'fixed', count: 4 }, isotope: null, atomMap: null } },
    ]);
    expect(document.graph.atoms[atomId]).toEqual({ id: atomId, element: 'N', charge: 1, hydrogens: { mode: 'fixed', count: 4 } });
    expect(document.graph.atoms[atomId]).not.toHaveProperty('isotope');
    expect(document.graph.atoms[atomId]).not.toHaveProperty('atomMap');
    expect(original.graph.atoms[atomId]).toMatchObject({ element: 'C', isotope: 13, atomMap: 2 });
  });

  it('updates a newly created bond by reference and clears incompatible wedge depiction', () => {
    const { document, created } = applyDocumentEdits(emptyDocument(), [
      { type: 'add-atom', ref: '$a', element: 'C', position: { x: 0, y: 0 } },
      { type: 'add-atom', ref: '$b', element: 'O', position: { x: 1, y: 0 } },
      { type: 'add-bond', ref: '$bond', atoms: ['$a', '$b'], depiction: { style: 'wedge', from: '$a' } },
      { type: 'update-bond', bondId: '$bond', order: 2 },
    ]);
    expect(document.graph.bonds[created.bonds.$bond].order).toBe(2);
    expect(document.depiction.bonds).toEqual({});
  });

  it('can replace and explicitly remove a single-bond depiction', () => {
    const original = exampleDocument('ethanol'), bondId = Object.keys(original.graph.bonds)[0];
    const from = original.graph.bonds[bondId].atoms[1];
    const updated = applyDocumentEdits(original, [{ type: 'update-bond', bondId, depiction: { style: 'hashed', from } }]).document;
    expect(updated.depiction.bonds[bondId]).toEqual({ style: 'hashed', from });
    expect(applyDocumentEdits(updated, [{ type: 'update-bond', bondId, depiction: null }]).document.depiction.bonds).toEqual({});
  });

  it('leaves the input document unchanged when final validation rejects an entire batch', () => {
    const original = exampleDocument('ethanol'), before = clone(original);
    const atomId = Object.keys(original.graph.atoms)[0];
    expect(() => applyDocumentEdits(original, [
      { type: 'rename', title: 'Must not persist' },
      { type: 'add-atom', ref: '$new', element: 'N', position: { x: 4, y: 0 } },
      { type: 'update-atom', atomId, changes: { isotope: 0 } },
    ])).toThrow('同位素');
    expect(original).toEqual(before);
  });

  it('rejects a duplicate bond rather than silently changing its order', () => {
    const original = exampleDocument('ethanol'), before = clone(original);
    const bond = Object.values(original.graph.bonds)[0];
    expect(() => applyDocumentEdits(original, [
      { type: 'rename', title: 'Must not persist' },
      { type: 'add-bond', atoms: [bond.atoms[1], bond.atoms[0]], order: 3 },
    ])).toThrow('已存在化学键');
    expect(original).toEqual(before);
  });

  it.each([
    { label: 'duplicate temporary atom references', operations: [
      { type: 'add-atom', ref: '$same', element: 'C', position: { x: 0, y: 0 } },
      { type: 'add-atom', ref: '$same', element: 'O', position: { x: 1, y: 0 } },
    ] },
    { label: 'unknown operations', operations: [{ type: 'invent-reaction' }] },
    { label: 'unknown operation fields', operations: [{ type: 'rename', title: 'Invalid', unsupported: true }] },
    { label: 'unknown nested atom properties', operations: [{ type: 'add-atom', element: 'C', position: { x: 0, y: 0 }, properties: { stereo: 'R' } }] },
    { label: 'unknown coordinate fields', operations: [{ type: 'add-atom', element: 'C', position: { x: 0, y: 0, z: 1 } }] },
    { label: 'invalid reference names', operations: [{ type: 'add-atom', ref: 'without-dollar', element: 'C', position: { x: 0, y: 0 } }] },
    { label: 'forward references', operations: [
      { type: 'set-position', atomId: '$future', position: { x: 1, y: 1 } },
      { type: 'add-atom', ref: '$future', element: 'C', position: { x: 0, y: 0 } },
    ] },
    { label: 'references to removed atoms', operations: [
      { type: 'add-atom', ref: '$gone', element: 'C', position: { x: 0, y: 0 } },
      { type: 'remove-atom', atomId: '$gone' },
      { type: 'update-atom', atomId: '$gone', changes: { charge: 1 } },
    ] },
    { label: 'inherited object keys as atom IDs', operations: [{ type: 'remove-atom', atomId: 'toString' }] },
  ])('rejects $label without modifying the original', ({ operations }) => {
    const original = exampleDocument('ethanol'), before = clone(original);
    expect(() => applyDocumentEdits(original, [
      { type: 'rename', title: 'Must not persist' },
      ...operations as EditOperation[],
    ])).toThrow();
    expect(original).toEqual(before);
  });

  it('rejects missing and removed bond references', () => {
    const original = exampleDocument('ethanol'), before = clone(original);
    const bondId = Object.keys(original.graph.bonds)[0];
    expect(() => applyDocumentEdits(original, [{ type: 'remove-bond', bondId: 'missing' }])).toThrow('对象不存在');
    expect(() => applyDocumentEdits(original, [
      { type: 'remove-bond', bondId },
      { type: 'update-bond', bondId, order: 2 },
    ])).toThrow('对象不存在');
    expect(original).toEqual(before);
  });

  it('transforms only the requested atoms and applies explicit positions independently', () => {
    const original = emptyDocument();
    const a = addAtom(original, 'C', { x: -1, y: 0 }), b = addAtom(original, 'C', { x: 1, y: 0 });
    const other = addAtom(original, 'O', { x: 5, y: 5 });
    addBond(original, a, b);
    const { document } = applyDocumentEdits(original, [
      { type: 'transform', atomIds: [a, b, a], transform: 'rotate-left' },
      { type: 'set-position', atomId: other, position: { x: 8, y: 3 } },
    ]);
    expect(document.depiction.positions[a].x).toBeCloseTo(-Math.sqrt(3) / 2);
    expect(document.depiction.positions[a].y).toBeCloseTo(-0.5);
    expect(document.depiction.positions[b].x).toBeCloseTo(Math.sqrt(3) / 2);
    expect(document.depiction.positions[b].y).toBeCloseTo(0.5);
    expect(document.depiction.positions[other]).toEqual({ x: 8, y: 3 });
    expect(document.graph).toEqual(original.graph);
    expect(original.depiction.positions[a]).toEqual({ x: -1, y: 0 });
    expect(original.depiction.positions[other]).toEqual({ x: 5, y: 5 });
  });

  it('removes explicit bonds, atom incident bonds and their depiction records together', () => {
    const original = exampleDocument('ethanol'), before = clone(original);
    const [first, second] = Object.values(original.graph.bonds);
    for (const bond of [first, second]) original.depiction.bonds[bond.id] = { style: 'wedge', from: bond.atoms[0] };
    const atomId = second.atoms[1];
    const { document } = applyDocumentEdits(original, [
      { type: 'remove-bond', bondId: first.id },
      { type: 'remove-atom', atomId },
    ]);
    expect(document.graph.bonds).toEqual({});
    expect(document.depiction.bonds).toEqual({});
    expect(document.graph.atoms).not.toHaveProperty(atomId);
    expect(document.depiction.positions).not.toHaveProperty(atomId);
    expect(Object.keys(document.graph.atoms)).toEqual(Object.keys(before.graph.atoms).filter(id => id !== atomId));
    expect(Object.keys(original.graph.bonds)).toHaveLength(2);
    expect(validateDocument(document)).toEqual([]);
  });

  it('rejects non-array and oversized batches', () => {
    const original = emptyDocument();
    expect(() => applyDocumentEdits(original, {} as EditOperation[])).toThrow('数组');
    expect(() => applyDocumentEdits(original, Array.from({ length: 1001 }, () => ({ type: 'rename' as const, title: 'Too many' })))).toThrow('1000');
  });
});
