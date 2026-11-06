import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import initRDKit from '@rdkit/rdkit';
import { createChemistryEngine, type ChemistryEngine } from '../src/chemistry/engine';
import { runAiAssistant } from '../src/ai/assistant';
import type { AiEditProposal } from '../src/ai/proposal';
import type { AiCompletionRequest, AiMessage, AiRunEvent, AiTransport, AiTurn } from '../src/ai/types';
import type { ChemicalDocument } from '../src/core/types';
import { exampleDocument } from '../src/core/templates';
import { createChemicalEditor, type ChemicalEditorElement } from '../src/editor/chemical-editor';

let engine: ChemistryEngine;
const editors: ChemicalEditorElement[] = [];
const sourceSentinel = 'LOCAL_SOURCE_NOT_FOR_MODEL';
beforeAll(async () => { engine = createChemistryEngine(await initRDKit()); });
afterEach(() => { editors.splice(0).forEach(editor => editor.destroy()); document.body.replaceChildren(); vi.restoreAllMocks(); });

function create(document = exampleDocument('ethanol')) {
  document.source = { format: 'mrv', raw: sourceSentinel, fingerprint: '', issues: [] };
  const editor = createChemicalEditor({ container: globalThis.document.body, document }); editors.push(editor); return editor;
}
function distorted(): ChemicalDocument {
  const document = engine.importSmiles('CC(C)CC(O)C', 'Cleanup candidate');
  Object.values(document.depiction.positions).forEach((position, index) => { position.x = index * 0.12; position.y = 0; });
  return document;
}
const call = (name: string, args: unknown, id = name) => ({ id, name, arguments: JSON.stringify(args) });
const turn = (...toolCalls: AiTurn['toolCalls']): AiTurn => ({ text: '', toolCalls });
const done: AiTurn = { text: 'Tool results received.', toolCalls: [] };
const toolResults = (messages: AiMessage[]) => messages.filter(message => message.role === 'tool').map(message => ({ id: message.toolCallId, ...JSON.parse(message.content) }));
function scripted(...turns: (AiTurn | ((request: AiCompletionRequest) => AiTurn))[]) {
  const complete = vi.fn(async (request: AiCompletionRequest): Promise<AiTurn> => {
    expect(JSON.stringify(request)).not.toContain(sourceSentinel);
    const response = turns.shift(); if (!response) throw new Error('Unexpected extra model request');
    return typeof response === 'function' ? response(request) : response;
  });
  return { complete } satisfies AiTransport;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}

describe('AI tools with real local RDKit', () => {
  it('analyzes read-only and emits measured results without changing document, selection or the redo branch', async () => {
    const editor = create(); editor.applyEdits({ operations: [{ type: 'rename', title: 'Future title' }] }); editor.undo();
    const oxygen = Object.values(editor.getDocument().graph.atoms).find(atom => atom.element === 'O')!.id;
    editor.setSelection({ atomIds: [oxygen] }); const before = editor.getSnapshot();
    const events: AiRunEvent[] = [], load = vi.fn(async () => engine);
    const transport = scripted(turn(call('analyze_molecule', { expectedRevision: before.revision, atomIds: [] })), request => {
      const result = toolResults(request.messages)[0];
      expect(result.ok).toBe(true); expect(result.result.revision).toBe(before.revision);
      expect(result.result.analysis).toMatchObject({ engine: 'RDKit', formula: 'C2H6O', smiles: 'CCO', atomCount: 3, bondCount: 2 });
      expect(result.result.analysis.molecularWeight).toBeCloseTo(46.069, 3);
      expect(result.result.analysis.exactMass).toBeCloseTo(46.041864812, 6);
      return { text: 'The model summary does not replace the measured data.', toolCalls: [] };
    });
    const result = await runAiAssistant(editor, transport, { message: 'Analyze the whole molecule without editing.', allowEdits: false, loadChemistryEngine: load,
      onEvent(event) { events.push(structuredClone(event)); if (event.type === 'chemistry-analysis') { event.analysis.molecularWeight = -999; throw new Error('Unreliable UI observer'); } },
    });
    expect(load).toHaveBeenCalledTimes(1); expect(editor.getSnapshot()).toEqual(before);
    const measured = events.find(event => event.type === 'chemistry-analysis');
    expect(measured?.type).toBe('chemistry-analysis');
    if (measured?.type === 'chemistry-analysis') {
      expect(measured.revision).toBe(before.revision); expect(measured.analysis.version).toBe(engine.version);
      expect(measured.analysis.molecularWeight).toBeCloseTo(46.069, 3);
    }
    expect(toolResults(result.messages)[0].result.analysis.molecularWeight).toBeCloseTo(46.069, 3);
    expect(events.some(event => event.type === 'tool-end' && event.ok)).toBe(true);
    expect(JSON.stringify(result.messages)).not.toContain(sourceSentinel);
    editor.redo(); expect(editor.getDocument().title).toBe('Future title');
  });

  it('uses a real set-layout batch to clean coordinates while preserving graph, source and atomic undo', async () => {
    const editor = create(distorted()), before = editor.getSnapshot(), apply = vi.spyOn(editor, 'applyEdits');
    const chemistry = engine.analyze(before.document);
    const transport = scripted(turn(call('cleanup_molecule_2d', { expectedRevision: before.revision, atomIds: [] })), done);
    const result = await runAiAssistant(editor, transport, { message: 'Clean the whole molecule layout.', loadChemistryEngine: async () => engine });
    const after = editor.getSnapshot();
    expect(apply).toHaveBeenCalledTimes(1); expect(apply.mock.calls[0][0].operations).toHaveLength(1);
    expect(apply.mock.calls[0][0].operations[0].type).toBe('set-layout');
    expect(after.document.depiction.positions).not.toEqual(before.document.depiction.positions);
    expect(after.document.graph).toEqual(before.document.graph); expect(after.document.source).toEqual(before.document.source);
    expect(engine.analyze(after.document).smiles).toBe(chemistry.smiles);
    expect(after.revision).toBe(before.revision + 1); expect(toolResults(result.messages)[0]).toMatchObject({ ok: true, result: { engine: 'RDKit', engineVersion: engine.version } });
    editor.undo(); expect(editor.getDocument()).toEqual(before.document);
  });

  it('keeps cleanup pending until approval and rejects an unapproved cleanup without a commit', async () => {
    const editor = create(distorted()), before = editor.getSnapshot(), opened = deferred<AiEditProposal>(), approved = deferred<boolean>();
    const run = runAiAssistant(editor, scripted(turn(call('cleanup_molecule_2d', { expectedRevision: before.revision, atomIds: [] })), done), {
      message: 'Preview cleanup.', loadChemistryEngine: async () => engine,
      reviewEdits: proposal => { opened.resolve(proposal); return approved.promise; },
    });
    const proposal = await opened.promise;
    expect(proposal.tool).toBe('cleanup_molecule_2d'); expect(proposal.expectedRevision).toBe(before.revision);
    expect(proposal.after.graph).toEqual(before.document.graph); expect(proposal.after.depiction.positions).not.toEqual(before.document.depiction.positions);
    expect(JSON.stringify(proposal)).not.toContain(sourceSentinel); expect(editor.getSnapshot()).toEqual(before);
    approved.resolve(true); await run; expect(editor.getSnapshot().revision).toBe(before.revision + 1);
    editor.undo(); const unchanged = editor.getSnapshot();
    const declined = await runAiAssistant(editor, scripted(turn(call('cleanup_molecule_2d', { expectedRevision: unchanged.revision, atomIds: [] }))), {
      message: 'Do not apply this cleanup.', loadChemistryEngine: async () => engine, reviewEdits: async () => false,
    });
    expect(declined.rejected).toBe(true); expect(editor.getSnapshot()).toEqual(unchanged);
    expect(toolResults(declined.messages)[0]).toMatchObject({ ok: false, error: { code: 'AI_EDIT_REJECTED' } });
  });

  it('previews a source-free SMILES replacement and preserves S stereochemistry with one-step undo', async () => {
    const editor = create(), before = editor.getSnapshot(), smiles = 'N[C@@H](C)C(=O)O';
    const opened = deferred<AiEditProposal>(), decision = deferred<boolean>();
    const run = runAiAssistant(editor, scripted(turn(call('import_smiles', { expectedRevision: before.revision, smiles, title: 'S alanine' })), done), {
      message: `Import this supplied SMILES and replace the document: ${smiles}`, loadChemistryEngine: async () => engine,
      reviewEdits: proposal => { opened.resolve(proposal); return decision.promise; },
    });
    const preview = await opened.promise;
    expect(preview.tool).toBe('import_smiles'); expect(preview.before.source).toBeUndefined(); expect(preview.after.source).toBeUndefined();
    expect(JSON.stringify(preview)).not.toContain(sourceSentinel); expect(editor.getSnapshot()).toEqual(before);
    expect(Object.values(engine.analyze(preview.after).stereoAtoms)).toContain('S');
    decision.resolve(true); const result = await run;
    expect(editor.getDocument().title).toBe('S alanine'); expect(editor.getDocument().source).toBeUndefined();
    expect(Object.values(engine.analyze(editor.getDocument()).stereoAtoms)).toContain('S');
    expect(editor.getSnapshot().revision).toBe(before.revision + 1); expect(toolResults(result.messages)[0].ok).toBe(true);
    editor.undo(); expect(editor.getDocument()).toEqual(before.document);
  });

  it('aborts an unresolved loader promptly and ignores its eventual real engine result', async () => {
    const editor = create(distorted()), before = editor.getSnapshot(), controller = new AbortController();
    const started = deferred<void>(), delayed = deferred<ChemistryEngine>(), apply = vi.spyOn(editor, 'applyEdits');
    const run = runAiAssistant(editor, scripted(turn(call('cleanup_molecule_2d', { expectedRevision: before.revision, atomIds: [] }))), {
      message: 'Clean structure.', signal: controller.signal, loadChemistryEngine: () => { started.resolve(); return delayed.promise; },
    });
    const stopped = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    await started.promise; controller.abort(); await stopped; delayed.resolve(engine); await Promise.resolve();
    expect(apply).not.toHaveBeenCalled(); expect(editor.getSnapshot()).toEqual(before);
  });

  it('discards prepared work if manual editing changes the revision while RDKit is loading', async () => {
    const editor = create(distorted()), before = editor.getSnapshot(), started = deferred<void>(), delayed = deferred<ChemistryEngine>();
    const transport = scripted(turn(call('cleanup_molecule_2d', { expectedRevision: before.revision, atomIds: [] })), request => {
      expect(toolResults(request.messages)[0]).toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT', expectedRevision: before.revision, actualRevision: before.revision + 1 } }); return done;
    });
    const run = runAiAssistant(editor, transport, { message: 'Clean structure.', loadChemistryEngine: () => { started.resolve(); return delayed.promise; } });
    await started.promise; editor.applyEdits({ operations: [{ type: 'rename', title: 'Manual title' }] }); delayed.resolve(engine);
    await run; const expected = structuredClone(before.document); expected.title = 'Manual title';
    expect(editor.getDocument()).toEqual(expected); expect(editor.getSnapshot().revision).toBe(before.revision + 1);
  });

  it('rechecks revision after a cleanup review and does not overwrite manual edits', async () => {
    const editor = create(distorted()), before = editor.getSnapshot();
    const transport = scripted(turn(call('cleanup_molecule_2d', { expectedRevision: before.revision, atomIds: [] })), request => {
      expect(toolResults(request.messages)[0]).toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } }); return done;
    });
    await runAiAssistant(editor, transport, { message: 'Preview cleanup.', loadChemistryEngine: async () => engine, reviewEdits: async () => {
      editor.applyEdits({ operations: [{ type: 'rename', title: 'Manual edit during review' }] }); return true;
    } });
    const expected = structuredClone(before.document); expected.title = 'Manual edit during review';
    expect(editor.getDocument()).toEqual(expected); expect(editor.getSnapshot().revision).toBe(before.revision + 1);
  });

  it('rejects chemistry mutations in read-only mode before loading RDKit or showing preview', async () => {
    const editor = create(), before = editor.getSnapshot(), load = vi.fn(async () => engine), review = vi.fn(async () => true);
    const transport = scripted(turn(
      call('cleanup_molecule_2d', { expectedRevision: before.revision, atomIds: [] }),
      call('import_smiles', { expectedRevision: before.revision, smiles: 'CCO' }),
    ), done);
    const result = await runAiAssistant(editor, transport, { message: 'Read-only task.', allowEdits: false, loadChemistryEngine: load, reviewEdits: review });
    expect(toolResults(result.messages).every(response => !response.ok)).toBe(true);
    expect(load).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled(); expect(editor.getSnapshot()).toEqual(before);
  });

  it('reports invalid SMILES, incomplete selections and query chemistry without editing', async () => {
    const document = exampleDocument('ethanol'), atom = Object.values(document.graph.atoms)[0];
    const editor = create(document), before = editor.getSnapshot();
    const first = scripted(turn(
      call('import_smiles', { expectedRevision: before.revision, smiles: 'not a molecule' }),
      call('analyze_molecule', { expectedRevision: before.revision, atomIds: [atom.id] }),
      call('cleanup_molecule_2d', { expectedRevision: before.revision, atomIds: [atom.id] }),
    ), request => {
      const results = toolResults(request.messages); expect(results).toHaveLength(3); expect(results.every(response => !response.ok)).toBe(true);
      expect(results[1].error.message).toContain('完整分子'); expect(results[2].error.message).toContain('完整分子'); return done;
    });
    await runAiAssistant(editor, first, { message: 'Try unsupported inputs.', loadChemistryEngine: async () => engine });
    expect(editor.getSnapshot()).toEqual(before);
    editor.applyEdits({ operations: [{ type: 'update-atom', atomId: atom.id, changes: { queryConstraints: { substituentsUpTo: 3 } } }] });
    const queried = editor.getSnapshot();
    const rejected = await runAiAssistant(editor, scripted(turn(
      call('analyze_molecule', { expectedRevision: queried.revision, atomIds: [] }),
      call('cleanup_molecule_2d', { expectedRevision: queried.revision, atomIds: [] }),
    ), done), { message: 'Keep query conditions intact.', loadChemistryEngine: async () => engine });
    expect(toolResults(rejected.messages).every(response => !response.ok && response.error.message.includes('查询'))).toBe(true);
    expect(editor.getSnapshot()).toEqual(queried);
  });

  it('does not load chemistry for ordinary read/check tool requests', async () => {
    const editor = create(), before = editor.getSnapshot(), load = vi.fn(async () => engine);
    await runAiAssistant(editor, scripted(turn(call('read_structure', {}), call('check_structure', {})), done), { message: 'Read current data.', loadChemistryEngine: load });
    expect(load).not.toHaveBeenCalled(); expect(editor.getSnapshot()).toEqual(before);
  });
});
