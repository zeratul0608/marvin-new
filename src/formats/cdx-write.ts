import type { ChemicalDocument } from '../core/types';
import { encodeCdx } from './cdx';
import { fail } from './shared';
import { atomCdxProperties, cdxOrder } from './chemdraw-properties';
import { chemicalSymbol } from '../core/query';
import {bondTopologyCdxProperties} from './query-properties';

// Published ChemDraw SDK types: little-endian integers, signed 16.16 coordinates,
// points ordered y,x, font sizes in twentieths of a point, CDXString run offsets.
const join = (parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out; };
const uint = (n: number, width = 2, signed = false): Uint8Array => {
  const min = signed ? -(2 ** (width * 8 - 1)) : 0, max = signed ? 2 ** (width * 8 - 1) - 1 : 2 ** (width * 8) - 1;
  if (!Number.isInteger(n) || n < min || n > max) fail('数值超出 CDX 字段可表示范围', 'FORMAT_LIMIT');
  const bytes = new Uint8Array(width), view = new DataView(bytes.buffer);
  if (width === 1) view.setUint8(0, n); else if (width === 2) view.setUint16(0, n, true); else view.setUint32(0, n, true);
  return bytes;
};
const fixed = (n: number) => uint(Math.round(n * 65536), 4, true);
const prop = (tag: number, data: Uint8Array) => join([uint(tag), uint(data.length), data]);
const object = (tag: number, id: number, data: Uint8Array[]) => join([uint(tag), uint(id, 4), ...data, uint(0)]);

/** Rebuild ordinary supported 2D chemistry; document preservation is handled separately. */
export function writeCdx(doc: ChemicalDocument): string {
  const atoms = Object.values(doc.graph.atoms), bonds = Object.values(doc.graph.bonds);
  if (!atoms.length) fail('CDX 导出需要至少一个原子', 'EMPTY_CDX');
  const indices = new Map(atoms.map((a, i) => [a.id, i + 4]));
  const bondRefs = new Map(bonds.map((b, i) => [b.id, atoms.length + i + 4]));
  const ordering = (refs: (string | null)[]) => join(refs.map(id => uint(id === null ? 0 : bondRefs.get(id)!, 4)));
  let labelId = atoms.length + bonds.length + 4;
  const nodes = atoms.map(a => {
    const p = doc.depiction.positions[a.id], point = join([fixed(-p.y * 20), fixed(p.x * 20)]);
    const properties = [prop(0x0200, point), ...[...atomCdxProperties(a)].map(([tag, value]) => prop(tag, value))];
    if (a.charge) properties.push(prop(0x0421, uint(a.charge, 1, true)));
    if (a.isotope) properties.push(prop(0x0420, uint(a.isotope)));
    if (a.radical) properties.push(prop(0x0422, uint(a.radical, 1)));
    if (a.hydrogens.mode === 'fixed') properties.push(prop(0x042b, uint(a.hydrogens.count)));
    if (a.geometry) properties.push(prop(0x0430, uint(7, 1)), prop(0x0431, ordering(a.geometry.bondOrdering)));
    if (!a.attachment && (!a.query || a.query.kind !== 'any' || a.query.label !== undefined) && (a.element !== 'C' || a.charge || a.isotope || a.radical)) {
      const symbol = chemicalSymbol(a); if (/[^\x20-\x7e]/.test(symbol)) fail('此 CDX 标签字符集尚未实现，请保存 CDXML 或 JSON', 'FORMAT_LIMIT');
      const text = new TextEncoder().encode(symbol);
      const string = join([uint(1), uint(0), uint(3), uint(0x60), uint(200), uint(0), text]);
      properties.push(object(0x8006, labelId++, [prop(0x0200, point), prop(0x0700, string)]));
    }
    return object(0x8004, indices.get(a.id)!, properties);
  });
  const edges = bonds.map((b, i) => {
    const d = doc.depiction.bonds[b.id], reverse = d?.from === b.atoms[1];
    const display = d?.style === 'wedge' ? reverse ? 7 : 6 : d?.style === 'hashed' ? reverse ? 4 : 3 : d?.style === 'wavy' ? 8 : d?.style === 'dashed' ? 1 : d?.style === 'hash' ? 2 : d?.style === 'bold' ? 5 : 0;
    const properties = [prop(0x0604, uint(indices.get(b.atoms[0])!, 4)), prop(0x0605, uint(indices.get(b.atoms[1])!, 4)), prop(0x0600, uint(cdxOrder(b.order))), prop(0x0601, uint(display)),...[...bondTopologyCdxProperties(b)].map(([tag,value])=>prop(tag,value))];
    if (d?.labelOffsets) properties.push(prop(0x0608, uint(d.labelOffsets[0], 1)), prop(0x0609, uint(d.labelOffsets[1], 1)));
    if (d?.crossings) properties.push(prop(0x060e, join(d.crossings.map(id => uint(bondRefs.get(id)!, 4)))));
    if (d?.layer !== undefined) properties.push(prop(0x000a, uint(d.layer, 2, true)));
    if (b.circularOrdering) properties.push(prop(0x060b, ordering(b.circularOrdering)));
    if (b.cipLabel) properties.push(prop(0x060a, uint(b.cipLabel === 'E' ? 2 : 3, 1)));
    if (d?.doublePosition) {
      const position = d.doublePosition === 'center' ? 0 : (d.doublePosition === 'left') !== reverse ? 2 : 1;
      properties.push(prop(0x0603, uint(256 + position)));
    }
    return object(0x8005, atoms.length + i + 4, properties);
  });
  const font = new TextEncoder().encode('Arial');
  const header = new Uint8Array(22); header.set(new TextEncoder().encode('VjCD0100')); header.set([4, 3, 2, 1], 8);
  return encodeCdx(join([header, object(0x8000, 1, [
    prop(0x0100, join([uint(0), uint(1), uint(3), uint(1252), uint(font.length), font])),
    prop(0x0805, fixed(30)), prop(0x080a, join([uint(3), uint(0x60), uint(200), uint(0)])),
    object(0x8001, 2, [object(0x8003, 3, [...nodes, ...edges])]),
  ])]));
}
