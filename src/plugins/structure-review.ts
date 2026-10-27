import { connectedComponents, molecularFormula } from '../core/model';
import type { EditorPlugin, PluginContext } from '../editor/api-types';

function readSummary(context: PluginContext) {
  const snapshot = context.editor.getSnapshot();
  const atoms = Object.values(snapshot.document.graph.atoms);
  const diagnostics = context.editor.getDiagnostics();
  return {
    revision: snapshot.revision,
    title: snapshot.document.title,
    formula: molecularFormula(snapshot.document),
    atomCount: atoms.length,
    bondCount: Object.keys(snapshot.document.graph.bonds).length,
    fragmentCount: connectedComponents(snapshot.document).length,
    formalCharge: atoms.reduce((total, atom) => total + atom.charge, 0),
    isotopeAtomCount: atoms.filter(atom => atom.isotope !== undefined).length,
    selectedAtomCount: snapshot.selection.atomIds.length,
    selectedBondCount: snapshot.selection.bondId ? 1 : 0,
    diagnostics,
    scope: '基础结构摘要；分子式采用有限价态规则，不包含完整化学合理性或立体化学校验。',
  };
}

/** A trusted, in-page example that uses only the public plugin context. */
export const structureReviewPlugin: EditorPlugin = {
  id: 'structure-review',
  name: '结构审阅',
  version: '1.0.0',
  apiVersion: 1,
  description: '查看基础结构摘要，并将选中原子的形式电荷设为零。',
  activate(context) {
    const renderers = new Set<() => void>();
    const refresh = () => { for (const render of renderers) render(); };
    const cleanups = [
      context.on('change', refresh),
      context.on('selectionchange', refresh),
      context.registerCommand({
        id: 'review',
        title: '读取基础结构摘要',
        description: '返回原子、键、片段、形式电荷、同位素、基础分子式及现有诊断；不执行完整化学合理性校验。',
        execute() {
          const summary = readSummary(context);
          context.notify(`${summary.formula} · ${summary.atomCount} 个原子 · ${summary.fragmentCount} 个片段 · ${summary.diagnostics.length} 项基础诊断`);
          return summary;
        },
      }),
      context.registerCommand({
        id: 'neutralize-selection',
        title: '选中原子电荷归零',
        description: '将选中原子的形式电荷设为 0，整批可一步撤销；不推断质子化状态，也不增加或删除氢。',
        execute() {
          const snapshot = context.editor.getSnapshot();
          if (!snapshot.selection.atomIds.length) throw new Error('请先选择需要修改的原子。');
          const atomIds = snapshot.selection.atomIds.filter(atomId => snapshot.document.graph.atoms[atomId].charge !== 0);
          if (!atomIds.length) {
            context.notify('选中原子的形式电荷已经为 0。');
            return { revision: snapshot.revision, updatedAtomIds: [] };
          }
          const result = context.editor.applyEdits({
            expectedRevision: snapshot.revision,
            operations: atomIds.map(atomId => ({ type: 'update-atom', atomId, changes: { charge: 0 } })),
          });
          context.notify(`已将 ${atomIds.length} 个原子的形式电荷设为 0，可一步撤销。`);
          return { revision: result.snapshot.revision, updatedAtomIds: atomIds };
        },
      }),
      context.addPanel({
        id: 'summary',
        title: '基础结构摘要',
        mount(container) {
          const doc = container.ownerDocument;
          const list = doc.createElement('dl');
          const note = doc.createElement('p');
          const button = doc.createElement('button');
          list.style.cssText = 'display:grid;grid-template-columns:1fr auto;gap:6px 12px;margin:0;font-size:12px;';
          note.style.cssText = 'font-size:11px;line-height:1.6;color:#69788b;margin:12px 0;';
          button.type = 'button';
          button.textContent = '刷新摘要';
          const render = () => {
            const summary = readSummary(context);
            const rows: [string, string | number][] = [
              ['分子式（基础规则）', summary.formula],
              ['原子 / 键', `${summary.atomCount} / ${summary.bondCount}`],
              ['不连通片段', summary.fragmentCount],
              ['总形式电荷', summary.formalCharge > 0 ? `+${summary.formalCharge}` : summary.formalCharge],
              ['同位素标记原子', summary.isotopeAtomCount],
              ['选中原子 / 键', `${summary.selectedAtomCount} / ${summary.selectedBondCount}`],
              ['基础诊断', summary.diagnostics.length],
              ['文档版本', summary.revision],
            ];
            list.replaceChildren(...rows.flatMap(([label, value]) => {
              const term = doc.createElement('dt');
              const detail = doc.createElement('dd');
              term.textContent = label;
              detail.textContent = String(value);
              detail.style.cssText = 'margin:0;text-align:right;overflow-wrap:anywhere;';
              return [term, detail];
            }));
            note.textContent = summary.scope;
          };
          button.addEventListener('click', render);
          container.append(list, note, button);
          renderers.add(render);
          render();
          return () => {
            renderers.delete(render);
            button.removeEventListener('click', render);
            list.remove(); note.remove(); button.remove();
          };
        },
      }),
    ];
    return () => {
      for (const cleanup of cleanups.reverse()) cleanup();
      renderers.clear();
    };
  },
};
