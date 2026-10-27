import { addAtom, addBond, clone, findBond, removeAtom, removeBond, validateDocument } from './model';
import { transformAtoms, type StructureTransform } from './geometry';
import type { Atom, BondDepiction, BondOrder, ChemicalDocument, Point } from './types';

export interface AtomChanges {
  element?: string;
  charge?: number;
  isotope?: number | null;
  atomMap?: number | null;
  hydrogens?: Atom['hydrogens'];
}
/** References starting with $ refer to objects created earlier in the same batch. */
export type EditOperation =
  | { type: 'add-atom'; ref?: string; element: string; position: Point; properties?: Omit<AtomChanges, 'element'> }
  | { type: 'update-atom'; atomId: string; changes: AtomChanges }
  | { type: 'remove-atom'; atomId: string }
  | { type: 'set-position'; atomId: string; position: Point }
  | { type: 'add-bond'; ref?: string; atoms: [string, string]; order?: BondOrder; depiction?: BondDepiction }
  | { type: 'update-bond'; bondId: string; order?: BondOrder; depiction?: BondDepiction | null }
  | { type: 'remove-bond'; bondId: string }
  | { type: 'transform'; atomIds: string[]; transform: StructureTransform }
  | { type: 'rename'; title: string };

export interface CreatedObjects { atoms: Record<string, string>; bonds: Record<string, string> }

function fields(value: unknown, allowed: string[], name: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new Error(`${name}字段无效`);
}
function updateAtom(atom: Atom, changes: AtomChanges) {
  fields(changes, ['element', 'charge', 'isotope', 'atomMap', 'hydrogens'], '原子属性');
  for (const key of ['element', 'charge', 'hydrogens'] as const) if (Object.hasOwn(changes, key)) Object.assign(atom, { [key]: changes[key] });
  for (const key of ['isotope', 'atomMap'] as const) if (Object.hasOwn(changes, key)) {
    if (changes[key] === null) delete atom[key]; else atom[key] = changes[key] as number;
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
    fields(value, ['style', 'from'], '键描绘');
    return { style: value.style, from: resolve(value.from, 'atoms') };
  };
  for (const operation of batch) {
    if (!operation || typeof operation !== 'object') throw new Error('操作定义无效');
    switch (operation.type) {
      case 'add-atom': {
        fields(operation, ['type', 'ref', 'element', 'position', 'properties'], '新增原子');
        const atomId = addAtom(doc, operation.element, clone(operation.position));
        if (operation.properties !== undefined) {
          fields(operation.properties, ['charge', 'isotope', 'atomMap', 'hydrogens'], '新增原子属性');
          updateAtom(doc.graph.atoms[atomId], operation.properties);
        }
        remember(operation.ref, atomId, 'atoms'); break;
      }
      case 'update-atom': fields(operation, ['type', 'atomId', 'changes'], '修改原子'); updateAtom(doc.graph.atoms[resolve(operation.atomId, 'atoms')], operation.changes); break;
      case 'remove-atom': fields(operation, ['type', 'atomId'], '删除原子'); removeAtom(doc, resolve(operation.atomId, 'atoms')); break;
      case 'set-position': fields(operation, ['type', 'atomId', 'position'], '修改坐标'); doc.depiction.positions[resolve(operation.atomId, 'atoms')] = clone(operation.position); break;
      case 'add-bond': {
        fields(operation, ['type', 'ref', 'atoms', 'order', 'depiction'], '新增键');
        if (!Array.isArray(operation.atoms) || operation.atoms.length !== 2) throw new Error('化学键需要两个端点');
        const [a, b] = operation.atoms.map(id => resolve(id, 'atoms'));
        if (findBond(doc, a, b)) throw new Error('两个原子间已存在化学键，请使用 update-bond');
        if (operation.order !== undefined && ![1, 2, 3, 'aromatic'].includes(operation.order)) throw new Error('键级无效');
        const bondId = addBond(doc, a, b, operation.order ?? 1);
        if (operation.depiction !== undefined) doc.depiction.bonds[bondId] = depiction(operation.depiction);
        remember(operation.ref, bondId, 'bonds'); break;
      }
      case 'update-bond': {
        fields(operation, ['type', 'bondId', 'order', 'depiction'], '修改键');
        const bondId = resolve(operation.bondId, 'bonds');
        if (operation.order !== undefined) { doc.graph.bonds[bondId].order = operation.order; if (operation.order !== 1) delete doc.depiction.bonds[bondId]; }
        if (operation.depiction === null) delete doc.depiction.bonds[bondId];
        else if (operation.depiction !== undefined) doc.depiction.bonds[bondId] = depiction(operation.depiction);
        break;
      }
      case 'remove-bond': fields(operation, ['type', 'bondId'], '删除键'); removeBond(doc, resolve(operation.bondId, 'bonds')); break;
      case 'transform': {
        fields(operation, ['type', 'atomIds', 'transform'], '结构变换');
        if (!Array.isArray(operation.atomIds) || !['rotate-left', 'rotate-right', 'mirror-horizontal', 'mirror-vertical'].includes(operation.transform)) throw new Error('结构变换参数无效');
        transformAtoms(doc, operation.atomIds.map(id => resolve(id, 'atoms')), operation.transform); break;
      }
      case 'rename': fields(operation, ['type', 'title'], '修改标题'); doc.title = operation.title; break;
      default: throw new Error(`未知编辑操作：${String((operation as { type?: unknown }).type)}`);
    }
  }
  validateDocument(doc);
  return { document: doc, created };
}
