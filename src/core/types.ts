export type AtomId = string;
export type BondId = string;
export type Format = 'json' | 'mol' | 'mol-v3000' | 'cdxml' | 'mrv' | 'cdx' | 'rxn' | 'rxn-v3000';
export type ImportFormat = Format | 'cdx';
export type ImportData = string | Uint8Array | ArrayBuffer;
export interface ImportInput { data: ImportData; format?: ImportFormat; name?: string }
export interface Point { x: number; y: number }
export type HydrogenPolicy = { mode: 'auto' } | { mode: 'fixed'; count: number };
export type ConnectionType = 'Unspecified' | 'Diamond' | 'Star' | 'PolymerBead' | 'Wavy' | 'Residue' | 'Peptide' | 'DNA' | 'RNA' | 'Terminus' | 'Sulfide' | 'Nucleotide' | 'UnlinkedBranch';
export type AtomCipLabel = 'R' | 'S' | 'r' | 's' | 'u' | 'M' | 'P' | 'a' | '+' | '-' | '?';
export type ReactionParticipation = 'ReactionCenter' | 'MakeOrBreak' | 'ChangeType' | 'MakeAndChange' | 'NotReactionCenter' | 'NoChange' | 'Unmapped';
/** Ordered source-independent bond references; null represents a virtual/missing ligand. */
export type StereoBondOrdering = [BondId | null, BondId | null, BondId | null, BondId | null];
export interface TetrahedralGeometry {
  type: 'tetrahedral' | 'axial';
  /** Viewed from the first ligand, the other three are counterclockwise. Not a CIP label. */
  bondOrdering: StereoBondOrdering;
}
export type AtomQuery = { kind: 'elements'; elements: string[]; exclude?: boolean } | { kind: 'generic'; label: string } | { kind: 'any'; label?: string };
/** Predicates on a node; a concrete element can still carry query conditions. */
export interface AtomQueryConstraints {
  substituentsExactly?: number;
  substituentsUpTo?: number;
  ringBondCount?: 'Unspecified' | 'NoRingBonds' | 'AsDrawn' | 'SimpleRing' | 'Fusion' | 'SpiroOrHigher';
  unsaturatedBonds?: 'Unspecified' | 'MustBeAbsent' | 'MustBePresent';
  /** Exact-change restriction. Absence means unrestricted, never "must change". */
  reactionChange?: true;
  reactionStereo?: 'Unspecified' | 'Inversion' | 'Retention';
}
export interface AtomSubstructure {
  kind: 'abbreviation' | 'alternatives';
  /** Display the real child graphs while retaining the wrapper and its semantics. */
  display?: 'expanded';
  label: string;
  fragments: { document: ChemicalDocument; attachmentOrder: AtomId[] }[];
  /** External bonds on this parent node mapped onto numbered inner attachment ports. */
  connections: { bondId: BondId; fragment: number; atomId: AtomId }[];
}
export interface Atom {
  id: AtomId;
  element: string;
  /** A template boundary, distinct from an element or a wildcard query atom. */
  attachment?: 'external';
  charge: number;
  isotope?: number;
  /** ChemDraw/MDL spin state: 1 singlet, 2 doublet, 3 triplet; absent means none. */
  radical?: 1 | 2 | 3;
  /** Atom-map numbers are external annotations, never object identity. */
  atomMap?: number;
  hydrogens: HydrogenPolicy;
  geometry?: TetrahedralGeometry;
  query?: AtomQuery;
  queryConstraints?: AtomQueryConstraints;
  /** ChemDraw's display/export sequence, never the model object's identity. */
  sourceNumber?: number;
  /** Numbered attachment port inside a named fragment. */
  attachmentIndex?: number;
  substructure?: AtomSubstructure;
  connectionType?: ConnectionType;
  residueId?: number;
  /** Cached derived descriptor; invalidated after chemistry edits. Recalculation is explicit. */
  cipLabel?: AtomCipLabel;
  enhancedStereo?: { type: 'Absolute' | 'Or' | 'And'; group?: number };
  /** Multi-center attachment hub; not a carbon atom or a query label. */
  multiAttachment?: AtomId[];
  /** Explicitly unresolved in the source: no hidden atom graph may be invented. */
  namedFragment?: { type: 'Fragment' | 'Nickname'; label: string };
  /** Native, independent 3D coordinates; 2D editing never flattens these. */
  spatial?: [number, number, number];
}
export type BondOrder = 1 | 2 | 2.5 | 3 | 'aromatic' | 'any';
export interface Bond {
  id: BondId;
  atoms: [AtomId, AtomId];
  order: BondOrder;
  /** A query requirement, independent of the currently drawn bond order. */
  topology?: 'Unspecified' | 'Ring' | 'Chain' | 'RingOrChain';
  /** Clockwise/counterclockwise slots: first pair at atoms[0], second pair at atoms[1]. */
  circularOrdering?: StereoBondOrdering;
  cipLabel?: 'E' | 'Z';
  reactionParticipation?: ReactionParticipation;
  sequenceConnectivity?: 'Linear' | 'Bridged' | 'Staggered' | 'Cyclic';
  externalNumbers?: [number | null, number | null];
}
export interface BondDepiction {
  style: 'plain' | 'wedge' | 'hashed' | 'wavy' | 'dashed' | 'bold' | 'hash';
  /** The narrow end is explicit, independent of array or file ordering. */
  from: AtomId;
  /** Side of a double bond relative to the directed from → other endpoint. */
  doublePosition?: 'center' | 'left' | 'right';
  /** Character offsets in the labels at atoms[0] and atoms[1], independent of from. */
  labelOffsets?: [number, number];
  crossings?: BondId[];
  layer?: number;
  secondaryStyle?: 'plain' | 'dashed';
}
export type DocumentReference = { kind: 'atom' | 'bond' | 'drawing'; id: string } | { kind: 'molecule'; atomIds: AtomId[]; sourceId?: string };
export type DrawingTag = 'page' | 'group' | 't' | 'graphic' | 'curve' | 'arrow' | 'bioshape' | 'embeddedobject' | 'plasmidmap' | 'plasmidregion' | 'plasmidmarker' | 'marker' | 'gepplate' | 'geplane' | 'gepband' | 'table' | 'border' | 'ColoredMolecularArea' | 'bracketedgroup' | 'bracketattachment' | 'crossingbond' | 'chemicalproperty' | 'objecttag' | 'annotation' | 'represent';
export interface DrawingObject {
  id: string;
  tag: DrawingTag;
  /** Nonchemical display parameters; coordinates and document references have separate typed fields. */
  attributes: Record<string, string>;
  /** Native page coordinate units, retained without flattening Bezier handles or 3D drawing vectors. */
  geometry: Record<string, number[]>;
  references: Record<string, DocumentReference[]>;
  children: string[];
  atomIds: AtomId[];
  runs?: { text: string; attributes: Record<string, string> }[];
  parentId?: string;
  sourceId?: string;
  source?: { format: 'cdxml'; path: number[] } | { format: 'cdx'; serial: number };
}
export interface DrawingStyle {
  attributes: Record<string, string>;
  fonts: { id: string; name: string; charset?: string }[];
  colors: [number, number, number][];
}
export interface ReactionStep {
  id: string;
  schemeId: string;
  reactants: DocumentReference[];
  products: DocumentReference[];
  arrows: DocumentReference[];
  above: DocumentReference[];
  below: DocumentReference[];
  pluses: DocumentReference[];
  atomMappings?: { mode: 'specified' | 'manual' | 'auto'; atoms: [AtomId, AtomId][] }[];
  sourceId?: string;
  source?: { format: 'cdxml'; path: number[] } | { format: 'cdx'; serial: number };
}
export interface Diagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  objectId?: string;
}
export interface SourceRecord {
  format: ImportFormat;
  name?: string;
  /** CDX bytes are retained as a cdx:base64,... string; other formats retain original text. */
  raw: string;
  /** Original data can only be returned verbatim if the editable projection is unchanged. */
  fingerprint: string;
  issues: Diagnostic[];
}
export interface ChemicalDocument {
  schemaVersion: 1;
  id: string;
  title: string;
  graph: { atoms: Record<AtomId, Atom>; bonds: Record<BondId, Bond>; reactions?: Record<string, ReactionStep> };
  depiction: {
    positions: Record<AtomId, Point>;
    bonds: Record<BondId, BondDepiction>;
    objects?: Record<string, DrawingObject>;
    style?: DrawingStyle;
  };
  source?: SourceRecord;
}
export interface ImportResult { document: ChemicalDocument; issues: Diagnostic[] }
export interface ExportResult {
  data: string;
  format: Format;
  issues: Diagnostic[];
  passthrough: boolean;
  preservation?: 'original' | 'preserved' | 'converted' | 'rebuilt';
}
/** CDX data uses the same cdx:base64 transport as SourceRecord.raw. */
export interface SourceFileExportResult {
  data: string;
  format: ImportFormat;
  issues: Diagnostic[];
  passthrough: boolean;
  preservation: 'original' | 'preserved';
}
export interface FormatCapability {
  format: Format;
  name: string;
  extension: string;
  description: string;
}
