import { describe, expect, it } from 'vitest';
import { englishMessages, translateEnglish } from '../src/editor/i18n-en';
import { advancedFeatures } from '../src/editor/advanced-features';
import { advancedEditorSections } from '../src/editor/advanced-inspector';

const hasChinese = /[\u3400-\u9fff]/u;

describe('English editor message coverage and substitution boundaries', () => {
  it('translates every advanced search result, including its compound category caption', () => {
    for (const feature of advancedFeatures) {
      const section = advancedEditorSections.find(section => section.id === feature.section)!;
      expect(translateEnglish(feature.title), feature.id).not.toMatch(hasChinese);
      const caption = `高级编辑 · ${section.label} · ${feature.description}`;
      expect(translateEnglish(caption), feature.id).not.toMatch(hasChinese);
    }
  });

  it('translates selected-object badges without changing the object counts', () => {
    expect(translateEnglish('高级属性，当前选区 12 个对象含高级属性或化学注释'))
      .toBe('Advanced properties, 12 selected objects have advanced properties or chemical annotations');
    expect(translateEnglish('查询条件，当前选区 4 个对象含查询条件'))
      .toBe('Query conditions, 4 selected objects have query conditions');
    expect(translateEnglish('文档与反应，当前文档含 6 个图文对象、2 个反应步骤'))
      .toBe('Documents and reactions, document: 6 drawing objects, 2 reaction steps');
  });

  it('keeps user labels, filenames and formulas verbatim inside known UI templates', () => {
    const userLabel = '导出 · 我的缩写';
    expect(translateEnglish(`缩写片段 · ${userLabel}`)).toBe(`Abbreviation · ${userLabel}`);
    expect(translateEnglish(`查询原子 · ${userLabel}`)).toBe(`Query atom · ${userLabel}`);
    expect(translateEnglish(`编辑 ${userLabel}`)).toBe(`Edit ${userLabel}`);
    expect(translateEnglish('下载 导出·原子编号.cdx')).toBe('Download 导出·原子编号.cdx');
    expect(translateEnglish('C6H6 · 6 个画布节点 · 6 个已定义化学原子 · 2 项基础诊断'))
      .toBe('C6H6 · 6 canvas nodes · 6 defined chemical atoms · 2 basic diagnostics');
  });

  it('does not reinterpret an unknown user label as a drawing-tool name', () => {
    for (const label of ['我的定制工具', '更多编辑器工具', '新型高级编辑烷基', 'Unknown mixed 中文 name']) {
      expect(translateEnglish(label)).toBe(label);
    }
    expect(translateEnglish('更多编辑工具')).toBe('More editing tools');
    expect(translateEnglish('单键工具')).toBe('Single bond tool');
  });

  it('translates the complete structure-review scope with all known incomplete-graph reasons', () => {
    const scope = '基础结构摘要；包含已定义缩写的内部原子，分子式采用有限价态规则，不包含完整化学合理性或立体化学校验。 当前含查询结构、原子查询约束、未定义内部图的名称，电荷和同位素仅统计已定义部分。';
    const result = translateEnglish(scope);
    expect(result).not.toMatch(hasChinese);
    expect(result).toContain('query structures, atom query constraints, names without defined internal graphs');
    expect(result).toContain('limited valence rules');
    // A previously rendered English prefix can be left in a node by third-party UI code.
    expect(translateEnglish(scope.replace('基础结构摘要', 'Basic structure summary'))).toBe(result);
  });

  it('covers export-format hints and the complete empty compatibility report', () => {
    expect(translateEnglish('原生文档 · 保存稳定 ID、结构与布局')).toBe('Native document · preserve stable IDs, structure and layout');
    expect(translateEnglish('当前基础结构检查未发现问题。完整 CIP 计算、通用聚合物和专用 BioDraw 精确绘制尚未实现。')).not.toMatch(hasChinese);
  });

  it('covers full command descriptions instead of leaving untranslated tooltip clauses', () => {
    for (const description of [
      '返回原子、键、片段、形式电荷、同位素、基础分子式及现有诊断；不执行完整化学合理性校验。',
      '将选中原子的形式电荷设为 0，整批可一步撤销；不推断质子化状态，也不增加或删除氢。',
    ]) {
      expect(englishMessages[description]).toBeTruthy();
      expect(translateEnglish(description)).not.toMatch(hasChinese);
    }
  });
});
