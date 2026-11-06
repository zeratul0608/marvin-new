import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addAtom, addBond, molecularFormula, removeAtom, removeBond } from '../src/core/model';
import { exportDocument, exportOriginalSource, exportSourceFile, importDocument } from '../src/formats';
import { decodeCdx, parseCdxTree, type CdxObject } from '../src/formats/cdx';
import type { ChemicalDocument } from '../src/core/types';

const bytes = () => new Uint8Array(readFileSync(resolve('tests/fixtures/cdx/dimethylamine-styled.cdx')));
const input = (kind: string) => kind === 'cdx' ? bytes() : readFileSync(resolve('tests/fixtures/cdxml/dimethylamine-styled.cdxml'), 'utf8');
const load = (kind: string) => importDocument({ data: input(kind) }).document;
const flatten = (o: CdxObject): CdxObject[] => [o, ...o.children.flatMap(flatten)];
const nAtom = (doc: ChemicalDocument) => Object.values(doc.graph.atoms).find(a => a.element === 'N')!;
const save = (doc: ChemicalDocument) => importDocument({ data: exportSourceFile(doc).data }).document;
const integers = (n: number, width = 2) => Array.from({ length: width }, (_, i) => n >>> (i * 8) & 255);

describe.each(['cdx', 'cdxml'])('expanded %s source-preserving editing', kind => {
  it('regenerates a styled chemical label with isotope, charge and subscript H count', () => {
    const doc = load(kind), n = nAtom(doc); n.isotope = 15; n.charge = 1; n.hydrogens = { mode: 'fixed', count: 2 };
    const result = exportSourceFile(doc), again = importDocument({ data: result.data }).document;
    expect(result.preservation).toBe('preserved'); expect(result.issues).toEqual([]);
    expect(nAtom(again)).toMatchObject({ isotope: 15, charge: 1, hydrogens: { mode: 'fixed', count: 2 } });
    if (kind === 'cdxml') {
      const xml = new DOMParser().parseFromString(result.data.replace(/<!DOCTYPE[^>]*>/, ''), 'application/xml');
      const label = xml.querySelector('n[Element="7"] t')!;
      expect(label.textContent).toBe('15NH2+');
      expect([...label.children].map(s => Number(s.getAttribute('face')))).toEqual([64, 0, 0, 32, 64]);
      expect([...label.children].every(s => s.getAttribute('font') === '3' && s.getAttribute('size') === '10')).toBe(true);
      expect(xml.querySelector('n[Element="7"]')?.getAttribute('id')).toBe('5');
      expect(xml.querySelector('font[name="Times New Roman"]')).not.toBeNull();
    } else {
      const objects = flatten(parseCdxTree(decodeCdx(result.data))), label = objects.find(o => o.tag === 0x8006 && o.id === 17)!;
      const text = label.props.get(0x0700)!, view = new DataView(text.buffer, text.byteOffset, text.length), count = view.getUint16(0, true);
      expect(new TextDecoder().decode(text.subarray(2 + count * 10))).toBe('15NH2+');
      expect(Array.from({ length: count }, (_, i) => view.getUint16(6 + i * 10, true))).toEqual([64, 0, 0, 32, 64]);
      expect(Array.from({ length: count }, (_, i) => [view.getUint16(4 + i * 10, true), view.getUint16(8 + i * 10, true), view.getUint16(10 + i * 10, true)])).toEqual(Array(count).fill([3, 200, 3]));
      const original = flatten(parseCdxTree(bytes()));
      for (const tag of [0x0100, 0x0300, 0x0800]) expect(objects.find(o => o.props.has(tag))?.props.get(tag)).toEqual(original.find(o => o.props.has(tag))?.props.get(tag));
    }
  });

  it('changes the element of a labeled atom while retaining unrelated document styles', () => {
    const doc = load(kind); nAtom(doc).element = 'P';
    expect(molecularFormula(save(doc))).toBe('C2H7P');
    expect(exportOriginalSource(doc).data).toBe(importDocument({ data: input(kind) }).document.source!.raw);
  });

  it('adds a connected atom and bond with unique IDs, preserving all original atom IDs', () => {
    const doc = load(kind), carbon = Object.values(doc.graph.atoms).find(a => a.element === 'C')!;
    const pos = doc.depiction.positions[carbon.id], o = addAtom(doc, 'O', { x: pos.x + 1, y: pos.y + 1 }); addBond(doc, carbon.id, o);
    const output = exportSourceFile(doc), again = importDocument({ data: output.data }).document;
    expect(molecularFormula(again)).toBe('C2H7NO'); expect(Object.keys(again.graph.bonds)).toHaveLength(3);
    const ids = kind === 'cdx' ? flatten(parseCdxTree(decodeCdx(output.data))).filter(o => o.serial).map(o => String(o.id)) :
      [...new DOMParser().parseFromString(output.data.replace(/<!DOCTYPE[^>]*>/, ''), 'application/xml').querySelectorAll('page,fragment,n,b,t')].map(e => e.getAttribute('id')!);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['4', '5', '6', '17']));
  });

  it('deletes an atom and incident bond, refreshing the surviving nitrogen label', () => {
    const doc = load(kind), carbon = Object.values(doc.graph.atoms).find(a => a.element === 'C')!;
    removeAtom(doc, carbon.id); nAtom(doc).hydrogens = { mode: 'auto' };
    const again = save(doc);
    expect(molecularFormula(again)).toBe('CH5N'); expect(Object.keys(again.graph.atoms)).toHaveLength(2); expect(Object.keys(again.graph.bonds)).toHaveLength(1);
  });

  it('removes a bond without dropping the disconnected components', () => {
    const doc = load(kind); removeBond(doc, Object.keys(doc.graph.bonds)[0]); nAtom(doc).hydrogens = { mode: 'auto' };
    const again = save(doc); expect(molecularFormula(again)).toBe('C2H9N'); expect(Object.keys(again.graph.bonds)).toHaveLength(1);
  });

  it('rewires an existing bond within its fragment and preserves bond object identities', () => {
    const doc = load(kind), cs = Object.values(doc.graph.atoms).filter(a => a.element === 'C'), b = Object.values(doc.graph.bonds)[0];
    b.atoms = [cs[1].id, cs[0].id]; nAtom(doc).hydrogens = { mode: 'auto' };
    const again = save(doc);
    expect(molecularFormula(again)).toBe('C2H7N');
    const n = nAtom(again); expect(Object.values(again.graph.bonds).filter(b => b.atoms.includes(n.id))).toHaveLength(1);
  });

  it('continues preserving after JSON restoration and after reimporting an edited source file', () => {
    let doc = load(kind); nAtom(doc).isotope = 15;
    doc = importDocument({ data: JSON.stringify(doc), format: 'json' }).document;
    doc = save(doc); const carbon = Object.values(doc.graph.atoms).find(a => a.element === 'C')!;
    removeAtom(doc, carbon.id); nAtom(doc).hydrogens = { mode: 'auto' };
    expect(nAtom(save(doc)).isotope).toBe(15);
  });

  it('saves removal of every atom as an editable empty document', () => {
    const doc = load(kind); for (const id of Object.keys(doc.graph.atoms)) removeAtom(doc, id);
    expect(Object.keys(save(doc).graph.atoms)).toHaveLength(0); expect(exportOriginalSource(doc).preservation).toBe('original');
  });
});

describe('document reference and custom-label protection', () => {
  const xml = (extra = '', label = '') => `<CDXML><page id="1"><fragment id="2"><n id="3" p="0 0" Element="7">${label}</n><n id="4" p="30 0"/><b id="5" B="3" E="4"/></fragment>${extra}</page></CDXML>`;
  it('blocks deleting or changing an externally represented atom while preserving the source', () => {
    const doc = importDocument({ data: xml('<graphic id="9"><represent attribute="Charge" object="3"/></graphic>') }).document;
    nAtom(doc).charge = 1; expect(() => exportSourceFile(doc)).toThrow('引用');
    removeAtom(doc, nAtom(doc).id); expect(() => exportSourceFile(doc)).toThrow('引用');
    expect(exportOriginalSource(doc).preservation).toBe('original');
  });
  it('preserves an unrelated graphic and custom text through graph edits', () => {
    const doc = importDocument({ data: xml('<graphic id="9" GraphicType="Rectangle" BoundingBox="40 40 80 80"/><t id="10"><s>独立注释</s></t>') }).document;
    const carbon = Object.values(doc.graph.atoms).find(a => a.element === 'C')!; removeAtom(doc, carbon.id);
    const output = exportSourceFile(doc);
    expect(output.data).toContain('独立注释'); expect(output.data).toContain('GraphicType="Rectangle"'); expect(output.data).toContain('BoundingBox="40 40 80 80"');
  });
  it.each(['custom note', 'Nickname'])('does not rewrite the custom atom label %s', text => {
    const doc = importDocument({ data: xml('', `<t><s font="3">${text}</s></t>`) }).document;
    nAtom(doc).isotope = 15; expect(() => exportSourceFile(doc)).toThrow('自定义文字');
  });
  it('does not flatten genuinely mixed-font labels', () => {
    const doc = importDocument({ data: xml('', '<t><s font="3">N</s><s font="4">H2</s></t>') }).document;
    nAtom(doc).isotope = 15; expect(() => exportSourceFile(doc)).toThrow('混合字体');
  });
  it('refuses merging source fragments', () => {
    const raw = '<CDXML><page><fragment><n id="1" p="0 0"/></fragment><fragment><n id="2" p="30 0"/></fragment></page></CDXML>';
    const doc = importDocument({ data: raw }).document; addBond(doc, ...Object.keys(doc.graph.atoms) as [string, string]);
    expect(() => exportSourceFile(doc)).toThrow('跨来源片段');
  });
  it('creates a fragment inside an originally empty single-page CDXML document', () => {
    const doc = importDocument({ data: '<CDXML><page id="1"/></CDXML>' }).document;
    addAtom(doc, 'O', { x: 0, y: 0 }); expect(molecularFormula(save(doc))).toBe('H2O');
  });
  it('blocks an actual CDX reference to an edited atom', () => {
    const source = bytes();
    const graphic = [...integers(0x8007), ...integers(30, 4), ...integers(0x000e), ...integers(6), ...integers(5, 4), ...integers(0x0421), 0, 0];
    const raw = new Uint8Array([...source.subarray(0, -2), ...graphic, ...source.subarray(-2)]);
    const doc = importDocument({ data: raw }).document; nAtom(doc).isotope = 15;
    expect(() => exportSourceFile(doc)).toThrow('引用');
  });
  it('does not guess whether an unknown CDX property contains object references', () => {
    const source = bytes(), unknown = [...integers(0x1234), ...integers(4), ...integers(5, 4)];
    const raw = new Uint8Array([...source.subarray(0, 28), ...unknown, ...source.subarray(28)]);
    const doc = importDocument({ data: raw }).document; nAtom(doc).isotope = 15;
    expect(() => exportSourceFile(doc)).toThrow('引用类型未知');
  });
  it('does not guess whether a vendor XML property encodes object references', () => {
    const doc = importDocument({ data: xml('<graphic id="9" GraphicType="Rectangle" VendorData="YWJj"/>') }).document;
    nAtom(doc).isotope = 15; expect(() => exportSourceFile(doc)).toThrow('引用类型未知');
  });
});

describe('cross-format conversion after topology edits', () => {
  it.each(['add', 'delete'])('maps all fields of ordinary CDX after an atom %s', change => {
    const data = new Uint8Array(readFileSync(resolve('tests/fixtures/cdx/rdkit-ethanol.cdx'))), doc = importDocument({ data }).document;
    if (change === 'add') { const id = addAtom(doc, 'F', { x: 2, y: 2 }); addBond(doc, Object.keys(doc.graph.atoms)[0], id); }
    else removeAtom(doc, Object.values(doc.graph.atoms).find(a => a.element === 'O')!.id);
    const output = exportDocument(doc, { format: 'cdxml' });
    expect(output.preservation).toBe('converted');
    expect(molecularFormula(importDocument({ data: output.data }).document)).toBe(change === 'add' ? 'C2H5FO' : 'C2H6');
  });
});
