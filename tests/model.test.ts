import { describe, expect, it } from 'vitest';
import { addAtom, addBond, clone, connectedComponents, emptyDocument, hydrogenCount, molecularFormula, removeAtom, validateDocument } from '../src/core/model';
import { DocumentStore } from '../src/core/store';
import { exampleDocument } from '../src/core/templates';

describe('editable chemical graph', () => {
  it.each([['aspirin', 'C9H8O4'], ['caffeine', 'C8H10N4O2'], ['ethanol', 'C2H6O'], ['benzene', 'C6H6']] as const)('calculates the basic formula of %s', (name, formula) => {
    const doc = exampleDocument(name);
    expect(validateDocument(doc)).toEqual([]);
    expect(molecularFormula(doc)).toBe(formula);
    const positions = Object.values(doc.depiction.positions).map(p => `${p.x},${p.y}`);
    expect(new Set(positions).size).toBe(positions.length);
  });
  it('distinguishes an authored zero hydrogen count from automatic inference', () => {
    const doc = emptyDocument();
    const carbon = addAtom(doc, 'C', { x: 0, y: 0 });
    expect(hydrogenCount(doc, carbon)).toBe(4);
    doc.graph.atoms[carbon].hydrogens = { mode: 'fixed', count: 0 };
    expect(hydrogenCount(doc, carbon)).toBe(0);
    expect(molecularFormula(doc)).toBe('C');
  });
  it('keeps explicit graph H separate from non-graph H and never invents metal hydrogens', () => {
    const doc = emptyDocument();
    const o = addAtom(doc, 'O', { x: 0, y: 0 });
    const h = addAtom(doc, 'H', { x: 1, y: 0 }); addBond(doc, o, h);
    expect(molecularFormula(doc)).toBe('H2O');
    const fe = addAtom(doc, 'Fe', { x: 4, y: 0 });
    expect(hydrogenCount(doc, fe)).toBeNull();
  });
  it('allows chemically incomplete states while forbidding dangling references', () => {
    const doc = emptyDocument();
    const o = addAtom(doc, 'O', { x: 0, y: 0 });
    for (let i = 0; i < 3; i++) addBond(doc, o, addAtom(doc, 'C', { x: i, y: 1 }));
    expect(validateDocument(doc).some(i => i.code === 'VALENCE_UNRESOLVED')).toBe(true);
    const dangling = clone(doc); delete dangling.graph.atoms[o];
    expect(() => validateDocument(dangling)).toThrow();
  });
  it('removes incident bonds and retains all surviving atom identities', () => {
    const doc = exampleDocument('ethanol'), ids = Object.keys(doc.graph.atoms);
    removeAtom(doc, ids[1]);
    expect(Object.keys(doc.graph.atoms)).toEqual([ids[0], ids[2]]);
    expect(Object.keys(doc.graph.bonds)).toEqual([]);
    expect(connectedComponents(doc)).toHaveLength(2);
  });
  it('rolls back failed edits and restores exact stable IDs through undo/redo', () => {
    const original = exampleDocument('ethanol'), store = new DocumentStore(original);
    const ids = Object.keys(original.graph.atoms);
    expect(() => store.transact(doc => { doc.graph.bonds.bad = { id: 'bad', atoms: [ids[0], 'missing'], order: 1 }; })).toThrow();
    expect(store.document).toEqual(original); expect(store.canUndo).toBe(false);
    store.transact(doc => removeAtom(doc, ids[1]));
    store.undo(); expect(store.document).toEqual(original);
    store.redo(); expect(Object.keys(store.document.graph.atoms)).toEqual([ids[0], ids[2]]);
  });
  it('does not expose mutable store state or record no-op edits', () => {
    const store = new DocumentStore(exampleDocument('ethanol'));
    store.document.title = 'accidental mutation';
    expect(store.document.title).toBe('乙醇');
    store.transact(() => {}); expect(store.canUndo).toBe(false);
  });
  it('rejects unknown JSON semantic fields instead of silently dropping them', () => {
    const doc = exampleDocument('ethanol') as unknown as { graph: { stereo: unknown[] } };
    doc.graph.stereo = [];
    expect(() => validateDocument(doc as never)).toThrow('未知字段');
  });
  it('rejects endpoints that only exist on the object prototype', () => {
    const doc = exampleDocument('ethanol');
    Object.values(doc.graph.bonds)[0].atoms[0] = 'toString';
    expect(() => validateDocument(doc)).toThrow('端点引用无效');
  });
});
