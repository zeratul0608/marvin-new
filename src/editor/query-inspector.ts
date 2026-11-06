import type {Atom,AtomQueryConstraints,Bond} from '../core/types';
import {atomRingBondCounts,atomUnsaturatedBonds,atomReactionStereos,bondTopologies} from '../core/query';
import {escapeXml as esc} from '../formats/shared';

const names:Record<string,string>={Unspecified:'未指定（显式值）',NoRingBonds:'没有环键',AsDrawn:'按当前绘制',SimpleRing:'恰好 2 条环键',Fusion:'恰好 3 条环键',SpiroOrHigher:'至少 4 条环键',MustBeAbsent:'必须不含不饱和键',MustBePresent:'必须含不饱和键',Inversion:'构型反转',Retention:'构型保留',Ring:'必须为环键',Chain:'必须为链键',RingOrChain:'明确允许环键或链键'};
const enumField=(label:string,field:string,values:readonly string[],value?:string)=>`<label>${label}<select data-query-constraint="${field}"><option value="">无此条件</option>${values.map(v=>`<option value="${v}"${v===value?' selected':''}>${names[v]}</option>`).join('')}</select></label>`;
export function atomQueryConstraintControls(atom:Atom,expanded=false):string{
 if(atom.attachment)return '';
 const q=atom.queryConstraints??{};
 return `<details class="advanced-query-controls"${expanded?' open':''}><summary>高级查询条件${atom.queryConstraints?' · 已设置':''}</summary><label>非氢取代数：恰好<input data-query-constraint="substituentsExactly" type="number" min="0" max="255" step="1" placeholder="不限制" value="${q.substituentsExactly??''}"/></label><label>非氢取代数：最多<input data-query-constraint="substituentsUpTo" type="number" min="0" max="255" step="1" placeholder="不限制" value="${q.substituentsUpTo??''}"/></label>${enumField('环键数量','ringBondCount',atomRingBondCounts,q.ringBondCount)}${enumField('不饱和条件','unsaturatedBonds',atomUnsaturatedBonds,q.unsaturatedBonds)}<label><input type="checkbox" style="display:inline-block;width:16px;height:16px;min-height:0;margin:0 6px 0 0;vertical-align:middle" data-query-constraint="reactionChange"${q.reactionChange?' checked':''}/>仅允许明确指定的反应变化</label>${enumField('反应立体条件','reactionStereo',atomReactionStereos,q.reactionStereo)}<p>取代数统计非氢邻接原子，不是键级之和。0 是有效条件。反应立体条件只声明查询要求，不会执行构型翻转。含查询条件的结构不作为确定分子计算。</p><button class="wide-button" data-action="clear-query-constraints"${atom.queryConstraints?'':' disabled'}>清除全部原子查询约束</button></details>`;
}
export function bondTopologyControls(bond:Bond,expanded=false):string{
 return `<details class="bond-query-controls"${expanded?' open':''}><summary>键拓扑查询${bond.topology!==undefined?' · 已设置':''}</summary><label>环／链要求<select data-bond-topology><option value="">无此条件</option>${bondTopologies.map(v=>`<option value="${v}"${v===bond.topology?' selected':''}>${names[v]}</option>`).join('')}</select></label><p>这是对匹配对象的要求；设置环键不会自动闭合当前结构。“明确允许环键或链键”与未设置条件分别保存。</p></details>`;
}
export function changedQueryConstraint(atom:Atom,field:string,value:string,checked:boolean):AtomQueryConstraints|null{
 const keys=['substituentsExactly','substituentsUpTo','ringBondCount','unsaturatedBonds','reactionChange','reactionStereo'];
 if(!keys.includes(field))throw new Error('未知原子查询条件');
 const next:Record<string,unknown>={...atom.queryConstraints};
 if(field==='reactionChange'){if(checked)next[field]=true;else delete next[field];}
 else if(!value.trim())delete next[field];
 else next[field]=field==='substituentsExactly'||field==='substituentsUpTo'?Number(value):value;
 return Object.keys(next).length?next as AtomQueryConstraints:null;
}
export function atomConstraintDescription(q:AtomQueryConstraints):string{
 return [q.substituentsExactly!==undefined?`非氢取代数恰好 ${q.substituentsExactly}`:'',q.substituentsUpTo!==undefined?`非氢取代数最多 ${q.substituentsUpTo}`:'',q.ringBondCount?`环键：${names[q.ringBondCount]}`:'',q.unsaturatedBonds?names[q.unsaturatedBonds]:'',q.reactionChange?'仅允许指定反应变化':'',q.reactionStereo?`反应立体：${names[q.reactionStereo]}`:''].filter(Boolean).join('；');
}
export function queryConstraintMarkup(doc:{graph:{atoms:Record<string,Atom>;bonds:Record<string,Bond>};depiction:{positions:Record<string,{x:number;y:number}>}}):string{
 return Object.values(doc.graph.atoms).filter(a=>a.queryConstraints).map(a=>{const p=doc.depiction.positions[a.id];return `<text class="query-condition-label" data-query-constraints="${esc(a.id)}" x="${p.x+.4}" y="${-p.y-.58}"><title>${esc(atomConstraintDescription(a.queryConstraints!))}</title>Q</text>`;}).join('')+Object.values(doc.graph.bonds).filter(b=>b.topology!==undefined).map(b=>{const [a,c]=b.atoms.map(id=>doc.depiction.positions[id]),dx=c.x-a.x,dy=c.y-a.y,length=Math.hypot(dx,dy)||1;return `<text class="query-condition-label" data-query-topology="${esc(b.id)}" x="${(a.x+c.x)/2+dy/length*.42}" y="${-(a.y+c.y)/2+dx/length*.42}"><title>${names[b.topology!]}</title>${b.topology==='Ring'?'环':b.topology==='Chain'?'链':b.topology==='RingOrChain'?'环/链':'拓扑?'}</text>`;}).join('');
}
export const queryConstraintStyle='.query-condition-label{font:600 .20px Arial,sans-serif;fill:#82609c;text-anchor:middle;stroke:white;stroke-width:.07;paint-order:stroke;pointer-events:none}';
