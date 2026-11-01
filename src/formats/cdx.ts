import { ELEMENTS } from '../core/model';
import type { Atom, BondOrder, Diagnostic, ImportResult } from '../core/types';
import { fail, finish, GraphReader } from './shared';

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
  const fragments = objects.filter(object => object.tag === FRAGMENT);
  const structural = new Set([DOC, PAGE, GROUP, FRAGMENT, NODE, BOND]);
  const visual = new Set([0x000a, 0x0008, 0x0010, 0x0011, 0x0204, 0x0301, 0x0302, 0x0401, 0x0439, 0x043a, 0x043b, 0x043c, 0x0603, 0x060c, 0x060d, 0x060e, 0x060f]);
  const nodeRead = new Set([0x0200, 0x0400, 0x0402, 0x0420, 0x0421, 0x0422, 0x042b, 0x0437]);
  const bondRead = new Set([0x0600, 0x0601, 0x0604, 0x0605, 0x060a]);
  for (const object of objects) {
    if ([0x800d, 0x800e].includes(object.tag)) fail('CDX 反应角色与步骤尚未实现', 'UNSUPPORTED_REACTION');
    if ([0x800a, 0x8017, 0x8018, 0x8019].includes(object.tag)) fail('CDX Markush／聚合物／括号基团尚未实现', 'UNSUPPORTED_GROUP');
    if (!structural.has(object.tag)) {
      warn(object.tag === TEXT ? 'CDX 文本或原子标签排版暂未显示或完整保留到转换格式' : `CDX 文档对象 ${hex(object.tag)} 暂未解释`);
      continue;
    }
    if (object.props.has(0x0201) || object.props.has(0x0203)) fail('三维 CDX 结构暂不支持', 'UNSUPPORTED_3D');
    for (const [tag, value] of object.props) {
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
    for (const object of fragment.children.filter(child => child.tag === NODE)) {
      if (integer(object, 0x0400, 2, 1) !== 1) fail('CDX 查询原子、缩写基团或伪原子尚未实现', 'UNSUPPORTED_QUERY');
      const element = integer(object, 0x0402, 2, 6);
      if (!ELEMENTS[element - 1]) fail('CDX 原子元素无效', 'INVALID_CDX');
      const position = object.props.get(0x0200);
      if (!position || position.length !== 8) fail('CDX 原子缺少有效二维坐标；当前不提供自动布局', 'INVALID_CDX');
      if (integer(object, 0x0422, 1, 0) !== 0) fail('CDX 自由基语义尚未实现', 'UNSUPPORTED_RADICAL');
      if (integer(object, 0x0437, 1, 1) > 1) fail('CDX 拓扑立体化学信息尚未实现', 'UNSUPPORTED_STEREO');
      const chargeBytes = object.props.get(0x0421);
      // ChemDraw 8.0 stored charge as a four-byte Fixed; see Atom_Charge SDK erratum.
      const charge = chargeBytes?.length === 4 ? integer(object, 0x0421, 4, 0, true) >> 24 : integer(object, 0x0421, 1, 0, true);
      const properties: Partial<Atom> = { charge };
      const isotope = integer(object, 0x0420, 2, 0);
      if (isotope) properties.isotope = isotope;
      if (object.props.has(0x042b)) properties.hydrogens = { mode: 'fixed', count: integer(object, 0x042b, 2) };
      const point = view(position);
      reader.atom(prefix + (object.id || `unreferenced${object.serial}`), ELEMENTS[element - 1], point.getInt32(4, true) / 65536 / 20, -point.getInt32(0, true) / 65536 / 20, properties);
    }
    for (const object of fragment.children.filter(child => child.tag === BOND)) {
      const orders: Record<number, BondOrder> = { 1: 1, 2: 2, 4: 3, 128: 'aromatic' };
      const order = orders[integer(object, 0x0600, 2, 1)];
      if (order === undefined) fail('CDX 查询、配位或其他特殊键型尚未实现', 'UNSUPPORTED_BOND');
      const display = integer(object, 0x0601, 2, 0);
      if (![0, 3, 4, 6, 7, 8].includes(display)) fail(`CDX 键描绘 ${display} 尚未实现`, 'UNSUPPORTED_BOND');
      if (integer(object, 0x060a, 1, 1) > 1) fail('CDX 键拓扑立体化学尚未实现', 'UNSUPPORTED_STEREO');
      const begin = integer(object, 0x0604, 4), end = integer(object, 0x0605, 4);
      if (!begin || !end) fail('CDX 键不能引用未分配 ID 的原子', 'INVALID_CDX');
      reader.bond(prefix + begin, prefix + end, order, [3, 4].includes(display) ? 'hashed' : [6, 7].includes(display) ? 'wedge' : display === 8 ? 'wavy' : undefined, [4, 7].includes(display));
    }
  }
  for (const object of objects) if ([NODE, BOND].includes(object.tag) && object.parent?.tag !== FRAGMENT) fail('CDX 原子或键不属于普通分子片段', 'INVALID_CDX');
  if (!Object.keys(reader.document.graph.atoms).length) fail('CDX 文件中没有可编辑的普通二维分子', 'EMPTY_CDX');
  if (objects.filter(object => object.tag === PAGE).length > 1) warn('多页 CDX 文档会在同一画布中显示', 'CDX_MULTIPLE_PAGES');
  return finish(reader.document, encodeCdx(bytes), 'cdx', issues, name);
}
