import { hydrogenCount } from '../core/model';
import type { ChemicalDocument } from '../core/types';
import { fail } from './shared';
import { chemicalSymbol } from '../core/query';

export interface LabelPart { text: string; script: number }
const refuse = (message: string): never => fail(`无法保留源文档保存：${message}。原始文件仍可取回，或保存原生 JSON。`, 'PRESERVATION_LABEL_UNSUPPORTED');
const charge = (n: number) => n ? `${Math.abs(n) === 1 ? '' : Math.abs(n)}${n > 0 ? '+' : '-'}` : '';
/** Compare the drawn base graph when deciding whether an existing label needs
 * rewriting. Adding/removing a search restriction alone never changes its text.
 * This is not a molecular formula or an assertion that query H is known. */
function labelHydrogenCount(doc:ChemicalDocument,id:string):number|null{
  const atom=doc.graph.atoms[id],edges=Object.values(doc.graph.bonds).filter(b=>b.atoms.includes(id)&&b.topology!==undefined);
  if(!atom.queryConstraints&&!edges.length)return hydrogenCount(doc,id);
  const base={...atom};delete base.queryConstraints;
  const bonds={...doc.graph.bonds};for(const edge of edges){const copy={...edge};delete copy.topology;bonds[edge.id]=copy;}
  return hydrogenCount({...doc,graph:{...doc.graph,atoms:{...doc.graph.atoms,[id]:base},bonds}},id);
}
export function labelChanged(before: ChemicalDocument, doc: ChemicalDocument, id: string): boolean {
  const old = before.graph.atoms[id], atom = doc.graph.atoms[id];
  return old.namedFragment?.label !== atom.namedFragment?.label || old.substructure?.label !== atom.substructure?.label || JSON.stringify(old.query) !== JSON.stringify(atom.query) || old.element !== atom.element || old.charge !== atom.charge || old.isotope !== atom.isotope ||
    old.hydrogens.mode !== atom.hydrogens.mode || (old.hydrogens.mode === 'fixed' && atom.hydrogens.mode === 'fixed' && old.hydrogens.count !== atom.hydrogens.count) ||
    labelHydrogenCount(before, id) !== labelHydrogenCount(doc, id);
}

/** Update ordinary chemical labels only; never turn arbitrary annotations into element labels. */
export function chemicalLabel(before: ChemicalDocument, doc: ChemicalDocument, id: string, original: string): LabelPart[] {
  const old = before.graph.atoms[id], atom = doc.graph.atoms[id];
  if (atom.namedFragment) return [{ text: atom.namedFragment.label, script: 0 }];
  if (atom.substructure) return [{ text: atom.substructure.label, script: 0 }];
  if (atom.query) return [{ text: chemicalSymbol(atom), script: 0 }];
  if (old.query) return [{ text: atom.element, script: 0 }];
  const oldH = hydrogenCount(before, id), count = hydrogenCount(doc, id);
  if (oldH === null || count === null) {
    // Query bonds do not determine a hydrogen count. An isotope/charge edit on
    // a bare element label is still exact and must not invent an H suffix.
    const source = original.replace(/\s/g, '').replace(/−/g, '-');
    const expected = `${old.isotope ?? ''}${old.element}${charge(old.charge)}`;
    const onlyQueryHChange=labelHydrogenCount(before,id)===labelHydrogenCount(doc,id);
    if ((oldH !== count&&!onlyQueryHChange) || source !== expected || JSON.stringify(old.hydrogens) !== JSON.stringify(atom.hydrogens)) return refuse('该原子的氢数尚不能确定，无法同步标签');
    return [...(atom.isotope ? [{ text: String(atom.isotope), script: 0x40 }] : []), { text: atom.element, script: 0 }, ...(atom.charge ? [{ text: charge(atom.charge), script: 0x40 }] : [])];
  }
  const h = oldH ? `H${oldH > 1 ? oldH : ''}` : '';
  const source = original.replace(/\s/g, '').replace(/−/g, '-');
  const candidates = new Set<string>();
  for (const core of [old.element, old.element + h, h + old.element]) {
    for (const iso of ['', old.isotope ? String(old.isotope) : '']) for (const c of ['', charge(old.charge)]) candidates.add(iso + core + c);
  }
  if (old.isotope) candidates.add(h + old.isotope + old.element + charge(old.charge));
  if (!candidates.has(source)) return refuse('原子标签包含自定义文字，不能自动改写');
  const hydrogens: LabelPart[] = count ? [{ text: 'H', script: 0 }, ...(count > 1 ? [{ text: String(count), script: 0x20 }] : [])] : [];
  const heavy: LabelPart[] = [...(atom.isotope ? [{ text: String(atom.isotope), script: 0x40 }] : []), { text: atom.element, script: 0 }];
  const reverse = h && old.element !== 'H' && source.startsWith(h + old.element);
  return [...(reverse ? [...hydrogens, ...heavy] : [...heavy, ...hydrogens]), ...(atom.charge ? [{ text: charge(atom.charge), script: 0x40 }] : [])];
}

export function rewriteXmlLabel(node: Element, parts: LabelPart[]): void {
  const labels = [...node.children].filter(e => e.localName === 't');
  if (labels.length !== 1 || [...node.children].some(el => !['t', 'fragment', 'objecttag', 'annotation'].includes(el.localName))) return refuse('原子包含多个标签或附属对象，尚不能安全改写');
  const label = labels[0], runs = [...label.children];
  if (!runs.length || runs.some(e => e.localName !== 's' || [...e.attributes].some(a => !['font', 'size', 'face', 'color'].includes(a.name)))) return refuse('标签包含未实现的排版内容');
  const attributes = (s: Element) => JSON.stringify([...s.attributes].filter(a => a.name !== 'face').map(a => [a.name, a.value]).sort());
  const face = (s: Element) => { const n = Number(s.getAttribute('face') ?? 0); if (!Number.isInteger(n) || n < 0 || n > 65535) return refuse('标签字体样式无效'); return n & ~0x60; };
  const base = runs[0];
  if (runs.some(s => attributes(s) !== attributes(base) || face(s) !== face(base))) return refuse('混合字体标签尚不能安全改写');
  label.replaceChildren(...parts.map(part => {
    const s = base.cloneNode(false) as Element; s.setAttribute('face', String(face(base) | part.script)); s.textContent = part.text; return s;
  }));
  label.removeAttribute('BoundingBox'); label.removeAttribute('LineStarts'); node.removeAttribute('BoundingBox');
}

export function binaryLabelParts(data: Uint8Array, fallback?: Uint8Array): { text: string; style: Uint8Array } {
  if (data.length < 2) return refuse('CDX 标签数据截断');
  const view = new DataView(data.buffer, data.byteOffset, data.length), count = view.getUint16(0, true), offset = 2 + count * 10;
  if (offset > data.length || data.length - offset > 65535 || data.subarray(offset).some(n => n > 127)) return refuse('CDX 标签编码或样式不受支持');
  const styles: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const record = 2 + i * 10;
    const index = view.getUint16(record, true);
    if (index > data.length - offset || (i === 0 && index !== 0) || (i > 0 && index < view.getUint16(record - 10, true))) return refuse('CDX 标签样式索引无效');
    const style = data.slice(record + 2, record + 10); style[2] &= ~0x60; styles.push(style);
  }
  const style = styles[0] ?? fallback?.slice();
  if (!style || style.length !== 8) return refuse('没有可复用的 CDX 标签字体信息');
  style[2] &= ~0x60;
  if (styles.some(s => !s.every((n, i) => n === style[i]))) return refuse('混合字体标签尚不能安全改写');
  return { text: String.fromCharCode(...data.subarray(offset)), style };
}

export function encodeBinaryLabel(parts: LabelPart[], style: Uint8Array): Uint8Array {
  const text = parts.map(p => p.text).join('');
  if (text.length > 65535) return refuse('标签文本过长');
  const bytes = new Uint8Array(2 + parts.length * 10 + text.length), view = new DataView(bytes.buffer);
  view.setUint16(0, parts.length, true); let index = 0;
  parts.forEach((part, i) => { const offset = 2 + i * 10; view.setUint16(offset, index, true); bytes.set(style, offset + 2); view.setUint16(offset + 4, view.getUint16(offset + 4, true) | part.script, true); index += part.text.length; });
  bytes.set(new TextEncoder().encode(text), 2 + parts.length * 10); return bytes;
}
