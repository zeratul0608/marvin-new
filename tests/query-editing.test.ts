import { afterEach, describe, expect, it } from 'vitest';
import { addAtom, addBond, clone, emptyDocument, hydrogenCount, molecularFormula, removeBond, validateDocument } from '../src/core/model';
import { applyDocumentEdits } from '../src/core/edits';
import type { AtomQuery, ChemicalDocument } from '../src/core/types';
import { exportDocument, importDocument } from '../src/formats';
import { exportSourceFile } from '../src/formats/preservation';
import { stereoProjection } from '../src/formats/stereo';
import { moleculeMarkup } from '../src/editor/render';
import { createChemicalEditor } from '../src/editor/chemical-editor';

const signature = (doc: ChemicalDocument) => JSON.parse(JSON.stringify(stereoProjection(doc)));
function fixture(query: AtomQuery) {
  const doc = emptyDocument('query'), atomId = addAtom(doc, '*', { x: 0, y: 0 }, { query });
  const neighbor = addAtom(doc, 'C', { x: 1.5, y: 0 }); addBond(doc, atomId, neighbor);
  return { doc, atomId };
}
afterEach(() => document.body.replaceChildren());
describe('editable chemical queries and crossing depiction', () => {
  it.each<AtomQuery>([{ kind: 'elements', elements: ['N', 'O'] }, { kind: 'elements', elements: ['C', 'H'], exclude: true }, { kind: 'generic', label: 'R' }, { kind: 'any' }, { kind: 'any', label: 'X' }])('round trips a query through CDXML and CDX: %j', query => {
    const { doc, atomId } = fixture(query); expect(hydrogenCount(doc, atomId)).toBe(null); expect(molecularFormula(doc)).not.toContain('*');
    for (const format of ['cdxml', 'cdx'] as const) {
      const source = importDocument({ data: exportDocument(doc, { format }).data, format }).document;
      expect(signature(source)).toEqual(signature(doc));
      const id = Object.keys(source.graph.atoms)[0];
      const edited = applyDocumentEdits(source, [{ type: 'update-atom', atomId: id, changes: { query: { kind: 'generic', label: 'Ar' } } }]).document;
      expect(signature(importDocument({ data: exportSourceFile(edited).data, format }).document)).toEqual(signature(edited));
      expect(() => exportDocument(doc, { format: 'mol', allowLossy: true })).toThrow(/查询/);
    }
  });
  it('does not conflate a query, a concrete carbon or an attachment point', () => {
    const { doc, atomId } = fixture({ kind: 'generic', label: 'R' });
    expect(moleculeMarkup(doc)).toContain('>R</text>');
    const edited = applyDocumentEdits(doc, [{ type: 'update-atom', atomId, changes: { query: null, element: 'C' } }]).document;
    expect(edited.graph.atoms[atomId].query).toBeUndefined(); expect(hydrogenCount(edited, atomId)).toBe(3);
    const malformed = clone(doc); malformed.graph.atoms[atomId].element = 'C'; expect(() => validateDocument(malformed)).toThrow(/查询/);
  });
  it.each(['any', 2.5] as const)('preserves real bond type %s and renders it distinctly', order => {
    const doc = emptyDocument(), a = addAtom(doc, 'C', { x: 0, y: 0 }), b = addAtom(doc, 'C', { x: 1.5, y: 0 });
    addBond(doc, a, b, order); expect(hydrogenCount(doc, a)).toBe(null);
    for (const format of ['cdxml', 'cdx'] as const) expect(signature(importDocument({ data: exportDocument(doc, { format }).data, format }).document)).toEqual(signature(doc));
    expect(moleculeMarkup(doc)).toContain('stroke-dasharray');
  });
  it('preserves atom sequence and numbered attachment ports in XML after edits', () => {
    const doc = importDocument({ data: '<CDXML><page><fragment><n id="1" p="0 0" AtomID="4"/><n id="2" p="30 0" NodeType="ExternalConnectionPoint" ExternalConnectionNum="2"/><b id="3" B="1" E="2"/></fragment></page></CDXML>' }).document;
    const ids = Object.keys(doc.graph.atoms); expect(doc.graph.atoms[ids[0]].sourceNumber).toBe(4); expect(doc.graph.atoms[ids[1]].attachmentIndex).toBe(2);
    const edited = applyDocumentEdits(doc, [{ type: 'update-atom', atomId: ids[1], changes: { attachmentIndex: 3 } }]).document;
    expect(signature(importDocument({ data: exportSourceFile(edited).data }).document)).toEqual(signature(edited));
    const cdx = importDocument({ data: exportDocument(doc, { format: 'cdx', allowLossy: true }).data, format: 'cdx' }).document;
    expect(signature(cdx)).toEqual(signature(doc));
  });
  it('retains crossing references, layer and label offsets; deleting a crossing target clears only the derived hint', () => {
    const doc = emptyDocument(), ids = [{ x: -1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }, { x: 1, y: -1 }].map(p => addAtom(doc, 'C', p));
    const lower = addBond(doc, ids[0], ids[1]), upper = addBond(doc, ids[2], ids[3]);
    doc.depiction.bonds[upper] = { style: 'plain', from: ids[2], crossings: [lower], layer: 9, labelOffsets: [1, 0] };
    for (const format of ['cdxml', 'cdx'] as const) {
      const source = importDocument({ data: exportDocument(doc, { format }).data, format }).document; expect(signature(source)).toEqual(signature(doc));
      const d = Object.values(source.depiction.bonds)[0]; d.labelOffsets = [2, 0];
      expect(signature(importDocument({ data: exportSourceFile(source).data, format }).document)).toEqual(signature(source));
    }
    expect(moleculeMarkup(doc)).toContain('data-crossing='); removeBond(doc, lower); expect(doc.depiction.bonds[upper].crossings).toBeUndefined();
    expect(() => validateDocument(doc)).not.toThrow();
  });
  it('edits query lists in the inspector with an atomic undo and rejects unknown elements', () => {
    const { doc, atomId } = fixture({ kind: 'elements', elements: ['N', 'O'] }), editor = createChemicalEditor({ container: document.body, document: doc });
    editor.setSelection({ atomIds: [atomId] }); editor.showAdvancedEditor('queries'); let input = editor.shadowRoot!.querySelector<HTMLInputElement>('#query-value')!;
    input.value = 'F,Cl'; input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(editor.getDocument().graph.atoms[atomId].query).toEqual({ kind: 'elements', elements: ['F', 'Cl'] });
    editor.undo(); expect(editor.getDocument()).toEqual(doc);
    input = editor.shadowRoot!.querySelector<HTMLInputElement>('#query-value')!; input.value = 'NotAnElement'; input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(editor.getDocument()).toEqual(doc); editor.destroy();
  });
});
