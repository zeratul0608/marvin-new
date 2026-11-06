import {clone,emptyDocument,id} from '../core/model';
import type {ChemicalDocument,Diagnostic,DocumentReference,Format,ImportResult,ReactionParticipation,ReactionStep} from '../core/types';
import {readMol,writeMol} from './mol';
import {boundCount,fail,finish,integer} from './shared';

type Role='reactants'|'products'|'agents';
type RxnParts={version:'rxn'|'rxn-v3000';title:string;components:{role:Role;raw:string}[]};
const statusNames:Record<number,ReactionParticipation>={[-1]:'NotReactionCenter',1:'ReactionCenter',2:'NoChange',4:'MakeOrBreak',8:'ChangeType',12:'MakeAndChange'};
const statusCode=(value:ReactionParticipation|undefined)=>value===undefined?0:Number(Object.keys(statusNames).find(n=>statusNames[Number(n)]===value)??fail('RXN 尚不能表示此反应键条件，请保存 CDXML 或 JSON','UNSUPPORTED_RXN_PROPERTY'));
const linesOf=(raw:string)=>raw.replace(/^\uFEFF/,'').replaceAll('\r','').split('\n');
const counts=(values:string[])=>{if(values.length<2||values.length>3)fail('RXN 数量行必须包含反应物、产物及可选试剂数量');const n=values.map(v=>integer(v));n.forEach(boundCount);boundCount(n.reduce((a,b)=>a+b,0));return [n[0],n[1],n[2]??0]as const;};

/** RXN is a single reaction with explicit component roles, not a flat MOL list. */
function splitRxn(raw:string):RxnParts{
  const lines=linesOf(raw);if(lines.length<5)fail('RXN 文件头不完整');
  const header=lines[0].trim(),version=header==='$RXN V3000'?'rxn-v3000':header==='$RXN'||header==='$RXN V2000'?'rxn':fail('需要有效的 $RXN 或 $RXN V3000 文件头');
  const components:RxnParts['components']=[];
  if(version==='rxn'){
    const count=lines[4];if(count.length<6||count.slice(9).trim())fail('RXN V2000 数量行无效');
    const [reactants,products,agents]=counts([count.slice(0,3),count.slice(3,6),...(count.slice(6,9).trim()?[count.slice(6,9)]:[])]);
    let cursor=5;const expected=reactants+products+agents;
    for(let i=0;i<expected;i++){
      while(!lines[cursor]?.trim()&&cursor<lines.length)cursor++;
      if(lines[cursor]?.trim()!=='$MOL')fail('RXN 的 $MOL 数量与角色计数不一致');cursor++;
      const start=cursor;while(cursor<lines.length&&lines[cursor].trim()!=='$MOL')cursor++;
      const block=lines.slice(start,cursor).join('\n');if(!block.trim())fail('RXN 包含空的 MOL 数据段');
      components.push({role:i<reactants?'reactants':i<reactants+products?'products':'agents',raw:block});
    }
    if(lines.slice(cursor).some(l=>l.trim()))fail('RXN 数量行之后存在额外分子或未支持的数据');
  }else{
    const records:string[]=[];let ended=false;
    for(let i=4;i<lines.length;i++){
      if(!lines[i].trim())continue;
      if(ended)fail('RXN 结束标记之后还有额外数据');
      if(lines[i].trim()==='M  END'){ended=true;continue;}
      if(!lines[i].startsWith('M  V30 '))fail('RXN V3000 包含未支持的数据行');
      let record=lines[i].slice(7);
      while(record.endsWith('-')){record=record.slice(0,-1);i++;if(!lines[i]?.startsWith('M  V30 '))fail('RXN V3000 续行被截断');record+=lines[i].slice(7);}
      records.push(record.trim());
    }
    if(!ended)fail('RXN V3000 缺少最终 M  END');
    const first=records.shift()?.split(/\s+/);if(first?.[0]!=='COUNTS')fail('RXN V3000 缺少数量行');const expected=counts(first.slice(1));
    const seen=new Set<Role>(),order:Role[]=['reactants','products','agents'];let previous=-1,cursor=0;
    while(cursor<records.length){
      const start=records[cursor++],role=({ 'BEGIN REACTANT':'reactants','BEGIN PRODUCT':'products','BEGIN AGENT':'agents','BEGIN REAGENT':'agents'}as const)[start as 'BEGIN REACTANT'];
      if(!role||seen.has(role)||order.indexOf(role)<previous)fail('RXN V3000 角色分块无效、重复或顺序错误');seen.add(role);previous=order.indexOf(role);
      const end=start.replace('BEGIN ','END ');let number=0;
      while(records[cursor]!==end){
        if(records[cursor]!=='BEGIN CTAB')fail('RXN 角色块需要完整 CTAB');const block:string[]=[];let depth=0;
        do{const line=records[cursor++];if(line===undefined)fail('RXN CTAB 被截断');block.push(line);if(line==='BEGIN CTAB')depth++;if(line==='END CTAB')depth--;}while(depth>0);
        components.push({role,raw:[`${lines[1]} ${role} ${number+1}`,'  Molecule  2D','','  0  0  0     0  0            999 V3000',...block.map(line=>'M  V30 '+line),'M  END'].join('\n')});number++;
      }
      cursor++;if(number!==expected[order.indexOf(role)])fail('RXN V3000 角色中的 CTAB 数量与声明不一致');
    }
    for(let i=0;i<order.length;i++)if(expected[i]&&!seen.has(order[i]))fail('RXN V3000 缺少声明的角色分块');
  }
  return {version,title:lines[1],components};
}

/** Recover reaction-specific fields before delegating the molecule grammar to
 * the MOL adapter. Unsupported inversion/exact-change flags are never ignored. */
function reactionMol(raw:string):ChemicalDocument{
  const lines=linesOf(raw),statuses:number[]=[];
  if(lines[3]?.includes('V2000')){
    const n=integer(lines[3].slice(0,3)),m=integer(lines[3].slice(3,6));boundCount(n);boundCount(m);
    for(let i=0;i<n;i++){const row=lines[4+i]??'';if(integer(row.slice(63,66),0)||integer(row.slice(66,69),0))fail('RXN 原子反转／保留或精确变化标志尚未接入，不能丢弃','UNSUPPORTED_RXN_PROPERTY');}
    for(let i=0;i<m;i++){
      const row=lines[4+n+i]??'',status=integer(row.slice(18,21),0);if(status&&!statusNames[status])fail('此 RXN 反应中心组合标志尚不能完整表示','UNSUPPORTED_RXN_PROPERTY');statuses.push(status);
      lines[4+n+i]=row.slice(0,18)+'  0'+row.slice(21);
    }
  }else if(lines[3]?.includes('V3000')){
    let section='';
    for(let i=4;i<lines.length;i++){
      if(!lines[i].startsWith('M  V30 '))continue;let content=lines[i].slice(7);
      while(content.endsWith('-')){content=content.slice(0,-1);const next=lines[++i];if(!next?.startsWith('M  V30 '))fail('RXN 分子续行无效');content+=next.slice(7);lines[i-1]='';}
      const tokens=content.trim().split(/\s+/);if(tokens[0]==='BEGIN'){section=tokens[1];continue;}if(tokens[0]==='END'){section='';continue;}
      if(section==='ATOM')for(const key of ['INVRET','EXACHG']){
        const matches=tokens.filter(t=>t.startsWith(key+'='));if(matches.length>1||matches.some(t=>integer(t.split('=')[1])!==0))fail('RXN 原子反转／精确变化标志尚未接入','UNSUPPORTED_RXN_PROPERTY');content=content.replace(new RegExp(`\\s+${key}=0(?=\\s|$)`,'g'),'');
      }
      if(section==='ATOM'){const index=integer(tokens[0]),mapping=integer(tokens[5]);if(!Number.isSafeInteger(index)||index<1||index>2147483647||!Number.isSafeInteger(mapping)||mapping<0||mapping>2147483647)fail('RXN 原子序号或映射编号超出 32 位整数范围','INVALID_RXN_MAPPING');}
      if(section==='BOND'){
        const rx=tokens.filter(t=>t.startsWith('RXCTR='));if(rx.length>1)fail('重复的 RXN 反应中心标志');const status=rx.length?integer(rx[0].split('=')[1]):0;if(status&&!statusNames[status])fail('此 RXN 反应中心组合标志尚不能完整表示','UNSUPPORTED_RXN_PROPERTY');statuses.push(status);content=content.replace(/\s+RXCTR=[+-]?\d+(?=\s|$)/g,'');
      }
      lines[i]='M  V30 '+content;
    }
  }
  const result=readMol(lines.join('\n')).document;
  Object.values(result.graph.bonds).forEach((b,i)=>{if(statuses[i])b.reactionParticipation=statusNames[statuses[i]];});return result;
}

function uniqueMaps(doc:ChemicalDocument,ids:readonly string[]):Map<number,string>{
  const maps=new Map<number,string>();for(const id of ids){const number=doc.graph.atoms[id].atomMap;if(number===undefined)continue;if(maps.has(number))fail('同一反应侧的原子映射编号必须唯一','INVALID_RXN_MAPPING');maps.set(number,id);}return maps;
}
export function readRxn(raw:string,name?:string):ImportResult{
  const parts=splitRxn(raw),doc=emptyDocument(parts.title||name?.replace(/\.rxn$/i,'')||'RXN 反应'),refs:Record<Role,DocumentReference[]>={reactants:[],products:[],agents:[]};
  for(const [i,component]of parts.components.entries()){
    const mol=reactionMol(component.raw);if(!Object.keys(mol.graph.atoms).length)fail('RXN 的分子参与者必须包含原子，空反应请使用零角色计数','EMPTY_RXN_COMPONENT');Object.assign(doc.graph.atoms,mol.graph.atoms);Object.assign(doc.graph.bonds,mol.graph.bonds);Object.assign(doc.depiction.positions,mol.depiction.positions);Object.assign(doc.depiction.bonds,mol.depiction.bonds);
    refs[component.role].push({kind:'molecule',atomIds:Object.keys(mol.graph.atoms),sourceId:`rxn:${i}`});boundCount(Object.keys(doc.graph.atoms).length);boundCount(Object.keys(doc.graph.bonds).length);
  }
  const step:ReactionStep={id:id('reaction'),schemeId:id('scheme'),reactants:refs.reactants,products:refs.products,above:refs.agents,below:[],arrows:[],pluses:[]};
  const ids=(role:Role)=>refs[role].flatMap(ref=>ref.kind==='molecule'?ref.atomIds:[]),left=uniqueMaps(doc,ids('reactants')),right=uniqueMaps(doc,ids('products'));
  const pairs=[...left].filter(([number])=>right.has(number)).map(([number,atom])=>[atom,right.get(number)!]as [string,string]);if(pairs.length)step.atomMappings=[{mode:'specified',atoms:pairs}];doc.graph.reactions={[step.id]:step};
  return finish(doc,raw,parts.version,[],name);
}

type ExportParts={step:ReactionStep;roles:Record<Role,{ref:DocumentReference;ids:string[]}[]>;maps:Map<string,number>};
function exportParts(doc:ChemicalDocument):ExportParts{
  const steps=Object.values(doc.graph.reactions??{});if(steps.length!==1)fail('RXN 仅支持一条反应步骤；请先选择单步反应或保存 CDXML/JSON','UNSUPPORTED_RXN_REACTION');const step=steps[0];
  if(step.below.length)fail('RXN 尚不能保留箭头下方条件的角色信息，请保存 CDXML/JSON','UNSUPPORTED_RXN_CONDITION');
  const all=new Set<string>(),roles:ExportParts['roles']={reactants:[],products:[],agents:[]};
  for(const [role,refs]of [['reactants',step.reactants],['products',step.products],['agents',step.above]]as const)for(const ref of refs){
    if(ref.kind!=='molecule')fail('RXN 角色必须是明确的分子片段；文字和图元条件不能变成试剂','UNSUPPORTED_RXN_CONDITION');
    if(!ref.atomIds.length)fail('RXN 的分子参与者必须包含原子，空反应请使用零角色计数','EMPTY_RXN_COMPONENT');
    for(const id of ref.atomIds){if(all.has(id))fail('RXN 的参与者范围不能重叠或复用同一原子','INVALID_RXN_PARTICIPANT');all.add(id);}roles[role].push({ref,ids:ref.atomIds});
  }
  if(all.size!==Object.keys(doc.graph.atoms).length)fail('存在未分配反应角色的化学结构，RXN 导出不会忽略这些原子','INVALID_RXN_PARTICIPANT');
  boundCount(Object.values(roles).flat().length);
  for(const b of Object.values(doc.graph.bonds))if(!Object.values(roles).flat().some(p=>p.ids.includes(b.atoms[0])&&p.ids.includes(b.atoms[1])))fail('反应参与者范围切断了化学键','INVALID_RXN_PARTICIPANT');
  const lhs=roles.reactants.flatMap(p=>p.ids),rhs=roles.products.flatMap(p=>p.ids);uniqueMaps(doc,lhs);uniqueMaps(doc,rhs);
  const maps=new Map(Object.values(doc.graph.atoms).filter(a=>a.atomMap!==undefined).map(a=>[a.id,a.atomMap!])),used=new Set(maps.values()),pairedLeft=new Set<string>(),pairedRight=new Set<string>();
  if([...maps.values()].some(n=>!Number.isSafeInteger(n)||n>2147483647))fail('RXN 原子映射编号超出 32 位整数范围','FORMAT_LIMIT');
  for(const mapping of step.atomMappings??[]){
    if(mapping.mode!=='specified')fail('RXN 不能保留手动／自动映射的来源模式，请保存 CDXML/JSON','UNSUPPORTED_RXN_MAPPING');
    for(const [a,b]of mapping.atoms){
      if(!lhs.includes(a)||!rhs.includes(b)||pairedLeft.has(a)||pairedRight.has(b))fail('RXN 原子映射必须是一对一的反应物 → 产物对应','INVALID_RXN_MAPPING');pairedLeft.add(a);pairedRight.add(b);
      const left=maps.get(a),right=maps.get(b);if(left!==undefined&&right!==undefined&&left!==right)fail('原子映射编号与反应映射关系冲突','INVALID_RXN_MAPPING');let number=left??right;
      if(number===undefined){number=1;while(used.has(number))number++;used.add(number);}maps.set(a,number);maps.set(b,number);
    }
  }
  for(const ids of [lhs,rhs]){const seen=new Set<number>();for(const id of ids){const number=maps.get(id);if(number!==undefined){if(seen.has(number))fail('映射关系产生了重复编号，不能自动合并','INVALID_RXN_MAPPING');seen.add(number);}}}
  return {step,roles,maps};
}

/** Reject chemical losses; return reviewable warnings only for representational
 * details that the standard RXN container cannot carry. */
export function rxnExportIssues(doc:ChemicalDocument,format:Format):Diagnostic[]{
  exportParts(doc);
  const atoms=Object.values(doc.graph.atoms),bonds=Object.values(doc.graph.bonds),objects=Object.values(doc.depiction.objects??{}),issues:Diagnostic[]=[];
  if(atoms.some(a=>a.attachment||a.query||a.queryConstraints||a.substructure||a.namedFragment||a.multiAttachment||a.spatial||a.enhancedStereo||a.residueId!==undefined||a.connectionType))fail('RXN 当前仅支持确定的普通二维分子；查询、内部片段、生物连接、三维及增强立体请保存 CDXML/JSON','UNSUPPORTED_RXN_CHEMISTRY');
  if(bonds.some(b=>b.topology!==undefined||b.order==='any'||b.order===2.5||b.sequenceConnectivity||b.externalNumbers))fail('RXN 尚未完整映射查询键或生物序列连接','UNSUPPORTED_RXN_CHEMISTRY');for(const b of bonds)statusCode(b.reactionParticipation);
  if(objects.some(o=>!['page','group','arrow','t','graphic','curve'].includes(o.tag)))fail('RXN 不能保留聚合物或复杂专用文档对象，请保存 CDXML/JSON','UNSUPPORTED_RXN_DOCUMENT');
  const warn=(code:string,message:string)=>issues.push({severity:'warning',code,message});
  if(format==='rxn-v3000'&&doc.source?.format==='rxn'&&linesOf(doc.source.raw).join('\n').split(/^[ \t]*\$MOL[ \t]*$/m).slice(1).some(block=>!!block.replace(/^\n/,'').split('\n')[0]))warn('RXN_COMPONENT_NAME_LOSS','V3000 的当前 CTAB 适配器未写组件名称；分子图和角色仍保留。');
  if(objects.length||doc.depiction.style||Object.values(doc.graph.reactions??{})[0].arrows.length||Object.values(doc.graph.reactions??{})[0].pluses.length)warn('RXN_DRAWING_LOSS','RXN 保存反应角色及分子数据，不保存箭头、文字、分组、图元和文档样式；明确允许后才重建导出。');
  if(atoms.some(a=>a.geometry)||bonds.some(b=>b.circularOrdering))warn('STEREO_ORDERING_LOSS','RXN 的当前 MOL 适配器不写显式立体配体排序；仅保留二维坐标与楔键。');
  if(atoms.some(a=>a.cipLabel)||bonds.some(b=>b.cipLabel))warn('CIP_CACHE_LOSS','RXN 不保存来源 CIP 缓存；二维描绘保留，标签需要重新计算。');
  if(atoms.some(a=>a.sourceNumber!==undefined||a.attachmentIndex!==undefined))warn('RXN_ANNOTATION_LOSS','RXN 不保存 ChemDraw 来源显示编号与端口显示序号。');
  if(Object.values(doc.depiction.bonds).some(d=>d.doublePosition||d.labelOffsets||d.crossings||d.layer!==undefined||d.secondaryStyle||['dashed','bold','hash'].includes(d.style)))warn('BOND_DISPLAY_LOSS','RXN 的当前 MOL 适配器不保存双键偏侧、附加线型及标签／交叉描绘。');
  return issues;
}

function writeReactionMol(doc:ChemicalDocument,format:'mol'|'mol-v3000'):string{
  const lines=writeMol(doc,format).split('\n'),bonds=Object.values(doc.graph.bonds);
  if(format==='mol'){const start=4+Object.keys(doc.graph.atoms).length;bonds.forEach((b,i)=>{const code=statusCode(b.reactionParticipation);if(code)lines[start+i]=lines[start+i].slice(0,18)+String(code).padStart(3)+lines[start+i].slice(21);});}
  else{let section='',index=0;for(let i=4;i<lines.length;i++){if(lines[i]==='M  V30 BEGIN BOND'){section='BOND';continue;}if(lines[i]==='M  V30 END BOND'){section='';continue;}if(section==='BOND'){const code=statusCode(bonds[index++].reactionParticipation);if(code)lines[i]+=` RXCTR=${code}`;}}if(!bonds.length){const start=lines.indexOf('M  V30 BEGIN BOND');if(start>=0)lines.splice(start,2);}}
  return lines.join('\n');
}
export function writeRxn(doc:ChemicalDocument,format:Format):string{
  if(format!=='rxn'&&format!=='rxn-v3000')fail('未支持的 RXN 输出版本');const {roles,maps}=exportParts(doc),source=doc.source?.format==='rxn'||doc.source?.format==='rxn-v3000'?linesOf(doc.source.raw):undefined;
  const header=[format==='rxn'?'$RXN':'$RXN V3000',doc.title.replace(/[\r\n]/g,' '),source?.[2]??'  Molecule',source?.[3]??''],oldTitles=source?.join('\n').split(/^[ \t]*\$MOL[ \t]*$/m).slice(1).map(block=>block.replace(/^\n/,'').split('\n')[0])??[];
  const component=(participant:{ref:DocumentReference;ids:string[]})=>{
    const mol=emptyDocument(''),ids=new Set(participant.ids),old=participant.ref.kind==='molecule'?participant.ref.sourceId?.match(/^rxn:(\d+)$/):undefined;mol.title=old?oldTitles?.[Number(old[1])]??'':'';
    for(const id of ids){mol.graph.atoms[id]=clone(doc.graph.atoms[id]);if(maps.has(id))mol.graph.atoms[id].atomMap=maps.get(id)!;mol.depiction.positions[id]=clone(doc.depiction.positions[id]);}
    for(const b of Object.values(doc.graph.bonds))if(b.atoms.every(id=>ids.has(id))){mol.graph.bonds[b.id]=clone(b);if(doc.depiction.bonds[b.id])mol.depiction.bonds[b.id]=clone(doc.depiction.bonds[b.id]);}
    return writeReactionMol(mol,format==='rxn'?'mol':'mol-v3000');
  };
  if(format==='rxn'){
    if(Object.values(roles).some(role=>role.length>999))fail('RXN V2000 每个角色最多 999 个分子，请选择 V3000','FORMAT_LIMIT');header.push([roles.reactants.length,roles.products.length,...(roles.agents.length?[roles.agents.length]:[])].map(n=>String(n).padStart(3)).join(''));
    for(const role of ['reactants','products','agents']as const)for(const item of roles[role])header.push('$MOL',component(item));
  }else{
    header.push(`M  V30 COUNTS ${roles.reactants.length} ${roles.products.length}${roles.agents.length?' '+roles.agents.length:''}`);
    for(const [role,name]of [['reactants','REACTANT'],['products','PRODUCT'],['agents','AGENT']]as const){if(role==='agents'&&!roles[role].length)continue;header.push(`M  V30 BEGIN ${name}`);for(const item of roles[role])header.push(...component(item).split('\n').slice(4,-1));header.push(`M  V30 END ${name}`);}header.push('M  END');
  }
  return header.join('\n');
}
