import type { ChemicalDocument, DocumentReference, DrawingObject, Point, ReactionStep } from './types';

export const drawingTags = ['page', 'group', 't', 'graphic', 'curve', 'arrow', 'bioshape', 'embeddedobject', 'plasmidmap', 'plasmidregion', 'plasmidmarker', 'marker', 'gepplate', 'geplane', 'gepband', 'table', 'border', 'ColoredMolecularArea', 'bracketedgroup', 'bracketattachment', 'crossingbond', 'chemicalproperty', 'objecttag', 'annotation', 'represent'] as const;
export const geometryStride: Record<string, number> = { p: 2, BoundingBox: 2, CurvePoints: 2, CurvePoints3D: 3, xyz: 3, Head3D: 3, Tail3D: 3, Center3D: 3, MajorAxisEnd3D: 3, MinorAxisEnd3D: 3, TopLeft: 2, TopRight: 2, BottomLeft: 2, BottomRight: 2 };
export const reactionRoles = ['reactants', 'products', 'arrows', 'above', 'below', 'pluses'] as const;
/** A view only: the full editable document remains in the store. */
export function documentPage(doc:ChemicalDocument,pageId?:string):ChemicalDocument{
  const page=pageId?doc.depiction.objects?.[pageId]:undefined;if(!page||page.tag!=='page')return doc;
  const atoms=new Set(page.atomIds),objects=doc.depiction.objects??{};
  const visible=(id:string):boolean=>id===pageId||!!objects[id].parentId&&visible(objects[id].parentId!);
  return {...doc,graph:{...doc.graph,atoms:Object.fromEntries(Object.entries(doc.graph.atoms).filter(([id])=>atoms.has(id))),bonds:Object.fromEntries(Object.entries(doc.graph.bonds).filter(([,b])=>b.atoms.every(id=>atoms.has(id))))},depiction:{...doc.depiction,positions:Object.fromEntries(Object.entries(doc.depiction.positions).filter(([id])=>atoms.has(id))),objects:Object.fromEntries(Object.entries(objects).filter(([id])=>visible(id)))}};
}
const fail = (message: string): never => { throw new Error(message); };
const fields = (value: unknown, keys: string[]) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) fail('文档对象字段无效'); };
const strings = (value: unknown): value is Record<string, string> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(v => typeof v === 'string');
const safeId=(id:unknown)=>typeof id==='string'&&!!id&&!['__proto__','constructor','prototype'].includes(id);
const provenance=(value:DrawingObject|ReactionStep)=>{
  if(value.sourceId!==undefined&&typeof value.sourceId!=='string')fail('来源对象编号无效');
  if(value.source){const source=value.source;fields(source,source.format==='cdxml'?['format','path']:['format','serial']);if(source.format==='cdxml'){if(!Array.isArray(source.path)||source.path.length>64||source.path.some(n=>!Number.isSafeInteger(n)||n<0))fail('来源路径无效');}else if(source.format!=='cdx'||!Number.isSafeInteger(source.serial)||source.serial<0)fail('来源对象序号无效');}
};

export function validateReference(doc: ChemicalDocument, ref: DocumentReference): void {
  if (ref?.kind === 'molecule') { fields(ref, ['kind', 'atomIds', 'sourceId']); if (!Array.isArray(ref.atomIds) || new Set(ref.atomIds).size !== ref.atomIds.length || ref.atomIds.some(id => !Object.hasOwn(doc.graph.atoms, id)) || (ref.sourceId!==undefined&&typeof ref.sourceId!=='string')) fail('分子参与者引用无效'); }
  else {
    fields(ref, ['kind', 'id']);
    const table = ref.kind === 'atom' ? doc.graph.atoms : ref.kind === 'bond' ? doc.graph.bonds : ref.kind === 'drawing' ? doc.depiction.objects : undefined;
    if (typeof ref.id !== 'string' || !table || !Object.hasOwn(table, ref.id)) fail('文档对象引用无效');
  }
}
export function validateDrawings(doc: ChemicalDocument): void {
  const objects = doc.depiction.objects;
  if (objects) {
    if (typeof objects !== 'object' || Array.isArray(objects) || Object.keys(objects).length > 30_000) fail('绘图对象表无效或超过限额');
    for (const [id, object] of Object.entries(objects)) {
      fields(object, ['id', 'tag', 'attributes', 'geometry', 'references', 'children', 'atomIds', 'runs', 'parentId', 'sourceId', 'source']);
      if(!safeId(id))fail('图元 ID 无效');provenance(object);
      if (object.id !== id || !id || !(drawingTags as readonly string[]).includes(object.tag) || !strings(object.attributes) || !object.geometry || typeof object.geometry !== 'object' || Array.isArray(object.geometry)) fail('绘图对象定义无效');
      for (const [name, values] of Object.entries(object.geometry)) if (!geometryStride[name] || !Array.isArray(values) || !values.length || values.length % geometryStride[name] || values.some(n => !Number.isFinite(n))) fail('绘图坐标或控制点无效');
      if (!Array.isArray(object.children) || new Set(object.children).size !== object.children.length || object.children.some(child => !Object.hasOwn(objects, child) || objects[child].parentId !== id)) fail('绘图层级无效');
      if (object.parentId !== undefined && (!objects[object.parentId] || !objects[object.parentId].children.includes(id))) fail('绘图父对象引用无效');
      if (!Array.isArray(object.atomIds) || object.atomIds.some(atom => !Object.hasOwn(doc.graph.atoms, atom))) fail('绘图分组的原子引用无效');
      if(new Set(object.atomIds).size!==object.atomIds.length||Object.keys(object.attributes).some(key=>key==='id'||geometryStride[key]||!/^[:A-Za-z_][\w.:-]*$/.test(key)))fail('图元属性或成员列表无效');
      if (!object.references || typeof object.references !== 'object' || Array.isArray(object.references)) fail('绘图引用表无效');
      for (const refs of Object.values(object.references)) { if (!Array.isArray(refs)) fail('绘图引用列表无效'); refs.forEach(ref => validateReference(doc, ref)); }
      if (object.runs !== undefined && (!Array.isArray(object.runs) || object.runs.some(run => { fields(run, ['text', 'attributes']); return typeof run.text !== 'string' || !strings(run.attributes); }))) fail('文本分段无效');
      let parent = object.parentId; const seen = new Set([id]); while (parent) { if (seen.has(parent)) fail('绘图层级含循环'); seen.add(parent); parent = objects[parent].parentId; }
    }
  }
  if (doc.depiction.style) {
    const style = doc.depiction.style; fields(style, ['attributes', 'fonts', 'colors']);
    if (!strings(style.attributes) || !Array.isArray(style.fonts) || style.fonts.some(f => { fields(f, ['id', 'name', 'charset']); return typeof f.id !== 'string' || typeof f.name !== 'string' || (f.charset !== undefined && typeof f.charset !== 'string'); }) || !Array.isArray(style.colors) || style.colors.some(c => !Array.isArray(c) || c.length !== 3 || c.some(n => !Number.isFinite(n) || n < 0 || n > 1))) fail('绘图文档样式无效');
  }
  if (doc.graph.reactions) {
    if (typeof doc.graph.reactions !== 'object' || Array.isArray(doc.graph.reactions)) fail('反应步骤表无效');
    for (const [id, step] of Object.entries(doc.graph.reactions)) {
      fields(step, ['id', 'schemeId', ...reactionRoles, 'atomMappings', 'sourceId', 'source']);
      if(!safeId(id))fail('反应步骤 ID 无效');provenance(step);
      if (step.id !== id || !id || typeof step.schemeId !== 'string' || !step.schemeId) fail('反应步骤定义无效');
      for (const role of reactionRoles) { if (!Array.isArray(step[role])) fail('反应角色必须为列表'); step[role].forEach(ref => validateReference(doc, ref)); }
      if (step.atomMappings) for (const mapping of step.atomMappings) {
        fields(mapping, ['mode', 'atoms']); if (!['specified', 'manual', 'auto'].includes(mapping.mode) || !Array.isArray(mapping.atoms) || mapping.atoms.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair.some(atom => !Object.hasOwn(doc.graph.atoms, atom)))) fail('反应原子映射无效');
      }
    }
  }
}

/** Move native vector control points and grouped chemical atoms as one edit. */
export function moveDrawing(doc: ChemicalDocument, objectId: string, delta: Point): void {
  if (!doc.depiction.objects?.[objectId] || !Number.isFinite(delta.x) || !Number.isFinite(delta.y)) fail('绘图移动参数无效');
  const seen = new Set<string>(), atoms = new Set<string>();
  const move = (id: string) => {
    if (seen.has(id)) return; seen.add(id); const object = doc.depiction.objects![id];
    for (const [name, values] of Object.entries(object.geometry)) for (let i = 0; i < values.length; i += geometryStride[name]) { values[i] += delta.x * 20; values[i + 1] -= delta.y * 20; }
    object.children.forEach(move); object.atomIds.forEach(id => atoms.add(id));
  }; move(objectId);
  for (const id of atoms) { doc.depiction.positions[id].x += delta.x; doc.depiction.positions[id].y += delta.y; }
}

export type DrawingChanges = Partial<Pick<DrawingObject, 'attributes' | 'geometry' | 'runs' | 'references'>>;
export type ReactionChanges = Partial<Pick<ReactionStep, typeof reactionRoles[number] | 'atomMappings'>>;

/** Delete graphic content and prune its roles; never silently delete grouped chemistry. */
export function removeDrawing(doc: ChemicalDocument, objectId: string): void {
  const objects = doc.depiction.objects ?? {}, root = objects[objectId]; if (!root) fail('绘图对象不存在');
  if (root.atomIds.length) fail('此分组包含化学内容，请先移出或删除内部原子');
  const removed = new Set<string>(); const visit = (id: string) => { removed.add(id); objects[id].children.forEach(visit); }; visit(objectId);
  for (const id of removed) delete objects[id];
  for (const object of Object.values(objects)) {
    object.children = object.children.filter(id => !removed.has(id));
    for (const key of Object.keys(object.references)) object.references[key] = object.references[key].filter(ref => ref.kind !== 'drawing' || !removed.has(ref.id));
  }
  for (const step of Object.values(doc.graph.reactions ?? {})) for (const role of reactionRoles) step[role] = step[role].filter(ref => ref.kind !== 'drawing' || !removed.has(ref.id));
}
