import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import initRDKit from '@rdkit/rdkit';
import { prepareAiChemistry, type AiChemistryRequest } from '../src/ai/chemistry-tools';
import { createChemistryEngine, type ChemistryEngine } from '../src/chemistry/engine';
import { applyDocumentEdits } from '../src/core/edits';
import { clone } from '../src/core/model';
import { exampleDocument } from '../src/core/templates';
import type { ChemicalDocument } from '../src/core/types';
import { createChemicalEditor, type ChemicalEditorElement } from '../src/editor/chemical-editor';
import { importDocument, exportDocument } from '../src/formats';
import { polymerXml } from './fixtures/polymer-fixture';

let engine: ChemistryEngine;
const editors: ChemicalEditorElement[] = [];
beforeAll(async () => { engine = createChemistryEngine(await initRDKit()); });
afterEach(() => { editors.splice(0).forEach(editor => editor.destroy()); document.body.replaceChildren(); vi.restoreAllMocks(); });
function mount(doc = exampleDocument('ethanol')) {
  const editor = createChemicalEditor({ container: document.body, document: doc }); editors.push(editor); return editor;
}
const loaded = () => Promise.resolve(engine);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function request(editor: ChemicalEditorElement, tool: AiChemistryRequest['tool'], atomIds: string[] = []): AiChemistryRequest {
  return { tool, atomIds, expectedRevision: editor.getSnapshot().revision };
}

describe('AI local chemistry preparation', () => {
  it('returns real ethanol properties without editing the document, selection, history or view', async () => {
    const editor = mount(), ids = Object.keys(editor.getDocument().graph.atoms);
    editor.setSelection({ atomIds: ids }); const before = editor.getSnapshot();
    const fit = vi.spyOn(editor, 'fit'), select = vi.spyOn(editor, 'setSelection'), change = vi.fn();
    editor.addEventListener('change', change);
    const result = await prepareAiChemistry(editor, request(editor, 'analyze_molecule', ids), { loadEngine: loaded });
    expect(result.kind).toBe('analysis'); if (result.kind !== 'analysis') throw Error('Expected analysis');
    expect(result.revision).toBe(before.revision); expect(result.analysis.engine).toBe('RDKit');
    expect(result.analysis.formula).toBe('C2H6O'); expect(result.analysis.molecularWeight).toBeCloseTo(46.069, 3);
    expect(result.analysis.exactMass).toBeCloseTo(46.041864812, 6); expect(result.analysis.smiles).toBe('CCO');
    expect(result.analysis.descriptors.hBondDonors).toBe(1); expect(result.analysis.atomIds).toEqual(ids);
    expect(editor.getSnapshot()).toEqual(before); expect(fit).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled(); expect(change).not.toHaveBeenCalled();
  });

  it('calculates only the requested complete component and refuses a cut selection', async () => {
    const doc = engine.importSmiles('CCO.O'), editor = mount(doc), ids = Object.keys(doc.graph.atoms), before = editor.getSnapshot();
    const result = await prepareAiChemistry(editor, request(editor, 'analyze_molecule', ids.slice(0, 3)), { loadEngine: loaded });
    if (result.kind !== 'analysis') throw Error('Expected analysis');
    expect(result.analysis.formula).toBe('C2H6O'); expect(result.analysis.atomCount).toBe(3); expect(result.analysis.atomIds).not.toContain(ids[3]);
    await expect(prepareAiChemistry(editor, request(editor, 'analyze_molecule', ids.slice(0, 1)), { loadEngine: loaded })).rejects.toThrow('完整分子');
    expect(editor.getSnapshot()).toEqual(before);
  });

  it('refuses query and polymer simplification without modifying their source documents', async () => {
    const query = exampleDocument('ethanol'); Object.values(query.graph.atoms)[0].queryConstraints = { substituentsUpTo: 3 };
    for (const doc of [query, importDocument({ data: polymerXml }).document]) {
      const editor = mount(doc), before = editor.getSnapshot();
      await expect(prepareAiChemistry(editor, request(editor, 'analyze_molecule'), { loadEngine: loaded })).rejects.toThrow();
      await expect(prepareAiChemistry(editor, request(editor, 'cleanup_molecule_2d'), { loadEngine: loaded })).rejects.toThrow();
      expect(editor.getSnapshot()).toEqual(before);
    }
  });

  it('prepares verified cleanup operations with stable identities and retained source, then permits one atomic commit', async () => {
    const ordinary = engine.importSmiles('CC(C)CC(O)C');
    const source = importDocument({ data: exportDocument(ordinary, { format: 'cdxml' }).data }).document;
    Object.values(source.depiction.positions).forEach((p, i) => { p.x = i * .1; p.y = 0; });
    const editor = mount(source), before = editor.getSnapshot();
    const result = await prepareAiChemistry(editor, request(editor, 'cleanup_molecule_2d'), { loadEngine: loaded });
    if (result.kind !== 'cleanup') throw Error('Expected cleanup');
    expect(editor.getSnapshot()).toEqual(before); expect(result.expectedRevision).toBe(before.revision);
    expect(result.document.graph).toEqual(before.document.graph); expect(result.document.source).toEqual(before.document.source);
    expect(result.document.depiction.positions).not.toEqual(before.document.depiction.positions);
    expect(result.isomericSmiles).toBe(engine.analyze(before.document).smiles); expect(result.engineVersion).toBe(engine.version);
    expect(applyDocumentEdits(before.document, result.operations).document).toEqual(result.document);
    editor.applyEdits({ expectedRevision: result.expectedRevision, operations: result.operations });
    expect(editor.getSnapshot().revision).toBe(before.revision + 1); editor.undo(); expect(editor.getDocument()).toEqual(before.document);
  });

  it.each(['F[C@](Cl)(Br)I', 'C/C=C/C'])('retains specified isomeric identity during local preparation: %s', async smiles => {
    const doc = engine.importSmiles(smiles), editor = mount(doc), before = editor.getSnapshot(), analysis = engine.analyze(doc);
    const result = await prepareAiChemistry(editor, request(editor, 'cleanup_molecule_2d'), { loadEngine: loaded });
    if (result.kind !== 'cleanup') throw Error('Expected cleanup');
    const after = engine.analyze(result.document);
    expect(after.smiles).toBe(analysis.smiles); expect(after.stereoAtoms).toEqual(analysis.stereoAtoms); expect(after.stereoBonds).toEqual(analysis.stereoBonds);
    expect(editor.getSnapshot()).toEqual(before);
  });

  it('prepares exact SMILES chemistry and its supplied title without replacing the editor', async () => {
    const editor = mount(), before = editor.getSnapshot();
    const result = await prepareAiChemistry(editor, { tool: 'import_smiles', smiles: '[13CH3][18OH]', title: '用户标题 <keep>', expectedRevision: before.revision }, { loadEngine: loaded });
    if (result.kind !== 'import') throw Error('Expected import');
    expect(result.document.title).toBe('用户标题 <keep>'); expect(result.document.source).toBeUndefined(); expect(result.expectedRevision).toBe(before.revision);
    expect(engine.analyze(result.document).smiles).toBe('[13CH3][18OH]'); expect(editor.getSnapshot()).toEqual(before);
    await expect(prepareAiChemistry(editor, { tool: 'import_smiles', smiles: 'CCO>O>CC=O', expectedRevision: before.revision }, { loadEngine: loaded })).rejects.toThrow('单条');
    expect(editor.getSnapshot()).toEqual(before);
  });

  it('rejects stale versions before loading the engine', async () => {
    const editor = mount(), input = request(editor, 'analyze_molecule'), load = vi.fn(loaded);
    editor.applyEdits({ operations: [{ type: 'rename', title: 'Manual revision' }] }); const before = editor.getSnapshot();
    await expect(prepareAiChemistry(editor, input, { loadEngine: load })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(load).not.toHaveBeenCalled(); expect(editor.getSnapshot()).toEqual(before);
  });

  it('rejects a result loaded after a manual edit, without overwriting the manual document', async () => {
    const editor = mount(), loading = deferred<ChemistryEngine>();
    const pending = prepareAiChemistry(editor, request(editor, 'cleanup_molecule_2d'), { loadEngine: () => loading.promise });
    editor.applyEdits({ operations: [{ type: 'rename', title: 'Manual edit while loading' }] }); const manual = editor.getSnapshot();
    loading.resolve(engine); await expect(pending).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(editor.getSnapshot()).toEqual(manual);
  });

  it('aborts before loading and while an uncooperative loader remains pending', async () => {
    const editor = mount(), before = editor.getSnapshot(), stopped = new AbortController(), load = vi.fn(loaded); stopped.abort();
    await expect(prepareAiChemistry(editor, request(editor, 'analyze_molecule'), { loadEngine: load, signal: stopped.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(load).not.toHaveBeenCalled();
    const controller = new AbortController(), loading = deferred<ChemistryEngine>();
    const pending = prepareAiChemistry(editor, request(editor, 'analyze_molecule'), { loadEngine: () => loading.promise, signal: controller.signal });
    await Promise.resolve(); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    loading.reject(new Error('A late loader error is still handled')); await Promise.resolve();
    expect(editor.getSnapshot()).toEqual(before);
  });

  it('checks cancellation and version again after a host computation returns', async () => {
    const editor = mount(), before = editor.getSnapshot(), controller = new AbortController();
    const cancelled: ChemistryEngine = { ...engine, analyze(doc, ids) { const result = engine.analyze(doc, ids); controller.abort(); return result; } };
    await expect(prepareAiChemistry(editor, request(editor, 'analyze_molecule'), { loadEngine: async () => cancelled, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(editor.getSnapshot()).toEqual(before);
    const changed: ChemistryEngine = { ...engine, analyze(doc, ids) { const result = engine.analyze(doc, ids); editor.applyEdits({ operations: [{ type: 'rename', title: 'Manual during custom computation' }] }); return result; } };
    await expect(prepareAiChemistry(editor, request(editor, 'analyze_molecule'), { loadEngine: async () => changed })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(editor.getDocument().title).toBe('Manual during custom computation');
  });

  it('detaches caller parameters and returned documents from a host loader', async () => {
    const editor = mount(engine.importSmiles('CCC.O')), before = editor.getSnapshot(), ids = Object.keys(before.document.graph.atoms).slice(0, 3);
    const expectedIds = [...ids], input = request(editor, 'cleanup_molecule_2d', ids), loading = deferred<ChemistryEngine>();
    let hostDocument: ChemicalDocument | undefined;
    const host: ChemistryEngine = { ...engine, cleanup2D(doc, selected) { const prepared = engine.cleanup2D(doc, selected); hostDocument = prepared.document; return prepared; } };
    const pending = prepareAiChemistry(editor, input, { loadEngine: () => loading.promise });
    input.atomIds!.splice(0); input.expectedRevision = 999; loading.resolve(host);
    const result = await pending; if (result.kind !== 'cleanup') throw Error('Expected cleanup');
    expect(result.atomIds).toEqual(expectedIds); const prepared = clone(result.document);
    hostDocument!.title = 'Changed outside'; expect(result.document).toEqual(prepared); expect(editor.getSnapshot()).toEqual(before);
  });

  it('rejects ambiguous or malformed SDK inputs before any computation', async () => {
    const editor = mount(), load = vi.fn(loaded), input = request(editor, 'analyze_molecule');
    await expect(prepareAiChemistry(editor, { ...input, atomIds: ['missing', 'missing'] }, { loadEngine: load })).rejects.toThrow('选区参数');
    await expect(prepareAiChemistry(editor, { ...input, expectedRevision: NaN }, { loadEngine: load })).rejects.toThrow('有效文档版本');
    await expect(prepareAiChemistry(editor, { ...input, smiles: 'CCO' }, { loadEngine: load })).rejects.toThrow('选区参数');
    expect(load).not.toHaveBeenCalled();
  });
});
