import type { ChemistryAnalysis, ChemistryEngine } from '../chemistry/engine';
import { loadChemistryEngine } from '../chemistry/runtime';
import type { EditOperation } from '../core/edits';
import type { ChemicalDocument } from '../core/types';
import { RevisionConflictError, type EditorApi, type EditorSnapshot } from '../editor/api-types';

export interface AiChemistryRequest {
  tool: 'analyze_molecule' | 'cleanup_molecule_2d' | 'import_smiles';
  expectedRevision: number;
  atomIds?: string[];
  smiles?: string;
  title?: string;
}

export interface AiChemistryOptions {
  loadEngine?: () => Promise<ChemistryEngine>;
  signal?: AbortSignal;
}

export type AiPreparedChemistry =
  | { kind: 'analysis'; analysis: ChemistryAnalysis; revision: number }
  | { kind: 'cleanup'; operations: EditOperation[]; document: ChemicalDocument; engineVersion: string; atomIds: string[]; isomericSmiles: string; expectedRevision: number }
  | { kind: 'import'; document: ChemicalDocument; engineVersion: string; expectedRevision: number };

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('AI 化学计算已停止', 'AbortError');
}

function checkRevision(editor: EditorApi, expected: number, signal?: AbortSignal): EditorSnapshot {
  checkAbort(signal);
  const snapshot = editor.getSnapshot();
  if (snapshot.revision !== expected) throw new RevisionConflictError(expected, snapshot.revision);
  return snapshot;
}

function validateRequest(request: AiChemistryRequest): void {
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => !['tool', 'expectedRevision', 'atomIds', 'smiles', 'title'].includes(key))) throw new Error('AI 化学计算请求字段无效');
  if (!['analyze_molecule', 'cleanup_molecule_2d', 'import_smiles'].includes(request.tool)) throw new Error('AI 化学计算工具无效');
  if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) throw new Error('AI 化学计算需要有效文档版本');
  if (request.tool === 'import_smiles') {
    if (request.atomIds !== undefined || typeof request.smiles !== 'string' || !request.smiles.trim() || request.smiles.length > 50000 || (request.title !== undefined && (typeof request.title !== 'string' || request.title.length > 500))) throw new Error('AI SMILES 导入参数无效');
  } else if (request.smiles !== undefined || request.title !== undefined || (request.atomIds !== undefined && (!Array.isArray(request.atomIds) || request.atomIds.length > 2000 || request.atomIds.some(id => typeof id !== 'string' || !id || id.length > 256) || new Set(request.atomIds).size !== request.atomIds.length))) throw new Error('AI 化学计算选区参数无效');
}

/** Aborting does not poison the shared lazy WASM loader or wait for an uncooperative host loader. */
function loadAbortably(load: () => Promise<ChemistryEngine>, signal?: AbortSignal): Promise<ChemistryEngine> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (engine?: ChemistryEngine, error?: unknown) => {
      if (settled) return;
      settled = true; signal?.removeEventListener('abort', onAbort);
      if (error !== undefined) reject(error); else resolve(engine!);
    };
    const onAbort = () => finish(undefined, new DOMException('AI 化学计算已停止', 'AbortError'));
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => { checkAbort(signal); return load(); }).then(engine => finish(engine), error => finish(undefined, error));
  });
}

/** Prepares local computation only. The caller must review, recheck revision and commit the original operations. */
export async function prepareAiChemistry(editor: EditorApi, request: AiChemistryRequest, options: AiChemistryOptions = {}): Promise<AiPreparedChemistry> {
  checkAbort(options.signal); validateRequest(request);
  const input = structuredClone(request);
  const snapshot = structuredClone(checkRevision(editor, input.expectedRevision, options.signal));
  const load = options.loadEngine ?? loadChemistryEngine;
  if (typeof load !== 'function') throw new Error('AI 化学计算模块加载器无效');
  const engine = await loadAbortably(load, options.signal);
  checkRevision(editor, input.expectedRevision, options.signal);
  if (!engine || typeof engine.version !== 'string' || typeof engine.analyze !== 'function' || typeof engine.cleanup2D !== 'function' || typeof engine.importSmiles !== 'function') throw new Error('本地化学计算模块无效');
  let result: AiPreparedChemistry;
  if (input.tool === 'analyze_molecule') {
    result = { kind: 'analysis', analysis: engine.analyze(snapshot.document, input.atomIds ?? []), revision: snapshot.revision };
  } else if (input.tool === 'cleanup_molecule_2d') {
    const prepared = engine.cleanup2D(snapshot.document, input.atomIds ?? []);
    result = { kind: 'cleanup', operations: prepared.operations, document: prepared.document, engineVersion: prepared.engineVersion, atomIds: prepared.atomIds, isomericSmiles: prepared.isomericSmiles, expectedRevision: snapshot.revision };
  } else {
    result = { kind: 'import', document: engine.importSmiles(input.smiles!, input.title), engineVersion: engine.version, expectedRevision: snapshot.revision };
  }
  checkRevision(editor, input.expectedRevision, options.signal);
  return structuredClone(result);
}
