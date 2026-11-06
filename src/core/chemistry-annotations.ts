import type { ChemicalDocument } from './types';
import {substructureDisplayReplacer} from './substructure-display';

export const connectionTypes = ['Unspecified', 'Diamond', 'Star', 'PolymerBead', 'Wavy', 'Residue', 'Peptide', 'DNA', 'RNA', 'Terminus', 'Sulfide', 'Nucleotide', 'UnlinkedBranch'] as const;
export const atomCipLabels = ['R', 'S', 'r', 's', 'u', 'M', 'P', 'a', '+', '-', '?'] as const;
export const reactionParticipations = ['ReactionCenter', 'MakeOrBreak', 'ChangeType', 'MakeAndChange', 'NotReactionCenter', 'NoChange', 'Unmapped'] as const;

/** CIP is a derived cache. Do not continue presenting a source descriptor after arbitrary chemistry edits. */
export function invalidateCipLabels(before: ChemicalDocument, after: ChemicalDocument): void {
  const chemical = (doc: ChemicalDocument) => JSON.stringify({
    atoms: Object.values(doc.graph.atoms).map(a => [a.id, a.element, a.charge, a.isotope, a.radical, a.hydrogens, a.query, a.queryConstraints, a.geometry, a.substructure?.fragments.map(f => f.document.graph)]),
    bonds: Object.values(doc.graph.bonds).map(b => [b.id, b.atoms, b.order, b.topology, b.circularOrdering]),
    wedges: Object.entries(doc.depiction.bonds).filter(([,d]) => ['wedge', 'hashed', 'wavy'].includes(d.style)).map(([id,d]) => [id,d.style,d.from]),
  },substructureDisplayReplacer);
  if (chemical(before) === chemical(after)) return;
  for (const atom of Object.values(after.graph.atoms)) if (atom.cipLabel === before.graph.atoms[atom.id]?.cipLabel) delete atom.cipLabel;
  for (const bond of Object.values(after.graph.bonds)) if (bond.cipLabel === before.graph.bonds[bond.id]?.cipLabel) delete bond.cipLabel;
}
