import type { CreatedObjects, EditOperation } from '../core/edits';
import type { AtomId, BondId, ChemicalDocument, Diagnostic, ExportResult, Format, ImportResult } from '../core/types';

export const EDITOR_API_VERSION = 1 as const;
export interface EditorSelection { atomIds: AtomId[]; bondId?: BondId }
export interface EditorSnapshot {
  apiVersion: typeof EDITOR_API_VERSION;
  revision: number;
  document: ChemicalDocument;
  selection: EditorSelection;
  canUndo: boolean;
  canRedo: boolean;
}
export interface EditRequest { operations: readonly EditOperation[]; expectedRevision?: number }
export interface EditResult { snapshot: EditorSnapshot; created: CreatedObjects }
export interface EditorEvents {
  change: { document: ChemicalDocument; revision: number };
  selectionchange: { selection: EditorSelection; revision: number };
}
export interface EditorApi {
  getSnapshot(): EditorSnapshot;
  getDocument(): ChemicalDocument;
  getSelection(): EditorSelection;
  setSelection(selection: EditorSelection): void;
  applyEdits(request: EditRequest): EditResult;
  getDiagnostics(): Diagnostic[];
  import(input: { data: string; format?: Format; name?: string }): ImportResult;
  export(input: { format: Format; allowLossy?: boolean }): ExportResult;
  exportSvg(): string;
  undo(): void;
  redo(): void;
  fit(): void;
}
export class RevisionConflictError extends Error {
  readonly code = 'REVISION_CONFLICT';
  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(`文档已更新：预期版本 ${expectedRevision}，当前版本 ${actualRevision}。请重新读取后再修改。`);
    this.name = 'RevisionConflictError';
  }
}

export type EditorRequest =
  | { method: 'get_snapshot' | 'get_selection' | 'get_diagnostics' | 'export_svg' | 'undo' | 'redo' | 'fit' | 'list_plugins' | 'list_commands' }
  | { method: 'set_selection'; params: EditorSelection }
  | { method: 'apply_edits'; params: EditRequest }
  | { method: 'import'; params: { data: string; format?: Format; name?: string } }
  | { method: 'export'; params: { format: Format; allowLossy?: boolean } }
  | { method: 'execute_command'; params: { id: string; input?: unknown } };

export interface PluginCommand {
  id: string;
  title: string;
  description?: string;
  execute(input?: unknown): unknown | Promise<unknown>;
}
export interface PluginCommandInfo { id: string; pluginId: string; title: string; description?: string; running: boolean }
export interface PluginPanel { id: string; title: string; mount(container: HTMLElement): void | (() => void) }
export interface PluginContext {
  readonly apiVersion: typeof EDITOR_API_VERSION;
  readonly editor: EditorApi;
  registerCommand(command: PluginCommand): () => void;
  addPanel(panel: PluginPanel): () => void;
  on<K extends keyof EditorEvents>(type: K, listener: (detail: EditorEvents[K]) => void): () => void;
  notify(message: string): void;
}
export interface EditorPlugin {
  id: string;
  name: string;
  version: string;
  apiVersion: typeof EDITOR_API_VERSION;
  description?: string;
  /** Activation is synchronous; commands may perform asynchronous work. */
  activate(context: PluginContext): void | (() => void);
}
export interface PluginInfo { id: string; name: string; version: string; description?: string; enabled: boolean }
