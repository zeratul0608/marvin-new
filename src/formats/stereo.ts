import type { ChemicalDocument, StereoBondOrdering, Point, DocumentReference } from '../core/types';
export interface DrawingProjection { geometry: Record<string, number[]>; [key: string]: unknown }
export interface DocumentProjection { atoms: unknown[]; bonds: unknown[]; positions: Point[]; objects?: DrawingProjection[]; style?: unknown; reactions?: unknown[] }
import { fail } from './shared';

/** Resolve ChemDraw object IDs only after every bond has been read. Zero is a virtual ligand. */
export function readOrdering(refs: string[], bonds: Map<string, string>): StereoBondOrdering {
  if (refs.length !== 4) fail('ChemDraw 立体连接顺序必须包含四个对象 ID', 'INVALID_STEREO_REFERENCE');
  return refs.map(ref => {
    if (ref === '0') return null;
    const id = bonds.get(ref);
    if (!id) fail(`ChemDraw 立体连接顺序引用了片段外或不存在的键 ${ref}`, 'INVALID_STEREO_REFERENCE');
    return id;
  }) as StereoBondOrdering;
}

/** Stable-ID independent representation used to verify source-preserving round trips. */
export function stereoProjection(doc: ChemicalDocument, atomIds = Object.keys(doc.graph.atoms), bondIds = Object.keys(doc.graph.bonds)): DocumentProjection {
  const atoms = new Map(atomIds.map((id, i) => [id, i])), bonds = new Map(bondIds.map((id, i) => [id, i]));
  const drawings = Object.keys(doc.depiction.objects ?? {}), drawingIndices = new Map(drawings.map((id, i) => [id, i]));
  const reference = (ref: DocumentReference) => ref.kind === 'molecule' ? { kind: 'molecule', atomIds: ref.atomIds.map(id => atoms.get(id)).sort((a,b) => a! - b!) } : { kind: ref.kind, id: (ref.kind === 'atom' ? atoms : ref.kind === 'bond' ? bonds : drawingIndices).get(ref.id) };
  const schemes = new Map<string, number>();
  const refs = (ordering: StereoBondOrdering) => ordering.map(id => id === null ? null : bonds.get(id));
  return {
    atoms: atomIds.map(id => { const { id: _, geometry, substructure, multiAttachment, ...a } = doc.graph.atoms[id]; return { ...a, ...(multiAttachment ? { multiAttachment: multiAttachment.map(id => atoms.get(id)) } : {}),
      ...(substructure ? { substructure: { kind: substructure.kind, ...(substructure.display?{display:substructure.display}:{}), label: substructure.label, fragments: substructure.fragments.map(f => ({ document: stereoProjection(f.document), attachmentOrder: f.attachmentOrder.map(id => Object.keys(f.document.graph.atoms).indexOf(id)) })), connections: substructure.connections.map(p => ({ bondId: bonds.get(p.bondId), fragment: p.fragment, atomId: Object.keys(substructure.fragments[p.fragment].document.graph.atoms).indexOf(p.atomId) })) } } : {}),
      ...(geometry ? { geometry: { type: geometry.type, bondOrdering: refs(geometry.bondOrdering) } } : {}) }; }),
    bonds: bondIds.map(id => {
      const b = doc.graph.bonds[id], d = doc.depiction.bonds[id];
      const position = d?.doublePosition && d.from === b.atoms[1] && d.doublePosition !== 'center' ? d.doublePosition === 'left' ? 'right' : 'left' : d?.doublePosition;
      const directional = d && ['wedge', 'hashed', 'wavy'].includes(d.style);
      const { id: _, atoms: _atoms, order: _order, circularOrdering: _ordering, ...properties } = b;
      return { ...properties, atoms: b.atoms.map(a => atoms.get(a)), order: b.order,
        ...(b.circularOrdering ? { circularOrdering: refs(b.circularOrdering) } : {}),
        depiction: d && (d.style !== 'plain' || position || d.labelOffsets || d.crossings || d.layer !== undefined || d.secondaryStyle) ? { style: d.style, from: atoms.get(directional ? d.from : b.atoms[0]), ...(position ? { doublePosition: position } : {}), ...(d.labelOffsets ? { labelOffsets: d.labelOffsets } : {}), ...(d.crossings ? { crossings: d.crossings.map(id => bonds.get(id)) } : {}), ...(d.layer !== undefined ? { layer: d.layer } : {}), ...(d.secondaryStyle ? { secondaryStyle: d.secondaryStyle } : {}) } : undefined };
    }),
    positions: atomIds.map(id => ({x:doc.depiction.positions[id].x||0,y:doc.depiction.positions[id].y||0})),
    ...(drawings.length ? { objects: drawings.map(id => {
      const object = doc.depiction.objects![id], geometry = { ...object.geometry };
      if (['page', 'group'].includes(object.tag) || (object.tag === 't' && object.geometry.p)) delete geometry.BoundingBox;
      return { tag: object.tag, attributes: object.attributes, geometry, references: Object.fromEntries(Object.entries(object.references).map(([key, refs]) => [key, refs.map(reference)])),
        children: object.children.map(id => drawingIndices.get(id)), atomIds: object.atomIds.map(id => atoms.get(id)).sort((a,b) => a! - b!),
        ...(object.runs ? { runs: object.runs.some(run => run.text) ? object.runs : [] } : {}), ...(object.parentId ? { parent: drawingIndices.get(object.parentId) } : {}) };
    }), ...(doc.depiction.style ? { style: doc.depiction.style } : {}) } : {}),
    ...(doc.graph.reactions && Object.keys(doc.graph.reactions).length ? { reactions: Object.values(doc.graph.reactions).map(step => {
      if (!schemes.has(step.schemeId)) schemes.set(step.schemeId, schemes.size);
      return { scheme: schemes.get(step.schemeId), reactants: step.reactants.map(reference), products: step.products.map(reference), arrows: step.arrows.map(reference), above: step.above.map(reference), below: step.below.map(reference), pluses: step.pluses.map(reference),
        ...(step.atomMappings ? { atomMappings: step.atomMappings.map(mapping => ({ mode: mapping.mode, atoms: mapping.atoms.map(pair => pair.map(id => atoms.get(id))) })) } : {}) };
    }) } : {}),
  };
}
