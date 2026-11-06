import type { ChemistryAnalysis } from '../chemistry/engine';

/** Displays authoritative calculation values separately from the model's prose. */
export function mountAiAnalysisPanel(container: HTMLElement, analysis: ChemistryAnalysis, revision: number, getRevision: () => number, scope?: 'document' | 'selection') {
  const doc = container.ownerDocument;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
    const node=doc.createElement(tag); if(text!==undefined)node.textContent=text; if(className)node.className=className; return node;
  };
  const article=make('article',undefined,'ai-chemistry-analysis'); article.dataset.aiAnalysis=String(revision);
  article.append(make('strong','RDKit 计算结果'));
  const metadata=make('p',undefined,'ai-note'), version=make('span',`RDKit ${analysis.version} · `); version.dataset.i18nSkip='';
  metadata.append(version,make('span','文档版本'),make('span',` ${revision}`)); article.append(metadata);
  const values: [string,string][]=[
    ['分子式',analysis.formula],['平均分子量',`${analysis.molecularWeight.toFixed(3)} g/mol`],
    ['单同位素精确质量',`${analysis.exactMass.toFixed(6)} Da`],['形式电荷',String(analysis.formalCharge)],
    ['计算 LogP',analysis.descriptors.logP.toFixed(3)],['tPSA',`${analysis.descriptors.tpsa.toFixed(2)} Å²`],
    ['氢键供体',String(analysis.descriptors.hBondDonors)],['氢键受体',String(analysis.descriptors.hBondAcceptors)],
    ['环数量',String(analysis.ringCount)],['计算原子数',String(analysis.atomCount)],
  ];
  const table=make('dl',undefined,'ai-analysis-values');
  for(const [label,value] of values){const description=make('dd',value);description.dataset.i18nSkip='';table.append(make('dt',label),description);}
  article.append(table);
  const range=make('details');range.append(make('summary','计算范围'));
  range.append(make('p',scope==='document'?'计算时的整份文档':scope==='selection'?'计算时所选的完整分子':'计算时的完整分子范围'));
  const ids=make('pre',analysis.atomIds.join('\n'));ids.dataset.i18nSkip='';range.append(ids);article.append(range);
  const label=make('label','异构 SMILES'), smiles=make('textarea'); smiles.readOnly=true;smiles.rows=2;smiles.value=analysis.smiles;smiles.dataset.aiAnalysisSmiles='';smiles.setAttribute('aria-label','RDKit 计算的异构 SMILES');
  label.append(smiles);article.append(label);
  const tags=make('details');tags.append(make('summary','计算的立体标签'));
  const entries=[...Object.entries(analysis.stereoAtoms),...Object.entries(analysis.stereoBonds)];
  const text=make('pre',entries.length?entries.map(([id,value])=>`${id}: ${value}`).join('\n'):'—');text.dataset.i18nSkip='';tags.append(text);
  const unspecified=make('p');unspecified.append(make('span','未指定立体中心'),make('span',`: ${analysis.unspecifiedStereoCenters}`));tags.append(unspecified);article.append(tags);
  article.append(make('small','以上为计算值；没有向文档写入立体标签。'));
  const state=make('p',undefined,'ai-analysis-state');state.setAttribute('role','status');article.append(state);container.append(article);
  const refresh=()=>{
    const stale=getRevision()!==revision;article.dataset.stale=String(stale);
    state.textContent=stale?'文档已变化，以上结果属于计算时的版本。':'结果对应当前文档版本。';
  };
  refresh();return {element:article,refresh};
}
