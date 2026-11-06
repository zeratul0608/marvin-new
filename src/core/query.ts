import type { Atom, AtomQuery } from './types';

export const atomRingBondCounts = ['Unspecified','NoRingBonds','AsDrawn','SimpleRing','Fusion','SpiroOrHigher'] as const;
export const atomUnsaturatedBonds = ['Unspecified','MustBeAbsent','MustBePresent'] as const;
export const atomReactionStereos = ['Unspecified','Inversion','Retention'] as const;
export const bondTopologies = ['Unspecified','Ring','Chain','RingOrChain'] as const;

export function queryLabel(query: AtomQuery): string {
  return query.kind === 'elements' ? `${query.exclude ? 'NOT ' : ''}[${query.elements.join(',')}]` : query.label ?? '*';
}
export function chemicalSymbol(atom: Atom): string { return atom.namedFragment?.label ?? (atom.multiAttachment ? '◇' : atom.substructure?.label ?? (atom.query ? queryLabel(atom.query) : atom.attachment ? atom.connectionType === 'Star' ? '★' : atom.connectionType === 'PolymerBead' ? '●' : atom.connectionType === 'Wavy' ? '≈' : '◆' : atom.element)); }
