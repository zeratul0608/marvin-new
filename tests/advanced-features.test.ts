import { describe, expect, it } from 'vitest';
import { advancedFeatures, advancedSelectionSummary } from '../src/editor/advanced-features';
import { addAtom, addBond, emptyDocument } from '../src/core/model';
import type { DrawingObject } from '../src/core/types';

const drawing = (id: string, tag: DrawingObject['tag'], text?: string): DrawingObject => ({
  id, tag, attributes: {}, geometry: {}, references: {}, children: [], atomIds: [],
  ...(text === undefined ? {} : { runs: [{ text, attributes: {} }] }),
});

describe('advanced feature discovery', () => {
  it('routes existing chemical controls into all advanced categories without executing edits', () => {
    expect(new Set(advancedFeatures.map(feature => feature.id)).size).toBe(advancedFeatures.length);
    expect(new Set(advancedFeatures.map(feature => feature.section))).toEqual(new Set(['properties', 'queries', 'fragments', 'document', 'extensions']));
    const selectors = new Map(advancedFeatures.map(feature => [feature.id, 'selector' in feature ? feature.selector : undefined]));
    expect(selectors.get('atom-map')).toBe('[data-property="atomMap"]');
    expect(selectors.get('query-substituents')).toBe('[data-query-constraint="substituentsExactly"]');
    expect(selectors.get('fragment-collapse')).toBe('[data-collapse-label]');
    expect(advancedFeatures.every(feature => feature.title && feature.description && feature.keywords.includes('高级'))).toBe(true);
  });

  it('keeps ordinary atom properties out of advanced indicators and excludes unselected advanced atoms', () => {
    const doc = emptyDocument();
    const plain = addAtom(doc, 'C', { x: 0, y: 0 }, { charge: 1, isotope: 13, hydrogens: { mode: 'fixed', count: 2 } });
    addAtom(doc, 'N', { x: 2, y: 0 }, { atomMap: 3, queryConstraints: { substituentsExactly: 0 } });
    const before = JSON.stringify(doc);
    expect(advancedSelectionSummary(doc, { atomIds: [plain] })).toEqual({ label: '原子 · C', sections: {} });
    expect(advancedSelectionSummary(doc, { atomIds: [] })).toEqual({ label: '未选择对象', sections: {} });
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('counts each query-bearing node once and preserves a concrete element and explicit zero query', () => {
    const doc = emptyDocument();
    const concrete = addAtom(doc, 'C', { x: 0, y: 0 }, { queryConstraints: { substituentsExactly: 0, reactionStereo: 'Unspecified' } });
    const query = addAtom(doc, '*', { x: 2, y: 0 }, { query: { kind: 'elements', elements: ['N', 'O'], exclude: true }, queryConstraints: { ringBondCount: 'SimpleRing' } });
    expect(advancedSelectionSummary(doc, { atomIds: [concrete] })).toMatchObject({ label: '原子 · C', sections: { queries: { count: 1 } } });
    expect(advancedSelectionSummary(doc, { atomIds: [query] })).toMatchObject({ label: '查询原子 · NOT [N,O]', sections: { queries: { count: 1 } } });
    expect(advancedSelectionSummary(doc, { atomIds: [query, concrete, query] })).toMatchObject({ label: '已选择 2 个化学节点', sections: { queries: { count: 2 } } });
  });

  it('counts advanced properties per selected object rather than field and keeps bond queries separate', () => {
    const doc = emptyDocument();
    const a = addAtom(doc, 'C', { x: 0, y: 0 }, { atomMap: 1, sourceNumber: 2, spatial: [0, 0, 0], radical: 2 });
    const b = addAtom(doc, 'O', { x: 2, y: 0 });
    const bond = addBond(doc, a, b, 2);
    doc.graph.bonds[bond].topology = 'Unspecified';
    doc.graph.bonds[bond].cipLabel = 'E';
    expect(advancedSelectionSummary(doc, { atomIds: [a] }).sections).toMatchObject({ properties: { count: 1 } });
    expect(advancedSelectionSummary(doc, { atomIds: [], bondId: bond })).toMatchObject({ label: '双键 · C—O', sections: { properties: { count: 1 }, queries: { count: 1 } } });
    delete doc.graph.bonds[bond].cipLabel;
    delete doc.graph.bonds[bond].topology;
    expect(advancedSelectionSummary(doc, { atomIds: [], bondId: bond }).sections).toEqual({});
    doc.graph.bonds[bond].order = 'any';
    expect(advancedSelectionSummary(doc, { atomIds: [], bondId: bond })).toMatchObject({ label: '任意查询键 · C—O', sections: { queries: { count: 1 } } });
  });

  it('labels fragments, alternatives, named nodes and multicenter nodes by their real type', () => {
    const doc = emptyDocument();
    const target = addAtom(doc, 'C', { x: 0, y: 0 });
    const group = addAtom(doc, '*', { x: 2, y: 0 }, { substructure: { kind: 'abbreviation', label: '<OMe>', fragments: [{ document: emptyDocument(), attachmentOrder: [] }], connections: [] } });
    const named = addAtom(doc, '*', { x: 4, y: 0 }, { namedFragment: { type: 'Nickname', label: 'Custom' } });
    const multi = addAtom(doc, '*', { x: 6, y: 0 }, { multiAttachment: [target] });
    const port = addAtom(doc, '*', { x: 8, y: 0 }, { attachment: 'external', attachmentIndex: 2, hydrogens: { mode: 'fixed', count: 0 } });
    expect(advancedSelectionSummary(doc, { atomIds: [group] })).toMatchObject({ label: '缩写片段 · <OMe>', sections: { fragments: { count: 1 } } });
    doc.graph.atoms[group].substructure!.kind = 'alternatives';
    expect(advancedSelectionSummary(doc, { atomIds: [group] }).label).toBe('备选片段 · <OMe>');
    expect(advancedSelectionSummary(doc, { atomIds: [named] }).label).toBe('未展开片段 · Custom');
    expect(advancedSelectionSummary(doc, { atomIds: [multi] }).label).toBe('多中心连接 · 1 个目标');
    expect(advancedSelectionSummary(doc, { atomIds: [port] })).toMatchObject({ label: '外部连接点 · 2', sections: { properties: { count: 1 } } });
    expect(advancedSelectionSummary(doc, { atomIds: [target, group, named, multi] }).sections.fragments?.count).toBe(3);
  });

  it('reports document objects and reaction steps across the document while keeping page navigation basic', () => {
    const doc = emptyDocument();
    doc.depiction.objects = { page: drawing('page', 'page') };
    expect(advancedSelectionSummary(doc, { atomIds: [] }).sections.document).toBeUndefined();
    doc.depiction.objects.text = drawing('text', 't', 'NaOH <test>');
    doc.depiction.objects.bracket = drawing('bracket', 'bracketedgroup');
    doc.graph.reactions = { step: { id: 'step', schemeId: 'scheme', reactants: [], products: [], arrows: [], above: [], below: [], pluses: [] } };
    expect(advancedSelectionSummary(doc, { atomIds: [], objectId: 'text' })).toEqual({ label: '文字 · NaOH <test>', sections: { document: { count: 3, description: '当前文档含 2 个图文对象、1 个反应步骤' } } });
    expect(advancedSelectionSummary(doc, { atomIds: [], objectId: 'bracket' }).label).toBe('聚合物／重复单元');
    expect(advancedSelectionSummary(doc, { atomIds: [] }).sections.extensions).toBeUndefined();
  });

  it('tolerates stale selection references after deletion and does not invent an atom label', () => {
    const doc = emptyDocument();
    expect(advancedSelectionSummary(doc, { atomIds: ['deleted'] })).toEqual({ label: '未选择对象', sections: {} });
    expect(advancedSelectionSummary(doc, { atomIds: [], bondId: 'deleted' })).toEqual({ label: '未选择对象', sections: {} });
    expect(advancedSelectionSummary(doc, { atomIds: [], objectId: 'deleted' })).toEqual({ label: '未选择对象', sections: {} });
  });
});
