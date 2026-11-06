import { afterEach, describe, expect, it } from 'vitest';
import { mountAiAnalysisPanel } from '../src/ai/analysis-panel';
import type { ChemistryAnalysis } from '../src/chemistry/engine';
import { EditorI18n } from '../src/editor/i18n';

const controllers: EditorI18n[] = [];
afterEach(() => { controllers.splice(0).forEach(controller => controller.destroy()); document.body.replaceChildren(); });

function analysis(): ChemistryAnalysis {
  return {
    engine: 'RDKit', version: '2026.09.1', atomIds: ['c1', 'c2', 'o1'], atomCount: 3, bondCount: 2, moleculeCount: 1,
    formula: 'C2H6O', formalCharge: 0, molecularWeight: 46.069, exactMass: 46.041864812,
    smiles: 'CCO', ringCount: 0, aromaticAtomIds: [], aromaticBondIds: [], hydrogenCounts: { c1: 3, c2: 2, o1: 1 },
    stereoAtoms: { c1: 'R' }, stereoBonds: { b1: 'E' }, unspecifiedStereoCenters: 1,
    descriptors: { logP: -0.0014, tpsa: 20.23, hBondDonors: 1, hBondAcceptors: 1 },
    scope: 'Based on the supplied complete molecular graph.',
  };
}
function mount(result = analysis(), revision = 7, getRevision = () => revision) {
  const container = document.createElement('div'); document.body.append(container);
  return { container, panel: mountAiAnalysisPanel(container, result, revision, getRevision) };
}

describe('authoritative RDKit result panel', () => {
  it('renders the engine report values and copyable SMILES independently from assistant prose', () => {
    const result = analysis(), before = structuredClone(result), { panel } = mount(result);
    expect(panel.element.dataset.aiAnalysis).toBe('7');
    expect(panel.element.textContent).toContain('RDKit 2026.09.1');
    expect([...panel.element.querySelectorAll('dd')].map(node => node.textContent)).toEqual([
      'C2H6O', '46.069 g/mol', '46.041865 Da', '0', '-0.001', '20.23 Å²', '1', '1', '0', '3',
    ]);
    const smiles = panel.element.querySelector<HTMLTextAreaElement>('[data-ai-analysis-smiles]')!;
    expect(smiles.readOnly).toBe(true); expect(smiles.value).toBe('CCO');
    expect(panel.element.querySelector('details:last-of-type pre')!.textContent).toBe('c1: R\nb1: E');
    expect(panel.element.textContent).toContain('未指定立体中心: 1');
    expect(result).toEqual(before);
  });

  it('marks a result stale after a manual revision without changing its historical calculation', () => {
    let revision = 11;
    const { panel } = mount(analysis(), 11, () => revision);
    const previousValues = [...panel.element.querySelectorAll('dd')].map(node => node.textContent);
    expect(panel.element.dataset.stale).toBe('false');
    expect(panel.element.querySelector('[role="status"]')!.textContent).toBe('结果对应当前文档版本。');
    revision = 12; panel.refresh();
    expect(panel.element.dataset.stale).toBe('true');
    expect(panel.element.querySelector('[role="status"]')!.textContent).toBe('文档已变化，以上结果属于计算时的版本。');
    expect([...panel.element.querySelectorAll('dd')].map(node => node.textContent)).toEqual(previousValues);
    expect(panel.element.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('CCO');
  });

  it('uses inert text and form values for hostile data rather than creating executable elements', () => {
    const result = analysis();
    result.formula = '<img src=x onerror=alert(1)>';
    result.smiles = '</textarea><script>alert(1)</script>';
    result.version = '<svg onload=alert(1)>';
    const { panel } = mount(result);
    expect(panel.element.querySelector('img,svg,script')).toBeNull();
    expect(panel.element.textContent).toContain(result.formula); expect(panel.element.textContent).toContain(result.version);
    expect(panel.element.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(result.smiles);
  });

  it('localizes interface labels and stale status while preserving numeric values, chemical text and nodes', () => {
    let revision = 2;
    const result = analysis(), { container, panel } = mount(result, 2, () => revision);
    const values = [...panel.element.querySelectorAll('dd')], originalValues = values.map(node => node.textContent);
    const smiles = panel.element.querySelector<HTMLTextAreaElement>('textarea')!, tags = panel.element.querySelector('details:last-of-type pre')!;
    const controller = new EditorI18n(container, 'en'); controllers.push(controller);
    expect(panel.element.querySelector('strong')!.textContent).toMatch(/RDKit.*results/i);
    expect([...panel.element.querySelectorAll('dt')].map(node => node.textContent).join(' ')).not.toMatch(/[\u3400-\u9fff]/);
    expect(smiles.getAttribute('aria-label')).toMatch(/SMILES/i); expect(smiles.getAttribute('aria-label')).toMatch(/RDKit/i);
    expect(panel.element.querySelector('[role="status"]')!.textContent).toMatch(/current document revision/i);
    expect([...panel.element.querySelectorAll('dd')]).toEqual(values);
    expect(values.map(node => node.textContent)).toEqual(originalValues); expect(smiles.value).toBe(result.smiles); expect(tags.textContent).toBe('c1: R\nb1: E');
    revision = 3; panel.refresh(); controller.translate();
    expect(panel.element.querySelector('[role="status"]')!.textContent).toMatch(/document changed/i);
    controller.setLocale('zh-CN');
    expect(panel.element.querySelector('strong')!.textContent).toBe('RDKit 计算结果');
    expect(panel.element.querySelector('[role="status"]')!.textContent).toBe('文档已变化，以上结果属于计算时的版本。');
    expect(smiles).toBe(panel.element.querySelector('textarea')); expect(values.map(node => node.textContent)).toEqual(originalValues);
  });
  it.each(['document','selection'] as const)('identifies the calculation-time %s scope and preserves raw atom IDs across languages', scope => {
    const result=analysis(); result.atomIds=['导出','内部中文-id'];
    const container=document.createElement('div'); document.body.append(container);
    const panel=mountAiAnalysisPanel(container,result,5,()=>5,scope);
    const range=panel.element.querySelector('details')!, ids=range.querySelector('pre')!;
    expect(range.querySelector('summary')!.textContent).toBe('计算范围');
    expect(range.querySelector('p')!.textContent).toBe(scope==='document'?'计算时的整份文档':'计算时所选的完整分子');
    expect(ids.textContent).toBe('导出\n内部中文-id');
    const controller=new EditorI18n(container,'en'); controllers.push(controller);
    expect(range.querySelector('p')!.textContent).toMatch(scope==='document'?/document/i:/selected|selection/i);
    expect(ids.textContent).toBe('导出\n内部中文-id');
    controller.setLocale('zh-CN');
    expect(range.querySelector('p')!.textContent).toBe(scope==='document'?'计算时的整份文档':'计算时所选的完整分子');
    expect(ids.textContent).toBe('导出\n内部中文-id');
  });

});
