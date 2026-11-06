import { connectedComponents } from '../core/model';
import type { ChemicalDocument } from '../core/types';
import type { CdxObject } from './cdx';
import { cdxLiteralTags, cdxReferenceTags, xmlLiteralAttributes, xmlReferenceAttributes } from './preservation-properties';
import { fail } from './shared';
import { cdxmlDocumentMetadata } from './cdxml-metadata';
import { drawingTags } from '../core/drawing';

const refuse = (message: string): never => fail(`无法保留源文档保存：${message}。原始文件仍可取回，或保存原生 JSON。`, 'PRESERVATION_REFERENCE_UNSUPPORTED');
const xmlObjects = new Set(['CDXML', 'page', 'group', 'fragment', 'n', 'b', 't', 's', 'fonttable', 'font', 'colortable', 'color', 'scheme', 'step', ...drawingTags]);

/** Keep source page/group/fragment membership. Never silently merge source fragments. */
export function planFragments<T>(doc: ChemicalDocument, before: ChemicalDocument, existing: Map<string, T>, fragments: T[], placeNew?: (atomIds:string[])=>T|undefined): Map<string, T> {
  const result = new Map<string, T>();
  for (const component of connectedComponents(doc)) {
    const members = [...new Set(component.filter(id => before.graph.atoms[id]).map(id => existing.get(id)!))];
    if (members.length > 1) return refuse('跨来源片段的连接尚不能安全保存');
    const target = members[0] ?? placeNew?.(component) ?? (fragments.length === 1 ? fragments[0] : undefined);
    if (target === undefined) return refuse('新片段的来源页面不明确');
    for (const id of component) result.set(id, target);
  }
  return result;
}

export function allocateIds(existing: Iterable<string>): () => string {
  const used = new Set(existing); let next = 1;
  return () => { while (used.has(String(next))) { if (++next > 0xffffffff) return refuse('没有可分配的源文档对象 ID'); } const id = String(next++); used.add(id); return id; };
}

function mentions(value: string, ids: Set<string>): boolean {
  return value.split(/[^\p{L}\p{N}_.:-]+/u).some(token => ids.has(token));
}

/** Check external references before deleting objects or changing externally represented chemistry. */
export function guardXmlReferences(xml: Document, affected: Set<string>, removed: Set<Element>, modeled = new Set<Element>()): void {
  if (!affected.size) return;
  for (const element of xml.getElementsByTagName('*')) {
    let skip = false;
    for (let parent: Element | null = element; parent; parent = parent.parentElement) if (removed.has(parent)) { skip = true; break; }
    if (skip) continue;
    if (!xmlObjects.has(element.localName)) return refuse(`文档对象 ${element.localName} 的引用语义未知`);
    for (const a of element.attributes) {
      if (a.namespaceURI && !a.name.startsWith('xmlns')) {
        if (a.namespaceURI === 'http://www.w3.org/XML/1998/namespace' && ['lang', 'space'].includes(a.localName)) continue;
        return refuse(`文档属性 ${element.localName}.${a.name} 的引用类型未知`);
      }
      if (a.name === 'id' || a.name.startsWith('xmlns') || xmlLiteralAttributes.has(a.localName)) continue;
      if (element.localName === 'CDXML' && cdxmlDocumentMetadata.has(a.localName)) continue;
      if (element.localName === 't' && cdxmlDocumentMetadata.has(a.localName)) continue;
      if (element.localName === 'annotation' && ['Keyword', 'Content'].includes(a.localName)) continue;
      if (element.localName === 'objecttag' && ['DisplayName', 'Value'].includes(a.localName)) continue;
      if (element.localName === 'color' && ['r', 'g', 'b'].includes(a.localName)) continue;
      if (element.localName === 'b' && ['B', 'E', 'CrossingBonds'].includes(a.localName)) continue;
      if (element.localName === 'n' && ['AtomID', 'ExternalConnectionNum'].includes(a.localName)) continue;
      if ((element.localName === 'n' && a.localName === 'BondOrdering') || (element.localName === 'b' && a.localName === 'BondCircularOrdering')) continue;
      if (element.localName === 'represent' && a.localName === 'attribute') continue;
      if (modeled.has(element) && element.localName !== 'represent' && xmlReferenceAttributes.has(a.localName)) continue; // Rewritten from validated references.
      if (!xmlReferenceAttributes.has(a.localName)) return refuse(`文档属性 ${element.localName}.${a.name} 的引用类型未知`);
      if (mentions(a.value, affected)) return refuse(`文档对象 ${element.localName}.${a.name} 引用了将删除或改变化学属性的对象`);
    }
  }
}

export function guardCdxReferences(objects: CdxObject[], affected: Set<number>, removed: Set<CdxObject>, modeled = new Set<CdxObject>()): void {
  if (!affected.size) return;
  for (const object of objects) {
    let skip = false;
    for (let parent: CdxObject | undefined = object; parent; parent = parent.parent) if (removed.has(parent)) { skip = true; break; }
    if (skip) continue;
    for (const [tag, bytes] of object.props) {
      if (cdxLiteralTags.has(tag) || (object.tag === 0x8005 && [0x0604, 0x0605, 0x060e].includes(tag))) continue;
      if ((object.tag === 0x8004 && tag === 0x0431) || (object.tag === 0x8005 && tag === 0x060b)) continue;
      if (modeled.has(object) && cdxReferenceTags.has(tag) && tag !== 0x000e) continue;
      if (!cdxReferenceTags.has(tag)) return refuse(`CDX 属性 0x${tag.toString(16)} 的引用类型未知`);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
      // Also covers arrays with counts and RepresentsProperty's six-byte records.
      for (let i = 0; i + 4 <= bytes.length; i++) if (affected.has(view.getUint32(i, true))) return refuse(`CDX 属性 0x${tag.toString(16)} 引用了将删除或改变化学属性的对象`);
    }
  }
}
