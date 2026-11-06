import type { Atom, Bond, ChemicalDocument, DocumentReference } from '../core/types';
import { escapeXml as esc } from '../formats/shared';
import { reactionRoles } from '../core/drawing';
import { atomCipLabels,connectionTypes,reactionParticipations } from '../core/chemistry-annotations';
import {getPolymerGroup,bracketUsages,polymerRepeatPatterns,polymerFlipTypes} from '../core/polymers';

const selectField=(label:string,attribute:string,values:readonly string[],value?:string)=>`<label>${label}<select ${attribute}><option value="">未指定</option>${values.map(v=>`<option value="${esc(v)}"${v===value?' selected':''}>${esc(v)}</option>`).join('')}</select></label>`;
export function atomAnnotations(atom:Atom):string{
  let html=selectField('连接点／生物连接类型','data-property="connectionType"',connectionTypes,atom.connectionType)+selectField('来源 CIP 标签（不自动计算）','data-property="cipLabel"',atomCipLabels,atom.cipLabel);
  html+=`<label>残基编号<input data-property="residueId" type="number" min="1" value="${atom.residueId??''}"/></label>`;
  html+=selectField('增强立体类型','data-property="enhancedStereo"',['Absolute','Or','And'],atom.enhancedStereo?.type);
  if(atom.enhancedStereo&&atom.enhancedStereo.type!=='Absolute')html+=`<label>立体分组编号<input data-property="enhancedStereoGroup" type="number" min="1" value="${atom.enhancedStereo.group}"/></label>`;
  if(atom.spatial)html+=`<label>独立三维坐标（x y z）<input data-property="spatial" value="${atom.spatial.join(' ')}"/></label><p>修改二维排版不会覆盖三维坐标。</p>`;
  if(atom.namedFragment)html=`<h3>来源未展开的片段</h3><label>片段名称<input data-property="namedFragmentLabel" value="${esc(atom.namedFragment.label)}"/></label><p>原文件未提供内部原子图。名称及外部连接可编辑；内部组成尚未定义。</p><button data-action="edit-substructure" class="wide-button">补全并编辑内部结构</button>`+html;
  if(atom.multiAttachment)html=`<h3>多中心连接</h3><label>目标原子<input data-property="multiAttachment" value="${esc(atom.multiAttachment.join(' '))}"/></label><p>虚拟中心独立保存连接目标，不计作碳原子。</p>`+html;
  return `<details><summary>化学注释与分组</summary>${html}</details>`;
}
export function bondAnnotations(bond:Bond):string{
  return '<details><summary>反应与序列注释</summary>'+selectField('来源双键 CIP 标签','data-bond-annotation="cipLabel"',['E','Z'],bond.cipLabel)+selectField('反应键变化','data-bond-annotation="reactionParticipation"',reactionParticipations,bond.reactionParticipation)+selectField('序列连接方式','data-bond-annotation="sequenceConnectivity"',['Linear','Bridged','Staggered','Cyclic'],bond.sequenceConnectivity)+`<label>两端外部连接编号（0 表示未指定）<input data-bond-annotation="externalNumbers" value="${bond.externalNumbers?.map(n=>n??0).join(' ')??''}"/></label></details>`;
}

export function documentInspector(doc:ChemicalDocument,selected?:string,pageId?:string,options:{showPages?:boolean}={}):string {
  const objects=Object.values(doc.depiction.objects??{}), steps=Object.values(doc.graph.reactions??{});
  if(!objects.length&&!steps.length)return '';
  const title=(ref:DocumentReference):string=>ref.kind==='molecule'?`分子片段 · ${ref.atomIds.length} 个原子`:ref.kind==='drawing'?(()=>{const o=doc.depiction.objects![ref.id];return `${o.tag} · ${o.runs?.map(r=>r.text).join('').slice(0,50)||o.sourceId||objects.indexOf(o)+1}`;})():`${ref.kind==='atom'?'原子':'化学键'} ${ref.id.slice(-6)}`;
  const pages=objects.filter(o=>o.tag==='page');
  let html=`<section class="property-section">${options.showPages!==false&&pages.length>1?`<label>当前页面<select data-document-page><option value="">所有页面</option>${pages.map((page,i)=>`<option value="${esc(page.id)}"${page.id===pageId?' selected':''}>第 ${i+1} 页</option>`).join('')}</select></label>`:''}<h3>文档对象 · ${objects.length}</h3><label>选择文字、箭头、图形或分组<select data-document-object><option value="">选择对象</option>${objects.map((o,i)=>`<option data-i18n-skip value="${esc(o.id)}"${o.id===selected?' selected':''}>${i+1}. ${esc(title({kind:'drawing',id:o.id}))}</option>`).join('')}</select></label>`;
  const object=selected?doc.depiction.objects?.[selected]:undefined;
  if(object){
    if(object.tag==='bracketedgroup'){
      const polymer=getPolymerGroup(doc,object.id),members=new Set(polymer.atomIds),atoms=Object.values(doc.graph.atoms);
      html+='<h3>聚合物／重复单元</h3>'+selectField('括号化学类型','data-polymer-field="usage"',bracketUsages,polymer.usage)+selectField('单元连接方式','data-polymer-field="repeatPattern"',polymerRepeatPatterns,polymer.repeatPattern)+selectField('单元翻转方式','data-polymer-field="flipType"',polymerFlipTypes,polymer.flipType);
      html+=`<label>重复次数（MultipleGroup）<input data-polymer-field="repeatCount" type="number" step="any" min="0" value="${polymer.repeatCount??''}"/></label><label>SRU 标签<input data-polymer-field="label" maxlength="256" value="${esc(polymer.label??'')}"/></label><label>组分顺序<input data-polymer-field="componentOrder" type="number" min="0" max="32767" value="${polymer.componentOrder??''}"/></label>`;
      html+=`<label>单元成员原子<select data-polymer-members multiple size="5">${atoms.map((a,i)=>`<option data-i18n-skip value="${esc(a.id)}"${members.has(a.id)?' selected':''}>${i+1}. ${esc(a.substructure?.label??a.element)}</option>`).join('')}</select></label><p>已解析 ${members.size} 个成员原子、${polymer.crossings.length} 条跨括号键。成员、连接、重复模式分别保存；未展开整个聚合物。</p>`;
      for(const [i,crossing]of polymer.crossings.entries())html+=`<label>边界 ${i+1} 的连接键<select data-polymer-crossing="${esc(crossing.id)}">${Object.values(doc.graph.bonds).filter(b=>b.atoms.filter(id=>members.has(id)).length===1).map(b=>`<option value="${esc(b.id)}"${b.id===crossing.bondId?' selected':''}>${b.atoms.map(id=>`${atoms.findIndex(a=>a.id===id)+1}.${doc.graph.atoms[id].element}`).join(' ↔ ')}</option>`).join('')}</select></label>`;
    }
    if(object.runs)html+=`<label>文字内容<textarea data-drawing-text>${esc(object.runs.map(r=>r.text).join(''))}</textarea></label>`;
    for(const [key,values]of Object.entries(object.geometry))html+=`<label>${esc(key)}（原始坐标单位）<input data-drawing-coordinate="${esc(key)}" value="${values.join(' ')}"/></label>`;
    for(const [key,value]of Object.entries(object.attributes))if(value.length<300&&!key.startsWith('CDXProperty')&&!(object.tag==='bracketedgroup'&&['BracketUsage','PolymerRepeatPattern','PolymerFlipType','RepeatCount','SRULabel','ComponentOrder'].includes(key)))html+=`<label>${esc(key)}<input data-drawing-attribute="${esc(key)}" value="${esc(value)}"/></label>`;
    if(object.tag==='bioshape')html+='<p>专用 BioDraw 图形目前以轮廓显示；原始参数可修改并保存。</p>';
    if(object.atomIds.length)html+=`<p>分组含 ${object.atomIds.length} 个化学节点，拖动时一起移动。</p>`;
    html+='<button class="wide-button" data-action="delete-selection">删除所选图元</button>';
  }
  html+='</section>';
  const labels={reactants:'反应物',products:'产物',arrows:'箭头',above:'箭头上方条件',below:'箭头下方条件',pluses:'加号'};
  for(const [i,step]of steps.entries()){
    const choices=[...new Map([...steps.flatMap(s=>reactionRoles.flatMap(role=>s[role])),...objects.filter(o=>['t','arrow','graphic'].includes(o.tag)).map(o=>({kind:'drawing' as const,id:o.id}))].map(ref=>[JSON.stringify(ref),ref])).values()];
    html+=`<details class="property-section"><summary>反应步骤 ${i+1}</summary>`;
    for(const role of reactionRoles)html+=`<label>${labels[role]}<select multiple size="3" data-reaction-step="${esc(step.id)}" data-reaction-role="${role}">${choices.map(ref=>{const value=JSON.stringify(ref);return `<option${ref.kind==='drawing'?' data-i18n-skip':''} value="${esc(value)}"${step[role].some(r=>JSON.stringify(r)===value)?' selected':''}>${esc(title(ref))}</option>`;}).join('')}</select></label>`;
    html+='</details>';
  }
  return html;
}
