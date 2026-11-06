import type { AtomSubstructure, ChemicalDocument } from './types';

/** CDXML pairs the external bond list with the leading internal ports. */
export function orderSubstructurePorts(group:AtomSubstructure):void{
  group.fragments.forEach((fragment,index)=>{
    const bound=group.connections.filter(port=>port.fragment===index).map(port=>port.atomId);
    fragment.attachmentOrder=[...bound,...fragment.attachmentOrder.filter(id=>!bound.includes(id))];
  });
}

/** Nested chemistry is a real recursively validated document, never an opaque XML blob. */
export function validateSubstructures(doc: ChemicalDocument, validate: (document: ChemicalDocument, ancestors: Set<ChemicalDocument>) => unknown, ancestors: Set<ChemicalDocument>): void {
  for (const atom of Object.values(doc.graph.atoms)) {
    const group = atom.substructure; if (!group) continue;
    if (atom.element !== '*' || atom.query || atom.attachment || atom.geometry || !['abbreviation', 'alternatives'].includes(group.kind) || typeof group.label !== 'string' || !group.label.trim() || group.label.length > 500 || !Array.isArray(group.fragments) || !group.fragments.length || !Array.isArray(group.connections)) throw new Error('嵌套化学片段定义无效');
    if (Object.keys(group).some(k => !['kind', 'display', 'label', 'fragments', 'connections'].includes(k))) throw new Error('嵌套片段含未知字段');
    if (group.display !== undefined && group.display !== 'expanded') throw new Error('内部片段显示状态无效');
    if (group.kind === 'abbreviation' && group.fragments.length !== 1) throw new Error('普通缩写必须含一个明确的内部片段');
    for (const fragment of group.fragments) {
      if (!fragment || Object.keys(fragment).some(k => !['document', 'attachmentOrder'].includes(k)) || !Array.isArray(fragment.attachmentOrder) || new Set(fragment.attachmentOrder).size !== fragment.attachmentOrder.length) throw new Error('内部片段连接顺序无效');
      validate(fragment.document, ancestors);
      if (fragment.attachmentOrder.some(id => fragment.document.graph.atoms[id]?.attachment !== 'external')) throw new Error('内部连接顺序必须引用真实的外部连接点');
    }
    const adjacent = Object.values(doc.graph.bonds).filter(b => b.atoms.includes(atom.id));
    const refs = new Set<string>(), ports = new Set<string>();
    for (const port of group.connections) {
      if (!port || Object.keys(port).some(k => !['bondId', 'fragment', 'atomId'].includes(k)) || !Number.isInteger(port.fragment) || !group.fragments[port.fragment]?.attachmentOrder.includes(port.atomId) || !adjacent.some(b => b.id === port.bondId) || refs.has(port.bondId) || ports.has(`${port.fragment}:${port.atomId}`)) throw new Error('内外片段的连接点映射无效；请先重新绑定边界连接');
      refs.add(port.bondId); ports.add(`${port.fragment}:${port.atomId}`);
    }
    if (adjacent.some(b => !refs.has(b.id))) throw new Error('缩写的外部键缺少内部连接点映射');
  }
}
