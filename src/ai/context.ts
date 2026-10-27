import { molecularFormula } from '../core/model';
import type { EditorApi, EditorSnapshot } from '../editor/api-types';

/** The UI preview and model requests share the same source-free context. */
export function snapshotForModel(snapshot: EditorSnapshot): EditorSnapshot {
  const clean = structuredClone(snapshot);
  delete clean.document.source;
  if (Object.keys(clean.document.graph.atoms).length > 2000 || Object.keys(clean.document.graph.bonds).length > 2000 || JSON.stringify(clean).length > 700_000) throw new Error('当前结构超过 AI 上下文限额；请缩小文档后重试。结构未被截断。');
  return clean;
}

export function getAiEditorContext(editor: EditorApi) {
  const snapshot = snapshotForModel(editor.getSnapshot());
  return {
    snapshot,
    diagnostics: editor.getDiagnostics(),
    summary: {
      formula: molecularFormula(snapshot.document),
      atomCount: Object.keys(snapshot.document.graph.atoms).length,
      bondCount: Object.keys(snapshot.document.graph.bonds).length,
    },
  };
}
