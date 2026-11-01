import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeCdx, encodeCdx } from '../src/formats/cdx';
import { detectFormat, exportDocument, FormatError, importDocument } from '../src/formats';
import { connectedComponents, molecularFormula } from '../src/core/model';
import { exampleDocument } from '../src/core/templates';
import { createChemicalEditor } from '../src/editor/chemical-editor';
import type { Format } from '../src/core/types';

const fixture = (name: string) => new Uint8Array(readFileSync(resolve('tests/fixtures/cdx', `${name}.cdx`)));
const uint = (value: number, size = 2): number[] => Array.from({ length: size }, (_, index) => (value >>> (index * 8)) & 255);
const prop = (tag: number, bytes: number[], extended = false) => [...uint(tag), ...uint(extended ? 65535 : bytes.length), ...(extended ? uint(bytes.length, 4) : []), ...bytes];
const object = (tag: number, id: number, content: number[]) => [...uint(tag), ...uint(id, 4), ...content, 0, 0];
const position = (x = 0, y = 0) => prop(0x0200, [...uint(Math.round(y * 65536), 4), ...uint(Math.round(x * 65536), 4)]);
const node = (id: number, extra: number[] = []) => object(0x8004, id, [...position(id * 30, -15), ...extra]);
const bond = (id: number, begin: number, end: number, extra: number[] = []) => object(0x8005, id, [...prop(0x0604, uint(begin, 4)), ...prop(0x0605, uint(end, 4)), ...extra]);
const fragment = (id: number, content: number[]) => object(0x8003, id, content);
const header = [...new TextEncoder().encode('VjCD0100'), 4, 3, 2, 1, ...Array(16).fill(0)];
const cdx = (content: number[], explicitDocument = false) => new Uint8Array([...header, ...(explicitDocument ? object(0x8000, 42, content) : [...content, 0, 0])]);
const molecule = (content: number[]) => cdx(object(0x8001, 1, fragment(2, content)));
const atom = (extra: number[]) => molecule(node(3, extra));

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); });

describe('binary ChemDraw CDX import', () => {
  it.each([
    ['ethanol', 'C2H6O', 3, 2], ['benzene', 'C6H6', 6, 6], ['isotopes-charges', 'CH6ClN', 3, 1],
  ])('reads independently generated RDKit %s binary files', (name, formula, atoms, bonds) => {
    const bytes = fixture(`rdkit-${name}`);
    const { document } = importDocument({ data: bytes });
    expect(molecularFormula(document)).toBe(formula);
    expect(Object.keys(document.graph.atoms)).toHaveLength(atoms);
    expect(Object.keys(document.graph.bonds)).toHaveLength(bonds);
    expect(decodeCdx(document.source!.raw)).toEqual(bytes);
    if (name === 'isotopes-charges') {
      expect(Object.values(document.graph.atoms)).toEqual(expect.arrayContaining([
        expect.objectContaining({ element: 'C', isotope: 13 }),
        expect.objectContaining({ element: 'N', isotope: 15, charge: 1 }),
        expect.objectContaining({ element: 'Cl', charge: -1 }),
      ]));
    }
  });

  it('refuses the third-party ring stereo file without altering the current document', () => {
    const editor = createChemicalEditor({ container: document.body, document: exampleDocument('ethanol') });
    const before = editor.getDocument();
    expect(() => editor.import({ data: fixture('rdkit-ring-stereo1') })).toThrow('0x0445');
    expect(editor.getDocument()).toEqual(before);
    editor.destroy();
  });

  it('still rejects invalid version, reserved bytes and truncation in the 22-byte preamble variant', () => {
    const original = fixture('rdkit-ethanol');
    for (const offset of [8, 12, 21, 23]) {
      const invalid = original.slice(); invalid[offset] = 5;
      expect(() => importDocument({ data: invalid })).toThrow(FormatError);
    }
    expect(() => importDocument({ data: original.slice(0, 50) })).toThrow('截断');
  });

  it.each(['dimethylamine-simple', 'dimethylamine-styled'])('parses the public SDK %s file and preserves its exact source', name => {
    const data = fixture(name);
    expect(detectFormat(data)).toBe('cdx');
    const { document, issues } = importDocument({ data, name: `${name}.cdx` });
    expect(molecularFormula(document)).toBe('C2H7N');
    expect(Object.keys(document.graph.atoms)).toHaveLength(3);
    expect(Object.keys(document.graph.bonds)).toHaveLength(2);
    const nitrogen = Object.values(document.graph.atoms).find(a => a.element === 'N')!;
    expect(document.depiction.positions[nitrogen.id]).toEqual({ x: 148.5 / 20, y: -164.25 / 20 });
    expect(document.source?.format).toBe('cdx');
    expect(decodeCdx(document.source!.raw)).toEqual(data);
    const native = exportDocument(document, { format: 'json' }).data;
    expect(importDocument({ data: native }).document).toEqual(document);
    if (name.includes('styled')) {
      expect(issues.some(issue => issue.severity === 'warning')).toBe(true);
      expect(() => exportDocument(document, { format: 'mrv' })).toThrow('导出已阻止');
    }
    const converted = exportDocument(document, { format: 'mol-v3000', allowLossy: true });
    expect(molecularFormula(importDocument({ data: converted.data }).document)).toBe('C2H7N');
  });

  it('supports SDK ArrayBuffer, offset Uint8Array, explicit and detected Base64 inputs', () => {
    const bytes = fixture('dimethylamine-simple');
    const offset = new Uint8Array(bytes.length + 20); offset.set(bytes, 9);
    for (const data of [bytes.slice().buffer, offset.subarray(9, 9 + bytes.length), encodeCdx(bytes)]) {
      expect(molecularFormula(importDocument({ data }).document)).toBe('C2H7N');
    }
    expect(molecularFormula(importDocument({ data: encodeCdx(bytes).slice('cdx:base64,'.length), format: 'cdx' }).document)).toBe('C2H7N');
    expect(() => exportDocument(importDocument({ data: bytes }).document, { format: 'cdx' as Format })).toThrow('exportSourceFile');
  });

  it('supports an explicit document wrapper and scopes atom references to each fragment', () => {
    const contents = object(0x8001, 1, [
      ...fragment(2, [...node(3), ...node(4), ...bond(5, 3, 4)]),
      ...fragment(6, [...node(3), ...node(4, prop(0x0402, uint(8))), ...bond(5, 3, 4)]),
    ]);
    const document = importDocument({ data: cdx(contents, true) }).document;
    expect(Object.keys(document.graph.atoms)).toHaveLength(4);
    expect(connectedComponents(document)).toHaveLength(2);
    expect(molecularFormula(document)).toBe('C3H10O');
  });

  it('maps isotope, signed charge, explicit zero hydrogens and the legacy Fixed charge field', () => {
    const data = molecule([
      ...node(3, [...prop(0x0402, uint(8)), ...prop(0x0421, [255]), ...prop(0x0420, uint(18)), ...prop(0x042b, uint(0))]),
      ...node(4, [...prop(0x0402, uint(7)), ...prop(0x0421, uint(0x01000000, 4))]),
    ]);
    const result = Object.values(importDocument({ data }).document.graph.atoms);
    expect(result[0]).toMatchObject({ element: 'O', isotope: 18, charge: -1, hydrogens: { mode: 'fixed', count: 0 } });
    expect(result[1]).toMatchObject({ element: 'N', charge: 1, hydrogens: { mode: 'auto' } });
    const natural = Object.values(importDocument({ data: atom(prop(0x0420, uint(0))) }).document.graph.atoms)[0];
    expect(natural.isotope).toBeUndefined();
  });

  it.each([[1, 1], [2, 2], [4, 3], [128, 'aromatic']] as const)('maps CDX order bit %s to model order %s', (encoded, order) => {
    const data = molecule([...node(3), ...node(4), ...bond(5, 3, 4, prop(0x0600, uint(encoded)))]);
    expect(Object.values(importDocument({ data }).document.graph.bonds)[0].order).toBe(order);
  });

  it.each([[3, 'hashed', 0], [4, 'hashed', 1], [6, 'wedge', 0], [7, 'wedge', 1], [8, 'wavy', 0]] as const)('preserves depiction %s and its endpoint', (display, style, anchor) => {
    const data = molecule([...node(3), ...node(4), ...bond(5, 3, 4, prop(0x0601, uint(display)))]);
    const document = importDocument({ data }).document, b = Object.values(document.graph.bonds)[0];
    expect(document.depiction.bonds[b.id]).toEqual({ style, from: b.atoms[anchor] });
  });

  it('reads extended-length properties and diagnoses unrepresented graphical content', () => {
    const data = molecule([...node(3), ...object(0x8006, 9, prop(0x0700, Array(66000).fill(0), true))]);
    const { document, issues } = importDocument({ data });
    expect(Object.keys(document.graph.atoms)).toHaveLength(1);
    expect(issues.some(issue => issue.code === 'UNSUPPORTED_CDX_CONTENT')).toBe(true);
    expect(() => exportDocument(document, { format: 'cdxml' })).toThrow('导出已阻止');
    expect(decodeCdx(document.source!.raw)).toEqual(data);
  });

  it.each([
    atom(prop(0x0400, uint(4))), atom(prop(0x0422, [2])), atom(prop(0x0437, [2])),
    atom(prop(0x0403, [1, 0, 7, 0])), atom(prop(0x0201, Array(12).fill(0))), atom(prop(0x0450, [0])),
    molecule([...node(3), ...node(4), ...bond(5, 3, 4, prop(0x0600, uint(3)))]),
    molecule([...node(3), ...node(4), ...bond(5, 3, 4, prop(0x0600, uint(4096)))]),
    molecule([...node(3), ...object(0x800d, 9, [])]), molecule([...node(3), ...object(0x8017, 9, [])]),
    molecule([...node(3), ...object(0x800a, 9, [])]), molecule(fragment(9, node(3))),
  ])('rejects unsupported chemical semantics instead of changing them silently', data => {
    expect(() => importDocument({ data })).toThrow(FormatError);
  });

  it('rejects truncation at every boundary of the SDK example', () => {
    const bytes = fixture('dimethylamine-simple');
    for (let length = 0; length < bytes.length; length++) expect(() => importDocument({ data: bytes.subarray(0, length), format: 'cdx' })).toThrow(FormatError);
  });

  it.each([
    molecule([...node(3), ...node(3)]), molecule([...node(3), ...bond(5, 3, 99)]),
    molecule([...node(3), ...bond(5, 3, 3)]), molecule([...node(3), ...node(4), ...bond(5, 3, 4), ...bond(6, 4, 3)]),
    molecule(node(3, prop(0x0402, uint(0)))), molecule(node(3, prop(0x0402, [6]))),
    cdx(node(3)), cdx(object(0x8001, 1, fragment(2, object(0x8004, 3, [])))),
    molecule([...node(3), ...node(4), ...bond(5, 0, 4)]),
  ])('rejects corrupt references, duplicate objects and invalid property values', data => { expect(() => importDocument({ data })).toThrow(FormatError); });

  it('bounds file size, nesting and Base64 before allocating or projecting content', () => {
    expect(() => importDocument({ data: new Uint8Array(2_000_001), format: 'cdx' })).toThrow('2 MB');
    expect(() => importDocument({ data: 'A'.repeat(2_666_672), format: 'cdx' })).toThrow('2 MB');
    expect(() => importDocument({ data: 'cdx:base64,broken!' })).toThrow('Base64');
    let nested = node(3); for (let i = 0; i < 65; i++) nested = object(0x8002, i + 50, nested);
    expect(() => importDocument({ data: cdx(nested) })).toThrow('嵌套深度');
  });

  it('imports CDX through the file chooser, restores its draft and preserves state on failure', async () => {
    const editor = createChemicalEditor({ container: document.body, document: exampleDocument('ethanol'), storageKey: 'cdx-draft' });
    const original = editor.getDocument(), input = editor.shadowRoot!.querySelector<HTMLInputElement>('.file-input')!;
    const bytes = fixture('dimethylamine-simple');
    const file = new File([bytes.slice().buffer], 'sample.cdx');
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(editor.shadowRoot!.querySelector<HTMLTextAreaElement>('.import-source')!.value).toContain('已选择 CDX 文件：sample.cdx'));
    expect(editor.shadowRoot!.querySelector<HTMLTextAreaElement>('.import-source')!.readOnly).toBe(true);
    editor.shadowRoot!.querySelector<HTMLButtonElement>('[data-action="apply-import"]')!.click();
    expect(molecularFormula(editor.getDocument())).toBe('C2H7N');
    const imported = editor.getDocument();
    expect(() => editor.import({ data: bytes.subarray(0, 50), format: 'cdx' })).toThrow();
    expect(editor.getDocument()).toEqual(imported);
    editor.undo(); expect(editor.getDocument()).toEqual(original);
    editor.redo(); expect(editor.getDocument()).toEqual(imported);
    editor.destroy();
    const restored = createChemicalEditor({ container: document.body, storageKey: 'cdx-draft' });
    expect(restored.getDocument()).toEqual(imported); expect(restored.restored).toBe(true);
    restored.destroy();
  });
});
