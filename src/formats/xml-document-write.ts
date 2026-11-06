import type { ChemicalDocument, DocumentReference } from '../core/types';
import { reactionRoles } from '../core/drawing';
import { reactionAttributes, xmlAtPath } from './xml-document';
import { scopeElements } from './xml-scope';
import { fail } from './shared';
import { connectedComponents, emptyDocument } from '../core/model';

/** Bind only to provenance from a fresh parse of the trusted source, never JSON-supplied paths. */
export function bindXmlDocument(xml: Document, baseline: ChemicalDocument, original: ChemicalDocument) {
  const objects = new Map<string, Element>(), steps = new Map<string, Element>();
  const bind = (old: Record<string, { source?: { format: string; path?: number[] } }> | undefined, parsed: typeof old, output: Map<string, Element>) => {
    const entries = Object.values(parsed ?? {});
    Object.keys(old ?? {}).forEach((id, i) => {
      const source = entries[i]?.source, el = source?.format === 'cdxml' && source.path ? xmlAtPath(xml, source.path) : undefined;
      if (!el) fail('文档对象的来源路径无效', 'INVALID_DOCUMENT_REFERENCE'); output.set(id, el);
    });
  };
  bind(baseline.depiction.objects, original.depiction.objects, objects);
  bind(baseline.graph.reactions, original.graph.reactions, steps);
  return { objects, steps };
}

export function patchXmlDocument(xml: Document, doc: ChemicalDocument, before: ChemicalDocument,
  binding: ReturnType<typeof bindXmlDocument>, atomElements: Map<string, Element>, bondElements: Map<string, Element>, nextId: () => string, rebuild = false): Set<Element> {
  const create = (name: string) => xml.createElementNS(xml.documentElement.namespaceURI, name);
  const nativeId = (element: Element) => { if (!element.hasAttribute('id')) element.setAttribute('id', nextId()); return element.getAttribute('id')!; };
  const { objects, steps } = binding, current = doc.depiction.objects ?? {};
  for (const [id, el] of objects) if (!current[id]) el.remove();
  for (const object of Object.values(current)) if (!objects.has(object.id)) { const el = create(object.tag); nativeId(el); objects.set(object.id, el); }
  const page = () => [...xml.documentElement.children].find(el => el.localName === 'page') ?? xml.documentElement.appendChild(create('page'));
  const reference = (ref: DocumentReference): string => {
    if (ref.kind !== 'molecule') {
      const element = (ref.kind === 'atom' ? atomElements : ref.kind === 'bond' ? bondElements : objects).get(ref.id);
      if (!element || !element.isConnected) fail('无法保存已删除的文档引用', 'INVALID_DOCUMENT_REFERENCE'); return nativeId(element);
    }
    const fragments = scopeElements(xml, 'fragment');
    const wanted = new Set(ref.atomIds.map(id => atomElements.get(id)));
    const match = fragments.find(fragment => {
      const nodes = [...atomElements.values()].filter(el => el.isConnected && fragment.contains(el));
      return nodes.length === wanted.size && nodes.every(el => wanted.has(el)) && (wanted.size > 0 || fragment.getAttribute('id') === ref.sourceId);
    });
    if (!match) fail('反应参与者必须对应一个完整分子片段；请先调整参与者范围', 'INVALID_REACTION_PARTICIPANT'); return nativeId(match);
  };
  // Attach parents before resolving references. Retain the relative order of original siblings.
  const attach = (id: string, visiting = new Set<string>()) => {
    if (visiting.has(id)) fail('文档对象层级循环'); visiting.add(id);
    const object = current[id], el = objects.get(id)!;
    if (object.parentId) attach(object.parentId, visiting);
    // Chemical fragments are transparent scene containers. An existing caption
    // may live inside one; do not flatten it into the nearest page/group.
    if(before.depiction.objects?.[id]?.parentId===object.parentId&&before.depiction.objects?.[id]&&el.isConnected){visiting.delete(id);return;}
    const parent = object.parentId ? objects.get(object.parentId)! : object.tag === 'page' ? xml.documentElement : page();
    if (el.parentElement !== parent) parent.append(el); visiting.delete(id);
  };
  for (const id of Object.keys(current)) attach(id);
  if(rebuild){
    const partitions:string[][]=[],claimed=new Set<string>();
    const refs=[...Object.values(current).flatMap(o=>Object.values(o.references).flat()),...Object.values(doc.graph.reactions??{}).flatMap(step=>reactionRoles.flatMap(role=>step[role]))];
    for(const ref of refs)if(ref.kind==='molecule'&&ref.atomIds.length){
      if(partitions.some(ids=>ids.length===ref.atomIds.length&&ids.every(id=>ref.atomIds.includes(id))))continue;
      if(ref.atomIds.some(id=>claimed.has(id)))fail('重建时分子片段范围不能部分重叠','INVALID_REACTION_PARTICIPANT');
      partitions.push(ref.atomIds);ref.atomIds.forEach(id=>claimed.add(id));
    }
    for(const component of connectedComponents(doc)){const rest=component.filter(id=>!claimed.has(id));if(rest.length)partitions.push(rest);}
    const oldFragments=scopeElements(xml,'fragment'),containers=Object.values(current).filter(o=>['page','group'].includes(o.tag));
    const depth=(id:string):number=>current[id].parentId?1+depth(current[id].parentId!):0;
    const assignments=new Map<string,Element>();
    for(const ids of partitions){
      const parent=containers.filter(o=>ids.every(id=>o.atomIds.includes(id))).sort((a,b)=>depth(b.id)-depth(a.id))[0];
      const fragment=create('fragment');nativeId(fragment);(parent?objects.get(parent.id)!:page()).append(fragment);
      for(const id of ids){fragment.append(atomElements.get(id)!);assignments.set(id,fragment);}
    }
    for(const bond of Object.values(doc.graph.bonds)){
      const parent=assignments.get(bond.atoms[0]);if(parent!==assignments.get(bond.atoms[1]))fail('反应分子片段范围不能切断化学键','INVALID_REACTION_PARTICIPANT');parent!.append(bondElements.get(bond.id)!);
    }
    for(const fragment of oldFragments)fragment.remove();
    const modeledPages=new Set(Object.values(current).filter(o=>o.tag==='page').map(o=>objects.get(o.id)));
    if(modeledPages.size)for(const p of [...xml.documentElement.children].filter(e=>e.localName==='page'&&!modeledPages.has(e)))if(!p.children.length)p.remove();
  }
  for (const object of Object.values(current)) {
    const el = objects.get(object.id)!, old = before.depiction.objects?.[object.id];
    for (const key of Object.keys(old?.attributes ?? {})) if (!(key in object.attributes)) el.removeAttribute(key);
    for (const key of Object.keys(old?.geometry ?? {})) if (!(key in object.geometry)) el.removeAttribute(key);
    for (const key of Object.keys(old?.references ?? {})) if (!(key in object.references)) el.removeAttribute(key);
    for (const [key, value] of Object.entries(object.attributes)) el.setAttribute(key, value);
    for (const [key, values] of Object.entries(object.geometry)) {
      const previous=old?.geometry[key];
      // Numeric parsing does not authorize changing a retained source spelling
      // (for example 318.20 -> 318.2) during an unrelated presentation edit.
      if(!rebuild&&el.hasAttribute(key)&&previous?.length===values.length&&values.every((value,index)=>value===previous[index]))continue;
      el.setAttribute(key,values.join(' '));
    }
    for (const [key, refs] of Object.entries(object.references)) el.setAttribute(key, refs.map(reference).join(' '));
    if (object.runs && JSON.stringify(old?.runs) !== JSON.stringify(object.runs)) {
      for (const run of [...el.children].filter(e => e.localName === 's')) run.remove();
      for (const run of object.runs) { const span = create('s'); for (const [key, value] of Object.entries(run.attributes)) span.setAttribute(key, value); span.textContent = run.text; el.append(span); }
      el.removeAttribute('LineStarts'); el.removeAttribute('BoundingBox');
    }
  }
  const schemes = new Map<string, Element>();
  for (const old of Object.values(before.graph.reactions ?? {})) if (steps.get(old.id)?.parentElement) schemes.set(old.schemeId, steps.get(old.id)!.parentElement!);
  for (const [id, el] of steps) if (!doc.graph.reactions?.[id]) el.remove();
  for (const step of Object.values(doc.graph.reactions ?? {})) {
    let scheme = schemes.get(step.schemeId);
    if (!scheme) { scheme = create('scheme'); nativeId(scheme); page().append(scheme); schemes.set(step.schemeId, scheme); }
    let el = steps.get(step.id); if (!el) { el = create('step'); nativeId(el); steps.set(step.id, el); }
    if (el.parentElement !== scheme) scheme.append(el);
    for (const role of reactionRoles) { const refs = step[role].map(reference); if (refs.length) el.setAttribute(reactionAttributes[role], refs.join(' ')); else el.removeAttribute(reactionAttributes[role]); }
    for (const [name, mode] of [['ReactionStepAtomMap','specified'],['ReactionStepAtomMapManual','manual'],['ReactionStepAtomMapAuto','auto']] as const) {
      const mapping = step.atomMappings?.find(m => m.mode === mode);
      if (mapping) el.setAttribute(name, mapping.atoms.flat().map(id => reference({ kind: 'atom', id })).join(' ')); else el.removeAttribute(name);
    }
  }
  if (doc.depiction.style && JSON.stringify(doc.depiction.style) !== JSON.stringify(before.depiction.style)) {
    if(rebuild)for(const attr of [...xml.documentElement.attributes])xml.documentElement.removeAttribute(attr.name);
    for (const key of Object.keys(before.depiction.style?.attributes ?? {})) if (!(key in doc.depiction.style.attributes)) xml.documentElement.removeAttribute(key);
    for (const [key, value] of Object.entries(doc.depiction.style.attributes)) xml.documentElement.setAttribute(key, value);
    for (const [tag, childTag, entries] of [['fonttable','font',doc.depiction.style.fonts],['colortable','color',doc.depiction.style.colors.map(([r,g,b]) => ({r:String(r),g:String(g),b:String(b)}))]] as const) {
      let table = [...xml.documentElement.children].find(e => e.localName === tag); if (!table) { table = create(tag); xml.documentElement.prepend(table); }
      table.replaceChildren(...entries.map(attributes => { const el = create(childTag); for (const [key,value] of Object.entries(attributes)) el.setAttribute(key, value); return el; }));
    }
  }
  return new Set([...objects.values(), ...steps.values()]);
}

export function rebuildXmlDocument(doc:ChemicalDocument,raw:string):string{
  const xml=new DOMParser().parseFromString(raw,'application/xml');
  const nodes=scopeElements(xml,'n'),bonds=scopeElements(xml,'b');
  let next=Math.max(0,...[...xml.getElementsByTagName('*')].map(e=>Number(e.getAttribute('id')??0)))+1;
  patchXmlDocument(xml,doc,emptyDocument(),{objects:new Map(),steps:new Map()},new Map(Object.keys(doc.graph.atoms).map((id,i)=>[id,nodes[i]])),new Map(Object.keys(doc.graph.bonds).map((id,i)=>[id,bonds[i]])),()=>String(next++),true);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(xml).replace(/^\s*<\?xml[^?]*\?>/,'')}`;
}
