import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addAtom, clone, molecularFormula } from '../src/core/model';
import { exportDocument, exportOriginalSource, exportSourceFile, importDocument } from '../src/formats';
import { decodeCdx, parseCdxTree, type CdxObject } from '../src/formats/cdx';
import { createChemicalEditor } from '../src/editor/chemical-editor';

const fixture = (name: string) => new Uint8Array(readFileSync(resolve(`tests/fixtures/cdx/${name}.cdx`)));
const flatten = (o: CdxObject): CdxObject[] => [o, ...o.children.flatMap(flatten)];
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); });

describe('source-preserving saves', () => {
  it.each(['dimethylamine-simple', 'dimethylamine-styled', 'rdkit-ethanol'])('returns exact original %s bytes even after editing', name => {
    const bytes = fixture(name), doc = importDocument({ data: bytes }).document;
    const original = exportSourceFile(doc);
    expect(original.preservation).toBe('original'); expect(decodeCdx(original.data)).toEqual(bytes);
    Object.values(doc.graph.atoms)[0].isotope = 15;
    expect(decodeCdx(exportOriginalSource(doc).data)).toEqual(bytes);
    expect(doc.graph.atoms).not.toEqual(importDocument({ data: bytes }).document.graph.atoms);
  });

  it('moves a labeled atom in CDX by patching only its point and attached label geometry', () => {
    const bytes = fixture('dimethylamine-styled'), doc = importDocument({ data: bytes }).document;
    const n = Object.values(doc.graph.atoms).find(a => a.element === 'N')!;
    doc.depiction.positions[n.id].x += .01;
    const saved = exportSourceFile(doc), result = decodeCdx(saved.data);
    expect(saved.preservation).toBe('preserved'); expect(saved.issues).toEqual([]);
    expect(result.length).toBe(bytes.length);
    const nitrogen = flatten(parseCdxTree(bytes)).find(o => o.tag === 0x8004 && o.id === 5)!;
    const allowed = new Set<number>();
    for (const object of flatten(nitrogen)) for (const tag of [0x0200, 0x0204]) {
      const data = object.props.get(tag); if (data) for (let i = data.byteOffset - bytes.byteOffset; i < data.byteOffset - bytes.byteOffset + data.length; i++) allowed.add(i);
    }
    for (let i = 0; i < bytes.length; i++) if (!allowed.has(i)) expect(result[i], `unmodified byte ${i}`).toBe(bytes[i]);
    const again = importDocument({ data: result }).document;
    const importedN = Object.values(again.graph.atoms).find(a => a.element === 'N')!;
    expect(again.depiction.positions[importedN.id].x).toBeCloseTo(doc.depiction.positions[n.id].x, 5);
    expect(molecularFormula(again)).toBe('C2H7N');
  });

  it('inserts and removes CDX numeric properties without rebuilding document fields', () => {
    const doc = importDocument({ data: fixture('rdkit-ethanol') }).document;
    const o = Object.values(doc.graph.atoms).find(a => a.element === 'O')!;
    o.isotope = 18; o.charge = -1; o.hydrogens = { mode: 'fixed', count: 0 };
    const exported = exportSourceFile(doc), again = importDocument({ data: exported.data }).document;
    expect(Object.values(again.graph.atoms).find(a => a.element === 'O')).toMatchObject({ isotope: 18, charge: -1, hydrogens: { mode: 'fixed', count: 0 } });
    const root = parseCdxTree(decodeCdx(exported.data));
    expect(flatten(root).find(o => o.props.has(0x0805))?.props.get(0x0805)).toEqual(flatten(parseCdxTree(fixture('rdkit-ethanol'))).find(o => o.props.has(0x0805))?.props.get(0x0805));
    const changed = Object.values(again.graph.atoms).find(a => a.element === 'O')!;
    delete changed.isotope; changed.hydrogens = { mode: 'auto' };
    expect(Object.values(importDocument({ data: exportSourceFile(again).data }).document.graph.atoms).find(a => a.element === 'O')?.isotope).toBeUndefined();
  });

  it('patches a binary wedge anchor and subsequent bond order without reusing stale stereo caches', () => {
    const doc = importDocument({ data: fixture('rdkit-ethanol') }).document;
    const bond = Object.values(doc.graph.bonds)[0];
    doc.depiction.bonds[bond.id] = { style: 'wedge', from: bond.atoms[1] };
    const output = exportSourceFile(doc);
    const again = importDocument({ data: output.data }).document, b = Object.values(again.graph.bonds)[0];
    expect(again.depiction.bonds[b.id]).toEqual({ style: 'wedge', from: b.atoms[1] });
    b.order = 2; delete again.depiction.bonds[b.id];
    const changed = importDocument({ data: exportSourceFile(again).data }).document;
    expect(Object.values(changed.graph.bonds)[0].order).toBe(2);
    expect(Object.keys(changed.depiction.bonds)).toHaveLength(0);
  });

  const xml = '<?xml version="1.0"?><!DOCTYPE CDXML SYSTEM "http://example.invalid/cdxml.dtd"><CDXML BondLength="30"><!-- keep comment --><fonttable><font id="9" name="Courier"/></fonttable><page id="1"><fragment id="2"><n id="3" p="0 0" Element="8"/></fragment><t id="8" p="50 50"><s font="9">keep &lt;text&gt; &amp; symbols</s></t><graphic id="7" GraphicType="Rectangle" BoundingBox="40 40 80 80"/></page></CDXML>';
  it('preserves CDXML text, comments, graphics, fonts, IDs and external DOCTYPE when moving an atom', () => {
    const doc = importDocument({ data: xml }).document;
    doc.depiction.positions[Object.keys(doc.graph.atoms)[0]].x = 2;
    const saved = exportDocument(doc, { format: 'cdxml' });
    expect(saved.preservation).toBe('preserved'); expect(saved.issues).toEqual([]);
    expect(saved.data).toContain('<!-- keep comment -->'); expect(saved.data).toContain('http://example.invalid/cdxml.dtd');
    const dom = new DOMParser().parseFromString(saved.data.replace(/<!DOCTYPE[^>]*>/, ''), 'application/xml');
    expect(dom.querySelector('font')?.getAttribute('name')).toBe('Courier');
    expect(Object.fromEntries([...dom.querySelector('graphic')!.attributes].map(a => [a.name, a.value]))).toEqual({ id: '7', GraphicType: 'Rectangle', BoundingBox: '40 40 80 80' });
    expect(dom.querySelector('t')?.textContent).toBe('keep <text> & symbols');
    expect(dom.querySelector('n')?.getAttribute('id')).toBe('3');
    expect(dom.querySelector('n')?.getAttribute('p')).toBe('40 0');
  });

  it('patches unlabelled atom fields and bond depiction in CDXML without dropping extra objects', () => {
    const raw = '<CDXML><page><fragment><n id="1" p="0 0"/><n id="2" p="30 0" Element="8"/><b id="3" B="1" E="2"/></fragment><graphic id="4" GraphicType="Rectangle"/></page></CDXML>';
    const doc = importDocument({ data: raw }).document, atoms = Object.values(doc.graph.atoms), bond = Object.values(doc.graph.bonds)[0];
    atoms[0].isotope = 13; atoms[1].charge = -1; atoms[1].hydrogens = { mode: 'fixed', count: 0 };
    doc.depiction.bonds[bond.id] = { style: 'hashed', from: bond.atoms[1] };
    const saved = exportSourceFile(doc);
    expect(saved.data).toContain('GraphicType="Rectangle"'); expect(saved.data).toContain('WedgedHashEnd');
    const again = importDocument({ data: saved.data }).document;
    expect(Object.values(again.graph.atoms)[0].isotope).toBe(13);
    expect(Object.values(again.graph.atoms)[1].charge).toBe(-1);
  });

  it('retains XML namespaces while patching qualified atom nodes', () => {
    const raw = '<c:CDXML xmlns:c="urn:cdxml"><c:page><c:fragment><c:n id="1" p="0 0" Element="8"/></c:fragment></c:page></c:CDXML>';
    const doc = importDocument({ data: raw }).document;
    doc.depiction.positions[Object.keys(doc.graph.atoms)[0]].x = 1;
    const output = exportSourceFile(doc);
    expect(output.data).toContain('xmlns:c="urn:cdxml"');
    expect(output.data).toContain('p="20 0"');
  });

  it('uses stable original IDs after JSON recovery and atom table reordering', () => {
    const initial = importDocument({ data: fixture('rdkit-ethanol') }).document;
    const doc = importDocument({ data: exportDocument(initial, { format: 'json' }).data }).document;
    doc.graph.atoms = Object.fromEntries(Object.entries(doc.graph.atoms).reverse());
    const c = Object.values(doc.graph.atoms).find(a => a.element === 'C')!; c.isotope = 13;
    // Source bindings follow stable baseline IDs, not the insertion order after restoration.
    const result = importDocument({ data: exportSourceFile(doc).data }).document;
    expect(Object.values(result.graph.atoms).filter(a => a.isotope === 13)).toHaveLength(1);
    expect(decodeCdx(exportOriginalSource(doc).data)).toEqual(fixture('rdkit-ethanol'));
  });

  it.each(['cdx', 'cdxml'])('refuses topology edits in strict %s preservation while keeping the original available', kind => {
    const doc = importDocument({ data: kind === 'cdx' ? fixture('rdkit-ethanol') : xml }).document;
    addAtom(doc, 'F', { x: 0, y: 1 });
    expect(() => exportSourceFile(doc)).toThrow('新增、删除');
    if (kind === 'cdxml') expect(() => exportDocument(doc, { format: 'cdxml' })).toThrow('导出已阻止');
    expect(exportOriginalSource(doc).preservation).toBe('original');
  });

  it('refuses label chemistry changes, out-of-bounds layout and values outside binary limits', () => {
    const doc = importDocument({ data: fixture('dimethylamine-styled') }).document;
    const n = Object.values(doc.graph.atoms).find(a => a.element === 'N')!;
    n.element = 'O'; expect(() => exportSourceFile(doc)).toThrow('标签');
    n.element = 'N'; doc.depiction.positions[n.id].x = 1000;
    expect(() => exportSourceFile(doc)).toThrow('包围框');
    const simple = importDocument({ data: fixture('rdkit-ethanol') }).document;
    Object.values(simple.graph.atoms)[0].charge = 128;
    expect(() => exportSourceFile(simple)).toThrow('数值超出');
  });

  it('refuses a malformed or mismatched baseline instead of patching the wrong objects', () => {
    const doc = importDocument({ data: fixture('rdkit-ethanol') }).document;
    Object.values(doc.graph.atoms)[0].isotope = 13;
    const bad = clone(doc); bad.source!.fingerprint = '{}';
    expect(() => exportSourceFile(bad)).toThrow('基线无效');
    const mismatch = clone(doc), original = JSON.parse(mismatch.source!.fingerprint);
    Object.values(original.graph.atoms as Record<string, { element: string }>)[0].element = 'N';
    mismatch.source!.fingerprint = JSON.stringify(original);
    expect(() => exportSourceFile(mismatch)).toThrow('不匹配');
  });

  it.each(['dimethylamine-simple', 'rdkit-ethanol', 'rdkit-benzene', 'rdkit-isotopes-charges'])('maps all fields of %s to CDXML without dropping unknown data', name => {
    const doc = importDocument({ data: fixture(name) }).document;
    const result = exportDocument(doc, { format: 'cdxml' });
    expect(result.preservation).toBe('converted'); expect(result.issues).toEqual([]);
    expect(molecularFormula(importDocument({ data: result.data }).document)).toBe(molecularFormula(doc));
    const root = parseCdxTree(fixture(name));
    for (const object of flatten(root).filter(o => o.tag === 0x8004)) expect(result.data).toContain(`id="${object.id}"`);
  });

  it('refuses cross-format conversion of unimplemented document fields while preserving same-format data', () => {
    const doc = importDocument({ data: fixture('dimethylamine-styled') }).document;
    expect(() => exportDocument(doc, { format: 'cdxml' })).toThrow('导出已阻止');
    const lossy = exportDocument(doc, { format: 'cdxml', allowLossy: true });
    expect(lossy.issues.some(i => i.code === 'DOCUMENT_PRESERVATION_UNAVAILABLE')).toBe(true);
    expect(decodeCdx(exportSourceFile(doc).data)).toEqual(fixture('dimethylamine-styled'));
  });

  it('exposes original and preserved saves through the JSON command API', async () => {
    const editor = createChemicalEditor({ container: document.body });
    editor.import({ data: fixture('rdkit-ethanol') });
    const atom = Object.values(editor.getDocument().graph.atoms)[0];
    editor.applyEdits({ operations: [{ type: 'update-atom', atomId: atom.id, changes: { isotope: 13 } }] });
    expect(await editor.execute({ method: 'export_source', params: {} })).toMatchObject({ preservation: 'preserved', format: 'cdx' });
    expect(await editor.execute({ method: 'export_source', params: { original: true } })).toMatchObject({ preservation: 'original' });
    editor.destroy();
  });
});
