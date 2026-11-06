import { addAtom, addBond, clone, findBond, removeAtom, removeBond, validateDocument } from './model';
import { transformAtoms, type StructureTransform } from './geometry';
import { layoutAtoms, type LayoutAction } from './layout';
import type { Atom, BondDepiction, BondOrder, ChemicalDocument, Point, StereoBondOrdering } from './types';
import { assertStereoEdit, geometryFromOrdering, invertAtomStereo, invertDoubleStereo } from './stereochemistry';
import { invalidateCipLabels } from './chemistry-annotations';
import { moveDrawing, removeDrawing, type DrawingChanges, type ReactionChanges } from './drawing';
import { orderSubstructurePorts } from './substructure';
import {updatePolymer,type PolymerChanges} from './polymers';
import {expandSubstructureInPlace} from './expansion';
import {collapseSubstructureInPlace} from './collapse';
import {setSubstructureDisplayInPlace} from './substructure-display';

export interface AtomChanges {
  element?: string;
  charge?: number;
  isotope?: number | null;
  radical?: Atom['radical'] | null;
  atomMap?: number | null;
  hydrogens?: Atom['hydrogens'];
  query?: Atom['query'] | null;
  queryConstraints?: Atom['queryConstraints'] | null;
  sourceNumber?: number | null;
  attachmentIndex?: number | null;
  connectionType?: Atom['connectionType'] | null;
  residueId?: number | null;
  cipLabel?: Atom['cipLabel'] | null;
  enhancedStereo?: Atom['enhancedStereo'] | null;
  namedFragment?: Atom['namedFragment'] | null;
  multiAttachment?: Atom['multiAttachment'] | null;
  spatial?: Atom['spatial'] | null;
}
/** References starting with $ refer to objects created earlier in the same batch. */
export type EditOperation =
  | { type: 'add-atom'; ref?: string; element: string; position: Point; properties?: Omit<AtomChanges, 'element'> }
  | { type: 'update-atom'; atomId: string; changes: AtomChanges }
  | { type: 'remove-atom'; atomId: string }
  | { type: 'set-position'; atomId: string; position: Point }
  | { type: 'set-layout'; positions: Record<string,Point>; depictions?: Record<string,BondDepiction|null> }
  | { type: 'add-bond'; ref?: string; atoms: [string, string]; order?: BondOrder; topology?: import('./types').Bond['topology']; depiction?: BondDepiction }
  | { type: 'update-bond'; bondId: string; order?: BondOrder; topology?: import('./types').Bond['topology'] | null; depiction?: BondDepiction | null }
  | { type: 'remove-bond'; bondId: string }
  | { type: 'set-atom-geometry'; atomId: string; bondOrdering: StereoBondOrdering | null }
  | { type: 'set-bond-ordering'; bondId: string; bondOrdering: StereoBondOrdering | null }
  | { type: 'invert-atom-stereo'; atomId: string }
  | { type: 'invert-double-stereo'; bondId: string }
  | { type: 'set-substructure'; atomId: string; substructure: NonNullable<Atom['substructure']> }
  | { type: 'set-substructure-display'; atomId: string; expanded: boolean; recursive?: boolean }
  | { type: 'expand-substructure'; atomId: string; recursive?: boolean }
  | { type: 'collapse-substructure'; atomIds: string[]; label: string; ref?: string }
  | { type: 'set-bond-annotations'; bondId: string; changes: { cipLabel?: 'E' | 'Z' | null; topology?: import('./types').Bond['topology'] | null; reactionParticipation?: import('./types').ReactionParticipation | null; sequenceConnectivity?: import('./types').Bond['sequenceConnectivity'] | null; externalNumbers?: import('./types').Bond['externalNumbers'] | null } }
  | { type: 'transform'; atomIds: string[]; transform: StructureTransform }
  | { type: 'layout'; atomIds: string[]; action: LayoutAction }
  | { type: 'rename'; title: string }
  | { type: 'update-drawing'; objectId: string; changes: DrawingChanges }
  | { type: 'update-polymer'; objectId: string; changes: PolymerChanges }
  | { type: 'update-polymer-crossing'; objectId: string; bondId: string; innerAtomId: string }
  | { type: 'move-drawing'; objectId: string; delta: Point }
  | { type: 'remove-drawing'; objectId: string }
  | { type: 'update-reaction'; stepId: string; changes: ReactionChanges };

export interface CreatedObjects { atoms: Record<string, string>; bonds: Record<string, string> }

function fields(value: unknown, allowed: string[], name: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new Error(`${name}字段无效`);
}
function updateAtom(atom: Atom, changes: AtomChanges) {
  fields(changes, ['element', 'charge', 'isotope', 'atomMap', 'hydrogens', 'radical', 'query', 'queryConstraints', 'sourceNumber', 'attachmentIndex', 'connectionType', 'residueId', 'cipLabel', 'enhancedStereo', 'namedFragment', 'multiAttachment', 'spatial'], '原子属性');
  for (const key of ['element', 'charge', 'hydrogens'] as const) if (Object.hasOwn(changes, key)) Object.assign(atom, { [key]: changes[key] });
  for (const key of ['isotope', 'atomMap', 'radical', 'query', 'queryConstraints', 'sourceNumber', 'attachmentIndex', 'connectionType', 'residueId', 'cipLabel', 'enhancedStereo', 'namedFragment', 'multiAttachment', 'spatial'] as const) if (Object.hasOwn(changes, key)) {
    if (changes[key] === null) delete atom[key]; else Object.assign(atom, { [key]: changes[key] });
  }
}

/** Returns a validated, independent document. A failed batch leaves the input untouched. */
export function applyDocumentEdits(document: ChemicalDocument, operations: readonly EditOperation[]): { document: ChemicalDocument; created: CreatedObjects } {
  if (!Array.isArray(operations) || operations.length > 1000) throw new Error('每批操作必须为数组，且最多包含 1000 项');
  validateDocument(document);
  const batch: readonly EditOperation[] = clone(operations);
  const doc = clone(document), created: CreatedObjects = { atoms: {}, bonds: {} };
  const resolve = (reference: string, kind: 'atoms' | 'bonds') => {
    if (typeof reference !== 'string' || !reference) throw new Error('对象引用必须为非空字符串');
    const key = Object.hasOwn(created[kind], reference) ? created[kind][reference] : reference;
    if (!key || !Object.hasOwn(doc.graph[kind], key)) throw new Error(`对象不存在：${reference}`);
    return key;
  };
  const remember = (ref: string | undefined, id: string, kind: 'atoms' | 'bonds') => {
    if (ref === undefined) return;
    if (typeof ref !== 'string' || !/^\$[A-Za-z][A-Za-z0-9_]*$/.test(ref) || Object.hasOwn(created[kind], ref)) throw new Error('临时引用必须唯一，且采用 $name 格式');
    created[kind][ref] = id;
  };
  const depiction = (value: BondDepiction) => {
    fields(value, ['style', 'from', 'doublePosition', 'labelOffsets', 'crossings', 'layer', 'secondaryStyle'], '键描绘');
    return { ...value, from: resolve(value.from, 'atoms'), ...(value.crossings ? { crossings: value.crossings.map(id => resolve(id, 'bonds')) } : {}) };
  };
  const ordering = (value: StereoBondOrdering): StereoBondOrdering => {
    if (!Array.isArray(value) || value.length !== 4) throw new Error('立体连接顺序必须包含四项');
    return value.map(id => id === null ? null : resolve(id, 'bonds')) as StereoBondOrdering;
  };
  for (const operation of batch) {
    if (!operation || typeof operation !== 'object') throw new Error('操作定义无效');
    switch (operation.type) {
      case 'add-atom': {
        fields(operation, ['type', 'ref', 'element', 'position', 'properties'], '新增原子');
        const atomId = addAtom(doc, operation.element, clone(operation.position), operation.properties?.query ? { query: clone(operation.properties.query) } : {});
        if (operation.properties !== undefined) {
          fields(operation.properties, ['charge', 'isotope', 'atomMap', 'hydrogens', 'radical', 'query', 'queryConstraints', 'sourceNumber', 'attachmentIndex', 'connectionType', 'residueId', 'cipLabel'], '新增原子属性');
          updateAtom(doc.graph.atoms[atomId], operation.properties);
        }
        remember(operation.ref, atomId, 'atoms'); break;
      }
      case 'update-atom': fields(operation, ['type', 'atomId', 'changes'], '修改原子'); updateAtom(doc.graph.atoms[resolve(operation.atomId, 'atoms')], operation.changes); break;
      case 'remove-atom': fields(operation, ['type', 'atomId'], '删除原子'); removeAtom(doc, resolve(operation.atomId, 'atoms')); break;
      case 'set-position': fields(operation, ['type', 'atomId', 'position'], '修改坐标'); doc.depiction.positions[resolve(operation.atomId, 'atoms')] = clone(operation.position); break;
      case 'set-layout': {
        fields(operation,['type','positions','depictions'],'设置二维布局');
        if(!operation.positions||typeof operation.positions!=='object'||Array.isArray(operation.positions)||Object.keys(operation.positions).length>2000)throw new Error('二维布局的坐标表无效');
        if(operation.depictions!==undefined&&(!operation.depictions||typeof operation.depictions!=='object'||Array.isArray(operation.depictions)))throw new Error('二维布局的描绘表无效');
        for(const [id,point]of Object.entries(operation.positions))doc.depiction.positions[resolve(id,'atoms')]=clone(point);
        for(const [id,value]of Object.entries(operation.depictions??{})){const key=resolve(id,'bonds');if(value===null)delete doc.depiction.bonds[key];else doc.depiction.bonds[key]=depiction(value);}
        break;
      }
      case 'add-bond': {
        fields(operation, ['type', 'ref', 'atoms', 'order', 'topology', 'depiction'], '新增键');
        if (!Array.isArray(operation.atoms) || operation.atoms.length !== 2) throw new Error('化学键需要两个端点');
        const [a, b] = operation.atoms.map(id => resolve(id, 'atoms'));
        if (findBond(doc, a, b)) throw new Error('两个原子间已存在化学键，请使用 update-bond');
        if (operation.order !== undefined && ![1, 2, 2.5, 3, 'aromatic', 'any'].includes(operation.order)) throw new Error('键级无效');
        const bondId = addBond(doc, a, b, operation.order ?? 1);
        if(operation.topology!==undefined)doc.graph.bonds[bondId].topology=operation.topology;
        if (operation.depiction !== undefined) doc.depiction.bonds[bondId] = depiction(operation.depiction);
        remember(operation.ref, bondId, 'bonds'); break;
      }
      case 'update-bond': {
        fields(operation, ['type', 'bondId', 'order', 'topology', 'depiction'], '修改键');
        const bondId = resolve(operation.bondId, 'bonds');
        if (operation.order !== undefined) { if (operation.order !== doc.graph.bonds[bondId].order) delete doc.depiction.bonds[bondId]; doc.graph.bonds[bondId].order = operation.order; }
        if(operation.topology===null)delete doc.graph.bonds[bondId].topology;else if(operation.topology!==undefined)doc.graph.bonds[bondId].topology=operation.topology;
        if (operation.depiction === null) delete doc.depiction.bonds[bondId];
        else if (operation.depiction !== undefined) doc.depiction.bonds[bondId] = depiction(operation.depiction);
        break;
      }
      case 'remove-bond': fields(operation, ['type', 'bondId'], '删除键'); removeBond(doc, resolve(operation.bondId, 'bonds')); break;
      case 'set-atom-geometry': {
        fields(operation, ['type', 'atomId', 'bondOrdering'], '设置原子几何');
        const atom = doc.graph.atoms[resolve(operation.atomId, 'atoms')];
        if (operation.bondOrdering === null) delete atom.geometry;
        else atom.geometry = geometryFromOrdering(doc, atom.id, ordering(operation.bondOrdering));
        break;
      }
      case 'set-bond-ordering': {
        fields(operation, ['type', 'bondId', 'bondOrdering'], '设置双键连接顺序');
        const bond = doc.graph.bonds[resolve(operation.bondId, 'bonds')];
        if (operation.bondOrdering === null) delete bond.circularOrdering;
        else bond.circularOrdering = ordering(operation.bondOrdering);
        break;
      }
      case 'invert-atom-stereo': fields(operation, ['type', 'atomId'], '反转四面体构型'); invertAtomStereo(doc, resolve(operation.atomId, 'atoms')); break;
      case 'invert-double-stereo': fields(operation, ['type', 'bondId'], '反转双键构型'); invertDoubleStereo(doc, resolve(operation.bondId, 'bonds')); break;
      case 'set-substructure': {
        fields(operation, ['type', 'atomId', 'substructure'], '编辑内部片段');const atom=doc.graph.atoms[resolve(operation.atomId,'atoms')];atom.element='*';delete atom.namedFragment;delete atom.query;delete atom.multiAttachment;atom.substructure=clone(operation.substructure);for(const port of atom.substructure.connections)port.bondId=resolve(port.bondId,'bonds');orderSubstructurePorts(atom.substructure);break;
      }
      case 'set-substructure-display': {
        fields(operation,['type','atomId','expanded','recursive'],'内部片段显示');if(typeof operation.expanded!=='boolean'||operation.recursive!==undefined&&typeof operation.recursive!=='boolean')throw new Error('片段显示参数无效');
        setSubstructureDisplayInPlace(doc,resolve(operation.atomId,'atoms'),operation.expanded,operation.recursive);break;
      }
      case 'expand-substructure': {
        fields(operation,['type','atomId','recursive'],'展开内部片段');if(operation.recursive!==undefined&&typeof operation.recursive!=='boolean')throw new Error('递归展开参数无效');expandSubstructureInPlace(doc,resolve(operation.atomId,'atoms'),operation.recursive);break;
      }
      case 'collapse-substructure': {
        fields(operation,['type','atomIds','label','ref'],'收起化学片段');if(!Array.isArray(operation.atomIds))throw new Error('收起选区必须为数组');
        const result=collapseSubstructureInPlace(doc,operation.atomIds.map(a=>resolve(a,'atoms')),operation.label);remember(operation.ref,result.wrapperId,'atoms');break;
      }
      case 'set-bond-annotations': {
        fields(operation, ['type', 'bondId', 'changes'], '修改键条件'); fields(operation.changes, ['cipLabel', 'topology', 'reactionParticipation', 'sequenceConnectivity', 'externalNumbers'], '键条件');
        const bond = doc.graph.bonds[resolve(operation.bondId, 'bonds')];
        for (const key of ['cipLabel', 'topology', 'reactionParticipation', 'sequenceConnectivity', 'externalNumbers'] as const) if (Object.hasOwn(operation.changes, key)) { if (operation.changes[key] === null) delete bond[key]; else Object.assign(bond, { [key]: operation.changes[key] }); }
        break;
      }
      case 'transform': {
        fields(operation, ['type', 'atomIds', 'transform'], '结构变换');
        if (!Array.isArray(operation.atomIds) || !['rotate-left', 'rotate-right', 'mirror-horizontal', 'mirror-vertical'].includes(operation.transform)) throw new Error('结构变换参数无效');
        transformAtoms(doc, operation.atomIds.map(id => resolve(id, 'atoms')), operation.transform); break;
      }
      case 'layout': {
        fields(operation, ['type', 'atomIds', 'action'], '结构排版');
        if (!Array.isArray(operation.atomIds)) throw new Error('结构排版选区无效');
        layoutAtoms(doc, operation.atomIds.map(id => resolve(id, 'atoms')), operation.action); break;
      }
      case 'rename': fields(operation, ['type', 'title'], '修改标题'); doc.title = operation.title; break;
      case 'move-drawing': fields(operation, ['type','objectId','delta'], '移动图元'); moveDrawing(doc, operation.objectId, operation.delta); break;
      case 'remove-drawing': fields(operation, ['type','objectId'], '删除图元'); removeDrawing(doc, operation.objectId); break;
      case 'update-drawing': {
        fields(operation, ['type','objectId','changes'], '修改图元'); fields(operation.changes, ['attributes','geometry','runs','references'], '图元属性');
        const object = doc.depiction.objects?.[operation.objectId]; if (!object) throw new Error('图元不存在'); Object.assign(object, clone(operation.changes)); break;
      }
      case 'update-reaction': {
        fields(operation, ['type','stepId','changes'], '修改反应步骤'); fields(operation.changes, ['reactants','products','arrows','above','below','pluses','atomMappings'], '反应属性');
        const step = doc.graph.reactions?.[operation.stepId]; if (!step) throw new Error('反应步骤不存在'); Object.assign(step, clone(operation.changes)); break;
      }
      case 'update-polymer': {
        fields(operation,['type','objectId','changes'],'修改聚合物组');const changes=clone(operation.changes);
        if(Array.isArray(changes?.atomIds))changes.atomIds=changes.atomIds.map(id=>resolve(id,'atoms'));
        updatePolymer(doc,operation.objectId,changes);break;
      }
      case 'update-polymer-crossing': {
        fields(operation,['type','objectId','bondId','innerAtomId'],'修改跨括号键');const crossing=doc.depiction.objects?.[operation.objectId];if(crossing?.tag!=='crossingbond')throw new Error('跨括号键不存在');
        crossing.references.BondID=[{kind:'bond',id:resolve(operation.bondId,'bonds')}];crossing.references.InnerAtomID=[{kind:'atom',id:resolve(operation.innerAtomId,'atoms')}];break;
      }
      default: throw new Error(`未知编辑操作：${String((operation as { type?: unknown }).type)}`);
    }
  }
  invalidateCipLabels(document, doc);
  validateDocument(doc);
  assertStereoEdit(document, doc);
  return { document: doc, created };
}
