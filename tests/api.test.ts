import { afterEach, describe, expect, it } from 'vitest';
import { createChemicalEditor, type ChemicalEditorElement } from '../src/editor/chemical-editor';
import { RevisionConflictError, type EditResult, type EditorEvents, type EditorPlugin, type EditorRequest, type EditorSelection } from '../src/editor/api-types';
import { emptyDocument } from '../src/core/model';
import { exampleDocument } from '../src/core/templates';
import { structureReviewPlugin } from '../src/plugins/structure-review';

const editors: ChemicalEditorElement[] = [];
function create(document = exampleDocument('ethanol')) {
  const container = globalThis.document.createElement('div');
  globalThis.document.body.append(container);
  const editor = createChemicalEditor({ container, document });
  editors.push(editor);
  return editor;
}
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.replaceChildren();
  localStorage.clear();
});

describe('public editor API', () => {
  it('returns independent document snapshots and selection arrays', () => {
    const editor = create(), atomId = Object.keys(editor.getDocument().graph.atoms)[0];
    editor.setSelection({ atomIds: [atomId] });
    const before = editor.getSnapshot(), snapshot = editor.getSnapshot(), selection = editor.getSelection();
    expect(snapshot.apiVersion).toBe(1);
    expect(snapshot.revision).toBeGreaterThanOrEqual(0);
    snapshot.document.title = 'External mutation';
    snapshot.document.graph.atoms[atomId].element = 'N';
    snapshot.document.depiction.positions[atomId].x = 999;
    snapshot.selection.atomIds.length = 0;
    selection.atomIds.push('missing');
    expect(editor.getSnapshot()).toEqual(before);
    expect(editor.getSelection()).toEqual({ atomIds: [atomId] });
  });

  it('validates the entire selection before changing it', () => {
    const editor = create(), document = editor.getDocument();
    const atomId = Object.keys(document.graph.atoms)[0], bondId = Object.keys(document.graph.bonds)[0];
    editor.setSelection({ atomIds: [atomId] });
    let events = 0; editor.addEventListener('selectionchange', () => events++);
    const before = editor.getSnapshot();
    const invalid: unknown[] = [
      { atomIds: ['missing'] }, { atomIds: [], bondId: 'missing' },
      { atomIds: [atomId], bondId }, { atomIds: 'all' },
      { atomIds: [atomId], unsupported: true }, { atomIds: ['toString'] },
    ];
    for (const selection of invalid) {
      expect(() => editor.setSelection(selection as EditorSelection)).toThrow();
      expect(editor.getSnapshot()).toEqual(before);
    }
    expect(events).toBe(0);
    editor.setSelection({ atomIds: [], bondId });
    expect(editor.getSelection()).toEqual({ atomIds: [], bondId });
  });

  it('commits a batch as one change and one undo step', () => {
    const editor = create(), before = editor.getSnapshot();
    const atomId = Object.keys(before.document.graph.atoms)[0];
    const changes: EditorEvents['change'][] = [];
    editor.addEventListener('change', event => changes.push((event as CustomEvent<EditorEvents['change']>).detail));
    const result = editor.applyEdits({ expectedRevision: before.revision, operations: [
      { type: 'rename', title: 'Batch result' },
      { type: 'update-atom', atomId, changes: { isotope: 13 } },
      { type: 'set-position', atomId, position: { x: 9, y: 2 } },
    ] });
    expect(changes).toHaveLength(1);
    expect(changes[0].revision).toBe(before.revision + 1);
    expect(result.snapshot.revision).toBe(before.revision + 1);
    expect(result.snapshot.document.title).toBe('Batch result');
    expect(result.snapshot.document.graph.atoms[atomId].isotope).toBe(13);
    expect(result.snapshot.document.depiction.positions[atomId]).toEqual({ x: 9, y: 2 });
    editor.undo();
    expect(editor.getDocument()).toEqual(before.document);
    expect(editor.getSnapshot().revision).toBe(before.revision + 2);
    expect(editor.getSnapshot().canRedo).toBe(true);
    editor.redo();
    expect(editor.getDocument()).toEqual(result.snapshot.document);
  });

  it('reports a revision conflict without touching document, selection or history', () => {
    const editor = create(), staleRevision = editor.getSnapshot().revision;
    editor.applyEdits({ operations: [{ type: 'rename', title: 'Current version' }] });
    editor.setSelection({ atomIds: [Object.keys(editor.getDocument().graph.atoms)[0]] });
    const before = editor.getSnapshot();
    let changes = 0; editor.addEventListener('change', () => changes++);
    let error: unknown;
    try { editor.applyEdits({ expectedRevision: staleRevision, operations: [{ type: 'rename', title: 'Outdated edit' }] }); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(RevisionConflictError);
    expect(error).toMatchObject({ code: 'REVISION_CONFLICT', expectedRevision: staleRevision, actualRevision: before.revision });
    expect(editor.getSnapshot()).toEqual(before);
    expect(changes).toBe(0);
  });

  it.each([
    { method: 'unknown_method' },
    { method: 'get_snapshot', unsupported: true },
    { method: 'get_snapshot', params: {} },
    { method: 'apply_edits' },
    { method: 'apply_edits', params: { operations: [], expectedRevision: '1' } },
    { method: 'set_selection', params: { atomIds: [], unsupported: true } },
    { method: 'export', params: { format: 'json', unsupported: true } },
    { method: 'execute_command', params: { id: 'unused', unsupported: true } },
  ])('rejects unsupported JSON methods and parameters: %j', async request => {
    const editor = create(), before = editor.getSnapshot();
    await expect(editor.execute(request as unknown as EditorRequest)).rejects.toThrow();
    expect(editor.getSnapshot()).toEqual(before);
  });

  it('rejects a string allowLossy flag through both direct and JSON export', async () => {
    const editor = create(), input = { format: 'mrv', allowLossy: 'false' };
    expect(() => editor.export(input as unknown as Parameters<typeof editor.export>[0])).toThrow('布尔值');
    await expect(editor.execute({ method: 'export', params: input } as unknown as EditorRequest)).rejects.toThrow('布尔值');
    expect(editor.export({ format: 'mrv', allowLossy: false }).format).toBe('mrv');
  });

  it('executes a serialized edit batch with temporary references', async () => {
    const editor = create(emptyDocument());
    const request = JSON.parse(JSON.stringify({ method: 'apply_edits', params: {
      expectedRevision: editor.getSnapshot().revision,
      operations: [
        { type: 'add-atom', ref: '$carbon', element: 'C', position: { x: 0, y: 0 } },
        { type: 'add-atom', ref: '$oxygen', element: 'O', position: { x: 1, y: 0 } },
        { type: 'add-bond', ref: '$bond', atoms: ['$carbon', '$oxygen'] },
        { type: 'update-atom', atomId: '$oxygen', changes: { isotope: 18 } },
      ],
    } }));
    const result = await editor.execute(request) as EditResult;
    const carbon = result.created.atoms.$carbon, oxygen = result.created.atoms.$oxygen, bond = result.created.bonds.$bond;
    expect(result.snapshot.document.graph.bonds[bond].atoms).toEqual([carbon, oxygen]);
    expect(result.snapshot.document.graph.atoms[oxygen].isotope).toBe(18);
    expect(await editor.execute({ method: 'get_snapshot' })).toEqual(editor.getSnapshot());
    expect(await editor.execute({ method: 'set_selection', params: { atomIds: [oxygen] } })).toEqual({ atomIds: [oxygen] });
    expect(await editor.execute({ method: 'get_selection' })).toEqual({ atomIds: [oxygen] });
  });

  it('emits selectionchange for API and keyboard changes without changing the document revision', () => {
    const editor = create(), atomIds = Object.keys(editor.getDocument().graph.atoms);
    const revision = editor.getSnapshot().revision, events: EditorEvents['selectionchange'][] = [];
    editor.addEventListener('selectionchange', event => events.push((event as CustomEvent<EditorEvents['selectionchange']>).detail));
    editor.setSelection({ atomIds: [atomIds[0]] });
    expect(events).toEqual([{ selection: { atomIds: [atomIds[0]] }, revision }]);
    editor.setSelection({ atomIds: [atomIds[0]] });
    expect(events).toHaveLength(1);
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(events.at(-1)).toEqual({ selection: { atomIds }, revision });
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(events.at(-1)).toEqual({ selection: { atomIds: [] }, revision });
    expect(events).toHaveLength(3);
    expect(editor.getSnapshot().revision).toBe(revision);
  });

  it.each(['native', 'plugin'] as const)('keeps change documents paired with their revisions after a reentrant %s selection listener edits', listenerType => {
    const editor = create(), atomId = Object.keys(editor.getDocument().graph.atoms)[0];
    editor.setSelection({ atomIds: [atomId] });
    const before = editor.getSnapshot(), events: EditorEvents['change'][] = [];
    let followUps = 0;
    const followUp = (detail: EditorEvents['selectionchange']) => {
      if (detail.selection.atomIds.length || followUps) return;
      followUps++;
      editor.applyEdits({ expectedRevision: detail.revision, operations: [{ type: 'rename', title: 'Selection follow-up' }] });
    };
    if (listenerType === 'native') {
      editor.addEventListener('selectionchange', event => followUp((event as CustomEvent<EditorEvents['selectionchange']>).detail));
    } else {
      editor.registerPlugin({
        id: 'selection-follow-up', name: 'Selection follow-up', version: '1.0.0', apiVersion: 1,
        activate(context) { return context.on('selectionchange', followUp); },
      });
    }
    editor.addEventListener('change', event => events.push(structuredClone((event as CustomEvent<EditorEvents['change']>).detail)));
    editor.applyEdits({ operations: [{ type: 'rename', title: 'Before removal' }] });
    editor.applyEdits({ operations: [{ type: 'remove-atom', atomId }] });
    expect(followUps).toBe(1);
    expect(editor.getSnapshot().revision).toBe(before.revision + 3);
    expect(editor.getDocument().title).toBe('Selection follow-up');
    const titlesByRevision = new Map([
      [before.revision + 1, 'Before removal'],
      [before.revision + 2, 'Before removal'],
      [before.revision + 3, 'Selection follow-up'],
    ]);
    expect(events.length).toBeGreaterThanOrEqual(2);
    for (const event of events) expect(event.document.title).toBe(titlesByRevision.get(event.revision));
    const revisions = events.map(event => event.revision);
    expect(new Set(revisions).size).toBe(revisions.length);
    for (let index = 1; index < revisions.length; index++) expect(revisions[index]).toBeGreaterThan(revisions[index - 1]);
    expect(events.at(-1)?.document).toEqual(editor.getDocument());
    expect(events.at(-1)?.revision).toBe(editor.getSnapshot().revision);
  });

  it('runs the example structure review plugin through public APIs and re-enables without duplicated resources', async () => {
    const document = exampleDocument('ethanol'), atomIds = Object.keys(document.graph.atoms);
    document.graph.atoms[atomIds[0]].charge = 1;
    document.graph.atoms[atomIds[1]].charge = -1;
    document.graph.atoms[atomIds[2]].charge = -1;
    const editor = create(document);
    editor.registerPlugin(structureReviewPlugin);
    editor.setSelection({ atomIds: atomIds.slice(0, 2) });
    const before = editor.getSnapshot();
    let changes = 0; editor.addEventListener('change', () => changes++);
    const result = await editor.executeCommand('structure-review.neutralize-selection');
    expect(result).toEqual({ revision: before.revision + 1, updatedAtomIds: atomIds.slice(0, 2) });
    expect(changes).toBe(1);
    expect(atomIds.slice(0, 2).map(id => editor.getDocument().graph.atoms[id].charge)).toEqual([0, 0]);
    expect(editor.getDocument().graph.atoms[atomIds[2]].charge).toBe(-1);
    editor.undo();
    expect(editor.getDocument()).toEqual(before.document);
    expect(changes).toBe(2);

    const commandIds = ['structure-review.review', 'structure-review.neutralize-selection'].sort();
    const panels = () => editor.shadowRoot!.querySelectorAll('[data-plugin-panel="structure-review.summary"]');
    expect(editor.getCommands().map(command => command.id).sort()).toEqual(commandIds);
    expect(panels()).toHaveLength(1);
    for (let cycle = 0; cycle < 2; cycle++) {
      editor.setPluginEnabled('structure-review', false);
      expect(editor.getCommands()).toHaveLength(0);
      expect(panels()).toHaveLength(0);
      expect(editor.getPlugins()[0].enabled).toBe(false);
      editor.setPluginEnabled('structure-review', true);
      editor.setPluginEnabled('structure-review', true);
      expect(editor.getCommands().map(command => command.id).sort()).toEqual(commandIds);
      expect(panels()).toHaveLength(1);
      expect(editor.getPlugins()[0].enabled).toBe(true);
    }
  });

  it('cleans up registered plugin resources on destroy and isolates other instances', () => {
    const first = create(), second = create(exampleDocument('benzene'));
    let activations = 0, disposals = 0, panelDisposals = 0;
    const changes = new Map<string, number>();
    const plugin: EditorPlugin = {
      id: 'test-lifecycle', name: 'Lifecycle test', version: '1.0.0', apiVersion: 1,
      activate(context) {
        activations++;
        const documentId = context.editor.getDocument().id;
        context.on('change', () => changes.set(documentId, (changes.get(documentId) ?? 0) + 1));
        context.addPanel({ id: 'status', title: 'Lifecycle status', mount(container) {
          const element = document.createElement('span');
          element.dataset.lifecycle = 'active'; element.textContent = documentId;
          container.append(element);
          return () => { panelDisposals++; element.remove(); };
        } });
        return () => { disposals++; };
      },
    };
    first.registerPlugin(plugin); second.registerPlugin(plugin);
    expect(activations).toBe(2);
    expect(first.getPlugins()).toHaveLength(1);
    expect(second.getPlugins()).toHaveLength(1);
    first.applyEdits({ operations: [{ type: 'rename', title: 'First instance' }] });
    expect(changes.get(first.getDocument().id)).toBe(1);
    expect(changes.get(second.getDocument().id)).toBeUndefined();
    first.destroy(); first.destroy();
    expect(disposals).toBe(1);
    expect(panelDisposals).toBe(1);
    expect(first.isConnected).toBe(false);
    expect(second.isConnected).toBe(true);
    expect(second.shadowRoot!.querySelector('[data-lifecycle="active"]')).not.toBeNull();
    second.applyEdits({ operations: [{ type: 'rename', title: 'Second instance' }] });
    expect(changes.get(second.getDocument().id)).toBe(1);
    expect(second.getPlugins()).toHaveLength(1);
    second.destroy();
    expect(disposals).toBe(2);
    expect(panelDisposals).toBe(2);
  });
});
