import { atomicNumber, hydrogenCount, validateDocument } from '../core/model';
import type { ChemicalDocument, SourceFileExportResult } from '../core/types';
import { decodeCdx, encodeCdx, parseCdxTree, readCdx, type CdxObject } from './cdx';
import { readCdxml } from './xml';
import { escapeXml, fail } from './shared';

const canonical = (value: unknown): string | undefined => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : v);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const blocked = (reason: string): never => fail(`无法保留源文档保存：${reason}。可保存原生 JSON，或明确选择有损重建。`, 'PRESERVATION_UNSUPPORTED');
const list = (node: CdxObject): CdxObject[] => [node, ...node.children.flatMap(list)];
const pointText = (x: number, y: number) => `${x * 20} ${-y * 20}`;

function projection(doc: ChemicalDocument, order?: ChemicalDocument) {
  const atoms = order ? Object.keys(order.graph.atoms).map(id => doc.graph.atoms[id]) : Object.values(doc.graph.atoms), ids = new Map(atoms.map((a, i) => [a.id, i]));
  const bonds = order ? Object.keys(order.graph.bonds).map(id => doc.graph.bonds[id]) : Object.values(doc.graph.bonds);
  return {
    atoms: atoms.map(({ id: _, ...a }) => a), positions: atoms.map(a => doc.depiction.positions[a.id]),
    bonds: bonds.map(b => ({ atoms: b.atoms.map(a => ids.get(a)), order: b.order,
      depiction: doc.depiction.bonds[b.id] ? { style: doc.depiction.bonds[b.id].style, from: ids.get(doc.depiction.bonds[b.id].from) } : undefined })),
  };
}

function matchesProjection(parsed: ChemicalDocument, doc: ChemicalDocument, order: ChemicalDocument, tolerance: number) {
  const a = projection(parsed), b = projection(doc, order);
  return same(a.atoms, b.atoms) && same(a.bonds, b.bonds) && a.positions.length === b.positions.length &&
    a.positions.every((p, i) => Math.abs(p.x - b.positions[i].x) <= tolerance && Math.abs(p.y - b.positions[i].y) <= tolerance);
}

/** Existing fingerprints retain the original stable IDs, including after native JSON restoration. */
function baseline(doc: ChemicalDocument, parsed: ChemicalDocument): ChemicalDocument {
  let before: ChemicalDocument;
  try {
    const initial = JSON.parse(doc.source!.fingerprint);
    before = { schemaVersion: 1, id: doc.id, title: initial.title, graph: initial.graph, depiction: initial.depiction };
    validateDocument(before);
  } catch { return blocked('来源基线无效'); }
  if (!same(projection(before), projection(parsed))) return blocked('原始文件与来源基线不匹配');
  const a = Object.keys(before.graph.atoms), b = Object.keys(before.graph.bonds);
  if (a.length !== Object.keys(doc.graph.atoms).length || a.some(id => !doc.graph.atoms[id]) ||
      b.length !== Object.keys(doc.graph.bonds).length || b.some(id => !doc.graph.bonds[id] || !same(before.graph.bonds[id].atoms, doc.graph.bonds[id].atoms))) {
    return blocked('新增、删除或重新连接对象尚不能保留所有外部文档引用');
  }
  for (const id of a) if (before.graph.atoms[id].atomMap !== doc.graph.atoms[id].atomMap) return blocked('原子映射的保留写入尚未实现');
  return before;
}

function guardLabel(before: ChemicalDocument, doc: ChemicalDocument, id: string, hasLabel: boolean) {
  if (hasLabel && (!same(before.graph.atoms[id], doc.graph.atoms[id]) || hydrogenCount(before, id) !== hydrogenCount(doc, id))) {
    blocked('该化学修改需要重排原子标签，尚不能保证原标签的字体、上下标与图形一致');
  }
}

export function exportOriginalSource(doc: ChemicalDocument): SourceFileExportResult {
  validateDocument(doc);
  if (!doc.source) return blocked('当前文档没有原始文件');
  if (doc.source.format === 'cdx') decodeCdx(doc.source.raw);
  return { data: doc.source.raw, format: doc.source.format, issues: [], passthrough: true, preservation: 'original' };
}

/** Save the current projection by changing only supported fields of the original document. */
export function exportSourceFile(doc: ChemicalDocument): SourceFileExportResult {
  validateDocument(doc);
  if (!doc.source) return blocked('当前文档没有原始文件');
  const current = JSON.stringify({ title: doc.title, graph: doc.graph, depiction: doc.depiction });
  if (current === doc.source.fingerprint) return exportOriginalSource(doc);
  const data = doc.source.format === 'cdx' ? patchCdx(doc) : doc.source.format === 'cdxml' ? patchCdxml(doc) : blocked('此来源格式暂未实现保留编辑');
  return { data, format: doc.source.format, issues: [], passthrough: false, preservation: 'preserved' };
}

function numericPoint(value: string): number[] {
  const point = value.trim().split(/\s+/).map(Number);
  if (!point.length || point.some(n => !Number.isFinite(n))) return blocked('关联排版坐标无法解释');
  return point;
}
function inside(point: number[], box: number[]) { return point[0] >= box[0] && point[0] <= box[2] && point[1] >= box[1] && point[1] <= box[3]; }

function patchCdxml(doc: ChemicalDocument): string {
  const raw = doc.source!.raw, original = readCdxml(raw).document, before = baseline(doc, original);
  const text = raw.replace(/<!DOCTYPE[^>]*>/gi, '');
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  const nodes = [...xml.getElementsByTagName('*')].filter(e => e.localName === 'n'), bonds = [...xml.getElementsByTagName('*')].filter(e => e.localName === 'b');
  const atoms = Object.values(before.graph.atoms);
  for (const [i, old] of atoms.entries()) {
    const node = nodes[i], now = doc.graph.atoms[old.id];
    guardLabel(before, doc, old.id, node.children.length > 0);
    const p = doc.depiction.positions[old.id], previous = before.depiction.positions[old.id];
    if (!same(p, previous)) {
      const dx = (p.x - previous.x) * 20, dy = -(p.y - previous.y) * 20;
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        if (parent.hasAttribute('BoundingBox') && !inside([p.x * 20, -p.y * 20], numericPoint(parent.getAttribute('BoundingBox')!))) blocked('移动超出来源包围框，无法确认未解释的页面排版');
      }
      for (const el of [node, ...node.getElementsByTagName('*')]) {
        for (const attr of ['p', 'BoundingBox']) if (el.hasAttribute(attr)) {
          const values = numericPoint(el.getAttribute(attr)!);
          if (values.length !== (attr === 'p' ? 2 : 4)) blocked('关联排版坐标长度无效');
          el.setAttribute(attr, values.map((n, j) => n + (j % 2 ? dy : dx)).join(' '));
        }
      }
      node.setAttribute('p', pointText(p.x, p.y));
    }
    if (old.element !== now.element) node.setAttribute('Element', String(atomicNumber(now.element)));
    if (old.charge !== now.charge) node.setAttribute('Charge', String(now.charge));
    if (old.isotope !== now.isotope) { if (now.isotope === undefined) node.removeAttribute('Isotope'); else node.setAttribute('Isotope', String(now.isotope)); }
    if (!same(old.hydrogens, now.hydrogens)) { if (now.hydrogens.mode === 'auto') node.removeAttribute('NumHydrogens'); else node.setAttribute('NumHydrogens', String(now.hydrogens.count)); }
  }
  for (const [i, old] of Object.values(before.graph.bonds).entries()) {
    const now = doc.graph.bonds[old.id], el = bonds[i], d = doc.depiction.bonds[old.id];
    if (old.order !== now.order) el.setAttribute('Order', now.order === 'aromatic' ? '1.5' : String(now.order));
    if (!same(before.depiction.bonds[old.id], d)) el.setAttribute('Display', d?.style === 'wedge' ? `Wedge${d.from === now.atoms[1] ? 'End' : 'Begin'}` : d?.style === 'hashed' ? `WedgedHash${d.from === now.atoms[1] ? 'End' : 'Begin'}` : d?.style === 'wavy' ? 'Wavy' : 'Solid');
  }
  if (!same(before.graph.atoms, doc.graph.atoms) || !same(before.graph.bonds, doc.graph.bonds) || !same(before.depiction.bonds, doc.depiction.bonds)) {
    for (const el of nodes) el.removeAttribute('AS'); for (const el of bonds) el.removeAttribute('BS');
  }
  const declaration = raw.match(/^\s*<\?xml[^?]*\?>/)?.[0] ?? '<?xml version="1.0" encoding="UTF-8"?>';
  const doctype = raw.match(/<!DOCTYPE[^>]*>/i)?.[0];
  // Chromium can include the original XML declaration when serializing a Document.
  const body = new XMLSerializer().serializeToString(xml).replace(/^\s*<\?xml[^?]*\?>/, '');
  const output = `${declaration}\n${doctype ? doctype + '\n' : ''}${body}`;
  if (!matchesProjection(readCdxml(output).document, doc, before, 1e-10)) return blocked('保留结果的化学内容复核失败');
  return output;
}

const int = (value: number, size: number, signed = false): Uint8Array => {
  if (!Number.isInteger(value) || value < (signed ? -(2 ** (size * 8 - 1)) : 0) || value > (signed ? 2 ** (size * 8 - 1) - 1 : 2 ** (size * 8) - 1)) return blocked('数值超出源格式可表示范围');
  const bytes = new Uint8Array(size), v = new DataView(bytes.buffer);
  if (size === 1) v.setUint8(0, value); else if (size === 2) v.setUint16(0, value, true); else v.setInt32(0, value, true);
  return bytes;
};
const join = (parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, a) => n + a.length, 0)); let offset = 0; for (const a of parts) { out.set(a, offset); offset += a.length; } return out; };
const fixed = (value: number) => int(Math.round(value * 65536), 4, true);
const number = (bytes: Uint8Array, signed = false) => { const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length); return bytes.length === 1 ? signed ? v.getInt8(0) : v.getUint8(0) : bytes.length === 2 ? signed ? v.getInt16(0, true) : v.getUint16(0, true) : signed ? v.getInt32(0, true) : v.getUint32(0, true); };

function patchCdx(doc: ChemicalDocument): string {
  const bytes = decodeCdx(doc.source!.raw), root = parseCdxTree(bytes), objects = list(root);
  const before = baseline(doc, readCdx(bytes).document);
  const nodes = objects.filter(o => o.tag === 0x8004), bonds = objects.filter(o => o.tag === 0x8005);
  const edits = new Map<number, { end: number; data: Uint8Array }>(), additions = new Map<CdxObject, Uint8Array[]>();
  const set = (o: CdxObject, tag: number, value?: Uint8Array) => {
    const data = value ? join([int(tag, 2), int(value.length, 2), value]) : new Uint8Array();
    const range = o.ranges.get(tag);
    if (range) edits.set(range.start, { end: range.end, data });
    else if (value) { const parts = additions.get(o) ?? []; parts.push(data); additions.set(o, parts); }
  };
  for (const [i, old] of Object.values(before.graph.atoms).entries()) {
    const node = nodes[i], now = doc.graph.atoms[old.id];
    guardLabel(before, doc, old.id, node.children.length > 0);
    const p = doc.depiction.positions[old.id], previous = before.depiction.positions[old.id];
    if (!same(p, previous)) {
      const dx = (p.x - previous.x) * 20, dy = -(p.y - previous.y) * 20;
      for (let parent = node.parent; parent; parent = parent.parent) {
        const box = parent.props.get(0x0204);
        if (box) { if (box.length !== 16) blocked('来源包围框长度无效'); const b = Array.from({ length: 4 }, (_, j) => number(box.subarray(j * 4, j * 4 + 4), true) / 65536); if (!inside([p.x * 20, -p.y * 20], [b[1], b[0], b[3], b[2]])) blocked('移动超出来源包围框，无法确认未解释的页面排版'); }
      }
      for (const object of list(node)) for (const tag of [0x0200, 0x0204]) {
        const data = object.props.get(tag); if (!data) continue;
        if (data.length !== (tag === 0x0200 ? 8 : 16)) blocked('关联排版坐标长度无效');
        set(object, tag, join(Array.from({ length: data.length / 4 }, (_, j) => fixed(number(data.subarray(j * 4, j * 4 + 4), true) / 65536 + (j % 2 ? dx : dy)))));
      }
      set(node, 0x0200, join([fixed(-p.y * 20), fixed(p.x * 20)]));
    }
    if (old.element !== now.element) set(node, 0x0402, int(atomicNumber(now.element), 2));
    if (old.charge !== now.charge) set(node, 0x0421, int(now.charge, 1, true));
    if (old.isotope !== now.isotope) set(node, 0x0420, now.isotope === undefined ? undefined : int(now.isotope, 2));
    if (!same(old.hydrogens, now.hydrogens)) set(node, 0x042b, now.hydrogens.mode === 'auto' ? undefined : int(now.hydrogens.count, 2));
  }
  for (const [i, old] of Object.values(before.graph.bonds).entries()) {
    const now = doc.graph.bonds[old.id], d = doc.depiction.bonds[old.id], node = bonds[i];
    if (old.order !== now.order) set(node, 0x0600, int(now.order === 'aromatic' ? 128 : now.order === 3 ? 4 : now.order, 2));
    if (!same(before.depiction.bonds[old.id], d)) set(node, 0x0601, int(d?.style === 'wedge' ? d.from === now.atoms[1] ? 7 : 6 : d?.style === 'hashed' ? d.from === now.atoms[1] ? 4 : 3 : d?.style === 'wavy' ? 8 : 0, 2));
  }
  if (!same(before.graph.atoms, doc.graph.atoms) || !same(before.graph.bonds, doc.graph.bonds) || !same(before.depiction.bonds, doc.depiction.bonds)) {
    for (const node of nodes) set(node, 0x0437); for (const bond of bonds) set(bond, 0x060a);
  }
  for (const [object, parts] of additions) edits.set(object.end - 2, { end: object.end - 2, data: join(parts) });
  const pieces: Uint8Array[] = []; let offset = 0;
  for (const [start, edit] of [...edits].sort(([a], [b]) => a - b)) { if (start < offset) return blocked('源属性修改发生冲突'); pieces.push(bytes.subarray(offset, start), edit.data); offset = edit.end; }
  pieces.push(bytes.subarray(offset)); const output = join(pieces);
  if (!matchesProjection(readCdx(output).document, doc, before, .5 / 65536 / 20 + 1e-12)) return blocked('保留结果的化学内容复核失败');
  return encodeCdx(output);
}

/** Only known, exactly representable objects/properties are converted; no opaque payload is hidden in XML. */
export function convertCdxDocumentToCdxml(doc: ChemicalDocument): string {
  if (doc.source?.format !== 'cdx') return blocked('来源不是 CDX');
  const source = exportSourceFile(doc), root = parseCdxTree(decodeCdx(source.data));
  const names: Record<number, string> = { 0x8000: 'CDXML', 0x8001: 'page', 0x8002: 'group', 0x8003: 'fragment', 0x8004: 'n', 0x8005: 'b' };
  const seen = new Set<number>();
  const encode = (object: CdxObject, virtual = false): string => {
    const name = names[object.tag]; if (!name) return blocked(`CDX 对象 0x${object.tag.toString(16)} 尚无完整 CDXML 映射`);
    const attributes: Record<string, string> = {};
    if (!virtual && object.id) { if (seen.has(object.id)) return blocked('CDX 局部重复 ID 无法原样映射到 CDXML'); seen.add(object.id); attributes.id = String(object.id); }
    if (object.tag === 0x8004 && !object.id) return blocked('未分配 ID 的 CDX 原子尚无完整 CDXML 映射');
    const scalar = (bytes: Uint8Array, width: number, signed = false) => { if (bytes.length !== width) return blocked('CDX 属性长度不符合映射'); return number(bytes, signed); };
    for (const [tag, bytes] of object.props) {
      if (tag === 0x000a) attributes.Z = String(scalar(bytes, 2, true));
      else if (tag === 0x0204) {
        if (bytes.length !== 16) return blocked('CDX 包围框长度不符合映射');
        const v = Array.from({ length: 4 }, (_, i) => number(bytes.subarray(i * 4, i * 4 + 4), true) / 65536);
        attributes.BoundingBox = [v[1], v[0], v[3], v[2]].join(' ');
      } else if (object.tag === 0x8000 && tag === 0x0805) attributes.BondLength = String(scalar(bytes, 4, true) / 65536);
      else if (object.tag === 0x8004) {
        if (tag === 0x0200) { if (bytes.length !== 8) return blocked('CDX 坐标长度不符合映射'); attributes.p = `${number(bytes.subarray(4), true) / 65536} ${number(bytes.subarray(0, 4), true) / 65536}`; }
        else if (tag === 0x0400 && scalar(bytes, 2) === 1) attributes.NodeType = 'Element';
        else if (tag === 0x0402) attributes.Element = String(scalar(bytes, 2));
        else if (tag === 0x0420) attributes.Isotope = String(scalar(bytes, 2));
        else if (tag === 0x0421) attributes.Charge = String(bytes.length === 4 ? scalar(bytes, 4, true) >> 24 : scalar(bytes, 1, true));
        else if (tag === 0x042b) attributes.NumHydrogens = String(scalar(bytes, 2));
        else if (tag === 0x0437 && scalar(bytes, 1) <= 1) attributes.AS = scalar(bytes, 1) ? 'N' : 'U';
        else return blocked(`CDX 原子属性 0x${tag.toString(16)} 尚无完整 CDXML 映射`);
      } else if (object.tag === 0x8005) {
        const orders: Record<number, string> = { 1: '1', 2: '2', 4: '3', 128: '1.5' };
        const displays: Record<number, string> = { 0: 'Solid', 3: 'WedgedHashBegin', 4: 'WedgedHashEnd', 6: 'WedgeBegin', 7: 'WedgeEnd', 8: 'Wavy' };
        if (tag === 0x0604 || tag === 0x0605) attributes[tag === 0x0604 ? 'B' : 'E'] = String(scalar(bytes, 4));
        else if (tag === 0x0600 && orders[scalar(bytes, 2)]) attributes.Order = orders[scalar(bytes, 2)];
        else if (tag === 0x0601 && displays[scalar(bytes, 2)]) attributes.Display = displays[scalar(bytes, 2)];
        else if (tag === 0x060a && scalar(bytes, 1) <= 1) attributes.BS = scalar(bytes, 1) ? 'N' : 'U';
        else return blocked(`CDX 键属性 0x${tag.toString(16)} 尚无完整 CDXML 映射`);
      } else return blocked(`CDX 属性 0x${tag.toString(16)} 尚无完整 CDXML 映射`);
    }
    return `<${name}${Object.entries(attributes).map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join('')}>${object.children.map(child => encode(child)).join('')}</${name}>`;
  };
  const actual = root.children.length === 1 && root.children[0].tag === 0x8000 && !root.props.size ? root.children[0] : root;
  const output = `<?xml version="1.0" encoding="UTF-8"?>\n${encode(actual, actual === root)}`;
  const before = baseline(doc, readCdx(decodeCdx(doc.source.raw)).document);
  if (!matchesProjection(readCdxml(output).document, doc, before, .5 / 65536 / 20 + 1e-12)) return blocked('跨格式转换的化学内容复核失败');
  return output;
}
