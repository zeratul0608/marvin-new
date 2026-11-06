import { atomicNumber, emptyDocument, validateDocument } from '../core/model';
import type { ChemicalDocument, SourceFileExportResult } from '../core/types';
import { decodeCdx, encodeCdx, parseCdxTree, readCdx, type CdxObject } from './cdx';
import { readCdxml, writeCdxml } from './xml';
import { escapeXml, fail } from './shared';
import { binaryLabelParts, chemicalLabel, encodeBinaryLabel, labelChanged, rewriteXmlLabel } from './preservation-labels';
import { allocateIds, guardCdxReferences, guardXmlReferences, planFragments } from './preservation-topology';
import { cdxDisplayMapper } from './cdx-display';
import {bracketObjectNames,bracketReferenceProperties,readBracketProperty} from './cdx-brackets';
import { stereoProjection } from './stereo';
import { atomCdxProperties, atomXmlProperties, bondXmlProperties, cdxOrder } from './chemdraw-properties';
import {atomQueryCdxTags,queryCdxPropertyToXml,bondTopologyCdxProperties,readCdxBondTopology} from './query-properties';
import { scopeElements } from './xml-scope';
import { chemicalSymbol } from '../core/query';
import { bindXmlDocument, patchXmlDocument } from './xml-document-write';
import { cdxDrawingChanges, cdxReactionProperties,readCdxDrawingProperty } from './cdx-document';
import {prepareExpandedSource} from './preservation-expansion';
import {prepareCollapsedSource} from './preservation-collapse';
import {xmlReferenceAttributes} from './preservation-properties';
import {substructureDisplayReplacer} from '../core/substructure-display';
import {syncSubstructureDisplay,syncSubstructureDisplayTree} from './xml-substructure-display';

const canonical = (value: unknown): string | undefined => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : v);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const blocked = (reason: string): never => fail(`无法保留源文档保存：${reason}。可保存原生 JSON，或明确选择有损重建。`, 'PRESERVATION_UNSUPPORTED');
const list = (node: CdxObject): CdxObject[] => [node, ...node.children.flatMap(list)];
const pointText = (x: number, y: number) => `${x * 20} ${-y * 20}`;
const labelObjects = (node: Element): Element[] => [node, ...[...node.children].filter(el => el.localName !== 'fragment').flatMap(el => [el, ...el.getElementsByTagName('*')])];

function projection(doc: ChemicalDocument, order?: ChemicalDocument) {
  const arranged = order ? { ...doc, graph: { ...doc.graph, ...(order.graph.reactions ? { reactions: order.graph.reactions } : {}) }, depiction: { ...doc.depiction, ...(order.depiction.objects ? { objects: order.depiction.objects } : {}) } } : doc;
  return stereoProjection(arranged, Object.keys((order ?? doc).graph.atoms), Object.keys((order ?? doc).graph.bonds));
}

function matchesProjection(parsed: ChemicalDocument, doc: ChemicalDocument, order: ChemicalDocument, tolerance: number) {
  const a = projection(parsed), b = projection(doc, order);
  const geometry = (a.objects ?? []).every((object, i) => { const other = b.objects?.[i]; return other && same(Object.keys(object.geometry).sort(), Object.keys(other.geometry).sort()) && Object.entries(object.geometry).every(([key, values]) => values.length === other.geometry[key].length && values.every((v, j) => Math.abs(v - other.geometry[key][j]) <= tolerance * 20)); });
  const objects = (entries: typeof a.objects) => entries?.map(({ geometry: _, ...object }) => object);
  return same(a.atoms, b.atoms) && same(a.bonds, b.bonds) && same(objects(a.objects), objects(b.objects)) && geometry && same(a.style, b.style) && same(a.reactions, b.reactions) && a.positions.length === b.positions.length &&
    a.positions.every((p, i) => Math.abs(p.x - b.positions[i].x) <= tolerance && Math.abs(p.y - b.positions[i].y) <= tolerance);
}
function projectionDifference(a:unknown,b:unknown,path='$'):string|undefined{
  if(typeof a==='number'&&typeof b==='number'&&Math.abs(a-b)<1e-9)return;
  if(typeof a!==typeof b||a===null||b===null||typeof a!=='object')return same(a,b)?undefined:`${path}: ${String(a).slice(0,60)} → ${String(b).slice(0,60)}`;
  for(const key of new Set([...Object.keys(a),...Object.keys(b as object)])){
    const different=projectionDifference((a as Record<string,unknown>)[key],(b as Record<string,unknown>)[key],`${path}.${key}`);if(different)return different;
  }
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
  for (const atom of Object.values(doc.graph.atoms)) if (before.graph.atoms[atom.id]?.atomMap !== atom.atomMap) return blocked('原子映射的保留写入尚未实现');
  for (const atom of Object.values(doc.graph.atoms)) if (before.graph.atoms[atom.id] && before.graph.atoms[atom.id].attachment !== atom.attachment) return blocked('外部连接点与元素之间的类型转换尚未实现');
  return before;
}

function ordered(doc: ChemicalDocument, atoms: string[], bonds: string[], drawings?: string[], reactions?: string[]): ChemicalDocument {
  return { ...doc, graph: { ...doc.graph, atoms: Object.fromEntries(atoms.map(id => [id, doc.graph.atoms[id]])), bonds: Object.fromEntries(bonds.map(id => [id, doc.graph.bonds[id]])), ...(reactions ? { reactions: Object.fromEntries(reactions.map(id => [id, doc.graph.reactions![id]])) } : {}) },
    depiction: { ...doc.depiction, ...(drawings ? { objects: Object.fromEntries(drawings.map(id => [id, doc.depiction.objects![id]])) } : {}) } };
}

export function exportOriginalSource(doc: ChemicalDocument): SourceFileExportResult {
  if (!doc.source) return blocked('当前文档没有原始文件');
  validateDocument({ ...emptyDocument(), source: doc.source });
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

/** A locally patched child may allocate IDs already used by its parent. Only
 * colliding IDs are rebound; unknown or outward references remain protected. */
function bindEmbeddedIds(parent:Document,child:Document,content:Element,replaced?:Element):void{
  const outside=new Set([...parent.getElementsByTagName('*')].filter(el=>el.hasAttribute('id')&&!['font','color'].includes(el.localName)&&!replaced?.contains(el)).map(el=>el.getAttribute('id')!));
  const elements=[content,...content.getElementsByTagName('*')],identified=elements.filter(el=>el.hasAttribute('id')),ids=identified.map(el=>el.getAttribute('id')!);
  if(!ids.some(id=>outside.has(id)))return;
  if(new Set(ids).size!==ids.length)return blocked('内部片段使用了跨层重复 ID，不能可靠重编号');
  const known=new Set(ids),next=allocateIds([...outside,...ids]),remap=new Map(ids.filter(id=>outside.has(id)).map(id=>[id,next()]));
  for(const el of elements)for(const attribute of el.attributes)if(xmlReferenceAttributes.has(attribute.name)&&attribute.value.trim().split(/\s+/).some(id=>id!=='0'&&!known.has(id)))return blocked('内部片段引用了其范围外对象，不能可靠重编号');
  guardXmlReferences(child,new Set(remap.keys()),new Set(),new Set(elements));
  for(const el of elements)for(const attribute of [...el.attributes]){
    if(attribute.name==='id')el.setAttribute('id',remap.get(attribute.value)??attribute.value);
    else if(xmlReferenceAttributes.has(attribute.name))el.setAttribute(attribute.name,attribute.value.trim().split(/\s+/).map(id=>remap.get(id)??id).join(' '));
  }
}

function patchCdxml(doc: ChemicalDocument,expansions=0): string {
  const raw = doc.source!.raw, original = readCdxml(raw).document, before = baseline(doc, original);
  const xml = new DOMParser().parseFromString(raw.replace(/<!DOCTYPE[^>]*>/gi, ''), 'application/xml');
  const expanded=prepareExpandedSource(doc,before,original,xml);
  if(expanded){if(expansions>=2000)return blocked('展开来源重建超过限额');return patchCdxml(expanded,expansions+1);}
  const collapsed=prepareCollapsedSource(doc,before,original,xml);
  if(collapsed){if(expansions>=2000)return blocked('收起来源重建超过限额');return patchCdxml(collapsed,expansions+1);}
  const documentBinding = bindXmlDocument(xml, before, original);
  const all = (tag: string) => [...xml.getElementsByTagName('*')].filter(e => e.localName === tag);
  const nodes = scopeElements(xml, 'n'), bonds = scopeElements(xml, 'b'), fragments = scopeElements(xml, 'fragment');
  const nextId = allocateIds([...xml.getElementsByTagName('*')].map(e => e.getAttribute('id') ?? ''));
  const create = (parent: Element, name: string) => xml.createElementNS(parent.namespaceURI, parent.prefix ? `${parent.prefix}:${name}` : name);
  if (!fragments.length && all('page').length <= 1) {
    const pages = all('page');
    const page = pages[0] ?? create(xml.documentElement, 'page');
    if (!pages.length) { page.setAttribute('id', nextId()); xml.documentElement.append(page); }
    const fragment = create(page, 'fragment'); fragment.setAttribute('id', nextId()); page.append(fragment); fragments.push(fragment);
  }
  const oldAtoms = Object.values(before.graph.atoms), oldBonds = Object.values(before.graph.bonds);
  const atomElements = new Map(oldAtoms.map((a, i) => [a.id, nodes[i]]));
  const bondElements = new Map(oldBonds.map((b, i) => [b.id, bonds[i]]));
  const membership = new Map(oldAtoms.map(a => [a.id, atomElements.get(a.id)!.parentElement!]));
  const plan = planFragments(doc, before, membership, fragments, ids=>{
    const pages=Object.values(doc.depiction.objects??{}).filter(o=>o.tag==='page'&&ids.every(id=>o.atomIds.includes(id)));
    if(pages.length!==1)return;
    const page=documentBinding.objects.get(pages[0].id);if(!page)return;
    const candidates=fragments.filter(fragment=>page.contains(fragment));if(candidates.length===1)return candidates[0];
    const fragment=create(page,'fragment');fragment.setAttribute('id',nextId());page.append(fragment);fragments.push(fragment);return fragment;
  });
  const removed = new Set<Element>(), affected = new Set<string>(), touched = new Set<Element>();
  const touch = (el: Element) => { touched.add(el); const id = el.getAttribute('id'); if (id) affected.add(id); };
  const remove = (el: Element) => { removed.add(el); for (const child of [el, ...el.getElementsByTagName('*')]) { const id = child.getAttribute('id'); if (id) affected.add(id); } touch(el.parentElement!); };
  for (const old of oldAtoms) {
    const node = atomElements.get(old.id)!;
    if (!doc.graph.atoms[old.id]) remove(node);
    else if (labelChanged(before, doc, old.id) || old.radical !== doc.graph.atoms[old.id].radical || !same(old.geometry, doc.graph.atoms[old.id].geometry)) { for (const el of labelObjects(node)) { const id = el.getAttribute('id'); if (id) affected.add(id); } touch(node.parentElement!); }
  }
  for (const old of oldBonds) {
    const bond = bondElements.get(old.id)!, now = doc.graph.bonds[old.id];
    if (!now) remove(bond);
    else {
      if (plan.get(now.atoms[0]) !== bond.parentElement || plan.get(now.atoms[1]) !== bond.parentElement) return blocked('已有键不能跨来源片段重新分配');
      if (!same(old, now) || !same(before.depiction.bonds[old.id], doc.depiction.bonds[old.id])) { const id = bond.getAttribute('id'); if (id) affected.add(id); touch(bond.parentElement!); }
    }
  }
  for (const atom of Object.values(doc.graph.atoms)) if (!before.graph.atoms[atom.id]) touch(plan.get(atom.id)!);
  for (const bond of Object.values(doc.graph.bonds)) if (!before.graph.bonds[bond.id]) touch(plan.get(bond.atoms[0])!);
  guardXmlReferences(xml, affected, removed, new Set([...documentBinding.objects.values(), ...documentBinding.steps.values()]));
  for (const el of removed) el.remove();
  const clearBoxes = (el: Element | null) => { for (; el; el = el.parentElement) el.removeAttribute('BoundingBox'); };
  for (const fragment of touched) clearBoxes(fragment);
  for (const atom of Object.values(doc.graph.atoms)) if (!before.graph.atoms[atom.id]) {
    const fragment = plan.get(atom.id)!, node = create(fragment, 'n'), p = doc.depiction.positions[atom.id];
    node.setAttribute('id', nextId()); node.setAttribute('p', pointText(p.x, p.y));
    for (const [key, value] of Object.entries(atomXmlProperties(atom))) node.setAttribute(key, value);
    if (atom.charge) node.setAttribute('Charge', String(atom.charge));
    if (atom.isotope) node.setAttribute('Isotope', String(atom.isotope));
    if (atom.radical) node.setAttribute('Radical', ['None', 'Singlet', 'Doublet', 'Triplet'][atom.radical]);
    if (atom.hydrogens.mode === 'fixed') node.setAttribute('NumHydrogens', String(atom.hydrogens.count));
    fragment.append(node); atomElements.set(atom.id, node);
  }
  for (const old of oldAtoms) {
    const now = doc.graph.atoms[old.id]; if (!now) continue;
    const node = atomElements.get(old.id)!, p = doc.depiction.positions[old.id], previous = before.depiction.positions[old.id];
    if (!same(p, previous)) {
      const dx = (p.x - previous.x) * 20, dy = -(p.y - previous.y) * 20;
      for (let parent = node.parentElement; parent; parent = parent.parentElement) if (parent.hasAttribute('BoundingBox') && !inside([p.x * 20, -p.y * 20], numericPoint(parent.getAttribute('BoundingBox')!))) parent.removeAttribute('BoundingBox');
      const labels = [...node.children].filter(el => el.localName === 't').flatMap(el => [el, ...el.getElementsByTagName('*')]);
      for (const el of [node, ...labels]) for (const attr of ['p', 'BoundingBox']) if (el.hasAttribute(attr)) {
        const values = numericPoint(el.getAttribute(attr)!); if (values.length !== (attr === 'p' ? 2 : 4)) return blocked('关联排版坐标长度无效');
        el.setAttribute(attr, values.map((n, j) => n + (j % 2 ? dy : dx)).join(' '));
      }
      node.setAttribute('p', pointText(p.x, p.y));
    }
    if (labelChanged(before, doc, old.id)) {
      const labels = [...node.children].filter(el => el.localName === 't');
      if (labels.length) rewriteXmlLabel(node, chemicalLabel(before, doc, old.id, labels.map(el => el.textContent).join('')));
      else if (now.element !== 'C' || now.charge || now.isotope || now.radical || now.query || now.substructure) {
        const text = create(node, 't'); text.setAttribute('p', pointText(p.x, p.y));
        for (const part of chemicalLabel(before, doc, old.id, chemicalSymbol(old))) {
          const run = create(text, 's'); run.setAttribute('font', xml.documentElement.getAttribute('LabelFont') ?? '3'); run.setAttribute('size', xml.documentElement.getAttribute('LabelSize') ?? '10');
          run.setAttribute('face', String((Number(xml.documentElement.getAttribute('LabelFace') ?? 0) & ~0x60) | part.script)); run.textContent = part.text; text.append(run);
        }
        node.append(text);
      }
      clearBoxes(node.parentElement);
    }
    if (old.element !== now.element) node.setAttribute('Element', String(atomicNumber(now.element)));
    if (old.charge !== now.charge) node.setAttribute('Charge', String(now.charge));
    if (old.radical !== now.radical) { if (now.radical) node.setAttribute('Radical', ['None', 'Singlet', 'Doublet', 'Triplet'][now.radical]); else node.removeAttribute('Radical'); }
    if (old.isotope !== now.isotope) { if (now.isotope === undefined) node.removeAttribute('Isotope'); else node.setAttribute('Isotope', String(now.isotope)); }
    if (!same(old.hydrogens, now.hydrogens)) { if (now.hydrogens.mode === 'auto') node.removeAttribute('NumHydrogens'); else node.setAttribute('NumHydrogens', String(now.hydrogens.count)); }
    const oldProps = atomXmlProperties(old), newProps = atomXmlProperties(now);
    for (const key of new Set([...Object.keys(oldProps), ...Object.keys(newProps)])) if (oldProps[key] !== newProps[key]) { if (newProps[key] !== undefined) node.setAttribute(key, newProps[key]); else node.removeAttribute(key); }
    // ChemDraw also stores displayed stereo descriptors as derived objecttag
    // text. Removing AS alone would leave a stale visible "(R)/(S)" caption.
    for(const tag of [...node.children].filter(el=>el.localName==='objecttag')){
      if((tag.getAttribute('Name')==='stereo'&&old.cipLabel!==now.cipLabel)||(tag.getAttribute('Name')==='enhancedstereo'&&!same(old.enhancedStereo,now.enhancedStereo)))tag.remove();
    }
  }
  for (const bond of Object.values(doc.graph.bonds)) {
    const old = before.graph.bonds[bond.id]; let el = bondElements.get(bond.id);
    if (!el) { const fragment = plan.get(bond.atoms[0])!; el = create(fragment, 'b'); el.setAttribute('id', nextId()); fragment.append(el); bondElements.set(bond.id, el); }
    const d = doc.depiction.bonds[bond.id];
    if (!old || !same(old.atoms, bond.atoms)) { el.setAttribute('B', atomElements.get(bond.atoms[0])!.getAttribute('id')!); el.setAttribute('E', atomElements.get(bond.atoms[1])!.getAttribute('id')!); }
    if (!old || old.order !== bond.order) el.setAttribute('Order', bond.order === 'aromatic' ? '1.5' : String(bond.order));
    const oldProps = old ? bondXmlProperties(old) : {}, newProps = bondXmlProperties(bond);
    for (const key of new Set([...Object.keys(oldProps), ...Object.keys(newProps)])) if (oldProps[key] !== newProps[key]) { if (newProps[key] !== undefined) el.setAttribute(key, newProps[key]); else el.removeAttribute(key); }
    if (!old || !same(before.depiction.bonds[bond.id], d) || !same(old.atoms, bond.atoms)) {
      el.setAttribute('Display', d?.style === 'wedge' ? `Wedge${d.from === bond.atoms[1] ? 'End' : 'Begin'}` : d?.style === 'hashed' ? `WedgedHash${d.from === bond.atoms[1] ? 'End' : 'Begin'}` : d?.style === 'wavy' ? 'Wavy' : d?.style === 'dashed' ? 'Dash' : d?.style === 'bold' ? 'Bold' : d?.style === 'hash' ? 'Hash' : 'Solid');
      const position = d?.doublePosition && d.from === bond.atoms[1] && d.doublePosition !== 'center' ? d.doublePosition === 'left' ? 'right' : 'left' : d?.doublePosition;
      if (position) el.setAttribute('DoublePosition', position[0].toUpperCase() + position.slice(1)); else el.removeAttribute('DoublePosition');
      if (d?.labelOffsets) { el.setAttribute('BeginAttach', String(d.labelOffsets[0])); el.setAttribute('EndAttach', String(d.labelOffsets[1])); } else { el.removeAttribute('BeginAttach'); el.removeAttribute('EndAttach'); }
      if (d?.layer !== undefined) el.setAttribute('Z', String(d.layer));
      if (d?.secondaryStyle) el.setAttribute('Display2', d.secondaryStyle === 'dashed' ? 'Dash' : 'Solid'); else el.removeAttribute('Display2');
    }
  }
  // Allocate IDs before encoding constraints, including references to newly added bonds.
  const encodeOrdering = (refs: (string | null)[]) => refs.map(id => {
    if (id === null) return '0';
    const el = bondElements.get(id)!;
    if (!el.hasAttribute('id')) el.setAttribute('id', nextId());
    return el.getAttribute('id')!;
  }).join(' ');
  for (const atom of Object.values(doc.graph.atoms)) if (atom.substructure && !same(before.graph.atoms[atom.id]?.substructure, atom.substructure)) {
    const node = atomElements.get(atom.id)!, old = [...node.children].filter(el => el.localName === 'fragment');
    const withoutDisplay=(value:unknown)=>value===undefined?undefined:JSON.parse(JSON.stringify(value,substructureDisplayReplacer));
    if(same(withoutDisplay(before.graph.atoms[atom.id]?.substructure),withoutDisplay(atom.substructure))){syncSubstructureDisplayTree(node,atom.substructure);continue;}
    atom.substructure.fragments.forEach((fragment, index) => {
      const data = fragment.document.source?.format === 'cdxml' ? exportSourceFile(fragment.document).data : writeCdxml(fragment.document);
      const parsed = new DOMParser().parseFromString(data.replace(/<!DOCTYPE[^>]*>/gi, ''), 'application/xml'), content = scopeElements(parsed, 'fragment')[0];
      if (!content) return blocked('内部片段输出无效');
      const childNodes = scopeElements(parsed, 'n'), ids = Object.keys(fragment.document.graph.atoms);
      if (fragment.attachmentOrder.length) content.setAttribute('ConnectionOrder', fragment.attachmentOrder.map(id => childNodes[ids.indexOf(id)]?.getAttribute('id') ?? blocked('内部连接点输出缺失')).join(' ')); else content.removeAttribute('ConnectionOrder');
      bindEmbeddedIds(xml,parsed,content,old[index]);
      if (old[index]) old[index].replaceWith(xml.importNode(content, true)); else node.append(xml.importNode(content, true));
    });
    for (const el of old.slice(atom.substructure.fragments.length)) el.remove();
    if (atom.substructure.connections.length) node.setAttribute('BondOrdering', encodeOrdering(atom.substructure.connections.map(port => port.bondId))); else node.removeAttribute('BondOrdering');
    syncSubstructureDisplay(node,atom.substructure);
  }
  for (const atom of Object.values(doc.graph.atoms)) if (!same(before.graph.atoms[atom.id]?.geometry, atom.geometry)) {
    const el = atomElements.get(atom.id)!;
    if (atom.geometry) { el.setAttribute('Geometry', 'Tetrahedral'); el.setAttribute('BondOrdering', encodeOrdering(atom.geometry.bondOrdering)); }
    else { el.removeAttribute('Geometry'); el.removeAttribute('BondOrdering'); }
  }
  for (const atom of Object.values(doc.graph.atoms)) if (!same(before.graph.atoms[atom.id]?.multiAttachment, atom.multiAttachment)) {
    const el = atomElements.get(atom.id)!;
    if (atom.multiAttachment) el.setAttribute('Attachments', atom.multiAttachment.map(id => atomElements.get(id)!.getAttribute('id')).join(' ')); else el.removeAttribute('Attachments');
  }
  for (const bond of Object.values(doc.graph.bonds)) if (!same(before.graph.bonds[bond.id]?.circularOrdering, bond.circularOrdering)) {
    const el = bondElements.get(bond.id)!;
    if (bond.circularOrdering) el.setAttribute('BondCircularOrdering', encodeOrdering(bond.circularOrdering)); else el.removeAttribute('BondCircularOrdering');
  }
  for (const bond of Object.values(doc.graph.bonds)) if (!same(before.depiction.bonds[bond.id]?.crossings, doc.depiction.bonds[bond.id]?.crossings)) {
    const el = bondElements.get(bond.id)!, refs = doc.depiction.bonds[bond.id]?.crossings;
    if (refs?.length) el.setAttribute('CrossingBonds', refs.map(id => { const target = bondElements.get(id)!; if (!target.hasAttribute('id')) target.setAttribute('id', nextId()); return target.getAttribute('id'); }).join(' ')); else el.removeAttribute('CrossingBonds');
  }
  if (touched.size) {
    for (const [id, el] of atomElements) if (doc.graph.atoms[id]) { const cip = doc.graph.atoms[id].cipLabel; if (cip) el.setAttribute('AS', cip); else el.removeAttribute('AS'); }
    for (const [id, el] of bondElements) if (doc.graph.bonds[id]) { const cip = doc.graph.bonds[id].cipLabel; if (cip) el.setAttribute('BS', cip); else el.removeAttribute('BS'); }
    for (const el of [...xml.getElementsByTagName('*')]) if (['CDXML', 'page', 'group', 'fragment', 'n', 'b'].includes(el.localName)) el.removeAttribute('Warning');
  }
  patchXmlDocument(xml, doc, before, documentBinding, atomElements, bondElements, nextId);
  const declaration = raw.match(/^\s*<\?xml[^?]*\?>/)?.[0] ?? '<?xml version="1.0" encoding="UTF-8"?>';
  const doctype = raw.match(/<!DOCTYPE[^>]*>/i)?.[0];
  const body = new XMLSerializer().serializeToString(xml).replace(/^\s*<\?xml[^?]*\?>/, '');
  const output = `${declaration}\n${doctype ? doctype + '\n' : ''}${body}`;
  const modelAtoms = new Map([...atomElements].map(([id, el]) => [el, id])), modelBonds = new Map([...bondElements].map(([id, el]) => [el, id]));
  const drawingIds = new Map([...documentBinding.objects].map(([id, el]) => [el, id])), reactionIds = new Map([...documentBinding.steps].map(([id, el]) => [el, id]));
  const elements = [...xml.getElementsByTagName('*')];
  const order = ordered(doc, scopeElements(xml, 'n').map(el => modelAtoms.get(el)!), scopeElements(xml, 'b').map(el => modelBonds.get(el)!), elements.filter(el => drawingIds.has(el)).map(el => drawingIds.get(el)!), elements.filter(el => reactionIds.has(el)).map(el => reactionIds.get(el)!));
  if (!matchesProjection(readCdxml(output).document, doc, order, 1e-10)) {
    const a = projection(readCdxml(output).document), b = projection(doc, order);
    return blocked(`保留结果的内容复核失败（${projectionDifference(a,b)}）`);
  }
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
  for (const atom of Object.values(doc.graph.atoms)) {
    int(atom.charge, 1, true); if (atom.isotope !== undefined) int(atom.isotope, 2);
    if (atom.hydrogens.mode === 'fixed') int(atom.hydrogens.count, 2);
    const p = doc.depiction.positions[atom.id]; fixed(p.x * 20); fixed(-p.y * 20);
  }
  const bytes = decodeCdx(doc.source!.raw), root = parseCdxTree(bytes), objects = list(root);
  const original = readCdx(bytes).document, before = baseline(doc, original), fragments = objects.filter(o => o.tag === 0x8003);
  const bindNative = (old: Record<string,{source?:{format:string;serial?:number}}> | undefined, parsed: typeof old) => {
    const values = Object.values(parsed ?? {});
    return new Map(Object.keys(old ?? {}).map((id,i) => [id, objects.find(o => o.serial === values[i]?.source?.serial) ?? blocked('CDX 文档对象来源绑定失败')]));
  };
  const drawingObjects = bindNative(before.depiction.objects, original.depiction.objects), reactionObjects = bindNative(before.graph.reactions, original.graph.reactions);
  const nodes = objects.filter(o => o.tag === 0x8004), bonds = objects.filter(o => o.tag === 0x8005);
  const oldAtoms = Object.values(before.graph.atoms), oldBonds = Object.values(before.graph.bonds);
  const atomObjects = new Map(oldAtoms.map((a, i) => [a.id, nodes[i]])), bondObjects = new Map(oldBonds.map((b, i) => [b.id, bonds[i]]));
  const membership = new Map(oldAtoms.map(a => [a.id, atomObjects.get(a.id)!.parent!]));
  const plan = planFragments(doc, before, membership, fragments);
  const removed = new Set<CdxObject>(), affected = new Set<number>(), touched = new Set<CdxObject>();
  const affect = (o: CdxObject) => { for (const child of list(o)) if (child.id) affected.add(child.id); };
  const touch = (o: CdxObject) => { touched.add(o); if (o.id) affected.add(o.id); };
  for (const old of oldAtoms) {
    const node = atomObjects.get(old.id)!;
    if (!doc.graph.atoms[old.id]) { removed.add(node); affect(node); touch(node.parent!); }
    else if (labelChanged(before, doc, old.id) || old.radical !== doc.graph.atoms[old.id].radical || !same(old.geometry, doc.graph.atoms[old.id].geometry)) { affect(node); touch(node.parent!); }
  }
  for (const old of oldBonds) {
    const node = bondObjects.get(old.id)!, now = doc.graph.bonds[old.id];
    if (!now) { removed.add(node); affect(node); touch(node.parent!); }
    else {
      if (plan.get(now.atoms[0]) !== node.parent || plan.get(now.atoms[1]) !== node.parent) return blocked('已有键不能跨来源片段重新分配');
      if (!same(old, now) || !same(before.depiction.bonds[old.id], doc.depiction.bonds[old.id])) { affect(node); touch(node.parent!); }
    }
  }
  for (const atom of Object.values(doc.graph.atoms)) if (!before.graph.atoms[atom.id]) touch(plan.get(atom.id)!);
  for (const bond of Object.values(doc.graph.bonds)) if (!before.graph.bonds[bond.id]) touch(plan.get(bond.atoms[0])!);
  for (const [id,object] of drawingObjects) if (!doc.depiction.objects?.[id]) removed.add(object);
  for (const [id,object] of reactionObjects) if (!doc.graph.reactions?.[id]) removed.add(object);
  guardCdxReferences(objects, affected, removed, new Set([...drawingObjects.values(),...reactionObjects.values()]));
  const changes = new Map<CdxObject, Map<number, Uint8Array | undefined>>(), children = new Map<CdxObject, Uint8Array[]>();
  const set = (o: CdxObject, tag: number, value?: Uint8Array) => { const props = changes.get(o) ?? new Map(); props.set(tag, value); changes.set(o, props); };
  const clearBoxes = (o?: CdxObject) => { for (; o; o = o.parent) set(o, 0x0204); };
  const property = (tag: number, value: Uint8Array) => join([int(tag, 2), ...(value.length >= 0xffff ? [int(0xffff, 2), int(value.length, 4)] : [int(value.length, 2)]), value]);
  const object = (tag: number, id: number, props: [number, Uint8Array][]) => join([int(tag, 2), int(id, 4), ...props.map(([tag, value]) => property(tag, value)), int(0, 2)]);
  const append = (parent: CdxObject, child: Uint8Array) => { const values = children.get(parent) ?? []; values.push(child); children.set(parent, values); };
  const nextId = allocateIds(objects.map(o => String(o.id)));
  const atomRefs = new Map(oldAtoms.map(a => [a.id, atomObjects.get(a.id)!.id]));
  const bondRefs = new Map(Object.keys(doc.graph.bonds).map(id => [id, before.graph.bonds[id] ? bondObjects.get(id)!.id : Number(nextId())]));
  const ordering = (refs: (string | null)[]) => join(refs.map(id => { const ref = id === null ? 0 : bondRefs.get(id); if (ref === undefined || (id !== null && !ref)) return blocked('立体约束不能引用没有源 ID 的键'); return int(ref, 4); }));
  const addedAtoms = new Map<CdxObject, string[]>(), addedBonds = new Map<CdxObject, string[]>();
  const note = (map: Map<CdxObject, string[]>, parent: CdxObject, id: string) => { const ids = map.get(parent) ?? []; ids.push(id); map.set(parent, ids); };
  for (const fragment of touched) clearBoxes(fragment);
  for (const atom of Object.values(doc.graph.atoms)) if (!before.graph.atoms[atom.id]) {
    const parent = plan.get(atom.id)!, id = Number(nextId()), p = doc.depiction.positions[atom.id];
    atomRefs.set(atom.id, id);
    const props: [number, Uint8Array][] = [[0x0200, join([fixed(-p.y * 20), fixed(p.x * 20)])], ...atomCdxProperties(atom)];
    if (atom.charge) props.push([0x0421, int(atom.charge, 1, true)]);
    if (atom.isotope) props.push([0x0420, int(atom.isotope, 2)]);
    if (atom.radical) props.push([0x0422, int(atom.radical, 1)]);
    if (atom.hydrogens.mode === 'fixed') props.push([0x042b, int(atom.hydrogens.count, 2)]);
    if (atom.geometry) props.push([0x0430, int(7, 1)], [0x0431, ordering(atom.geometry.bondOrdering)]);
    append(parent, object(0x8004, id, props)); note(addedAtoms, parent, atom.id);
  }
  const nativeReference = (ref: import('../core/types').DocumentReference): number => {
    if (ref.kind === 'molecule') {
      const fragment = fragments.find(f => { const members=Object.keys(doc.graph.atoms).filter(id => plan.get(id)===f); return members.length===ref.atomIds.length && members.every(id=>ref.atomIds.includes(id)) && (members.length>0||String(f.id)===ref.sourceId); });
      return fragment?.id ?? blocked('反应参与者不能对应完整来源片段');
    }
    const value = ref.kind==='atom'?atomRefs.get(ref.id):ref.kind==='bond'?bondRefs.get(ref.id):drawingObjects.get(ref.id)?.id;
    return value || blocked('文档引用缺少有效来源 ID');
  };
  for (const drawing of Object.values(doc.depiction.objects ?? {})) {
    const previous=before.depiction.objects?.[drawing.id], native=drawingObjects.get(drawing.id);
    if(!previous||!native)return blocked('新增 CDX 图元尚未实现二进制写入，请使用 CDXML');
    if(previous.parentId!==drawing.parentId)return blocked('CDX 图元跨父对象重新分配尚未实现');
    for(const [tag,value]of cdxDrawingChanges(previous,drawing))set(native,tag,value);
    if(!same(previous.references,drawing.references)) for(const key of new Set([...Object.keys(previous.references),...Object.keys(drawing.references)])) {
      const bracketTag=Object.keys(bracketReferenceProperties).map(Number).find(tag=>bracketReferenceProperties[tag]===key);
      if(bracketTag!==undefined){const refs=drawing.references[key]??[];if(bracketTag!==0x0a27&&refs.length>1)return blocked('括号边界只能指向一个对象');set(native,bracketTag,refs.length?join(refs.map(ref=>int(nativeReference(ref),4))):undefined);continue;}
      if(key!=='SupersededBy')return blocked(`CDX 图元引用 ${key} 尚未实现写入`);
      const refs=drawing.references[key]??[];if(refs.length>1)return blocked('SupersededBy 只能指向一个对象');set(native,native.props.has(0x0013)?0x0013:0x0012,refs.length?int(nativeReference(refs[0]),4):undefined);
    }
  }
  for(const step of Object.values(doc.graph.reactions??{})) {
    const previous=before.graph.reactions?.[step.id],native=reactionObjects.get(step.id);if(!previous||!native)return blocked('新增 CDX 反应步骤尚未实现二进制写入，请使用 CDXML');
    if(step.schemeId!==previous.schemeId)return blocked('CDX 反应步骤跨方案移动尚未实现');
    for(const [tagText,name]of Object.entries(cdxReactionProperties)) {
      const tag=Number(tagText),role=({ReactionStepReactants:'reactants',ReactionStepProducts:'products',ReactionStepPlusses:'pluses',ReactionStepArrows:'arrows',ReactionStepObjectsAboveArrow:'above',ReactionStepObjectsBelowArrow:'below'} as const)[name as 'ReactionStepReactants'];
      let values:number[]|undefined;
      if(role)values=step[role].map(nativeReference);
      else {const mode=tag===0x0c00?'specified':tag===0x0c07?'manual':'auto',mapping=step.atomMappings?.find(m=>m.mode===mode);values=mapping?.atoms.flat().map(id=>nativeReference({kind:'atom',id}));}
      if(values?.length)set(native,tag,join(values.map(n=>int(n,4))));else if(native.props.has(tag))set(native,tag);
    }
  }
  for (const old of oldAtoms) {
    const now = doc.graph.atoms[old.id]; if (!now) continue;
    const node = atomObjects.get(old.id)!, p = doc.depiction.positions[old.id], previous = before.depiction.positions[old.id];
    if (!same(p, previous)) {
      const dx = (p.x - previous.x) * 20, dy = -(p.y - previous.y) * 20;
      for (let parent = node.parent; parent; parent = parent.parent) {
        const box = parent.props.get(0x0204);
        if (box) { if (box.length !== 16) return blocked('来源包围框长度无效'); const b = Array.from({ length: 4 }, (_, j) => number(box.subarray(j * 4, j * 4 + 4), true) / 65536); if (!inside([p.x * 20, -p.y * 20], [b[1], b[0], b[3], b[2]])) set(parent, 0x0204); }
      }
      for (const child of list(node)) for (const tag of [0x0200, 0x0204]) {
        const data = child.props.get(tag); if (!data) continue;
        if (data.length !== (tag === 0x0200 ? 8 : 16)) return blocked('关联排版坐标长度无效');
        set(child, tag, join(Array.from({ length: data.length / 4 }, (_, j) => fixed(number(data.subarray(j * 4, j * 4 + 4), true) / 65536 + (j % 2 ? dx : dy)))));
      }
      set(node, 0x0200, join([fixed(-p.y * 20), fixed(p.x * 20)]));
    }
    if (labelChanged(before, doc, old.id)) {
      const labels = node.children.filter(child => child.tag === 0x8006);
      if (labels.length > 1 || node.children.some(child => ![0x8006, 0x8011].includes(child.tag)) || labels.some(label => label.children.length)) return blocked('原子包含多个标签或附属对象，尚不能安全改写');
      let fallback: Uint8Array | undefined;
      for (let parent: CdxObject | undefined = node; parent; parent = parent.parent) if (parent.props.has(0x080a)) { fallback = parent.props.get(0x080a); break; }
      if (labels.length) {
        const text = labels[0], data = text.props.get(0x0700); if (!data) return blocked('CDX 标签缺少文本属性');
        const original = binaryLabelParts(data, fallback), parts = chemicalLabel(before, doc, old.id, original.text);
        set(text, 0x0700, encodeBinaryLabel(parts, original.style)); set(text, 0x0204); set(text, 0x0704);
      } else if (now.element !== 'C' || now.charge || now.isotope || now.radical || now.query) {
        const style = fallback ?? join([int(3, 2), int(0, 2), int(200, 2), int(0, 2)]);
        append(node, object(0x8006, Number(nextId()), [[0x0200, join([fixed(-p.y * 20), fixed(p.x * 20)])], [0x0700, encodeBinaryLabel(chemicalLabel(before, doc, old.id, chemicalSymbol(old)), style)]]));
      }
      set(node, 0x0204); clearBoxes(node.parent);
    }
    if (old.element !== now.element) set(node, 0x0402, int(atomicNumber(now.element), 2));
    if (old.charge !== now.charge) set(node, 0x0421, int(now.charge, 1, true));
    if (old.radical !== now.radical) set(node, 0x0422, now.radical ? int(now.radical, 1) : undefined);
    if (old.isotope !== now.isotope) set(node, 0x0420, now.isotope === undefined ? undefined : int(now.isotope, 2));
    if (!same(old.hydrogens, now.hydrogens)) set(node, 0x042b, now.hydrogens.mode === 'auto' ? undefined : int(now.hydrogens.count, 2));
    if (!same(old.geometry, now.geometry)) { set(node, 0x0430, now.geometry ? int(7, 1) : undefined); set(node, 0x0431, now.geometry ? ordering(now.geometry.bondOrdering) : undefined); }
    if (!same(old.query, now.query)) {
      const props = atomCdxProperties(now);
      for (const tag of [0x0400, 0x0402, 0x0403, 0x0433]) set(node, tag, props.get(tag));
    }
    if(!same(old.queryConstraints,now.queryConstraints)){const props=atomCdxProperties(now);for(const tag of atomQueryCdxTags)set(node,tag,props.get(tag));}
    if (old.cipLabel !== now.cipLabel) set(node, 0x0437, atomCdxProperties(now).get(0x0437));
    if (old.connectionType !== now.connectionType) set(node, 0x0440, atomCdxProperties(now).get(0x0440));
    if (old.sourceNumber !== now.sourceNumber) set(node, 0x044d, atomCdxProperties(now).get(0x044d));
    if (old.attachmentIndex !== now.attachmentIndex) set(node, 0x044b, atomCdxProperties(now).get(0x044b));
  }
  const bondDisplay = (id: string) => { const b = doc.graph.bonds[id], d = doc.depiction.bonds[id]; return d?.style === 'wedge' ? d.from === b.atoms[1] ? 7 : 6 : d?.style === 'hashed' ? d.from === b.atoms[1] ? 4 : 3 : d?.style === 'wavy' ? 8 : d?.style === 'dashed' ? 1 : d?.style === 'hash' ? 2 : d?.style === 'bold' ? 5 : 0; };
  const bondPosition = (id: string): Uint8Array | undefined => { const b = doc.graph.bonds[id], d = doc.depiction.bonds[id]; return d?.doublePosition ? int(256 + (d.doublePosition === 'center' ? 0 : (d.doublePosition === 'left') !== (d.from === b.atoms[1]) ? 2 : 1), 2) : undefined; };
  const bondOrder = (id: string) => cdxOrder(doc.graph.bonds[id].order);
  for (const bond of Object.values(doc.graph.bonds)) {
    const old = before.graph.bonds[bond.id], parent = plan.get(bond.atoms[0])!;
    const begin = atomRefs.get(bond.atoms[0])!, end = atomRefs.get(bond.atoms[1])!;
    if (!begin || !end) return blocked('没有源 ID 的原子尚不能建立键引用');
    if (old) {
      const node = bondObjects.get(old.id)!;
      if (!same(old.atoms, bond.atoms)) { set(node, 0x0604, int(begin, 4)); set(node, 0x0605, int(end, 4)); }
      if (old.order !== bond.order) set(node, 0x0600, int(bondOrder(bond.id), 2));
      if(old.topology!==bond.topology)set(node,0x0606,bondTopologyCdxProperties(bond).get(0x0606));
      if (old.cipLabel !== bond.cipLabel) set(node, 0x060a, bond.cipLabel ? int(bond.cipLabel === 'E' ? 2 : 3, 1) : undefined);
      if (!same(old.circularOrdering, bond.circularOrdering)) set(node, 0x060b, bond.circularOrdering ? ordering(bond.circularOrdering) : undefined);
      if (!same(before.depiction.bonds[old.id], doc.depiction.bonds[bond.id]) || !same(old.atoms, bond.atoms)) { set(node, 0x0601, int(bondDisplay(bond.id), 2)); set(node, 0x0603, bondPosition(bond.id)); }
      const d = doc.depiction.bonds[bond.id], previous = before.depiction.bonds[bond.id];
      if (!same(d?.labelOffsets, previous?.labelOffsets)) { set(node, 0x0608, d?.labelOffsets ? int(d.labelOffsets[0], 1) : undefined); set(node, 0x0609, d?.labelOffsets ? int(d.labelOffsets[1], 1) : undefined); }
      if (!same(d?.crossings, previous?.crossings)) set(node, 0x060e, d?.crossings ? join(d.crossings.map(id => int(bondRefs.get(id)!, 4))) : undefined);
      if (d?.layer !== previous?.layer) set(node, 0x000a, d?.layer !== undefined ? int(d.layer, 2, true) : undefined);
    } else {
      append(parent, object(0x8005, bondRefs.get(bond.id)!, [[0x0604, int(begin, 4)], [0x0605, int(end, 4)], [0x0600, int(bondOrder(bond.id), 2)], [0x0601, int(bondDisplay(bond.id), 2)],...bondTopologyCdxProperties(bond), ...(bond.circularOrdering ? [[0x060b, ordering(bond.circularOrdering)] as [number, Uint8Array]] : []), ...(bond.cipLabel ? [[0x060a, int(bond.cipLabel === 'E' ? 2 : 3, 1)] as [number, Uint8Array]] : [])]));
      note(addedBonds, parent, bond.id);
      const d = doc.depiction.bonds[bond.id], extra: Uint8Array[] = [];
      if (d?.labelOffsets) extra.push(property(0x0608, int(d.labelOffsets[0], 1)), property(0x0609, int(d.labelOffsets[1], 1)));
      if (d?.crossings) extra.push(property(0x060e, join(d.crossings.map(id => int(bondRefs.get(id)!, 4)))));
      if (d?.layer !== undefined) extra.push(property(0x000a, int(d.layer, 2, true)));
      if (extra.length) { const entries = children.get(parent)!, encoded = entries.pop()!; entries.push(join([encoded.subarray(0, encoded.length - 2), ...extra, int(0, 2)])); }
      if (bondPosition(bond.id)) {
        const entries = children.get(parent)!;
        const encoded = entries.pop()!;
        entries.push(join([encoded.subarray(0, encoded.length - 2), property(0x0603, bondPosition(bond.id)!), int(0, 2)]));
      }
    }
  }
  if (touched.size) {
    for (const [id, node] of atomObjects) if (!removed.has(node)) set(node, 0x0437, atomCdxProperties(doc.graph.atoms[id]).get(0x0437));
    for (const [id, bond] of bondObjects) if (!removed.has(bond)) { const cip = doc.graph.bonds[id].cipLabel; set(bond, 0x060a, cip ? int(cip === 'E' ? 2 : 3, 1) : undefined); }
    for (const o of objects) if ([0x8000, 0x8001, 0x8002, 0x8003, 0x8004, 0x8005].includes(o.tag) && !removed.has(o)) set(o, 0x0010);
  }
  const edits = new Map<number, { end: number; data: Uint8Array }>();
  for (const o of removed) edits.set(o.start, { end: o.end, data: new Uint8Array() });
  const additions = new Map<CdxObject, Uint8Array[]>();
  for (const [o, props] of changes) {
    if (removed.has(o)) continue;
    for (const [tag, value] of props) {
      const data = value ? property(tag, value) : new Uint8Array(), range = o.ranges.get(tag);
      if (range) edits.set(range.start, { end: range.end, data });
      else if (value) { const values = additions.get(o) ?? []; values.push(data); additions.set(o, values); }
    }
  }
  for (const parent of new Set([...additions.keys(), ...children.keys()])) edits.set(parent.end - 2, { end: parent.end - 2, data: join([...(additions.get(parent) ?? []), ...(children.get(parent) ?? [])]) });
  const pieces: Uint8Array[] = []; let offset = 0;
  for (const [start, edit] of [...edits].sort(([a], [b]) => a - b)) { if (start < offset) return blocked('源属性修改发生冲突'); pieces.push(bytes.subarray(offset, start), edit.data); offset = edit.end; }
  pieces.push(bytes.subarray(offset)); const output = join(pieces);
  const order = ordered(doc,
    fragments.flatMap(f => [...oldAtoms.filter(a => doc.graph.atoms[a.id] && membership.get(a.id) === f).map(a => a.id), ...(addedAtoms.get(f) ?? [])]),
    fragments.flatMap(f => [...oldBonds.filter(b => doc.graph.bonds[b.id] && bondObjects.get(b.id)!.parent === f).map(b => b.id), ...(addedBonds.get(f) ?? [])]));
  if (!matchesProjection(readCdx(output).document, doc, order, .5 / 65536 / 20 + 1e-12)) return blocked('保留结果的化学内容复核失败');
  return encodeCdx(output);
}

/** Only known, exactly representable objects/properties are converted; no opaque payload is hidden in XML. */
export function convertCdxDocumentToCdxml(doc: ChemicalDocument): string {
  if (doc.source?.format !== 'cdx') return blocked('来源不是 CDX');
  const source = exportSourceFile(doc), root = parseCdxTree(decodeCdx(source.data));
  const names: Record<number, string> = { 0x8000: 'CDXML', 0x8001: 'page', 0x8002: 'group', 0x8003: 'fragment', 0x8004: 'n', 0x8005: 'b', 0x8006: 't' };
  const displayProperty = cdxDisplayMapper(root);
  const seen = new Set<number>();
  const encode = (object: CdxObject, virtual = false): string => {
    const name = names[object.tag]??bracketObjectNames[object.tag]??(object.tag===0x8007?'graphic':undefined); if (!name) return blocked(`CDX 对象 0x${object.tag.toString(16)} 尚无完整 CDXML 映射`);
    const attributes: Record<string, string> = {};
    const extraChildren: string[] = [];
    if (!virtual && object.id) { if (seen.has(object.id)) return blocked('CDX 局部重复 ID 无法原样映射到 CDXML'); seen.add(object.id); attributes.id = String(object.id); }
    if (object.tag === 0x8004 && !object.id) return blocked('未分配 ID 的 CDX 原子尚无完整 CDXML 映射');
    const scalar = (bytes: Uint8Array, width: number, signed = false) => { if (bytes.length !== width) return blocked('CDX 属性长度不符合映射'); return number(bytes, signed); };
    for (const [tag, bytes] of object.props) {
      if (displayProperty(object, tag, bytes, attributes, extraChildren)) continue;
      const bracket=readBracketProperty(tag,bytes);if(bracket){attributes[bracket[0]]=bracket[1];continue;}
      if(object.tag===0x8007){const mapped=readCdxDrawingProperty(tag,bytes);if(mapped){attributes[mapped[0]]=mapped[1];continue;}}
      if (tag === 0x000a) attributes.Z = String(scalar(bytes, 2, true));
      else if (object.tag === 0x8006 && tag === 0x0200) { if (bytes.length !== 8) return blocked('文本坐标长度无效'); attributes.p = `${number(bytes.subarray(4), true) / 65536} ${number(bytes.subarray(0, 4), true) / 65536}`; }
      else if (tag === 0x0204) {
        if (bytes.length !== 16) return blocked('CDX 包围框长度不符合映射');
        const v = Array.from({ length: 4 }, (_, i) => number(bytes.subarray(i * 4, i * 4 + 4), true) / 65536);
        attributes.BoundingBox = [v[1], v[0], v[3], v[2]].join(' ');
      } else if (object.tag === 0x8000 && tag === 0x0805) attributes.BondLength = String(scalar(bytes, 4, true) / 65536);
      else if (object.tag === 0x8004) {
        const query=queryCdxPropertyToXml(tag,bytes);if(query){attributes[query[0]]=query[1];continue;}
        if (tag === 0x0200) { if (bytes.length !== 8) return blocked('CDX 坐标长度不符合映射'); attributes.p = `${number(bytes.subarray(4), true) / 65536} ${number(bytes.subarray(0, 4), true) / 65536}`; }
        else if (tag === 0x0400 && [0, 1, 2, 7, 12].includes(scalar(bytes, 2))) attributes.NodeType = ({ 0: 'Unspecified', 1: 'Element', 2: 'ElementList', 7: 'GenericNickname', 12: 'ExternalConnectionPoint' } as Record<number, string>)[scalar(bytes, 2)];
        else if (tag === 0x0403 && bytes.length >= 4 && bytes.length % 2 === 0) { const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length), n = v.getInt16(0, true); if (Math.abs(n) * 2 + 2 !== bytes.length) return blocked('查询元素列表长度无效'); attributes.ElementList = `${n < 0 ? 'NOT ' : ''}${Array.from({ length: Math.abs(n) }, (_, i) => v.getUint16(i * 2 + 2, true)).join(' ')}`; }
        else if (tag === 0x0433 && bytes.length >= 2 && bytes[0] === 0 && bytes[1] === 0 && bytes.subarray(2).every(n => n < 128)) attributes.GenericNickname = new TextDecoder().decode(bytes.subarray(2));
        else if (tag === 0x0402) attributes.Element = String(scalar(bytes, 2));
        else if (tag === 0x0440 && scalar(bytes, 1) <= 4) attributes.ExternalConnectionType = ['Unspecified','Diamond','Star','PolymerBead','Wavy'][scalar(bytes, 1)];
        else if (tag === 0x0420) attributes.Isotope = String(scalar(bytes, 2));
        else if (tag === 0x0422 && scalar(bytes, 1) <= 3) attributes.Radical = ['None', 'Singlet', 'Doublet', 'Triplet'][scalar(bytes, 1)];
        else if (tag === 0x0421) attributes.Charge = String(bytes.length === 4 ? scalar(bytes, 4, true) >> 24 : scalar(bytes, 1, true));
        else if (tag === 0x042b) attributes.NumHydrogens = String(scalar(bytes, 2));
        else if (tag === 0x0448 && bytes.length === 0) attributes.NeedsClean = 'yes';
        else if (tag === 0x044d) attributes.AtomID = String(scalar(bytes, 4));
        else if (tag === 0x044b && [1, 2, 4].includes(bytes.length)) attributes.ExternalConnectionNum = String(number(bytes));
        else if (tag === 0x0430 && [0, 7].includes(scalar(bytes, 1))) attributes.Geometry = scalar(bytes, 1) === 7 ? 'Tetrahedral' : 'Unknown';
        else if (tag === 0x0431 && bytes.length === 16) attributes.BondOrdering = Array.from({ length: 4 }, (_, i) => number(bytes.subarray(i * 4, i * 4 + 4))).join(' ');
        else if (tag === 0x0437 && scalar(bytes, 1) <= 6) attributes.AS = ['U', 'N', 'R', 'S', 'r', 's', 'u'][scalar(bytes, 1)];
        else return blocked(`CDX 原子属性 0x${tag.toString(16)} 尚无完整 CDXML 映射`);
      } else if (object.tag === 0x8005) {
        if(tag===0x0606){attributes.Topology=readCdxBondTopology(new Map([[tag,bytes]]))!;continue;}
        const orders: Record<number, string> = { 1: '1', 2: '2', 4: '3', 128: '1.5', 256: '2.5', 65535: 'any' };
        const displays: Record<number, string> = { 0: 'Solid', 1: 'Dash', 2: 'Hash', 3: 'WedgedHashBegin', 4: 'WedgedHashEnd', 5: 'Bold', 6: 'WedgeBegin', 7: 'WedgeEnd', 8: 'Wavy' };
        if (tag === 0x0604 || tag === 0x0605) attributes[tag === 0x0604 ? 'B' : 'E'] = String(scalar(bytes, 4));
        else if (tag === 0x0600 && orders[scalar(bytes, 2)]) attributes.Order = orders[scalar(bytes, 2)];
        else if (tag === 0x0601 && displays[scalar(bytes, 2)]) attributes.Display = displays[scalar(bytes, 2)];
        else if (tag === 0x0603 && [0, 1, 2, 256, 257, 258].includes(scalar(bytes, 2))) attributes.DoublePosition = ['Center', 'Right', 'Left'][scalar(bytes, 2) & 255];
        else if (tag === 0x060a && scalar(bytes, 1) <= 3) attributes.BS = ['U', 'N', 'E', 'Z'][scalar(bytes, 1)];
        else if (tag === 0x0608 || tag === 0x0609) attributes[tag === 0x0608 ? 'BeginAttach' : 'EndAttach'] = String(scalar(bytes, 1));
        else if (tag === 0x060e && bytes.length % 4 === 0) attributes.CrossingBonds = Array.from({ length: bytes.length / 4 }, (_, i) => number(bytes.subarray(i * 4, i * 4 + 4))).join(' ');
        else if (tag === 0x060b && bytes.length === 16) attributes.BondCircularOrdering = Array.from({ length: 4 }, (_, i) => number(bytes.subarray(i * 4, i * 4 + 4))).join(' ');
        else return blocked(`CDX 键属性 0x${tag.toString(16)} 尚无完整 CDXML 映射`);
      } else return blocked(`CDX 属性 0x${tag.toString(16)} 尚无完整 CDXML 映射`);
    }
    return `<${name}${Object.entries(attributes).map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join('')}>${extraChildren.join('')}${object.children.map(child => encode(child)).join('')}</${name}>`;
  };
  const actual = root.children.length === 1 && root.children[0].tag === 0x8000 && !root.props.size ? root.children[0] : root;
  const output = `<?xml version="1.0" encoding="UTF-8"?>\n${encode(actual, actual === root)}`;
  const saved = readCdx(decodeCdx(source.data)).document;
  if (!matchesProjection(readCdxml(output).document, saved, saved, 1e-10)) return blocked('跨格式转换的化学内容复核失败');
  return output;
}
