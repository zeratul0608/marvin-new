import { addAtom, addBond, emptyDocument, fingerprint, validateDocument } from '../core/model';
import type { Atom, BondOrder, ChemicalDocument, Diagnostic, Format, ImportResult } from '../core/types';

export class FormatError extends Error {
  issues: Diagnostic[];
  constructor(message: string, code = 'INVALID_FORMAT', issues?: Diagnostic[]) {
    super(message); this.name = 'FormatError';
    this.issues = issues ?? [{ severity: 'error', code, message }];
  }
}
export function fail(message: string, code?: string): never { throw new FormatError(message, code); }
export function integer(value: string, fallback?: number): number {
  if (!value.trim() && fallback !== undefined) return fallback;
  if (!/^[+-]?\d+$/.test(value.trim())) fail(`无效的整数：${value}`);
  return Number(value);
}
export function numeric(value: string): number {
  if (!value.trim() || !Number.isFinite(Number(value))) fail(`无效的坐标：${value}`);
  return Number(value);
}
export function boundCount(count: number) { if (count < 0 || count > 2000) fail('首版单文档最多支持 2000 个原子／键', 'SIZE_LIMIT'); }
export function finish(doc: ChemicalDocument, raw: string, format: Format, issues: Diagnostic[], name?: string): ImportResult {
  boundCount(Object.keys(doc.graph.atoms).length); boundCount(Object.keys(doc.graph.bonds).length);
  try { validateDocument(doc); } catch (error) { fail((error as Error).message); }
  doc.source = { raw, format, fingerprint: fingerprint(doc), issues: structuredClone(issues), name };
  return { document: doc, issues };
}
export class GraphReader {
  document: ChemicalDocument;
  refs = new Map<string, string>();
  constructor(title: string) { this.document = emptyDocument(title || '导入的结构'); }
  atom(ref: string, element: string, x: number, y: number, props: Partial<Atom> = {}): string {
    if (!ref || this.refs.has(ref)) fail('文件中的原子 ID 缺失或重复');
    try {
      const atom = addAtom(this.document, element, { x, y }, props); this.refs.set(ref, atom); return atom;
    } catch (error) { return fail((error as Error).message, 'UNSUPPORTED_ATOM'); }
  }
  bond(a: string, b: string, order: BondOrder, style?: 'wedge' | 'hashed' | 'wavy', reverse = false): string {
    const aid = this.refs.get(a), bid = this.refs.get(b);
    if (!aid || !bid) fail('文件中的键引用了不存在的原子');
    if (aid === bid || Object.values(this.document.graph.bonds).some(x => x.atoms.includes(aid) && x.atoms.includes(bid))) fail('文件含重复键或自身连接');
    const bond = addBond(this.document, aid, bid, order);
    if (style) this.document.depiction.bonds[bond] = { style, from: reverse ? bid : aid };
    return bond;
  }
}
export const escapeXml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
