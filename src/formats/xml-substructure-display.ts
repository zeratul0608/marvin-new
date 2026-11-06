import type {AtomSubstructure} from '../core/types';
import {scopeElements} from './xml-scope';
import {fail} from './shared';

/** Standard objecttag container; the value describes application presentation,
 * never native chemical attributes, atom assignments or hidden chemical graphs. */
export const expandedViewTagName='MoleculeWorkbench.ExpandedView';
export const expandedViewXml=`<objecttag Name="${expandedViewTagName}" TagType="String" Value="1" Persistent="yes" Visible="no"/>`;
export function readSubstructureDisplay(node:Element,hasSubstructure:boolean):'expanded'|undefined{
  const markers=[...node.children].filter(el=>el.localName==='objecttag'&&el.getAttribute('Name')===expandedViewTagName);
  if(!markers.length)return;
  const marker=markers[0];
  if(markers.length!==1||!hasSubstructure||marker.getAttribute('TagType')!=='String'||marker.getAttribute('Value')!=='1'||marker.children.length||marker.textContent?.trim())fail('内部片段展开视图标记无效','INVALID_SUBSTRUCTURE_DISPLAY');
  const allowed=new Set(['Name','TagType','Value','Persistent','Visible','id','DisplayName','Tracking','PositioningType','PositioningAngle','PositioningOffset']);
  if([...marker.attributes].some(a=>!allowed.has(a.name)&&!a.name.startsWith('xmlns'))||['Persistent','Visible','Tracking'].some(k=>marker.hasAttribute(k)&&!['yes','no'].includes(marker.getAttribute(k)!)))fail('内部片段展开视图标记属性无效','INVALID_SUBSTRUCTURE_DISPLAY');
  return 'expanded';
}
export function syncSubstructureDisplay(node:Element,group:AtomSubstructure):void{
  const existing=readSubstructureDisplay(node,true);
  if(group.display==='expanded'){
    if(existing)return;
    const marker=node.ownerDocument.createElementNS(node.namespaceURI,node.prefix?`${node.prefix}:objecttag`:'objecttag');
    for(const [key,value]of Object.entries({Name:expandedViewTagName,TagType:'String',Value:'1',Persistent:'yes',Visible:'no'}))marker.setAttribute(key,value);
    node.append(marker);
  }else for(const marker of [...node.children])if(marker.localName==='objecttag'&&marker.getAttribute('Name')===expandedViewTagName)marker.remove();
}
/** Only used when chemistry and object ordering are unchanged. Patching flags
 * directly preserves native child labels, ID namespaces, boxes and references. */
export function syncSubstructureDisplayTree(node:Element,group:AtomSubstructure):void{
  syncSubstructureDisplay(node,group);
  const fragments=[...node.children].filter(el=>el.localName==='fragment');
  if(fragments.length!==group.fragments.length)fail('内部片段视图来源层级不匹配','PRESERVATION_UNSUPPORTED');
  group.fragments.forEach((fragment,index)=>{
    const nodes=scopeElements(fragments[index],'n'),atoms=Object.values(fragment.document.graph.atoms);
    if(nodes.length!==atoms.length)fail('内部片段视图来源节点不匹配','PRESERVATION_UNSUPPORTED');
    atoms.forEach((atom,i)=>{if(atom.substructure)syncSubstructureDisplayTree(nodes[i],atom.substructure);});
  });
}
