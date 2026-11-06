import { describe, expect, it } from 'vitest';
import { createAiEditProposal } from '../src/ai/proposal';
import { addAtom, emptyDocument, fingerprint } from '../src/core/model';
import { exampleDocument } from '../src/core/templates';
import type { ChemicalDocument } from '../src/core/types';
import type { EditorSnapshot } from '../src/editor/api-types';
import { importDocument } from '../src/formats';
import { abbreviationXml } from './fixtures/abbreviation-fixture';

const snapshot = (document: ChemicalDocument, revision = 17): EditorSnapshot => ({ apiVersion: 1, revision, document, selection: { atomIds: [] }, canUndo: true, canRedo: false });
const source = (document: ChemicalDocument, raw: string) => ({ format: 'json' as const, raw, fingerprint: fingerprint(document), issues: [] });
const reactionXml = '<CDXML><page id="1"><fragment id="2"><n id="3" p="0 0"/><n id="4" p="30 0" Element="8"/><b id="5" B="3" E="4"/><t id="6" p="0 30"><s>heat</s></t></fragment><fragment id="7"><n id="8" p="120 0" Element="7"/></fragment><arrow id="9" Head3D="100 0 0" Tail3D="60 0 0" ArrowheadHead="Full"/><scheme id="10"><step id="11" ReactionStepReactants="2" ReactionStepProducts="7" ReactionStepArrows="9" ReactionStepObjectsAboveArrow="6"/></scheme></page></CDXML>';

describe('source-free AI edit proposals', () => {
  it('previews a complete batch by stable IDs without changing the snapshot or committing anything', () => {
    const doc = exampleDocument('ethanol'), before = snapshot(doc), original = structuredClone(before);
    const [carbon, , oxygen] = Object.values(doc.graph.atoms), firstBond = Object.values(doc.graph.bonds)[0];
    const proposal = createAiEditProposal(before, { tool: 'apply_edits', operations: [
      { type: 'update-atom', atomId: carbon.id, changes: { element: 'N', charge: 1, isotope: 15, atomMap: 7, queryConstraints: { substituentsExactly: 2 } } },
      { type: 'set-position', atomId: carbon.id, position: { x: 2, y: 3 } },
      { type: 'update-bond', bondId: firstBond.id, order: 2, topology: 'Chain', depiction: { style: 'plain', from: firstBond.atoms[0], doublePosition: 'left' } },
      { type: 'remove-atom', atomId: oxygen.id },
      { type: 'add-atom', element: 'Br', position: { x: 5, y: 0 } },
    ] });
    expect(before).toEqual(original);
    expect(proposal.id).toMatch(/^ai-proposal-/); expect(proposal.expectedRevision).toBe(17);
    expect(proposal.hasChanges).toBe(true); expect(proposal.truncated).toBe(false);
    expect(proposal.totals.atoms).toMatchObject({ before: 3, after: 3, added: 1, removed: 1, updated: 1 });
    expect(proposal.totals.bonds).toMatchObject({ before: 2, after: 1, added: 0, removed: 1, updated: 1 });
    const atom = proposal.changes.find(change => change.kind === 'atom' && change.id === carbon.id)!;
    expect(atom.fields).toEqual(expect.arrayContaining(['element', 'charge', 'isotope', 'atomMap', 'queryConstraints', 'position']));
    expect(atom.details).toContain('元素：C → N'); expect(atom.details).toContain('同位素：未指定 → 15');
    const point = doc.depiction.positions[carbon.id];
    expect(atom.details).toContain(`二维位置：(${point.x}, ${point.y}) → (2, 3)`);
    const bond = proposal.changes.find(change => change.kind === 'bond' && change.id === firstBond.id)!;
    expect(bond.fields).toEqual(expect.arrayContaining(['order', 'topology', 'depiction']));
    expect(proposal.after.graph.atoms[carbon.id].isotope).toBe(15);
  });

  it('recursively strips original files and source locators while preserving the caller documents', () => {
    const doc = importDocument({ data: abbreviationXml }).document;
    const group = Object.values(doc.graph.atoms).find(atom => atom.substructure)!;
    const child = group.substructure!.fragments[0].document;
    doc.source = source(doc, 'ROOT_FILE_SECRET'); child.source = source(child, 'NESTED_FILE_SECRET');
    const original = structuredClone(doc);
    const proposal = createAiEditProposal(snapshot(doc), { tool: 'apply_edits', operations: [{ type: 'rename', title: 'Reviewed' }] });
    expect(JSON.stringify(proposal)).not.toContain('ROOT_FILE_SECRET'); expect(JSON.stringify(proposal)).not.toContain('NESTED_FILE_SECRET');
    expect(proposal.before.source).toBeUndefined(); expect(proposal.after.source).toBeUndefined();
    expect(proposal.before.graph.atoms[group.id].substructure!.fragments[0].document.source).toBeUndefined();
    expect(Object.values(proposal.before.depiction.objects ?? {}).every(object => !object.source)).toBe(true);
    expect(doc).toEqual(original);
  });

  it('aggregates internal fragment edits on their wrapper instead of pretending they are flattened atoms', () => {
    const doc = importDocument({ data: abbreviationXml }).document, group = Object.values(doc.graph.atoms).find(atom => atom.substructure)!;
    const changed = structuredClone(group.substructure!), inner = Object.values(changed.fragments[0].document.graph.atoms).find(atom => atom.element === 'O')!;
    inner.isotope = 18;
    const proposal = createAiEditProposal(snapshot(doc), { tool: 'apply_edits', operations: [{ type: 'set-substructure', atomId: group.id, substructure: changed }] });
    expect(proposal.totals.atoms).toMatchObject({ before: 2, after: 2, added: 0, removed: 0, updated: 1 });
    expect(proposal.changes.filter(change => change.kind === 'atom')).toHaveLength(1);
    expect(proposal.changes[0].id).toBe(group.id); expect(proposal.changes[0].fields).toContain('substructure');
    expect(proposal.changes[0].details).toContain('内部结构或连接映射已修改；数量仍按主画布节点统计。');
    expect(proposal.notes.join(' ')).toContain('缩写');
  });

  it('shows collapse as a representation change with honest main-canvas counts', () => {
    const doc = exampleDocument('ethanol'), ids = Object.keys(doc.graph.atoms).slice(0, 2);
    const proposal = createAiEditProposal(snapshot(doc), { tool: 'apply_edits', operations: [{ type: 'collapse-substructure', atomIds: ids, label: 'Et' }] });
    expect(proposal.totals.atoms).toMatchObject({ label: '主画布化学节点', before: 3, after: 2, added: 1, removed: 2 });
    const wrapper = Object.values(proposal.after.graph.atoms).find(atom => atom.substructure)!;
    expect(Object.keys(wrapper.substructure!.fragments[0].document.graph.atoms).length).toBeGreaterThan(2);
    expect(proposal.changes.some(change => change.action === 'add' && change.label === '缩写节点 · Et')).toBe(true);
    expect(proposal.notes.join(' ')).toContain('不会冒充已展开的普通原子');
  });

  it('summarizes text, drawing coordinates and reaction-role edits without leaking source records', () => {
    const doc = importDocument({ data: reactionXml }).document;
    const text = Object.values(doc.depiction.objects!).find(object => object.tag === 't')!, arrow = Object.values(doc.depiction.objects!).find(object => object.tag === 'arrow')!;
    const reaction = Object.values(doc.graph.reactions!)[0];
    const proposal = createAiEditProposal(snapshot(doc), { tool: 'apply_edits', operations: [
      { type: 'update-drawing', objectId: text.id, changes: { runs: [{ text: '80 °C', attributes: {} }] } },
      { type: 'move-drawing', objectId: arrow.id, delta: { x: 1, y: 2 } },
      { type: 'update-reaction', stepId: reaction.id, changes: { above: [] } },
    ] });
    expect(proposal.totals.drawings.updated).toBe(2); expect(proposal.totals.reactions.updated).toBe(1);
    expect(proposal.changes.find(change => change.id === text.id)?.details).toContain('文字：heat → 80 °C');
    expect(proposal.changes.find(change => change.id === reaction.id)?.details).toContain('箭头上方条件：1 项 → 0 项');
    expect(proposal.changes.find(change => change.id === arrow.id)?.fields).toContain('geometry');
    expect(Object.values(proposal.after.graph.reactions!).every(step => !step.source)).toBe(true);
  });

  it('bounds displayed changes while retaining every actual change in the complete preview document', () => {
    const doc = emptyDocument();
    const ids = Array.from({ length: 57 }, (_, i) => addAtom(doc, 'C', { x: i * 1.5, y: 0 }));
    const proposal = createAiEditProposal(snapshot(doc), { tool: 'apply_edits', operations: ids.map(atomId => ({ type: 'update-atom', atomId, changes: { isotope: 13 } })) });
    expect(proposal.changes).toHaveLength(50); expect(proposal.totalChanges).toBe(57); expect(proposal.truncated).toBe(true);
    expect(proposal.totals.atoms.updated).toBe(57); expect(Object.values(proposal.after.graph.atoms).every(atom => atom.isotope === 13)).toBe(true);
    expect(Object.values(doc.graph.atoms).every(atom => atom.isotope === undefined)).toBe(true);
    expect(proposal.notes.join(' ')).toContain('实际修改未被截断');
  });

  it('validates replacement previews, keeps labels plain text, and escapes chemical SVG output', () => {
    const before = snapshot(emptyDocument()), imported = emptyDocument('<script>alert(1)</script>');
    const label = '\"><script>alert(2)</script>';
    addAtom(imported, '*', { x: 0, y: 0 }, { query: { kind: 'generic', label } });
    imported.source = source(imported, 'IMPORT_FILE_SECRET');
    const proposal = createAiEditProposal(before, { tool: 'import_structure', document: imported, summary: '用户提供的导入预览' });
    expect(proposal.tool).toBe('import_structure'); expect(proposal.summary).toBe('用户提供的导入预览');
    expect(proposal.changes.some(change => change.label.includes(label))).toBe(true);
    expect(proposal.svg.after).not.toContain('<script>'); expect(proposal.svg.after).toContain('&lt;script&gt;');
    expect(JSON.stringify(proposal)).not.toContain('IMPORT_FILE_SECRET');
    imported.title = 'Changed after preview'; expect(proposal.after.title).not.toBe(imported.title);
    expect(before.document.title).not.toContain('script');
  });

  it('ignores source-only and key-order differences but detects document title and drawing style changes', () => {
    const doc = exampleDocument('ethanol'), reordered = structuredClone(doc);
    const atom = Object.values(reordered.graph.atoms)[0]; reordered.graph.atoms[atom.id] = { hydrogens: atom.hydrogens, charge: atom.charge, element: atom.element, id: atom.id };
    reordered.source = source(reordered, 'ONLY_SOURCE_CHANGED');
    const unchanged = createAiEditProposal(snapshot(doc), { tool: 'load_template', document: reordered });
    expect(unchanged.hasChanges).toBe(false); expect(unchanged.totalChanges).toBe(0);
    reordered.title = 'New title'; reordered.depiction.style = { attributes: { LineWidth: '2' }, colors: [], fonts: [] };
    const changed = createAiEditProposal(snapshot(doc), { tool: 'load_template', document: reordered });
    expect(changed.changes.filter(change => change.kind === 'document')).toHaveLength(1);
    expect(changed.changes.at(-1)?.fields).toEqual(['title', 'style']); expect(changed.hasChanges).toBe(true);
  });

  it('rejects invalid, ambiguous or oversized requests before exposing a partial preview', () => {
    const doc = exampleDocument('ethanol'), before = snapshot(doc), original = structuredClone(before);
    expect(() => createAiEditProposal(before, { tool: 'apply_edits', operations: [] })).toThrow('需要一批操作');
    expect(() => createAiEditProposal(before, { tool: 'apply_edits', operations: [{ type: 'rename', title: 'x' }], document: doc })).toThrow('不能同时提供');
    expect(() => createAiEditProposal(before, { tool: 'load_template', document: doc, operations: [] })).toThrow('不能包含局部操作');
    const invalid = structuredClone(doc); invalid.depiction.positions[Object.keys(invalid.graph.atoms)[0]].x = NaN;
    expect(() => createAiEditProposal(before, { tool: 'import_structure', document: invalid })).toThrow();
    const large = emptyDocument(); for (let i = 0; i < 2001; i++) addAtom(large, 'C', { x: i, y: 0 });
    expect(() => createAiEditProposal(before, { tool: 'load_template', document: large })).toThrow('对象限额');
    expect(before).toEqual(original);
  });
});
