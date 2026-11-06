import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAiAssistant } from '../src/ai/assistant';
import type { AiEditProposal } from '../src/ai/proposal';
import type { AiCompletionRequest, AiMessage, AiTurn } from '../src/ai/types';
import { fingerprint } from '../src/core/model';
import { exampleDocument } from '../src/core/templates';
import { createChemicalEditor, type ChemicalEditorElement } from '../src/editor/chemical-editor';

const editors: ChemicalEditorElement[] = [];
function create() {
  const editor = createChemicalEditor({ container: document.body, document: exampleDocument('ethanol') });
  editors.push(editor); return editor;
}
const call = (name: string, args: unknown = {}, id = name) => ({ id, name, arguments: JSON.stringify(args) });
const turn = (...toolCalls: AiTurn['toolCalls']): AiTurn => ({ text: '', toolCalls });
const tools = (messages: AiMessage[]) => messages.filter(message => message.role === 'tool').map(message => ({ id: message.toolCallId, ...JSON.parse(message.content) }));
function scripted(...turns: (AiTurn | ((request: AiCompletionRequest) => AiTurn))[]) {
  const complete = vi.fn(async (request: AiCompletionRequest): Promise<AiTurn> => {
    const response = turns.shift(); if (!response) throw new Error('Unexpected extra model request');
    return typeof response === 'function' ? response(request) : response;
  });
  return { complete };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const done: AiTurn = { text: '实际工具已执行。', toolCalls: [] };
afterEach(() => { editors.splice(0).forEach(editor => editor.destroy()); document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('AI optional edit review', () => {
  it('keeps direct editing as the default without requiring a review callback', async () => {
    const editor = create(), before = editor.getSnapshot();
    const transport = scripted(turn(call('apply_edits', { expectedRevision: before.revision, operations: [{ type: 'rename', title: 'Direct edit' }] })), request => {
      expect(editor.getDocument().title).toBe('Direct edit');
      expect(tools(request.messages)[0].ok).toBe(true); return done;
    });
    const result = await runAiAssistant(editor, transport, { message: '重命名为 Direct edit' });
    expect(result.rejected).not.toBe(true); expect(editor.getSnapshot().revision).toBe(before.revision + 1);
  });

  it('waits without modifying the editor, commits an accepted batch atomically and supports one-step undo', async () => {
    const editor = create(), before = editor.getSnapshot(), atomId = Object.values(before.document.graph.atoms).find(atom => atom.element === 'O')!.id;
    const reviewed = deferred<AiEditProposal>(), decision = deferred<boolean>();
    const transport = scripted(turn(call('apply_edits', { expectedRevision: before.revision, operations: [
      { type: 'update-atom', atomId, changes: { isotope: 18 } }, { type: 'rename', title: 'Reviewed ethanol' },
    ] })), done);
    const run = runAiAssistant(editor, transport, { message: '标记氧-18并重命名', reviewEdits: proposal => { reviewed.resolve(proposal); return decision.promise; } });
    const proposal = await reviewed.promise;
    expect(proposal.expectedRevision).toBe(before.revision); expect(proposal.tool).toBe('apply_edits');
    expect(proposal.after.graph.atoms[atomId].isotope).toBe(18); expect(proposal.after.title).toBe('Reviewed ethanol');
    expect(editor.getSnapshot()).toEqual(before); expect(transport.complete).toHaveBeenCalledTimes(1);
    decision.resolve(true); const result = await run;
    expect(result.rejected).not.toBe(true); expect(editor.getSnapshot().revision).toBe(before.revision + 1);
    expect(editor.getDocument().graph.atoms[atomId].isotope).toBe(18);
    editor.undo(); expect(editor.getDocument()).toEqual(before.document);
  });

  it('balances every tool result after rejection and does not execute any later mutation in that turn', async () => {
    const editor = create(), before = editor.getSnapshot(), atomId = Object.keys(before.document.graph.atoms)[0];
    const fit = vi.spyOn(editor, 'fit'), select = vi.spyOn(editor, 'setSelection'), review = vi.fn(async () => false);
    const transport = scripted(turn(
      call('apply_edits', { expectedRevision: before.revision, operations: [{ type: 'rename', title: 'Rejected' }] }, 'first'),
      call('select_atoms', { atomIds: [atomId] }, 'select'), call('fit_canvas', {}, 'fit'),
      call('load_template', { name: 'benzene', expectedRevision: before.revision }, 'replace'), call('read_structure', {}, 'read'),
    ));
    const result = await runAiAssistant(editor, transport, { message: '编辑并选择后缩放', reviewEdits: review });
    expect(result).toMatchObject({ rejected: true, completed: true, toolCount: 5 });
    const responses = tools(result.messages);
    expect(responses.map(response => response.id)).toEqual(['first', 'select', 'fit', 'replace', 'read']);
    expect(responses.slice(0, 4).every(response => !response.ok && response.error.code === 'AI_EDIT_REJECTED')).toBe(true);
    expect(responses[4].ok).toBe(true); expect(review).toHaveBeenCalledTimes(1); expect(transport.complete).toHaveBeenCalledTimes(1);
    expect(fit).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled(); expect(editor.getSnapshot()).toEqual(before);
  });

  it('checks the version again after review so manual edits cannot be overwritten', async () => {
    const editor = create(), before = editor.getSnapshot();
    const transport = scripted(turn(call('apply_edits', { expectedRevision: before.revision, operations: [{ type: 'rename', title: 'Old AI version' }] })), request => {
      expect(tools(request.messages)[0]).toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT', expectedRevision: before.revision, actualRevision: before.revision + 1 } });
      return { text: '文档已更新，未覆盖手动修改。', toolCalls: [] };
    });
    await runAiAssistant(editor, transport, { message: '改名', reviewEdits: async () => { editor.applyEdits({ operations: [{ type: 'rename', title: 'Manual edit' }] }); return true; } });
    expect(editor.getDocument().title).toBe('Manual edit'); expect(editor.getSnapshot().revision).toBe(before.revision + 1);
  });

  it('cancels a pending reviewer even when the callback ignores abort and never resolves', async () => {
    const editor = create(), before = editor.getSnapshot(), controller = new AbortController(), opened = deferred<void>();
    const apply = vi.spyOn(editor, 'applyEdits');
    const transport = scripted(turn(call('apply_edits', { expectedRevision: before.revision, operations: [{ type: 'rename', title: 'Never committed' }] })));
    const run = runAiAssistant(editor, transport, { message: '改名', signal: controller.signal, reviewEdits: (_proposal, signal) => {
      expect(signal).toBe(controller.signal); opened.resolve(); return new Promise<boolean>(() => {});
    } });
    const stopped = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    await opened.promise; controller.abort(); await stopped;
    expect(apply).not.toHaveBeenCalled(); expect(editor.getSnapshot()).toEqual(before);
  });

  it('never opens review in read-only mode and refuses all editing requests', async () => {
    const editor = create(), before = editor.getSnapshot(), review = vi.fn(async () => true);
    const data = JSON.stringify(exampleDocument('benzene'));
    const transport = scripted(turn(
      call('apply_edits', { expectedRevision: before.revision, operations: [{ type: 'rename', title: 'No write' }] }),
      call('load_template', { expectedRevision: before.revision, name: 'benzene' }),
      call('import_structure', { expectedRevision: before.revision, data, format: 'json' }),
    ), done);
    const result = await runAiAssistant(editor, transport, { message: '只读检查', allowEdits: false, reviewEdits: review });
    expect(tools(result.messages).every(response => !response.ok)).toBe(true); expect(review).not.toHaveBeenCalled();
    expect(editor.getSnapshot()).toEqual(before);
  });

  it('provides source-free import review but commits the actual original source for preservation', async () => {
    const editor = create(), document = editor.getDocument();
    document.source = { format: 'mrv', raw: 'OLD_RAW_SECRET', fingerprint: fingerprint(document), issues: [] }; editor.setDocument(document);
    const before = editor.getSnapshot();
    const data = '<CDXML><!-- IMPORT_RAW_SECRET --><page id="1"><fragment id="2"><n id="3" Element="8" p="0 0" NumHydrogens="2"/></fragment></page></CDXML>';
    let proposalId = '';
    const review = vi.fn(async (proposal: AiEditProposal) => {
      proposalId = proposal.id;
      expect(proposal.tool).toBe('import_structure'); expect(proposal.before.source).toBeUndefined(); expect(proposal.after.source).toBeUndefined();
      expect(JSON.stringify(proposal)).not.toContain('OLD_RAW_SECRET'); expect(JSON.stringify(proposal)).not.toContain('IMPORT_RAW_SECRET');
      return true;
    });
    const transport = scripted(turn(call('import_structure', { expectedRevision: before.revision, data, format: 'cdxml' })), done);
    const result = await runAiAssistant(editor, transport, { message: '导入用户提供的 CDXML', reviewEdits: review });
    expect(review).toHaveBeenCalledTimes(1); expect(editor.getDocument().source?.raw).toBe(data);
    expect(editor.export({ format: 'cdxml' })).toMatchObject({ data, passthrough: true });
    expect(JSON.stringify(result.messages)).not.toContain(proposalId); expect(JSON.stringify(result.messages)).not.toContain('OLD_RAW_SECRET');
    editor.undo(); expect(editor.getDocument()).toEqual(before.document);
  });

  it('reviews full template replacement while retaining atomic undo', async () => {
    const editor = create(), before = editor.getSnapshot();
    const review = vi.fn(async (proposal: AiEditProposal) => {
      expect(proposal.tool).toBe('load_template'); expect(proposal.after.title).toBe(exampleDocument('benzene').title);
      expect(Object.keys(proposal.after.graph.atoms)).toHaveLength(6); expect(editor.getSnapshot()).toEqual(before); return true;
    });
    const transport = scripted(turn(call('load_template', { expectedRevision: before.revision, name: 'benzene' })), done);
    await runAiAssistant(editor, transport, { message: '打开苯模板', reviewEdits: review });
    expect(review).toHaveBeenCalledTimes(1); expect(Object.keys(editor.getDocument().graph.atoms)).toHaveLength(6);
    expect(editor.getSnapshot().revision).toBe(before.revision + 1); editor.undo(); expect(editor.getDocument()).toEqual(before.document);
  });

  it('does not let a callback mutate the displayed proposal into a different actual edit', async () => {
    const editor = create(), before = editor.getSnapshot(), atomId = Object.values(before.document.graph.atoms).find(atom => atom.element === 'O')!.id;
    const transport = scripted(turn(call('apply_edits', { expectedRevision: before.revision, operations: [{ type: 'update-atom', atomId, changes: { isotope: 18 } }] })), done);
    await runAiAssistant(editor, transport, { message: '将氧标为氧-18', reviewEdits: async proposal => {
      proposal.expectedRevision = -1; proposal.after.graph.atoms[atomId].isotope = 99; proposal.before.graph.atoms[atomId].element = 'N';
      proposal.changes.splice(0); return true;
    } });
    expect(editor.getDocument().graph.atoms[atomId]).toMatchObject({ element: 'O', isotope: 18 });
    expect(editor.getSnapshot().revision).toBe(before.revision + 1);
  });
  it('requires an explicit boolean true from JavaScript reviewers', async () => {
    const editor=create(), before=editor.getSnapshot();
    const transport=scripted(turn(call('apply_edits',{expectedRevision:before.revision,operations:[{type:'rename',title:'Must not apply'}]})));
    const result=await runAiAssistant(editor,transport,{message:'Rename',reviewEdits:async()=> 'false' as unknown as boolean});
    expect(result.rejected).toBe(true);expect(editor.getSnapshot()).toEqual(before);
  });

});
