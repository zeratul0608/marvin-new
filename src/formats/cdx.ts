import { ELEMENTS } from '../core/model';
import type { Atom, BondOrder, Diagnostic, ImportResult } from '../core/types';
import { fail, finish, GraphReader } from './shared';
import { readOrdering } from './stereo';
import { readCdxDocument } from './cdx-document';
import { geometryFromOrdering } from '../core/stereochemistry';
import {atomQueryCdxTags,readCdxQueryConstraints,readCdxBondTopology} from './query-properties';

// Archived ChemDraw SDK: https://iupac.github.io/IUPAC-FAIRSpec/cdx_sdk/IntroCDX.htm
// Integer fields are little-endian; 2D points store signed 16.16 y followed by x.
const MAGIC = [0x56, 0x6a, 0x43, 0x44, 0x30, 0x31, 0x30, 0x30];
export const CDX_BASE64_PREFIX = 'cdx:base64,';
export const MAX_CDX_BYTES = 2_000_000;
const DOC = 0x8000, PAGE = 0x8001, GROUP = 0x8002, FRAGMENT = 0x8003, NODE = 0x8004, BOND = 0x8005, TEXT = 0x8006;
export interface CdxObject { tag: number; id: number; serial: number; start: number; end: number; ranges: Map<number, { start: number; end: number }>; props: Map<number, Uint8Array>; children: CdxObject[]; parent?: CdxObject }
const hex = (tag: number) => `0x${tag.toString(16).padStart(4, '0')}`;
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export function isCdx(bytes: Uint8Array): boolean {
  return bytes.length >= MAGIC.length && MAGIC.every((value, index) => bytes[index] === value);
}

/** Printable transport for JSON APIs, import previews and source-preserving native drafts. */
export function encodeCdx(bytes: Uint8Array): string {
  if (bytes.length > MAX_CDX_BYTES) fail('CDX 文件大小上限为 2 MB', 'SIZE_LIMIT');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return CDX_BASE64_PREFIX + btoa(binary);
}

export function decodeCdx(text: string): Uint8Array {
  const encoded = text.startsWith(CDX_BASE64_PREFIX) ? text.slice(CDX_BASE64_PREFIX.length) : text;
  if (encoded.length > Math.ceil(MAX_CDX_BYTES / 3) * 4) fail('CDX 文件大小上限为 2 MB', 'SIZE_LIMIT');
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) fail('CDX Base64 数据无效', 'INVALID_CDX');
  let binary: string;
  try { binary = atob(encoded); } catch { return fail('CDX Base64 数据无效', 'INVALID_CDX'); }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (bytes.length > MAX_CDX_BYTES) fail('CDX 文件大小上限为 2 MB', 'SIZE_LIMIT');
  return bytes;
}

export function parseCdxTree(bytes: Uint8Array): CdxObject {
  if (bytes.length > MAX_CDX_BYTES) fail('CDX 文件大小上限为 2 MB', 'SIZE_LIMIT');
  if (!isCdx(bytes) || bytes.length < 30) fail('CDX 文件头无效或文件已截断', 'INVALID_CDX');
  const data = view(bytes);
  // Current ChemDraw/RDKit files also use a 22-byte preamble followed by an
  // explicit Document object. Accept this exact variant, without scanning past
  // arbitrary header bytes or relaxing the archived 28-byte header validation.
  const headerLength = bytes.subarray(12, 22).every(value => value === 0) && data.getUint16(22, true) === DOC ? 22 : 28;
  if (data.getUint32(8, true) !== 0x01020304 || bytes.subarray(12, headerLength).some(value => value !== 0)) fail('CDX 文件头版本或保留字段不受支持', 'INVALID_CDX');
  const root: CdxObject = { tag: DOC, id: 0, serial: 0, start: headerLength, end: bytes.length, ranges: new Map(), props: new Map(), children: [] };
  const stack = [root], objectIds = new Map<CdxObject, Set<number>>();
  let offset = headerLength, serial = 0, propertyCount = 0, ended = false;
  const need = (length: number) => { if (length > bytes.length - offset) fail(`CDX 数据在字节 ${offset} 处截断`, 'TRUNCATED_CDX'); };
  while (offset < bytes.length) {
    need(2); const start = offset, tag = data.getUint16(offset, true); offset += 2;
    if (tag === 0) {
      if (stack.length === 1) { ended = true; break; }
      const closed = stack.pop()!;
      closed.end = offset;
      // Some producers explicitly wrap the document; others encode its properties after the header.
      if (closed.tag === DOC && stack.length === 1 && offset === bytes.length) { ended = true; break; }
      continue;
    }
    const parent = stack[stack.length - 1];
    if (tag & 0x8000) {
      need(4); const id = data.getUint32(offset, true); offset += 4;
      if (++serial > 20_000 || stack.length >= 64) fail('CDX 对象数量或嵌套深度超过限额', 'SIZE_LIMIT');
      if (tag === DOC && (parent !== root || root.children.length || root.props.size)) fail('CDX 文档对象嵌套无效', 'INVALID_CDX');
      const ids = objectIds.get(parent) ?? new Set<number>(); objectIds.set(parent, ids);
      if (id && ids.has(id)) fail(`CDX 容器内对象 ID ${id} 重复`, 'INVALID_CDX');
      if (id) ids.add(id);
      const object: CdxObject = { tag, id, serial, start, end: 0, ranges: new Map(), props: new Map(), children: [], parent };
      parent.children.push(object); stack.push(object);
    } else {
      need(2); let length = data.getUint16(offset, true); offset += 2;
      if (length === 0xffff) { need(4); length = data.getUint32(offset, true); offset += 4; }
      need(length);
      if (++propertyCount > 100_000) fail('CDX 属性数量超过限额', 'SIZE_LIMIT');
      if (parent.props.has(tag)) fail(`CDX 对象包含重复属性 ${hex(tag)}`, 'INVALID_CDX');
      parent.props.set(tag, bytes.subarray(offset, offset + length)); offset += length;
      parent.ranges.set(tag, { start, end: offset });
    }
  }
  if (!ended || stack.length !== 1) fail('CDX 对象或文档缺少结束标记', 'TRUNCATED_CDX');
  if (bytes.subarray(offset).some(value => value !== 0)) fail('CDX 文档结束后存在额外数据', 'INVALID_CDX');
  return root;
}

function integer(object: CdxObject, tag: number, width: number, fallback?: number, signed = false): number {
  const bytes = object.props.get(tag);
  if (!bytes) {
    if (fallback !== undefined) return fallback;
    return fail(`CDX 对象缺少属性 ${hex(tag)}`, 'INVALID_CDX');
  }
  if (bytes.length !== width) fail(`CDX 属性 ${hex(tag)} 的长度无效`, 'INVALID_CDX');
  const data = view(bytes);
  return width === 1 ? (signed ? data.getInt8(0) : data.getUint8(0)) : width === 2 ? (signed ? data.getInt16(0, true) : data.getUint16(0, true)) : (signed ? data.getInt32(0, true) : data.getUint32(0, true));
}

export function readCdx(bytes: Uint8Array, name?: string): ImportResult {
  const root = parseCdxTree(bytes), objects: CdxObject[] = [];
  const collect = (object: CdxObject) => { objects.push(object); object.children.forEach(collect); }; collect(root);
  if (objects.filter(object => object.tag === NODE).length > 2000 || objects.filter(object => object.tag === BOND).length > 2000) fail('CDX 最多支持 2000 个原子与 2000 条键', 'SIZE_LIMIT');
  const issues: Diagnostic[] = [], warningKeys = new Set<string>();
  const warn = (message: string, code = 'UNSUPPORTED_CDX_CONTENT') => {
    if (warningKeys.has(message)) return; warningKeys.add(message);
    if (issues.length < 100) issues.push({ severity: 'warning', code, message });
    else if (issues.length === 100) issues.push({ severity: 'warning', code, message: 'CDX 中还有其他未解释内容；完整原始文件已保留。' });
  };
  const reader = new GraphReader(name?.replace(/\.cdx$/i, '') || 'ChemDraw CDX 结构');
  const documentAtoms = new Map<CdxObject,string>(), documentBonds = new Map<CdxObject,string>();
  const fragments = objects.filter(object => object.tag === FRAGMENT);
  if (objects.some(object => object.tag === 0x800d && !object.children.some(child => child.tag === 0x800e))) fail('CDX 反应方案没有步骤', 'INVALID_REACTION');
  const structural = new Set([DOC, PAGE, GROUP, FRAGMENT, NODE, BOND]);
  const visual = new Set([0x000a, 0x0008, 0x0010, 0x0011, 0x0204, 0x0301, 0x0302, 0x0401, 0x0439, 0x043a, 0x043b, 0x043c, 0x0442, 0x0443, 0x0444, 0x0445, 0x0448, 0x060c, 0x060d, 0x060e, 0x060f]);
  const nodeRead = new Set([0x0200, 0x0400, 0x0402, 0x0403, 0x0420, 0x0421, 0x0422, 0x042b, 0x0430, 0x0431, 0x0433, 0x0437, 0x0440, 0x044b, 0x044d,...atomQueryCdxTags]);
  const bondRead = new Set([0x0600, 0x0601, 0x0603, 0x0604, 0x0605, 0x0606, 0x0608, 0x0609, 0x060a, 0x060b, 0x060e]);
  for (const object of objects) {
    if (object.tag===0x800a) fail('CDX 备选组尚未实现', 'UNSUPPORTED_GROUP');
    if([0x8017,0x8018,0x8019].includes(object.tag))continue; // Parsed as typed bracket/document records below.
    if (!structural.has(object.tag)) {
      warn(object.tag === TEXT ? 'CDX 文本或原子标签排版暂未显示或完整保留到转换格式' : `CDX 文档对象 ${hex(object.tag)} 暂未解释`);
      continue;
    }
    if (object.props.has(0x0201) || object.props.has(0x0203)) fail('三维 CDX 结构暂不支持', 'UNSUPPORTED_3D');
    for (const [tag, value] of object.props) {
      if (object.tag === NODE && tag === 0x0448 && value.length !== 0) fail('CDX NeedsClean 必须为隐含布尔值', 'INVALID_CDX');
      if ((object.tag === NODE && nodeRead.has(tag)) || (object.tag === BOND && bondRead.has(tag))) continue;
      if (tag >= 0x0c00 && tag <= 0x0c08) fail('CDX 反应属性尚未实现', 'UNSUPPORTED_REACTION');
      if (object.tag === NODE || object.tag === BOND) {
        if (!visual.has(tag) && !(tag >= 0x0800 && tag <= 0x0826)) fail(`CDX 化学对象属性 ${hex(tag)} 尚未实现`, 'UNSUPPORTED_CDX_PROPERTY');
      } else if (tag >= 0x0400 && tag < 0x0700 && !visual.has(tag)) {
        // False molecular chiral flags carry no positive stereo specification.
        if ([0x0500, 0x0501, 0x0502].includes(tag) && value.length === 1 && value[0] === 0) continue;
        return fail(`CDX 化学属性 ${hex(tag)} 尚未实现`, 'UNSUPPORTED_CDX_PROPERTY');
      }
      if (tag !== 0x000a) warn(`CDX 属性 ${hex(tag)} 的文档样式、显示或附加信息暂未完整解释`);
    }
  }
  for (const fragment of fragments) {
    for (let parent = fragment.parent; parent; parent = parent.parent) {
      if (![DOC, PAGE, GROUP].includes(parent.tag)) fail('CDX 缩写、嵌套或特殊分子片段尚未实现', 'UNSUPPORTED_GROUP');
    }
    const prefix = `f${fragment.serial}:`;
    const atomObjects = new Map<CdxObject, string>(), bondObjects = new Map<CdxObject, string>();
    for (const object of fragment.children.filter(child => child.tag === NODE)) {
      const type = integer(object, 0x0400, 2, 1), attachment = type === 12;
      if (![0, 1, 2, 7, 12].includes(type)) fail('此 CDX 缩写基团或伪原子尚未实现', 'UNSUPPORTED_QUERY');
      if ((object.props.has(0x0403) && type !== 2) || (object.props.has(0x0433) && type !== 7)) fail('CDX 查询属性与原子类型不匹配', 'INVALID_QUERY');
      const element = integer(object, 0x0402, 2, 6);
      if (!ELEMENTS[element - 1]) fail('CDX 原子元素无效', 'INVALID_CDX');
      const position = object.props.get(0x0200);
      if (!position || position.length !== 8) fail('CDX 原子缺少有效二维坐标；当前不提供自动布局', 'INVALID_CDX');
      const radical = integer(object, 0x0422, 1, 0);
      if (![0, 1, 2, 3].includes(radical)) fail('CDX 自由基自旋态无效', 'UNSUPPORTED_RADICAL');
      const cip = integer(object, 0x0437, 1, 1);
      if (cip > 6) fail('此 CDX CIP 枚举尚未实现', 'UNSUPPORTED_STEREO');
      const geometry = integer(object, 0x0430, 1, 0);
      if (![0, 7].includes(geometry) || object.props.has(0x0431) !== (geometry === 7)) fail('此 CDX 原子几何或键排序用途尚未实现', 'UNSUPPORTED_STEREO');
      const chargeBytes = object.props.get(0x0421);
      // ChemDraw 8.0 stored charge as a four-byte Fixed; see Atom_Charge SDK erratum.
      const charge = chargeBytes?.length === 4 ? integer(object, 0x0421, 4, 0, true) >> 24 : integer(object, 0x0421, 1, 0, true);
      const properties: Partial<Atom> = { charge };
      const constraints=readCdxQueryConstraints(object.props);if(constraints)properties.queryConstraints=constraints;
      if (object.props.has(0x044d)) properties.sourceNumber = integer(object, 0x044d, 4);
      if (object.props.has(0x044b)) { const length = object.props.get(0x044b)!.length; if (![1, 2, 4].includes(length)) fail('CDX 连接点序号长度无效'); properties.attachmentIndex = integer(object, 0x044b, length); }
      if (cip > 1) properties.cipLabel = (['U', 'N', 'R', 'S', 'r', 's', 'u'] as const)[cip] as Atom['cipLabel'];
      if (type === 2) {
        const data = object.props.get(0x0403); if (!data || data.length < 4 || data.length % 2) fail('CDX 查询元素列表无效');
        const v = view(data), count = v.getInt16(0, true); if (Math.abs(count) * 2 + 2 !== data.length) fail('CDX 查询元素列表长度不匹配');
        properties.query = { kind: 'elements', elements: Array.from({ length: Math.abs(count) }, (_, i) => { const e = ELEMENTS[v.getUint16(i * 2 + 2, true) - 1]; if (!e) fail('CDX 查询元素无效'); return e; }), ...(count < 0 ? { exclude: true } : {}) };
      } else if (type === 7) {
        const data = object.props.get(0x0433); if (!data || data.length < 3 || view(data).getUint16(0, true) !== 0 || data.subarray(2).some(b => b > 127)) fail('CDX 通用查询名称编码尚未实现');
        properties.query = { kind: 'generic', label: new TextDecoder().decode(data.subarray(2)) };
      } else if (type === 0) {
        const text = object.children.find(o => o.tag === TEXT)?.props.get(0x0700);
        let label: string | undefined;
        if (text) { if (text.length < 2) fail('CDX 查询标签截断'); const start = 2 + view(text).getUint16(0, true) * 10; if (start > text.length || text.subarray(start).some(n => n > 127)) fail('CDX 查询标签字符集尚未实现'); label = new TextDecoder().decode(text.subarray(start)); }
        properties.query = { kind: 'any', ...(label ? { label } : {}) };
      }
      if (radical) properties.radical = radical as Atom['radical'];
      const isotope = integer(object, 0x0420, 2, 0);
      if (isotope) properties.isotope = isotope;
      if (object.props.has(0x042b)) properties.hydrogens = { mode: 'fixed', count: integer(object, 0x042b, 2) };
      if (attachment) {
        const connection = integer(object, 0x0440, 1, 0); if (connection > 4) fail('此 CDX 连接点枚举尚未实现', 'UNSUPPORTED_ATTACHMENT');
        if (object.props.has(0x0440)) properties.connectionType = (['Unspecified', 'Diamond', 'Star', 'PolymerBead', 'Wavy'] as const)[connection];
        if (object.props.has(0x0402) || charge || isotope || radical || (properties.hydrogens && (properties.hydrogens.mode !== 'fixed' || properties.hydrogens.count !== 0)) || object.children.length) fail('CDX 外部连接点包含不支持的附加化学信息', 'UNSUPPORTED_ATTACHMENT');
        properties.attachment = 'external'; properties.hydrogens = { mode: 'fixed', count: 0 };
      }
      else if (object.props.has(0x0440)) fail('非连接点原子含外部连接类型属性', 'UNSUPPORTED_ATTACHMENT');
      const point = view(position);
      atomObjects.set(object, reader.atom(prefix + (object.id || `unreferenced${object.serial}`), attachment || properties.query ? '*' : ELEMENTS[element - 1], point.getInt32(4, true) / 65536 / 20, -point.getInt32(0, true) / 65536 / 20, properties));
    }
    for (const object of fragment.children.filter(child => child.tag === BOND)) {
      const orders: Record<number, BondOrder> = { 1: 1, 2: 2, 4: 3, 128: 'aromatic', 256: 2.5, 65535: 'any' };
      const order = orders[integer(object, 0x0600, 2, 1)];
      if (order === undefined) fail('CDX 查询、配位或其他特殊键型尚未实现', 'UNSUPPORTED_BOND');
      const display = integer(object, 0x0601, 2, 0);
      if (![0, 1, 2, 3, 4, 5, 6, 7, 8].includes(display)) fail(`CDX 键描绘 ${display} 尚未实现`, 'UNSUPPORTED_BOND');
      const cip = integer(object, 0x060a, 1, 1); if (cip > 3) fail('CDX 双键 CIP 枚举无效', 'UNSUPPORTED_STEREO');
      const begin = integer(object, 0x0604, 4), end = integer(object, 0x0605, 4);
      if (!begin || !end) fail('CDX 键不能引用未分配 ID 的原子', 'INVALID_CDX');
      const id = reader.bond(prefix + begin, prefix + end, order, [3, 4].includes(display) ? 'hashed' : [6, 7].includes(display) ? 'wedge' : display === 8 ? 'wavy' : display === 1 ? 'dashed' : display === 2 ? 'hash' : display === 5 ? 'bold' : undefined, [4, 7].includes(display));
      bondObjects.set(object, id);
      const topology=readCdxBondTopology(object.props);if(topology!==undefined)reader.document.graph.bonds[id].topology=topology;
      if (cip > 1) reader.document.graph.bonds[id].cipLabel = cip === 2 ? 'E' : 'Z';
      const offsets: [number, number] = [integer(object, 0x0608, 1, 0), integer(object, 0x0609, 1, 0)];
      if (object.props.has(0x0603)) {
        const value = integer(object, 0x0603, 2);
        if (![0, 1, 2, 256, 257, 258].includes(value)) fail('CDX 双键位置无效', 'INVALID_CDX');
        // Producers also write this default hint on single bonds. It has no effect there.
        if (order === 2 && display === 0) reader.document.depiction.bonds[id] = { style: 'plain', from: reader.document.graph.bonds[id].atoms[0], doublePosition: (['center', 'right', 'left'] as const)[value & 255] };
      }
      if (offsets.some(Boolean) || object.props.has(0x060e)) reader.document.depiction.bonds[id] = { ...(reader.document.depiction.bonds[id] ?? { style: 'plain', from: reader.document.graph.bonds[id].atoms[0] }), ...(offsets.some(Boolean) ? { labelOffsets: offsets } : {}), ...(object.props.has(0x000a) ? { layer: integer(object, 0x000a, 2, 0, true) } : {}) };
    }
    const bondRefs = new Map([...bondObjects].filter(([o]) => o.id).map(([o, id]) => [String(o.id), id]));
    const ordering = (object: CdxObject, tag: number) => {
      const bytes = object.props.get(tag)!;
      if (bytes.length !== 16) fail('CDX 立体连接顺序长度无效', 'INVALID_STEREO_REFERENCE');
      const v = view(bytes);
      return readOrdering(Array.from({ length: 4 }, (_, i) => String(v.getUint32(i * 4, true))), bondRefs);
    };
    for (const [object, id] of atomObjects) if (object.props.has(0x0431)) reader.document.graph.atoms[id].geometry = { type: 'tetrahedral', bondOrdering: ordering(object, 0x0431) };
    for (const [object, id] of bondObjects) if (object.props.has(0x060b)) reader.document.graph.bonds[id].circularOrdering = ordering(object, 0x060b);
    for (const [object, id] of bondObjects) if (object.props.has(0x060e)) {
      const data = object.props.get(0x060e)!; if (data.length % 4) fail('CDX 交叉键引用长度无效'); const v = view(data);
      reader.document.depiction.bonds[id].crossings = Array.from({ length: data.length / 4 }, (_, i) => { const ref = bondRefs.get(String(v.getUint32(i * 4, true))); if (!ref) fail('CDX 交叉键引用不存在'); return ref; });
    }
    for (const [object,id] of atomObjects) { documentAtoms.set(object,id); if (reader.document.graph.atoms[id].geometry) reader.document.graph.atoms[id].geometry = geometryFromOrdering(reader.document,id,reader.document.graph.atoms[id].geometry!.bondOrdering); }
    for (const [object,id] of bondObjects) documentBonds.set(object,id);
  }
  for (const object of objects) if ([NODE, BOND].includes(object.tag) && object.parent?.tag !== FRAGMENT) fail('CDX 原子或键不属于普通分子片段', 'INVALID_CDX');
  if (!Object.keys(reader.document.graph.atoms).length && !fragments.length) fail('CDX 文件中没有可编辑的普通二维分子', 'EMPTY_CDX');
  readCdxDocument(root,reader.document,documentAtoms,documentBonds);
  if (objects.filter(object => object.tag === PAGE).length > 1) warn('多页 CDX 文档会在同一画布中显示', 'CDX_MULTIPLE_PAGES');
  return finish(reader.document, encodeCdx(bytes), 'cdx', issues, name);
}
