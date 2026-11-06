import { describe, expect, it } from 'vitest';
import { AI_TOOLS, validateAiArguments } from '../src/ai/tool-schemas';
import { getAiEditorContext } from '../src/ai/context';
import { AI_PROMPT_PRESETS, BUILTIN_AI_PROMPT } from '../src/ai/prompts';
import { exampleDocument } from '../src/core/templates';
import type { EditorApi, EditorSnapshot } from '../src/editor/api-types';

const definition = (name: string) => {
  const result = AI_TOOLS.find(tool => tool.name === name);
  expect(result, name).toBeDefined(); return result!;
};
const valid = (name: string, args: unknown) => validateAiArguments(args, definition(name).parameters);

describe('AI local chemistry tool contract', () => {
  it('declares explicit versioned complete-molecule targets for analysis and cleanup', () => {
    for (const name of ['analyze_molecule', 'cleanup_molecule_2d']) {
      expect(() => valid(name, { expectedRevision: 0, atomIds: [] })).not.toThrow();
      expect(() => valid(name, { expectedRevision: 4, atomIds: ['a_1', 'a_2'] })).not.toThrow();
      expect(() => valid(name, { expectedRevision: 4 })).toThrow('缺少字段');
      expect(() => valid(name, { atomIds: [] })).toThrow('缺少字段');
      expect(() => valid(name, { expectedRevision: -1, atomIds: [] })).toThrow();
      expect(() => valid(name, { expectedRevision: 0.5, atomIds: [] })).toThrow();
      expect(() => valid(name, { expectedRevision: '4', atomIds: [] })).toThrow();
      expect(() => valid(name, { expectedRevision: 4, atomIds: ['a_1', 'a_1'] })).toThrow();
      expect(() => valid(name, { expectedRevision: 4, atomIds: Array.from({ length: 1001 }, (_, i) => `a_${i}`) })).toThrow();
      expect(() => valid(name, { expectedRevision: 4, atomIds: [] , automaticallyExpand: true })).toThrow('未知字段');
    }
    expect(definition('analyze_molecule').description).toContain('只读');
    expect(definition('cleanup_molecule_2d').description).toContain('可撤销批次');
  });

  it('requires user-supplied single-line SMILES and rejects reaction/multirecord input before engine loading', () => {
    expect(() => valid('import_smiles', { expectedRevision: 2, smiles: 'CCO' })).not.toThrow();
    expect(() => valid('import_smiles', { expectedRevision: 2, smiles: 'CCO.O', title: 'User title' })).not.toThrow();
    expect(() => valid('import_smiles', { expectedRevision: 2, smiles: 'C'.repeat(50000), title: 'x'.repeat(500) })).not.toThrow();
    for (const smiles of ['', 'C'.repeat(50001), 'CCO\nCCN', 'CCO\rCCN', 'CCO>>CC=O']) {
      expect(() => valid('import_smiles', { expectedRevision: 2, smiles })).toThrow();
    }
    expect(() => valid('import_smiles', { expectedRevision: 2, smiles: 'CCO', title: 'x'.repeat(501) })).toThrow();
    expect(() => valid('import_smiles', { smiles: 'CCO' })).toThrow('缺少字段');
    expect(() => valid('import_smiles', { expectedRevision: 2, name: 'ethanol' })).toThrow();
  });

  it('keeps chemistry tools closed to code, engine options and lossy simplification switches', () => {
    for (const extra of [
      { script: 'alert(1)' }, { allowLossy: true }, { sanitize: false }, { removeQueries: true }, { engine: 'remote' },
    ]) {
      expect(() => valid('analyze_molecule', { expectedRevision: 1, atomIds: [], ...extra })).toThrow();
      expect(() => valid('cleanup_molecule_2d', { expectedRevision: 1, atomIds: [], ...extra })).toThrow();
      expect(() => valid('import_smiles', { expectedRevision: 1, smiles: 'CCO', ...extra })).toThrow();
    }
  });

  it('communicates real lazy/local capabilities and read-only boundaries without claiming the module is already loaded', () => {
    const snapshot: EditorSnapshot = { apiVersion: 1, revision: 7, document: exampleDocument('ethanol'), selection: { atomIds: [] }, canUndo: false, canRedo: false };
    snapshot.document.source = { format: 'mrv', raw: 'PRIVATE_ORIGINAL', fingerprint: '', issues: [] };
    const editor = { getSnapshot: () => structuredClone(snapshot), getDiagnostics: () => [] } as unknown as EditorApi;
    const context = getAiEditorContext(editor), chemistry = context.capabilities.chemistryCalculation;
    expect(chemistry.engine).toBe('RDKit'); expect(chemistry.loading).toBe('lazy-local-wasm'); expect(chemistry.maxAtoms).toBe(1000);
    expect(chemistry.readOnlyTools).toEqual(['analyze_molecule']);
    expect(chemistry.mutationTools).toEqual(['cleanup_molecule_2d', 'import_smiles']);
    for (const name of [...chemistry.readOnlyTools, ...chemistry.mutationTools]) expect(context.capabilities.tools).toContain(name);
    expect(chemistry.selection).toContain('Never automatically expand');
    expect(chemistry.scope).toMatch(/rejected rather than simplified/);
    expect(chemistry.protections).toContain('read-and-write-revision-checks-after-loading');
    expect(chemistry.protections).toContain('computed-labels-do-not-assign-unspecified-centers');
    expect(JSON.stringify(context)).not.toContain('PRIVATE_ORIGINAL');
    expect(snapshot.document.source.raw).toBe('PRIVATE_ORIGINAL');
  });

  it('updates model instructions to use actual results, protect unsupported chemistry and require import intent', () => {
    for (const name of ['analyze_molecule', 'cleanup_molecule_2d', 'import_smiles']) expect(BUILTIN_AI_PROMPT).toContain(name);
    expect(BUILTIN_AI_PROMPT).not.toContain('本轮AI工具未开放这些计算');
    expect(BUILTIN_AI_PROMPT).not.toContain('不能声称此AI已调用它们');
    expect(BUILTIN_AI_PROMPT).toContain('不能自动扩展到未授权对象');
    expect(BUILTIN_AI_PROMPT).toContain('不能先删除查询');
    expect(BUILTIN_AI_PROMPT).toContain('不自动写入来源标签或给未指定中心指定构型');
    expect(BUILTIN_AI_PROMPT).toContain('没有提供SMILES时先询问');
  });

  it('provides localized calculation/cleanup presets and an import prompt that asks for the actual SMILES', () => {
    for (const title of ['计算分子性质', '整理二维结构', '导入 SMILES']) {
      const preset = AI_PROMPT_PRESETS.find(item => item.title === title)!;
      expect(preset, title).toBeDefined(); expect(preset.message).toBeTruthy(); expect(preset.messageEn).toBeTruthy();
    }
    const importing = AI_PROMPT_PRESETS.find(item => item.title === '导入 SMILES')!;
    expect(importing.message).toContain('先询问'); expect(importing.message).toContain('替换当前整份文档');
    expect(importing.messageEn).toContain('Ask me for the exact'); expect(importing.messageEn).toContain('Do not supply or guess');
    expect(importing.message).not.toContain('CCO'); expect(importing.messageEn).not.toContain('CCO');
  });
});
