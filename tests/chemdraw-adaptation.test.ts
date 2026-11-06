import { describe, expect, it } from 'vitest';
import { addAtom, addBond, clone, emptyDocument, hydrogenCount, molecularFormula } from '../src/core/model';
import { applyDocumentEdits } from '../src/core/edits';
import { exampleDocument } from '../src/core/templates';
import type { ChemicalDocument, Format } from '../src/core/types';
import { exportDocument, importDocument } from '../src/formats';
import { decodeCdx, parseCdxTree } from '../src/formats/cdx';
import { exportSourceFile } from '../src/formats/preservation';
import { moleculeMarkup } from '../src/editor/render';

const attrs = (doc: ChemicalDocument) => Object.values(doc.graph.atoms).map(({ id: _, ...a }) => a);
const xml = (attributes: string, bond = '') => `<CDXML><page id="1"><fragment id="2"><n id="3" p="0 0" ${attributes}/><n id="4" p="30 0"/>${bond}</fragment></page></CDXML>`;

describe('ChemDraw structure and depiction adaptation', () => {
  it.each(['ethanol', 'aspirin', 'caffeine', 'benzene'] as const)('writes a new native CDX for %s and reads it as real binary', sample => {
    const doc = exampleDocument(sample), output = exportDocument(doc, { format: 'cdx' });
    expect(output.preservation).toBe('rebuilt');
    const bytes = decodeCdx(output.data);
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe('VjCD0100');
    const result = importDocument({ data: bytes });
    expect(attrs(result.document)).toEqual(attrs(doc));
    expect(Object.values(result.document.graph.bonds).map(b => b.order)).toEqual(Object.values(doc.graph.bonds).map(b => b.order));
    expect(molecularFormula(result.document)).toBe(molecularFormula(doc));
    // Export a generated CDX to CDXML without dropping its font table or label runs.
    const converted = exportDocument(result.document, { format: 'cdxml' });
    expect(converted.preservation).toBe('converted'); expect(converted.data).toContain('<fonttable>');
    expect(attrs(importDocument({ data: converted.data }).document)).toEqual(attrs(doc));
  });

  it.each(([1, 2, 3] as const).flatMap(radical => (['cdx', 'cdxml', 'mol', 'mol-v3000', 'mrv'] as Format[]).map(format => ({ radical, format }))))('preserves radical spin state $radical through $format', ({ radical, format }) => {
    const doc = emptyDocument(); addAtom(doc, 'C', { x: 0, y: 0 }, { radical, hydrogens: { mode: 'fixed', count: radical === 2 ? 3 : 2 } });
    const imported = importDocument({ data: exportDocument(doc, { format }).data, format }).document;
    expect(attrs(imported)).toEqual(attrs(doc));
    expect(moleculeMarkup(imported)).toContain(`data-radical="${radical}"`);
    delete imported.source;
    expect(attrs(importDocument({ data: exportDocument(imported, { format }).data, format }).document)).toEqual(attrs(doc));
  });

  it('never fabricates automatic H counts for an unspecified radical valence', () => {
    const doc = emptyDocument(), id = addAtom(doc, 'C', { x: 0, y: 0 }, { radical: 2 });
    expect(hydrogenCount(doc, id)).toBe(null);
    expect(molecularFormula(doc)).toContain('待校验');
    const edited = applyDocumentEdits(doc, [{ type: 'update-atom', atomId: id, changes: { radical: null } }]).document;
    expect(hydrogenCount(edited, id)).toBe(4);
  });

  it.each(['cdx', 'cdxml'] as const)('source-saves a changed radical in %s without losing independent text', format => {
    const doc = importDocument({ data: xml('Element="6" Radical="Doublet" NumHydrogens="2"') }).document;
    delete doc.source;
    const source = importDocument({ data: exportDocument(doc, { format }).data, format }).document;
    Object.values(source.graph.atoms)[0].radical = 3;
    const saved = exportSourceFile(source);
    expect(saved.preservation).toBe('preserved');
    expect(Object.values(importDocument({ data: saved.data, format }).document.graph.atoms)[0].radical).toBe(3);
  });

  it.each(['cdx', 'cdxml'] as const)('retains double-bond side and direction when saving %s', format => {
    const doc = exampleDocument('ethanol'), b = Object.values(doc.graph.bonds)[0];
    b.order = 2; doc.depiction.bonds[b.id] = { style: 'plain', from: b.atoms[1], doublePosition: 'left' };
    const imported = importDocument({ data: exportDocument(doc, { format }).data, format }).document;
    const id = Object.keys(imported.graph.bonds)[0];
    expect(imported.depiction.bonds[id].doublePosition).toBe('right');
    imported.depiction.bonds[id].doublePosition = 'left';
    const saved = exportSourceFile(imported);
    const back = importDocument({ data: saved.data, format }).document;
    expect(back.depiction.bonds[Object.keys(back.graph.bonds)[0]].doublePosition).toBe('left');
    imported.depiction.bonds[id] = { style: 'plain', from: imported.graph.bonds[id].atoms[0] };
    expect(importDocument({ data: exportSourceFile(imported).data, format }).document.depiction.bonds).toEqual({});
  });

  it.each((['dashed', 'bold', 'hash'] as const).flatMap(style => (['cdx', 'cdxml'] as const).map(format => ({ style, format }))))('round-trips $style single bonds in $format', ({ style, format }) => {
    const doc = exampleDocument('ethanol'), id = Object.keys(doc.graph.bonds)[0];
    doc.depiction.bonds[id] = { style, from: doc.graph.bonds[id].atoms[0] };
    const result = importDocument({ data: exportDocument(doc, { format }).data, format }).document;
    const bid = Object.keys(result.graph.bonds)[0]; expect(result.depiction.bonds[bid].style).toBe(style);
    expect(() => exportDocument(doc, { format: 'mol' })).toThrow();
    expect(exportDocument(doc, { format: 'mol', allowLossy: true }).issues.some(i => i.code === 'BOND_DISPLAY_LOSS')).toBe(true);
    result.depiction.bonds[bid].style = style === 'bold' ? 'hash' : 'bold';
    const saved = importDocument({ data: exportSourceFile(result).data, format }).document;
    expect(saved.depiction.bonds[Object.keys(saved.graph.bonds)[0]].style).toBe(style === 'bold' ? 'hash' : 'bold');
  });

  it('accepts display-only hints with explicit diagnostics and keeps them on source save', () => {
    const raw = xml('NeedsClean="yes" AtomNumber="A1" LabelSize="12" LabelFace="1"');
    const result = importDocument({ data: raw }); expect(result.issues.length).toBeGreaterThan(0);
    const doc = result.document, id = Object.keys(doc.graph.atoms)[0]; doc.depiction.positions[id].x += 1;
    const saved = exportSourceFile(doc); expect(saved.data).toContain('NeedsClean="yes"'); expect(saved.data).toContain('AtomNumber="A1"');
    expect(doc.graph.atoms[id].atomMap).toBeUndefined();
  });

  it.each(['Geometry="Tetrahedral"', 'MysteryChemistry="1"', 'EnhancedStereoType="And"', 'Radical="Invalid"'])('continues refusing chemistry it cannot represent: %s', attr => {
    expect(() => importDocument({ data: xml(attr) })).toThrow();
  });

  it('refuses cross-fragment bond endpoints instead of connecting unrelated molecules', () => {
    expect(() => importDocument({ data: '<CDXML><page><fragment><n id="1" p="0 0"/><b B="1" E="2"/></fragment><fragment><n id="2" p="30 0"/></fragment></page></CDXML>' })).toThrow('同一分子片段');
  });

  it.each(['cdx', 'cdxml'] as const)('represents template attachment boundaries without inventing carbon in %s', format => {
    const raw = '<CDXML><page><fragment><n id="1" p="0 0" NumHydrogens="3"/><n id="2" p="30 0" NodeType="ExternalConnectionPoint" ExternalConnectionType="Diamond"/><b B="1" E="2"/></fragment></page></CDXML>';
    const source = importDocument({ data: raw }).document;
    expect(molecularFormula(source)).toBe('CH3 · 含连接点');
    const point = Object.values(source.graph.atoms).find(a => a.attachment)!;
    expect(point.element).toBe('*'); expect(hydrogenCount(source, point.id)).toBe(0);
    expect(moleculeMarkup(source)).toContain('◆');
    source.depiction.positions[point.id].x += 1;
    expect(exportSourceFile(source).data).toContain('ExternalConnectionType="Diamond"');
    delete source.source;
    const data = exportDocument(source, { format }).data;
    const back = importDocument({ data, format }).document;
    expect(attrs(back)).toEqual(attrs(source));
    const bid = Object.values(back.graph.atoms).find(a => a.attachment)!.id;
    back.depiction.positions[bid].x += 1;
    expect(attrs(importDocument({ data: exportSourceFile(back).data, format }).document)).toEqual(attrs(back));
    expect(() => exportDocument(back, { format: 'mol' })).toThrow('外部连接点');
    const json = exportDocument(back, { format: 'json' });
    expect(importDocument({ data: json.data }).document).toEqual(JSON.parse(JSON.stringify(back)));
  });

  it('refuses unsupported or ambiguous attachment semantics', () => {
    expect(() => importDocument({ data: xml('NodeType="ExternalConnectionPoint" Charge="1"') })).toThrow();
    expect(() => importDocument({ data: xml('NodeType="ExternalConnectionPoint" ExternalConnectionType="UnknownStyle"') })).toThrow();
    const doc = importDocument({ data: xml('NodeType="ExternalConnectionPoint"', '<b B="3" E="4" Order="2"/>') }).document;
    expect(Object.values(doc.graph.bonds)[0].order).toBe(2);
  });

  it('bounds CDX coordinates, numeric widths, empty structures and mapping losses', () => {
    expect(() => exportDocument(emptyDocument(), { format: 'cdx' })).toThrow('至少一个');
    const doc = exampleDocument('ethanol'), atom = Object.values(doc.graph.atoms)[0];
    atom.charge = 128; expect(() => exportDocument(doc, { format: 'cdx' })).toThrow('范围');
    atom.charge = 0; doc.depiction.positions[atom.id].x = 2000;
    expect(() => exportDocument(doc, { format: 'cdx' })).toThrow('范围');
    doc.depiction.positions[atom.id].x = .123456789; atom.atomMap = 3;
    expect(() => exportDocument(doc, { format: 'cdx' })).toThrow('导出已阻止');
    delete atom.atomMap;
    const bytes = decodeCdx(exportDocument(doc, { format: 'cdx' }).data), tree = parseCdxTree(bytes);
    const all = (o: typeof tree): typeof tree[] => [o, ...o.children.flatMap(all)];
    const ids = all(tree).filter(o => o.id).map(o => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    const back = importDocument({ data: bytes }).document;
    expect(Math.abs(Object.values(back.depiction.positions)[0].x - .123456789)).toBeLessThan(.5 / 65536 / 20);
  });
});

describe('fragment layout edits', () => {
  const fragments = () => { const doc = exampleDocument('ethanol'); const a = addAtom(doc, 'O', { x: 0, y: 0 }); addBond(doc, a, addAtom(doc, 'C', { x: 0, y: 3 })); addAtom(doc, 'Cl', { x: 0, y: 0 }, { charge: -1 }); return doc; };
  it.each(['arrange-row', 'arrange-column', 'arrange-circle'] as const)('arranges whole fragments using %s without changing their internal distances or graph', action => {
    const doc = fragments(), out = applyDocumentEdits(doc, [{ type: 'layout', atomIds: [], action }]).document;
    expect(out.graph).toEqual(doc.graph); expect(out.depiction.positions).not.toEqual(doc.depiction.positions);
    for (const b of Object.values(doc.graph.bonds)) {
      const distance = (d: ChemicalDocument) => { const a = d.depiction.positions[b.atoms[0]], c = d.depiction.positions[b.atoms[1]]; return Math.hypot(a.x - c.x, a.y - c.y); };
      expect(distance(out)).toBeCloseTo(distance(doc), 10);
    }
  });
  it('rejects partial fragments and leaves input untouched on failed batches', () => {
    const doc = fragments(), before = clone(doc);
    expect(() => applyDocumentEdits(doc, [{ type: 'layout', action: 'arrange-row', atomIds: [Object.keys(doc.graph.atoms)[0]] }])).toThrow('完整片段');
    expect(doc).toEqual(before);
  });
  it('uniformly normalizes each fragment independently and preserves angles', () => {
    const doc = fragments(), out = applyDocumentEdits(doc, [{ type: 'layout', atomIds: [], action: 'normalize-bond-length' }]).document;
    expect(out.graph).toEqual(doc.graph);
    const bond = Object.values(out.graph.bonds).at(-1)!;
    const a = out.depiction.positions[bond.atoms[0]], b = out.depiction.positions[bond.atoms[1]];
    expect(a.x).toBe(b.x); expect(Math.abs(a.y - b.y)).toBeCloseTo(1.5);
    expect(out.depiction.positions[Object.keys(doc.graph.atoms).at(-1)!]).toEqual(doc.depiction.positions[Object.keys(doc.graph.atoms).at(-1)!]);
  });
});
