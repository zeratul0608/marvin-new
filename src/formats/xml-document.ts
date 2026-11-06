import { id } from '../core/model';
import { drawingTags, geometryStride } from '../core/drawing';
import type { ChemicalDocument, DocumentReference, DrawingObject, DrawingStyle, ReactionStep } from '../core/types';
import { xmlReferenceAttributes } from './preservation-properties';
import { fail, numeric } from './shared';

export const reactionAttributes = { reactants: 'ReactionStepReactants', products: 'ReactionStepProducts', arrows: 'ReactionStepArrows', above: 'ReactionStepObjectsAboveArrow', below: 'ReactionStepObjectsBelowArrow', pluses: 'ReactionStepPlusses' } as const;
export function xmlPath(element: Element): number[] {
  const path: number[] = []; for (let el = element; el.parentElement; el = el.parentElement) path.unshift([...el.parentElement.children].indexOf(el)); return path;
}
export function xmlAtPath(input: Document, path: number[]): Element | undefined {
  let el: Element | undefined = input.documentElement; for (const index of path) el = el?.children[index]; return el;
}

export function readXmlDocument(input: Document, doc: ChemicalDocument, atomElements: Map<Element, string>, bondElements: Map<Element, string>): void {
  const elements = [...input.getElementsByTagName('*')].filter(el => {
    for (let parent = el.parentElement; parent; parent = parent.parentElement) if (parent.localName === 'n') return false;
    return true;
  });
  const pages = elements.filter(el => el.localName === 'page');
  const drawingElements = elements.filter(el => el.localName !== 'page' && (drawingTags as readonly string[]).includes(el.localName));
  const needsPages = drawingElements.length > 0 || pages.length > 1;
  if (needsPages) drawingElements.push(...pages);
  if (!drawingElements.length && !elements.some(el => el.localName === 'step')) return;
  // Preserve source order for deterministic mapping and whole-document round-trip checks.
  drawingElements.sort((a,b) => elements.indexOf(a) - elements.indexOf(b));
  const objects: Record<string, DrawingObject> = {}, byElement = new Map<Element, string>(), entities = new Map<string, { element: Element; ref: DocumentReference }[]>();
  const entity = (element: Element, ref: DocumentReference) => { const key = element.getAttribute('id'); if (key) entities.set(key, [...entities.get(key) ?? [], { element, ref }]); };
  for (const [el, atomId] of atomElements) entity(el, { kind: 'atom', id: atomId });
  for (const [el, bondId] of bondElements) entity(el, { kind: 'bond', id: bondId });
  for (const fragment of elements.filter(el => el.localName === 'fragment')) entity(fragment, { kind: 'molecule', atomIds: [...atomElements].filter(([el]) => fragment.contains(el)).map(([,id]) => id), sourceId: fragment.getAttribute('id')! });
  for (const element of drawingElements) {
    const objectId = id('drawing'); byElement.set(element, objectId);
    if (element.hasAttribute('id')) {
      entity(element, { kind: 'drawing', id: objectId });
    }
    const object: DrawingObject = { id: objectId, tag: element.localName as DrawingObject['tag'], attributes: {}, geometry: {}, references: {}, children: [], atomIds: ['group', 'page'].includes(element.localName) ? [...atomElements].filter(([el]) => element.contains(el)).map(([,id]) => id) : [], source: { format: 'cdxml', path: xmlPath(element) }, ...(element.hasAttribute('id') ? { sourceId: element.getAttribute('id')! } : {}) };
    for (const attribute of element.attributes) {
      if (['id','Warning','LineStarts'].includes(attribute.name) || xmlReferenceAttributes.has(attribute.name)) continue;
      if (geometryStride[attribute.name]) object.geometry[attribute.name] = attribute.value.trim().split(/\s+/).map(numeric);
      else object.attributes[attribute.name] = attribute.value;
    }
    if (element.localName === 't') {
      const runs = [...element.children].filter(el => el.localName === 's');
      object.runs = runs.length ? runs.map(run => ({ text: run.textContent ?? '', attributes: Object.fromEntries([...run.attributes].map(a => [a.name, a.value])) })) : [{ text: element.textContent ?? '', attributes: {} }];
    }
    objects[objectId] = object;
  }
  const resolve = (sourceId: string, origin: Element): DocumentReference => {
    const candidates = entities.get(sourceId) ?? [];
    if (candidates.length === 1) return structuredClone(candidates[0].ref);
    for (let scope = origin.parentElement; scope; scope = scope.parentElement) {
      const local = candidates.filter(candidate => scope!.contains(candidate.element));
      if (local.length === 1) return structuredClone(local[0].ref);
    }
    fail(`文档引用 ${sourceId} 未找到唯一对应对象`, 'INVALID_DOCUMENT_REFERENCE');
  };
  for (const [element, objectId] of byElement) {
    const object = objects[objectId];
    for (let parent = element.parentElement; parent; parent = parent.parentElement) if (byElement.has(parent)) { object.parentId = byElement.get(parent)!; objects[object.parentId].children.push(objectId); break; }
    for (const attribute of element.attributes) if (xmlReferenceAttributes.has(attribute.name)) object.references[attribute.name] = attribute.value.trim().split(/\s+/).filter(Boolean).map(ref => resolve(ref, element));
  }
  if (Object.keys(objects).length) {
    doc.depiction.objects = objects;
    const root = input.documentElement;
    const style: DrawingStyle = { attributes: Object.fromEntries([...root.attributes].filter(a => !['BoundingBox', 'WindowPosition', 'WindowSize', 'WindowIsZoomed', 'Warning'].includes(a.name)).map(a => [a.name, a.value])),
      fonts: [...input.getElementsByTagName('*')].filter(el => el.localName === 'font').map(el => ({ id: el.getAttribute('id') ?? '', name: el.getAttribute('name') ?? 'Arial', ...(el.hasAttribute('charset') ? { charset: el.getAttribute('charset')! } : {}) })),
      colors: [...input.getElementsByTagName('*')].filter(el => el.localName === 'color').map(el => ['r','g','b'].map(key => numeric(el.getAttribute(key) ?? '0')) as [number,number,number]) };
    doc.depiction.style = style;
  }
  const steps = elements.filter(el => el.localName === 'step');
  if (steps.length) {
    const schemes = new Map<Element, string>(); doc.graph.reactions = {};
    for (const element of steps) {
      const parent = element.parentElement!; if (!schemes.has(parent)) schemes.set(parent, id('scheme'));
      const stepId = id('reaction'), step: ReactionStep = { id: stepId, schemeId: schemes.get(parent)!, reactants: [], products: [], arrows: [], above: [], below: [], pluses: [], ...(element.hasAttribute('id') ? { sourceId: element.getAttribute('id')! } : {}), source: { format: 'cdxml', path: xmlPath(element) } };
      const allowed = ['id', ...Object.values(reactionAttributes), 'ReactionStepAtomMap', 'ReactionStepAtomMapManual', 'ReactionStepAtomMapAuto'];
      for (const attribute of element.attributes) if (!allowed.includes(attribute.name)) fail(`反应步骤属性 ${attribute.name} 尚未实现`, 'UNSUPPORTED_REACTION');
      if (!Object.values(reactionAttributes).some(name => element.getAttribute(name)?.trim())) fail('空反应步骤缺少参与者或箭头', 'INVALID_REACTION');
      for (const [role, attribute] of Object.entries(reactionAttributes)) step[role as keyof typeof reactionAttributes] = (element.getAttribute(attribute) ?? '').trim().split(/\s+/).filter(Boolean).map(ref => resolve(ref, element));
      for (const [name, mode] of [['ReactionStepAtomMap','specified'],['ReactionStepAtomMapManual','manual'],['ReactionStepAtomMapAuto','auto']] as const) if (element.hasAttribute(name)) {
        const refs = element.getAttribute(name)!.trim().split(/\s+/).filter(Boolean).map(ref => resolve(ref, element)); if (refs.length % 2 || refs.some(ref => ref.kind !== 'atom')) fail('反应原子映射必须是有效原子对', 'INVALID_REACTION_MAPPING');
        const atoms: [string,string][] = []; for (let i = 0; i < refs.length; i += 2) atoms.push([(refs[i] as { id: string }).id, (refs[i + 1] as { id: string }).id]);
        (step.atomMappings ??= []).push({ mode, atoms });
      }
      doc.graph.reactions[stepId] = step;
    }
  }
}
