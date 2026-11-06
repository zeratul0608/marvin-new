import { knownChemicalSummary } from '../core/chemical-summary';
import { AI_EDIT_OPERATION_SCHEMAS, AI_TOOLS } from './tool-schemas';
import { molecularFormula } from '../core/model';
import type { EditorApi, EditorSnapshot } from '../editor/api-types';

/** The UI preview and model requests share the same source-free context. */
export function snapshotForModel(snapshot: EditorSnapshot): EditorSnapshot {
  const clean = structuredClone(snapshot);
  const stripSource = (document: typeof clean.document) => {
    delete document.source;
    for (const object of Object.values(document.depiction.objects ?? {})) delete object.source;
    for (const step of Object.values(document.graph.reactions ?? {})) delete step.source;
    for (const atom of Object.values(document.graph.atoms)) for (const fragment of atom.substructure?.fragments ?? []) stripSource(fragment.document);
  };
  stripSource(clean.document);
  if (Object.keys(clean.document.graph.atoms).length > 2000 || Object.keys(clean.document.graph.bonds).length > 2000 || JSON.stringify(clean).length > 700_000) throw new Error('当前结构超过 AI 上下文限额；请缩小文档后重试。结构未被截断。');
  return clean;
}

export function getAiEditorContext(editor: EditorApi) {
  const snapshot = snapshotForModel(editor.getSnapshot());
  const known = knownChemicalSummary(snapshot.document);
  const atoms = Object.values(snapshot.document.graph.atoms), bonds = Object.values(snapshot.document.graph.bonds), objects = Object.values(snapshot.document.depiction.objects ?? {});
  return {
    snapshot,
    capabilities: {
      tools: AI_TOOLS.map(tool => tool.name),
      editOperations: AI_EDIT_OPERATION_SCHEMAS.map(operation => ((operation.properties as Record<string, {const:string}>).type.const)),
      constraints: ['versioned-atomic-edits', 'no-lossy-export', 'source-raw-excluded', 'no-arbitrary-code-or-plugin-execution', 'no-name-to-structure-or-reaction-prediction', 'no-simplification-to-enable-computation'],
      chemistryCalculation: {
        engine: 'RDKit', loading: 'lazy-local-wasm', maxAtoms: 1000,
        readOnlyTools: ['analyze_molecule'], mutationTools: ['cleanup_molecule_2d', 'import_smiles'],
        results: ['canonical-isomeric-smiles', 'formula', 'molecular-weight', 'exact-mass', 'formal-charge', 'ring-count', 'logP', 'tpsa', 'hydrogen-bond-counts', 'common-R/S/r/s/E/Z-labels'],
        selection: 'atomIds=[] explicitly means the whole document; nonempty IDs must form the requested complete molecule(s). Never automatically expand a partial selection.',
        scope: 'Complete defined ordinary molecules only. Query predicates, internal or unresolved fragments, polymer/repeating chemistry, multicenter nodes, axial/enhanced stereo and unsupported spin states are rejected rather than simplified.',
        import: 'Only user-provided single-molecule SMILES, optionally dot-separated ordinary fragments; replacing the whole document requires the user request and expectedRevision.',
        protections: ['read-and-write-revision-checks-after-loading', 'mutation-preview-when-enabled', 'one-step-undo-for-mutating-batches', 'preserve-chemical-identity-during-cleanup', 'computed-labels-do-not-assign-unspecified-centers'],
      },
      internalFragments: 'Display, expand and collapse are available; protected flattening failures retain the original graph. Arbitrary nested replacement is not exposed.',
    },
    diagnostics: editor.getDiagnostics(),
    summary: {
      formula: molecularFormula(snapshot.document),
      atomCount: Object.keys(snapshot.document.graph.atoms).length,
      bondCount: bonds.length,
      definedChemicalAtomCount: known.knownChemicalAtomCount,
      compositionComplete: known.complete,
      incompleteReasons: known.incompleteReasons,
      queryAtomCount: atoms.filter(atom => atom.query || atom.queryConstraints).length,
      topologyQueryBondCount: bonds.filter(bond => bond.topology !== undefined || bond.order === 'any').length,
      internalFragmentCount: atoms.filter(atom => atom.substructure || atom.namedFragment).length,
      drawingObjectCount: objects.filter(object => object.tag !== 'page').length,
      reactionStepCount: Object.keys(snapshot.document.graph.reactions ?? {}).length,
      polymerGroupCount: objects.filter(object => object.tag === 'bracketedgroup').length,
    },
  };
}
