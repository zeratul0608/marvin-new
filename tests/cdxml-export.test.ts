import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importDocument, exportDocument } from '../src/formats';
import { applyDocumentEdits } from '../src/core/edits';
import { molecularFormula } from '../src/core/model';
import type { ChemicalDocument } from '../src/core/types';

const read = (path: string) => readFileSync(resolve(path), 'utf8');
// Compare chemistry and geometry independently of generated internal IDs and source records.
function projection(doc: ChemicalDocument) {
  const atoms = Object.values(doc.graph.atoms), index = (id: string) => atoms.findIndex(a => a.id === id);
  return {
    atoms: atoms.map(({ id: _, ...properties }) => properties),
    points: atoms.map(a => Object.values(doc.depiction.positions[a.id]).map(n => Number(n.toFixed(4)) || 0)),
    bonds: Object.values(doc.graph.bonds).map(b => ({
      pair: b.atoms.map(index), order: b.order,
      style: doc.depiction.bonds[b.id]?.style,
      anchor: doc.depiction.bonds[b.id] ? index(doc.depiction.bonds[b.id].from) : undefined,
    })),
  };
}

describe('CDXML export with file fixtures', () => {
  it.each(['simple', 'styled'])('reads and rewrites the archived ChemDraw %s CDXML example', style => {
    const raw = read(`tests/fixtures/cdxml/dimethylamine-${style}.cdxml`);
    const input = importDocument({ data: raw });
    expect(molecularFormula(input.document)).toBe('C2H7N');
    expect(exportDocument(input.document, { format: 'cdxml' })).toMatchObject({ data: raw, passthrough: true });
    // An edit forces the actual writer; this must not pass by returning the fixture unchanged.
    const n = Object.values(input.document.graph.atoms).find(a => a.element === 'N')!;
    const edited = applyDocumentEdits(input.document, [{ type: 'update-atom', atomId: n.id, changes: { isotope: 15 } }]).document;
    if (style === 'styled') expect(() => exportDocument(edited, { format: 'cdxml' })).toThrow('导出已阻止');
    const output = exportDocument(edited, { format: 'cdxml', allowLossy: true });
    expect(output.passthrough).toBe(false);
    expect(output.data).toContain('Isotope="15"');
    expect(projection(importDocument({ data: output.data }).document)).toEqual(projection(edited));
  });

  it.each(['simple', 'styled'])('converts the original %s binary CDX to editable CDXML', style => {
    const input = importDocument({ data: new Uint8Array(readFileSync(resolve(`tests/fixtures/cdx/dimethylamine-${style}.cdx`))) });
    const output = exportDocument(input.document, { format: 'cdxml', allowLossy: true });
    expect(output.passthrough).toBe(false);
    const parsed = new DOMParser().parseFromString(output.data, 'application/xml');
    expect(parsed.querySelector('parsererror')).toBeNull();
    const ids = [...parsed.querySelectorAll('page, fragment, n, b')].map(e => e.getAttribute('id'));
    expect(ids.every(Boolean)).toBe(true); expect(new Set(ids).size).toBe(ids.length);
    for (const b of parsed.querySelectorAll('b')) {
      expect(parsed.querySelector(`n[id="${b.getAttribute('B')}"]`)).not.toBeNull();
      expect(parsed.querySelector(`n[id="${b.getAttribute('E')}"]`)).not.toBeNull();
    }
    expect(projection(importDocument({ data: output.data }).document)).toEqual(projection(input.document));
  });

  it.each(['public/examples/ethanol.cdxml', 'public/examples/ethanol.mrv'])('exports %s after editing and preserves the molecular graph', path => {
    const imported = importDocument({ data: read(path) });
    const edited = applyDocumentEdits(imported.document, [{ type: 'set-position', atomId: Object.keys(imported.document.graph.atoms)[0], position: { x: -2.125, y: 3.75 } }]).document;
    const output = exportDocument(edited, { format: 'cdxml' });
    expect(output.passthrough).toBe(false);
    expect(projection(importDocument({ data: output.data }).document)).toEqual(projection(edited));
    expect(molecularFormula(importDocument({ data: output.data }).document)).toBe('C2H6O');
  });

  it.each(['AS="R"', 'AS="S"', 'AS="u"'])('rejects actual atom stereochemistry %s', attribute => {
    expect(() => importDocument({ data: `<CDXML><page><fragment><n id="1" p="0 0" ${attribute}/></fragment></page></CDXML>` })).toThrow('拓扑立体');
  });
  it.each(['E', 'Z'])('rejects actual bond stereochemistry %s', stereo => {
    expect(() => importDocument({ data: `<CDXML><page><fragment><n id="1" p="0 0"/><n id="2" p="30 0"/><b B="1" E="2" BS="${stereo}"/></fragment></page></CDXML>` })).toThrow('拓扑立体');
  });
  it('accepts natural isotope zero without creating an invalid isotope and still rejects duplicate bond IDs', () => {
    const raw = '<CDXML><page><fragment><n id="1" p="0 0" Isotope="0" AS="U"/><n id="2" p="30 0"/><b B="1" E="2" BS="U"/></fragment></page></CDXML>';
    expect(molecularFormula(importDocument({ data: raw }).document)).toBe('C2H6');
    expect(() => importDocument({ data: raw.replace('<b B=', '<b id="1" B=') })).toThrow('重复');
  });
});
