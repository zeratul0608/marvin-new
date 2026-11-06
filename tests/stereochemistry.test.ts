import { afterEach, describe, expect, it } from 'vitest';
import { addAtom, addBond, clone, emptyDocument, validateDocument } from '../src/core/model';
import { applyDocumentEdits } from '../src/core/edits';
import { DocumentStore } from '../src/core/store';
import { circularOrderingFromDrawing } from '../src/core/stereochemistry';
import { exportDocument, importDocument } from '../src/formats';
import { exportSourceFile } from '../src/formats/preservation';
import { stereoProjection } from '../src/formats/stereo';
import { createChemicalEditor } from '../src/editor/chemical-editor';
import { runAiAssistant } from '../src/ai/assistant';
import type { ChemicalDocument } from '../src/core/types';

function tetra(virtual = false) {
  const doc = emptyDocument('tetrahedral'), center = addAtom(doc, 'C', { x: 0, y: 0 });
  const bonds = ['F', 'Cl', 'Br', 'I'].slice(0, virtual ? 3 : 4).map((element, i) => {
    const p = [{ x: 1.5, y: 0 }, { x: 0, y: 1.5 }, { x: -1.5, y: 0 }, { x: 0, y: -1.5 }][i];
    return addBond(doc, center, addAtom(doc, element, p));
  });
  doc.depiction.bonds[bonds[0]] = { style: 'wedge', from: center };
  doc.graph.atoms[center].geometry = { type: 'tetrahedral', bondOrdering: [bonds[0], bonds[1], bonds[2], bonds[3] ?? null] };
  return { doc, center, bonds };
}
function alkene() {
  const doc = emptyDocument('alkene'), ids = [{ x: -1, y: 1 }, { x: 0, y: 0 }, { x: 1.5, y: 0 }, { x: 2.5, y: -1 }].map(p => addAtom(doc, 'C', p));
  const bonds = [addBond(doc, ids[0], ids[1]), addBond(doc, ids[1], ids[2], 2), addBond(doc, ids[2], ids[3])], center = bonds[1];
  doc.graph.bonds[center].circularOrdering = circularOrderingFromDrawing(doc, center);
  return { doc, center, ids, bonds };
}
const signature = (doc: ChemicalDocument) => JSON.parse(JSON.stringify(stereoProjection(doc)));
afterEach(() => document.body.replaceChildren());

describe('editable ChemDraw geometry', () => {
  it.each([false, true])('validates explicit/virtual tetrahedral ligands (virtual=%s)', virtual => {
    const { doc, center, bonds } = tetra(virtual); expect(() => validateDocument(doc)).not.toThrow();
    const duplicate = clone(doc); duplicate.graph.atoms[center].geometry!.bondOrdering[1] = bonds[0];
    expect(() => validateDocument(duplicate)).toThrow(/重复/);
    const dangling = clone(doc); dangling.graph.atoms[center].geometry!.bondOrdering[0] = 'missing';
    expect(() => validateDocument(dangling)).toThrow(/有效键/);
    const wrongOrder = clone(doc); wrongOrder.graph.bonds[bonds[0]].order = 2; delete wrongOrder.depiction.bonds[bonds[0]];
    expect(() => validateDocument(wrongOrder)).toThrow(/三条或四条单键/);
  });
  it('validates all neighboring double bond slots and rejects references on the wrong end', () => {
    const { doc, center } = alkene(); expect(() => validateDocument(doc)).not.toThrow();
    const refs = doc.graph.bonds[center].circularOrdering!; [refs[0], refs[2]] = [refs[2], refs[0]];
    expect(() => validateDocument(doc)).toThrow(/各端点/);
  });
  it('atomically rejects a deletion that leaves a geometry reference dangling', () => {
    const { doc, center, bonds } = tetra(), store = new DocumentStore(doc);
    expect(() => store.transact(d => { delete d.graph.bonds[bonds[0]]; delete d.depiction.bonds[bonds[0]]; })).toThrow();
    expect(store.document).toEqual(doc); expect(store.canUndo).toBe(false);
    const edited = applyDocumentEdits(doc, [{ type: 'set-atom-geometry', atomId: center, bondOrdering: null }, { type: 'remove-bond', bondId: bonds[0] }]).document;
    expect(edited.graph.atoms[center].geometry).toBeUndefined();
    expect(Object.keys(edited.graph.bonds)).toHaveLength(3);
  });
  it('prevents ordinary edits from reversing or flattening a recorded tetrahedron', () => {
    const { doc, center, bonds } = tetra(), store = new DocumentStore(doc);
    expect(() => applyDocumentEdits(doc, [{ type: 'update-bond', bondId: bonds[0], depiction: { style: 'hashed', from: center } }])).toThrow(/改变或压平/);
    expect(() => store.transact(d => { d.depiction.bonds[bonds[0]].style = 'hashed'; })).toThrow(/改变或压平/);
    expect(store.document).toEqual(doc);
  });
  it('inverts wedges and ordering together, and undo/redo restores the entire operation', () => {
    const { doc, center, bonds } = tetra(), store = new DocumentStore(doc);
    const invert = () => store.replace(applyDocumentEdits(store.document, [{ type: 'invert-atom-stereo', atomId: center }]).document);
    invert(); expect(store.document.depiction.bonds[bonds[0]].style).toBe('hashed');
    expect(store.document.graph.atoms[center].geometry!.bondOrdering).toEqual([bonds[0], bonds[1], bonds[3], bonds[2]]);
    store.undo(); expect(store.document).toEqual(doc); store.redo(); invert(); expect(store.document).toEqual(doc);
  });
  it('retains the configuration in a whole-fragment mirror by reversing wedge depth', () => {
    const { doc, bonds } = tetra();
    const result = applyDocumentEdits(doc, [{ type: 'transform', atomIds: Object.keys(doc.graph.atoms), transform: 'mirror-horizontal' }]).document;
    expect(result.depiction.bonds[bonds[0]].style).toBe('hashed'); expect(result.graph).toEqual(doc.graph);
    const restored = applyDocumentEdits(result, [{ type: 'transform', atomIds: Object.keys(doc.graph.atoms), transform: 'mirror-horizontal' }]).document;
    expect(signature(restored)).toEqual(signature(doc));
  });
  it('does not fabricate wedge inversion for a flat or shared depiction', () => {
    const { doc, center } = tetra(); doc.depiction.bonds = {};
    expect(() => applyDocumentEdits(doc, [{ type: 'invert-atom-stereo', atomId: center }])).toThrow(/实／虚楔键/);
  });
  it('also preserves wedge depth during a complete mirror without explicit geometry metadata', () => {
    const { doc, center, bonds } = tetra(); delete doc.graph.atoms[center].geometry;
    const result = applyDocumentEdits(doc, [{ type: 'transform', atomIds: Object.keys(doc.graph.atoms), transform: 'mirror-vertical' }]).document;
    expect(result.depiction.bonds[bonds[0]].style).toBe('hashed');
  });
  it('resolves temporary bond IDs inside a new atom geometry in the same atomic batch', () => {
    const result = applyDocumentEdits(emptyDocument(), [
      { type: 'add-atom', ref: '$c', element: 'C', position: { x: 0, y: 0 } },
      { type: 'add-atom', ref: '$f', element: 'F', position: { x: 1.5, y: 0 } },
      { type: 'add-atom', ref: '$cl', element: 'Cl', position: { x: 0, y: 1.5 } },
      { type: 'add-atom', ref: '$br', element: 'Br', position: { x: -1.5, y: 0 } },
      { type: 'add-bond', ref: '$b1', atoms: ['$c', '$f'] },
      { type: 'add-bond', ref: '$b2', atoms: ['$c', '$cl'] },
      { type: 'add-bond', ref: '$b3', atoms: ['$c', '$br'] },
      { type: 'set-atom-geometry', atomId: '$c', bondOrdering: ['$b1', '$b2', '$b3', null] },
    ]);
    expect(result.document.graph.atoms[result.created.atoms.$c].geometry!.bondOrdering).toEqual([result.created.bonds.$b1, result.created.bonds.$b2, result.created.bonds.$b3, null]);
  });
  it('reflects an acyclic alkene branch, swaps ordering, and rejects accidental isomerization', () => {
    const { doc, center, ids } = alkene();
    expect(() => applyDocumentEdits(doc, [{ type: 'set-position', atomId: ids[3], position: { x: 2.5, y: 1 } }])).toThrow(/双键构型/);
    const result = applyDocumentEdits(doc, [{ type: 'invert-double-stereo', bondId: center }]).document;
    expect(result.depiction.positions[ids[3]].y).toBe(1);
    expect(result.graph.bonds[center].circularOrdering).not.toEqual(doc.graph.bonds[center].circularOrdering);
    expect(signature(applyDocumentEdits(result, [{ type: 'invert-double-stereo', bondId: center }]).document)).toEqual(signature(doc));
    addBond(doc, ids[0], ids[3]);
    expect(() => applyDocumentEdits(doc, [{ type: 'invert-double-stereo', bondId: center }])).toThrow(/环内双键/);
  });
  it.each(['cdx', 'cdxml', 'json'] as const)('round trips geometry, explicit endpoints and circular references through %s', format => {
    for (const fixture of [tetra().doc, tetra(true).doc, alkene().doc]) {
      const result = importDocument({ data: exportDocument(fixture, { format }).data, format }).document;
      expect(signature(result)).toEqual(signature(fixture));
    }
  });
  it.each(['cdx', 'cdxml'] as const)('source-saves inversion, clearing and new reference-bearing objects in %s', format => {
    for (const fixture of [tetra().doc, alkene().doc]) {
      const doc = importDocument({ data: exportDocument(fixture, { format }).data, format }).document;
      const atom = Object.values(doc.graph.atoms).find(a => a.geometry), bond = Object.values(doc.graph.bonds).find(b => b.circularOrdering);
      const inverted = applyDocumentEdits(doc, [atom ? { type: 'invert-atom-stereo', atomId: atom.id } : { type: 'invert-double-stereo', bondId: bond!.id }]).document;
      expect(signature(importDocument({ data: exportSourceFile(inverted).data, format }).document)).toEqual(signature(inverted));
      const cleared = applyDocumentEdits(inverted, [atom ? { type: 'set-atom-geometry', atomId: atom.id, bondOrdering: null } : { type: 'set-bond-ordering', bondId: bond!.id, bondOrdering: null }]).document;
      expect(signature(importDocument({ data: exportSourceFile(cleared).data, format }).document)).toEqual(signature(cleared));
      // Adding an entire tetrahedron into the same source fragment tests forward references.
      const extra = tetra().doc; Object.assign(cleared.graph.atoms, extra.graph.atoms); Object.assign(cleared.graph.bonds, extra.graph.bonds);
      Object.assign(cleared.depiction.positions, extra.depiction.positions); Object.assign(cleared.depiction.bonds, extra.depiction.bonds);
      expect(signature(importDocument({ data: exportSourceFile(cleared).data, format }).document)).toEqual(signature(cleared));
    }
  });
  it('converts source CDX geometry to CDXML with real object IDs', () => {
    const doc = importDocument({ data: exportDocument(tetra().doc, { format: 'cdx' }).data, format: 'cdx' }).document;
    const xml = exportDocument(doc, { format: 'cdxml' }); expect(xml.preservation).toBe('converted');
    expect(signature(importDocument({ data: xml.data }).document)).toEqual(signature(doc));
  });
  it('allocates IDs for optional-ID XML bonds when geometry is first recorded, also after JSON restore', () => {
    const fixture = tetra(), original = clone(fixture.doc); delete original.graph.atoms[fixture.center].geometry;
    const raw = exportDocument(original, { format: 'cdxml' }).data.replace(/<b id="[^"]+"/g, '<b');
    const doc = importDocument({ data: raw }).document, atomId = Object.keys(doc.graph.atoms)[0], refs = Object.keys(doc.graph.bonds);
    const edited = applyDocumentEdits(doc, [{ type: 'set-atom-geometry', atomId, bondOrdering: [refs[0], refs[1], refs[2], refs[3]] }]).document;
    const restored = importDocument({ data: exportDocument(edited, { format: 'json' }).data, format: 'json' }).document;
    expect(signature(importDocument({ data: exportSourceFile(restored).data }).document)).toEqual(signature(edited));
  });
  it.each(['mol', 'mol-v3000', 'mrv'] as const)('blocks silent explicit ordering loss in %s', format => {
    const { doc } = tetra(); expect(() => exportDocument(doc, { format })).toThrow(/导出已阻止/);
    expect(exportDocument(doc, { format, allowLossy: true }).issues.some(i => i.code === 'STEREO_ORDERING_LOSS')).toBe(true);
  });
  it('rejects invalid source reference lengths, dangling and cross-fragment IDs', () => {
    const raw = exportDocument(tetra().doc, { format: 'cdxml' }).data;
    expect(() => importDocument({ data: raw.replace(/BondOrdering="[^"]+"/, 'BondOrdering="999 0 0 0"') })).toThrow(/不存在/);
    expect(() => importDocument({ data: raw.replace(/BondOrdering="[^"]+"/, 'BondOrdering="0 0"') })).toThrow(/四个/);
  });
  it('edits from inspector buttons, swaps slots and restores them in history', () => {
    const { doc, center, bonds } = tetra(); const editor = createChemicalEditor({ container: document.body, document: doc });
    editor.setSelection({ atomIds: [center] }); editor.showAdvancedEditor('properties'); const root = editor.shadowRoot!;
    root.querySelector<HTMLButtonElement>('[data-action="invert-atom-stereo"]')!.click();
    expect(editor.getDocument().depiction.bonds[bonds[0]].style).toBe('hashed');
    editor.undo(); expect(editor.getDocument()).toEqual(doc);
    const slot = root.querySelector<HTMLSelectElement>('#atom-stereo-1')!; slot.value = bonds[2]; slot.dispatchEvent(new Event('change', { bubbles: true }));
    expect(editor.getDocument().graph.atoms[center].geometry!.bondOrdering).toEqual([bonds[0], bonds[2], bonds[1], bonds[3]]);
    editor.undo(); expect(editor.getDocument()).toEqual(doc); editor.destroy();
  });
  it('allows explicit whole-document replacement of a valid independent stereo snapshot', () => {
    const { doc, bonds } = tetra(), editor = createChemicalEditor({ container: document.body, document: doc });
    const replacement = clone(doc); replacement.depiction.bonds[bonds[0]].style = 'hashed';
    editor.setDocument(replacement); expect(editor.getDocument()).toEqual(replacement);
    editor.undo(); expect(editor.getDocument()).toEqual(doc); editor.destroy();
  });
  it('exposes stereo operations and source-free references to the AI whitelist', async () => {
    const { doc, center, bonds } = tetra(); const editor = createChemicalEditor({ container: document.body, document: doc });
    let rounds = 0;
    const result = await runAiAssistant(editor, { complete: async request => {
      if (rounds++ === 0) {
        expect(JSON.stringify(request.tools)).toContain('invert-atom-stereo');
        expect(JSON.stringify(request.messages)).toContain('tetrahedral');
        return { text: '', toolCalls: [{ id: 'invert', name: 'apply_edits', arguments: JSON.stringify({ expectedRevision: editor.getSnapshot().revision, operations: [{ type: 'invert-atom-stereo', atomId: center }] }) }] };
      }
      return { text: '已反转', toolCalls: [] };
    } }, { message: '反转该原子的构型' });
    expect(result.completed).toBe(true); expect(editor.getDocument().depiction.bonds[bonds[0]].style).toBe('hashed'); editor.destroy();
  });
});
