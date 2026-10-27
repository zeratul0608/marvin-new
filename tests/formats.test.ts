import { describe, expect, it } from 'vitest';
import { addAtom, addBond, clone, emptyDocument, molecularFormula, validateDocument } from '../src/core/model';
import { exampleDocument } from '../src/core/templates';
import type { ChemicalDocument, Format } from '../src/core/types';
import { detectFormat, exportDocument, FormatError, importDocument } from '../src/formats';
import { exportSvg } from '../src/editor/render';

function signature(doc: ChemicalDocument) {
  const atoms = Object.values(doc.graph.atoms), indices = new Map(atoms.map((a, i) => [a.id, i]));
  return {
    atoms: atoms.map(({ id: _, ...a }) => a),
    bonds: Object.values(doc.graph.bonds).map(b => ({ atoms: b.atoms.map(a => indices.get(a)).sort(), order: b.order })),
    stereo: Object.values(doc.graph.bonds).filter(b => doc.depiction.bonds[b.id]).map(b => ({ pair: b.atoms.map(a => indices.get(a)).sort(), style: doc.depiction.bonds[b.id].style, from: indices.get(doc.depiction.bonds[b.id].from) })),
    positions: atoms.map(a => ({ x: Number(doc.depiction.positions[a.id].x.toFixed(3)) || 0, y: Number(doc.depiction.positions[a.id].y.toFixed(3)) || 0 })),
  };
}
const exchangeFormats: Format[] = ['mol', 'mol-v3000', 'cdxml', 'mrv'];
describe('format compatibility', () => {
  it.each(exchangeFormats)('round-trips element/isotope/charge/explicit-zero-H/wedge anchor through %s', format => {
    const doc = emptyDocument('往返样例');
    const c = addAtom(doc, 'C', { x: 0, y: 0 }, { isotope: 13 });
    const n = addAtom(doc, 'N', { x: 1.299, y: .75 }, { charge: 1 });
    const o = addAtom(doc, 'O', { x: 2.598, y: 0 }, { charge: -1, hydrogens: { mode: 'fixed', count: 0 } });
    const cn = addBond(doc, c, n); addBond(doc, n, o);
    doc.depiction.bonds[cn] = { style: 'hashed', from: n };
    const data = exportDocument(doc, { format }).data;
    const imported = importDocument({ data });
    expect(signature(imported.document)).toEqual(signature(doc));
    // Force the adapter writer, rather than the untouched-source passthrough path.
    const edited = clone(imported.document); delete edited.source;
    const reread = importDocument({ data: exportDocument(edited, { format }).data });
    expect(signature(reread.document)).toEqual(signature(doc));
  });
  it.each(exchangeFormats.flatMap(from => exchangeFormats.map(to => [from, to])))('cross-converts %s → %s without changing the aspirin graph', (from, to) => {
    const original = exampleDocument('aspirin');
    const input = importDocument({ data: exportDocument(original, { format: from as Format }).data });
    const output = exportDocument(input.document, { format: to as Format });
    const back = importDocument({ data: output.data });
    expect(signature(back.document)).toEqual(signature(original));
    expect(molecularFormula(back.document)).toBe('C9H8O4');
  });
  it.each(['mol', 'mol-v3000', 'mrv'] as Format[])('preserves atom-map identity separately from atom ID in %s', format => {
    const doc = exampleDocument('ethanol'), atom = Object.values(doc.graph.atoms)[0]; atom.atomMap = 52;
    const imported = importDocument({ data: exportDocument(doc, { format }).data }).document;
    expect(Object.values(imported.graph.atoms)[0].atomMap).toBe(52);
    expect(Object.values(imported.graph.atoms)[0].id).not.toBe(atom.id);
  });
  it('blocks CDXML atom-map loss by default and reports explicit lossy exports', () => {
    const doc = exampleDocument('ethanol'); Object.values(doc.graph.atoms)[0].atomMap = 1;
    expect(() => exportDocument(doc, { format: 'cdxml' })).toThrow(FormatError);
    const result = exportDocument(doc, { format: 'cdxml', allowLossy: true });
    expect(result.issues[0].code).toBe('ATOM_MAP_LOSS');
  });
  it('returns unsupported document graphics verbatim only while their projection is unchanged', () => {
    const raw = '<CDXML><page id="1"><fragment id="2"><n id="3" p="0 0" Element="8"/></fragment><graphic id="4" GraphicType="Rectangle"/></page></CDXML>';
    const { document, issues } = importDocument({ data: raw });
    expect(issues.length).toBeGreaterThan(0);
    expect(exportDocument(document, { format: 'cdxml' })).toMatchObject({ data: raw, passthrough: true });
    document.depiction.positions[Object.keys(document.graph.atoms)[0]].x = 2;
    expect(() => exportDocument(document, { format: 'cdxml' })).toThrow('导出已阻止');
    expect(() => exportDocument(document, { format: 'mrv' })).toThrow();
    expect(exportDocument(document, { format: 'cdxml', allowLossy: true }).issues[0].code).toBe('SOURCE_DATA_LOSS');
  });
  it('keeps source records and stable IDs in native JSON and rejects future schemas', () => {
    const doc = importDocument({ data: exportDocument(exampleDocument('ethanol'), { format: 'mrv' }).data }).document;
    expect(importDocument({ data: exportDocument(doc, { format: 'json' }).data }).document).toEqual(doc);
    expect(() => importDocument({ data: JSON.stringify({ ...doc, schemaVersion: 2 }) })).toThrow();
  });
  it('imports standard MRV compact atom arrays and scopes duplicate external IDs by molecule', () => {
    const raw = '<cml><MDocument><MChemicalStruct><molecule molID="m1"><atomArray atomID="a1 a2" elementType="C O" x2="0 1.5" y2="0 0"/><bondArray><bond atomRefs2="a1 a2" order="1"/></bondArray></molecule><molecule molID="m2"><atomArray><atom id="a1" elementType="Cl" formalCharge="-1" x2="4" y2="0"/></atomArray></molecule></MChemicalStruct></MDocument></cml>';
    const result = importDocument({ data: raw });
    expect(Object.keys(result.document.graph.atoms)).toHaveLength(3);
    expect(Object.keys(result.document.graph.bonds)).toHaveLength(1);
    expect(validateDocument(result.document)).toEqual([]);
  });
  it('accepts a standalone MRV molecule root exactly once', () => {
    const data = '<molecule molID="m1"><atomArray><atom id="a1" elementType="O" x2="0" y2="0"/></atomArray></molecule>';
    const doc = importDocument({ data }).document;
    expect(Object.keys(doc.graph.atoms)).toHaveLength(1);
    expect(molecularFormula(doc)).toBe('H2O');
  });
  it('rejects a V2000 coordinate that rounds beyond its fixed-width field', () => {
    const doc = emptyDocument(); addAtom(doc, 'C', { x: -9999.99999, y: 0 });
    expect(() => exportDocument(doc, { format: 'mol' })).toThrow('V2000');
    expect(() => exportDocument(doc, { format: 'mol-v3000' })).not.toThrow();
  });
  it.each([
    '<CDXML><page><fragment><n id="1" p="0 0" NodeType="Nickname"/></fragment></page></CDXML>',
    '<CDXML><page><fragment><n id="1" p="0 0" MysteryChemistry="1"/></fragment></page></CDXML>',
    '<CDXML><page><scheme><step/></scheme></page></CDXML>',
    '<cml><molecule molID="m1"><atomArray><atom id="a1" elementType="N" x2="0" y2="0" radical="monovalent"/></atomArray></molecule></cml>',
    '<cml><molecule role="SRU"/></cml>',
    '<CDXML><page><fragment><n id="1" p="0 0"/><b id="2" B="1" E="missing"/></fragment></page></CDXML>',
    '<!DOCTYPE cml [<!ENTITY x "payload">]><cml/>',
  ])('rejects unsupported or corrupt chemical semantics', data => { expect(() => importDocument({ data })).toThrow(FormatError); });
  it('detects external-DTD CDXML without fetching the DTD', () => {
    const data = '<?xml version="1.0"?><!DOCTYPE CDXML SYSTEM "https://example.invalid/CDXML.dtd"><CDXML><page id="1"><fragment id="2"><n id="3" p="0 0" Element="6"/></fragment></page></CDXML>';
    expect(detectFormat(data)).toBe('cdxml');
    expect(molecularFormula(importDocument({ data }).document)).toBe('CH4');
  });
  it('escapes untrusted titles in standalone SVG exports', () => {
    const doc = exampleDocument('ethanol'); doc.title = '"><script>alert(1)</script>';
    const svg = exportSvg(doc);
    expect(svg).not.toContain('<script>'); expect(svg).toContain('&lt;script&gt;');
  });
  it('rejects malformed, truncated and multi-record data', () => {
    expect(() => importDocument({ data: '<CDXML><page></CDXML>' })).toThrow();
    const mol = exportDocument(exampleDocument('ethanol'), { format: 'mol' }).data;
    expect(() => importDocument({ data: mol.replace('M  END', '') })).toThrow();
    expect(() => importDocument({ data: mol + '\n$$$$\n' })).toThrow('SDF');
  });
});
