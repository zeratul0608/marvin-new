export type AtomId = string;
export type BondId = string;
export type Format = 'json' | 'mol' | 'mol-v3000' | 'cdxml' | 'mrv';
export type ImportFormat = Format | 'cdx';
export type ImportData = string | Uint8Array | ArrayBuffer;
export interface ImportInput { data: ImportData; format?: ImportFormat; name?: string }
export interface Point { x: number; y: number }
export type HydrogenPolicy = { mode: 'auto' } | { mode: 'fixed'; count: number };
export interface Atom {
  id: AtomId;
  element: string;
  charge: number;
  isotope?: number;
  /** Atom-map numbers are external annotations, never object identity. */
  atomMap?: number;
  hydrogens: HydrogenPolicy;
}
export type BondOrder = 1 | 2 | 3 | 'aromatic';
export interface Bond {
  id: BondId;
  atoms: [AtomId, AtomId];
  order: BondOrder;
}
export interface BondDepiction {
  style: 'plain' | 'wedge' | 'hashed' | 'wavy';
  /** The narrow end is explicit, independent of array or file ordering. */
  from: AtomId;
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
  graph: { atoms: Record<AtomId, Atom>; bonds: Record<BondId, Bond> };
  depiction: {
    positions: Record<AtomId, Point>;
    bonds: Record<BondId, BondDepiction>;
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
