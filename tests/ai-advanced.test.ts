import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAiAssistant } from '../src/ai/assistant';
import { getAiEditorContext } from '../src/ai/context';
import { AI_TOOLS } from '../src/ai/tool-schemas';
import type { AiMessage, AiTransport, AiTurn } from '../src/ai/types';
import type { EditOperation } from '../src/core/edits';
import { addAtom, addBond, emptyDocument } from '../src/core/model';
import { exampleDocument } from '../src/core/templates';
import { getPolymerGroup } from '../src/core/polymers';
import { importDocument } from '../src/formats';
import { createChemicalEditor, type ChemicalEditorElement } from '../src/editor/chemical-editor';
import { abbreviationXml } from './fixtures/abbreviation-fixture';
import { polymerXml } from './fixtures/polymer-fixture';

const editors: ChemicalEditorElement[] = [];
const create = (document = exampleDocument('ethanol')) => {
  const editor = createChemicalEditor({ container: globalThis.document.body, document }); editors.push(editor); return editor;
};
const call = (name: string, args: unknown, id = name) => ({ id, name, arguments: JSON.stringify(args) });
const toolResults = (messages: AiMessage[]) => messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
const execute = async (editor: ChemicalEditorElement, operations: unknown[], options: { allowEdits?: boolean } = {}) => {
  let round = 0;
  const transport: AiTransport = { complete: async () => ++round === 1 ? { text: '', toolCalls: [call('apply_edits', { expectedRevision: editor.getSnapshot().revision, operations })] } : { text: 'Done', toolCalls: [] } };
  return runAiAssistant(editor, transport, { message: 'Edit only as requested', ...options });
};
afterEach(() => { editors.splice(0).forEach(editor => editor.destroy()); document.body.replaceChildren(); });

describe('advanced chemistry in the AI tool boundary', () => {
  it('edits concrete atom query predicates and bond topology atomically with undo', async () => {
    const editor = create(), before = editor.getSnapshot(), atomId = Object.keys(before.document.graph.atoms)[0], bondId = Object.keys(before.document.graph.bonds)[0];
    const result = await execute(editor, [
      { type: 'update-atom', atomId, changes: { queryConstraints: { substituentsExactly: 0, substituentsUpTo: 3, ringBondCount: 'NoRingBonds', unsaturatedBonds: 'MustBeAbsent', reactionChange: true, reactionStereo: 'Retention' } } },
      { type: 'update-bond', bondId, topology: 'Chain' },
    ]);
    expect(toolResults(result.messages)[0].ok).toBe(true);
    expect(editor.getDocument().graph.atoms[atomId]).toMatchObject({ element: 'C', queryConstraints: { substituentsExactly: 0, reactionChange: true } });
    expect(editor.getDocument().graph.bonds[bondId].topology).toBe('Chain');
    expect(editor.getSnapshot().revision).toBe(before.revision + 1);
    editor.undo(); expect(editor.getDocument()).toEqual(before.document);
  });

  it('creates explicit element-list query nodes using temporary atom references', async () => {
    const editor = create(emptyDocument()), result = await execute(editor, [
      { type: 'add-atom', ref: '$query', element: '*', position: { x: 0, y: 0 }, properties: { query: { kind: 'elements', elements: ['N', 'O'], exclude: true } } },
      { type: 'add-atom', ref: '$carbon', element: 'C', position: { x: 1.5, y: 0 } },
      { type: 'add-bond', atoms: ['$query', '$carbon'], order: 'any', topology: 'RingOrChain' },
    ]);
    expect(toolResults(result.messages)[0].ok).toBe(true);
    expect(Object.values(editor.getDocument().graph.atoms).find(atom => atom.query)?.query).toEqual({ kind: 'elements', elements: ['N', 'O'], exclude: true });
    expect(Object.values(editor.getDocument().graph.bonds)[0]).toMatchObject({ order: 'any', topology: 'RingOrChain' });
  });

  it.each([
    { substituentsExactly: 256 }, { substituentsUpTo: -1 }, { substituentsExactly: 2.5 }, { reactionChange: false },
    { ringBondCount: 'Aromatic' }, { reactionStereo: 'Invert' }, { unsaturatedBonds: 'Maybe' }, { script: 'alert(1)' }, {},
  ])('rejects invalid query constraints before any operation can commit: %j', async queryConstraints => {
    const editor = create(), before = editor.getSnapshot(), atomId = Object.keys(before.document.graph.atoms)[0];
    const result = await execute(editor, [{ type: 'rename', title: 'Must not commit' }, { type: 'update-atom', atomId, changes: { queryConstraints } }]);
    expect(toolResults(result.messages)[0].ok).toBe(false); expect(editor.getSnapshot()).toEqual(before);
  });

  it('clears optional conditions rather than manufacturing a false reaction constraint', async () => {
    const editor = create(), atomId = Object.keys(editor.getDocument().graph.atoms)[0], bondId = Object.keys(editor.getDocument().graph.bonds)[0];
    editor.applyEdits({ operations: [{ type: 'update-atom', atomId, changes: { queryConstraints: { reactionChange: true } } }, { type: 'update-bond', bondId, topology: 'Ring' }] });
    const result = await execute(editor, [{ type: 'update-atom', atomId, changes: { queryConstraints: null } }, { type: 'update-bond', bondId, topology: null }]);
    expect(toolResults(result.messages)[0].ok).toBe(true);
    expect(editor.getDocument().graph.atoms[atomId].queryConstraints).toBeUndefined(); expect(editor.getDocument().graph.bonds[bondId].topology).toBeUndefined();
  });

  it('edits supported atom and bond annotations without claiming a recalculation', async () => {
    const editor = create(), atomId = Object.keys(editor.getDocument().graph.atoms)[0], bondId = Object.keys(editor.getDocument().graph.bonds)[0];
    const result = await execute(editor, [
      { type: 'update-atom', atomId, changes: { sourceNumber: 4, connectionType: 'Peptide', residueId: 9, enhancedStereo: { type: 'And', group: 2 }, spatial: [1, 2, 3] } },
      { type: 'set-bond-annotations', bondId, changes: { reactionParticipation: 'NoChange', sequenceConnectivity: 'Linear', externalNumbers: [1, null] } },
    ]);
    expect(toolResults(result.messages)[0].ok).toBe(true);
    expect(editor.getDocument().graph.atoms[atomId]).toMatchObject({ sourceNumber: 4, residueId: 9, enhancedStereo: { type: 'And', group: 2 }, spatial: [1, 2, 3] });
    expect(editor.getDocument().graph.bonds[bondId]).toMatchObject({ reactionParticipation: 'NoChange', externalNumbers: [1, null] });
  });

  it('preserves internal groups in expanded view and permits undoable graph promotion', async () => {
    const editor = create(importDocument({ data: abbreviationXml }).document), before = editor.getDocument();
    const id = Object.values(before.graph.atoms).find(atom => atom.substructure)!.id;
    const expanded = await execute(editor, [{ type: 'set-substructure-display', atomId: id, expanded: true, recursive: true }]);
    expect(toolResults(expanded.messages)[0].ok).toBe(true);
    expect(editor.getDocument().graph.atoms[id].substructure).toMatchObject({ display: 'expanded', fragments: before.graph.atoms[id].substructure!.fragments });
    editor.undo(); expect(editor.getDocument()).toEqual(before);
    const promoted = await execute(editor, [{ type: 'expand-substructure', atomId: id }]);
    expect(toolResults(promoted.messages)[0].ok).toBe(true); expect(editor.getDocument().graph.atoms[id]).toBeUndefined();
    expect(Object.values(editor.getDocument().graph.atoms).some(atom => atom.element === 'O')).toBe(true);
    editor.undo(); expect(editor.getDocument()).toEqual(before);
  });

  it('keeps protected annotations when group flattening is refused', async () => {
    const doc = importDocument({ data: abbreviationXml }).document, group = Object.values(doc.graph.atoms).find(atom => atom.substructure)!;
    group.charge = 1; const editor = create(doc), before = editor.getSnapshot();
    const result = await execute(editor, [{ type: 'expand-substructure', atomId: group.id }]);
    expect(toolResults(result.messages)[0].ok).toBe(false); expect(editor.getSnapshot()).toEqual(before);
  });

  it('collapses a concrete selection without dropping its chemical graph', async () => {
    const doc = emptyDocument(), carbon = addAtom(doc, 'C', { x: 0, y: 0 }), oxygen = addAtom(doc, 'O', { x: 1.5, y: 0 }); addBond(doc, carbon, oxygen);
    const editor = create(doc), before = editor.getDocument(), result = await execute(editor, [{ type: 'collapse-substructure', atomIds: [oxygen], label: 'OH', ref: '$group' }]);
    expect(toolResults(result.messages)[0].ok).toBe(true);
    const wrapper = Object.values(editor.getDocument().graph.atoms).find(atom => atom.substructure)!;
    expect(wrapper.substructure?.label).toBe('OH'); expect(Object.values(wrapper.substructure!.fragments[0].document.graph.atoms).some(atom => atom.element === 'O')).toBe(true);
    editor.undo(); expect(editor.getDocument()).toEqual(before);
  });

  it('rejects string booleans, arbitrary nested replacement and invalid bond enums', async () => {
    const editor = create(importDocument({ data: abbreviationXml }).document), group = Object.values(editor.getDocument().graph.atoms).find(atom => atom.substructure)!;
    const before = editor.getSnapshot();
    for (const invalid of [
      { type: 'set-substructure-display', atomId: group.id, expanded: 'true' },
      { type: 'expand-substructure', atomId: group.id, recursive: 'false' },
      { type: 'set-substructure', atomId: group.id, substructure: group.substructure },
      { type: 'update-bond', bondId: Object.keys(before.document.graph.bonds)[0], topology: 'Always' },
    ]) expect(toolResults((await execute(editor, [invalid])).messages)[0].ok).toBe(false);
    expect(editor.getSnapshot()).toEqual(before);
  });
});

describe('AI document and reaction edits', () => {
  const raw = '<CDXML><page id="1"><fragment id="2"><n id="3" p="0 0"/><n id="4" p="30 0" Element="8"/><b id="5" B="3" E="4"/></fragment><t id="6" p="30 30"><s font="3" size="10">heat</s></t><arrow id="7" Head3D="100 0 0" Tail3D="60 0 0"/><scheme id="8"><step id="9" ReactionStepReactants="2" ReactionStepArrows="7" ReactionStepObjectsAboveArrow="6"/></scheme></page></CDXML>';

  it('selects an existing document object, edits styled text and keeps reaction references', async () => {
    const editor = create(importDocument({ data: raw }).document), before = editor.getDocument();
    const object = Object.values(before.depiction.objects!).find(object => object.tag === 't')!;
    let round = 0;
    const result = await runAiAssistant(editor, { complete: async () => ++round === 1 ? { text: '', toolCalls: [call('select_atoms', { atomIds: [], objectId: object.id }), call('apply_edits', { expectedRevision: editor.getSnapshot().revision, operations: [{ type: 'update-drawing', objectId: object.id, changes: { runs: [{ ...object.runs![0], text: '80 °C' }] } }] })] } : { text: 'Done', toolCalls: [] } }, { message: 'Edit condition' });
    expect(toolResults(result.messages).map(result => result.ok)).toEqual([true, true]);
    expect(editor.getSelection()).toEqual({ atomIds: [], objectId: object.id });
    expect(editor.getDocument().depiction.objects![object.id].runs![0]).toEqual({ ...object.runs![0], text: '80 °C' });
    expect(editor.getDocument().graph.reactions).toEqual(before.graph.reactions);
    editor.undo(); expect(editor.getDocument()).toEqual(before);
  });

  it('edits reaction roles and existing polymer metadata with domain validation', async () => {
    const editor = create(importDocument({ data: raw }).document), before = editor.getDocument(), step = Object.values(before.graph.reactions!)[0];
    const result = await execute(editor, [{ type: 'update-reaction', stepId: step.id, changes: { products: step.reactants, reactants: [] } }]);
    expect(toolResults(result.messages)[0].ok).toBe(true); expect(editor.getDocument().graph.reactions![step.id].products).toEqual(step.reactants);
    editor.undo(); expect(editor.getDocument()).toEqual(before);
    editor.setDocument(importDocument({ data: polymerXml }).document);
    const group = Object.values(editor.getDocument().depiction.objects!).find(object => object.tag === 'bracketedgroup')!, original = editor.getDocument();
    const polymer = await execute(editor, [{ type: 'update-polymer', objectId: group.id, changes: { usage: 'MultipleGroup', repeatCount: 3.5, label: 'm', componentOrder: 2 } }]);
    expect(toolResults(polymer.messages)[0].ok).toBe(true); expect(getPolymerGroup(editor.getDocument(), group.id)).toMatchObject({ usage: 'MultipleGroup', repeatCount: 3.5, label: 'm', componentOrder: 2 });
    editor.undo(); expect(editor.getDocument()).toEqual(original);
    for (const invalid of [{ repeatCount: 0 }, { componentOrder: 32768 }, { usage: 'Invented' }]) expect(toolResults((await execute(editor, [{ type: 'update-polymer', objectId: group.id, changes: invalid }])).messages)[0].ok).toBe(false);
    expect(editor.getDocument()).toEqual(original);
  });

  it('rejects unknown geometry keys and unsafe dictionary keys before changing text', async () => {
    const editor = create(importDocument({ data: raw }).document), before = editor.getSnapshot(), object = Object.values(before.document.depiction.objects!).find(object => object.tag === 't')!;
    for (const changes of [{ geometry: { Script: [1, 2] } }, { attributes: { ['__proto__']: 'bad' } }, { runs: [{ text: 'Changed', attributes: {}, onclick: 'alert(1)' }] }]) {
      const result = await execute(editor, [{ type: 'update-drawing', objectId: object.id, changes }]);
      expect(toolResults(result.messages)[0].ok).toBe(false); expect(editor.getSnapshot()).toEqual(before);
    }
  });

  it('rejects advanced document operations in readonly mode without changing the selection', async () => {
    const editor = create(importDocument({ data: polymerXml }).document), before = editor.getSnapshot(), group = Object.values(before.document.depiction.objects!).find(object => object.tag === 'bracketedgroup')!;
    const operations: EditOperation[] = [{ type: 'update-polymer', objectId: group.id, changes: { label: 'changed' } }];
    const result = await execute(editor, operations, { allowEdits: false });
    expect(toolResults(result.messages)[0].ok).toBe(false); expect(editor.getSnapshot()).toEqual(before);
  });

  it('reports current advanced capabilities and counts while stripping nested source provenance', () => {
    const doc = importDocument({ data: abbreviationXml }).document, group = Object.values(doc.graph.atoms).find(atom => atom.substructure)!;
    group.substructure!.fragments[0].document.source = { format: 'cdxml', raw: 'PRIVATE_CHILD_SOURCE', fingerprint: '', issues: [] };
    const editor = create(doc), before = editor.getDocument(), context = getAiEditorContext(editor);
    expect(context.summary).toMatchObject({ internalFragmentCount: 1, definedChemicalAtomCount: 3 });
    expect(context.capabilities.editOperations).toEqual(expect.arrayContaining(['update-polymer', 'update-reaction', 'set-substructure-display']));
    expect(context.capabilities.tools).toEqual(AI_TOOLS.map(tool => tool.name));
    expect(JSON.stringify(context)).not.toContain('PRIVATE_CHILD_SOURCE'); expect(JSON.stringify(context)).not.toContain('"source"');
    expect(editor.getDocument()).toEqual(before);
  });
});

describe('AI malformed response boundaries', () => {
  it.each([null, { id: 1, name: 'read_structure', arguments: '{}' }, { id: 'x', name: null, arguments: '{}' }])('rejects an entire malformed tool round before committing any good call', async bad => {
    const editor = create(), before = editor.getSnapshot();
    const complete = vi.fn(async () => ({ text: '', toolCalls: [call('apply_edits', { expectedRevision: before.revision, operations: [{ type: 'rename', title: 'Never commit' }] }), bad] } as unknown as AiTurn));
    await expect(runAiAssistant(editor, { complete }, { message: 'Edit' })).rejects.toThrow('本轮工具均未执行'); expect(editor.getSnapshot()).toEqual(before);
  });

  it('rejects duplicate tool IDs and overlong histories without partial writes', async () => {
    const editor = create(), before = editor.getSnapshot();
    await expect(runAiAssistant(editor, { complete: async () => ({ text: '', toolCalls: [call('apply_edits', { expectedRevision: before.revision, operations: [{ type: 'rename', title: 'Never' }] }, 'same'), call('read_structure', {}, 'same')] }) }, { message: 'Edit' })).rejects.toThrow('ID 重复');
    expect(editor.getSnapshot()).toEqual(before);
    const complete = vi.fn(async () => ({ text: '', toolCalls: [] }));
    await expect(runAiAssistant(editor, { complete }, { message: 'Edit', history: Array.from({ length: 159 }, () => ({ role: 'user' as const, content: 'old' })) })).rejects.toThrow('160 条消息');
    expect(complete).not.toHaveBeenCalled(); expect(editor.getSnapshot()).toEqual(before);
  });
});
