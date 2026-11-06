import type { ChemicalDocument, DrawingObject } from '../core/types';
import type { CdxObject } from './cdx';
import { cdxDisplayMapper } from './cdx-display';
import { readXmlDocument, xmlAtPath } from './xml-document';
import { fail } from './shared';
import {bracketObjectNames,readBracketProperty,writeBracketProperty} from './cdx-brackets';

const names: Record<number,string> = {0x8000:'CDXML',0x8001:'page',0x8002:'group',0x8003:'fragment',0x8004:'n',0x8005:'b',0x8006:'t',0x8007:'graphic',0x8008:'curve',0x8009:'embeddedobject',0x800d:'scheme',0x800e:'step',0x8021:'arrow'};
const geometry: Record<number,string> = {0x0200:'p',0x0201:'xyz',0x0204:'BoundingBox',0x0207:'Head3D',0x0208:'Tail3D',0x020d:'Center3D',0x020e:'MajorAxisEnd3D',0x020f:'MinorAxisEnd3D'};
const roles: Record<number,string> = {0x0c00:'ReactionStepAtomMap',0x0c01:'ReactionStepReactants',0x0c02:'ReactionStepProducts',0x0c03:'ReactionStepPlusses',0x0c04:'ReactionStepArrows',0x0c05:'ReactionStepObjectsAboveArrow',0x0c06:'ReactionStepObjectsBelowArrow',0x0c07:'ReactionStepAtomMapManual',0x0c08:'ReactionStepAtomMapAuto'};
const scalarNames: Record<number,string> = {0x000a:'Z',0x0301:'color',0x0302:'bgcolor',0x0a20:'HeadSize',0x0a22:'LipSize',0x0a30:'ArrowheadCenterSize',0x0a31:'ArrowheadWidth'};
const enums: Record<number,{name:string;values:Record<number,string>}> = {
  0x0a00:{name:'GraphicType',values:{0:'Undefined',1:'Line',2:'Arc',3:'Rectangle',4:'Oval',5:'Orbital',6:'Bracket',7:'Symbol'}},
  0x0a06:{name:'BracketType',values:{0:'RoundPair',1:'SquarePair',2:'CurlyPair',3:'Square',4:'Curly',5:'Round'}},
  0x0a02:{name:'ArrowType',values:{0:'NoHead',1:'HalfHead',2:'FullHead',4:'Resonance',8:'Equilibrium',16:'Hollow',32:'RetroSynthetic',64:'NoGo',128:'Dipole'}},
  0x0a2f:{name:'ArrowheadType',values:{0:'Solid',1:'Solid',2:'Hollow',3:'Angle'}},
  0x0a35:{name:'ArrowheadHead',values:{0:'None',1:'HalfLeft',2:'Full',3:'HalfRight'}},
  0x0a36:{name:'ArrowheadTail',values:{0:'None',1:'HalfLeft',2:'Full',3:'HalfRight'}},
};
const num = (bytes:Uint8Array,signed=false) => {const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.length);if(![1,2,4].includes(bytes.length))fail('CDX 图元数值长度无效');return bytes.length===1?signed?v.getInt8(0):v.getUint8(0):bytes.length===2?signed?v.getInt16(0,true):v.getUint16(0,true):signed?v.getInt32(0,true):v.getUint32(0,true);};
const array = (bytes:Uint8Array) => {if(bytes.length%4)fail('CDX 引用数组长度无效');return Array.from({length:bytes.length/4},(_,i)=>num(bytes.subarray(i*4,i*4+4)));};
const coordinates = (tag:number,bytes:Uint8Array):number[] => {
  if(bytes.length%4)fail('CDX 图元坐标长度无效');const values=Array.from({length:bytes.length/4},(_,i)=>num(bytes.subarray(i*4,i*4+4),true)/65536);
  if([0x0200,0x0204].includes(tag))for(let i=0;i<values.length;i+=2)[values[i],values[i+1]]=[values[i+1],values[i]];return values;
};
const hex=(bytes:Uint8Array)=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
export function readCdxDrawingProperty(tag:number,bytes:Uint8Array):[string,string]|undefined{
  const bracket=readBracketProperty(tag,bytes);if(bracket)return bracket;
  if(geometry[tag])return [geometry[tag],coordinates(tag,bytes).join(' ')];
  if(scalarNames[tag])return [scalarNames[tag],String(num(bytes,tag===0x000a))];
  if(enums[tag]){const e=enums[tag],value=e.values[num(bytes)];if(value===undefined)fail('CDX 图元枚举无效');return [e.name,value];}
}

export function readCdxDocument(root:CdxObject,doc:ChemicalDocument,atoms:Map<CdxObject,string>,bonds:Map<CdxObject,string>):void {
  const input=new DOMParser().parseFromString('<CDXML/>','application/xml'), actual=root.children.length===1&&root.children[0].tag===0x8000?root.children[0]:root;
  const display=cdxDisplayMapper(root), sources=new Map<Element,CdxObject>(), atomElements=new Map<Element,string>(), bondElements=new Map<Element,string>();
  const append=(object:CdxObject,parent?:Element):Element|undefined=>{
    const name=names[object.tag]??bracketObjectNames[object.tag];if(!name)return;
    const el=object===actual?input.documentElement:input.createElementNS(null,name);if(object!==actual)parent!.append(el); sources.set(el,object);
    if(object.id)el.setAttribute('id',String(object.id));
    if(atoms.has(object))atomElements.set(el,atoms.get(object)!);if(bonds.has(object))bondElements.set(el,bonds.get(object)!);
    if(object.tag===0x8004||object.tag===0x8005)return el;
    const attrs:Record<string,string>={},children:string[]=[];
    const chemical=[0x8003,0x8004,0x8005].includes(object.tag);
    for(const [tag,bytes]of object.props){
      if(chemical)continue;
      if(display(object,tag,bytes,attrs,children))continue;
      const bracket=readBracketProperty(tag,bytes);if(bracket){attrs[bracket[0]]=bracket[1];continue;}
      if(geometry[tag])attrs[geometry[tag]]=coordinates(tag,bytes).join(' ');
      else if(roles[tag])attrs[roles[tag]]=array(bytes).join(' ');
      else if(tag===0x0013||tag===0x0012)attrs.SupersededBy=String(num(bytes));
      else if(scalarNames[tag])attrs[scalarNames[tag]]=String(num(bytes,tag===0x000a));
      else if(enums[tag]&&enums[tag].values[num(bytes)]!==undefined)attrs[enums[tag].name]=enums[tag].values[num(bytes)];
      else if(object!==actual)attrs[`CDXProperty${tag.toString(16).padStart(4,'0')}`]=hex(bytes);
    }
    for(const [key,value]of Object.entries(attrs))el.setAttribute(key,value);
    for(const child of children){const parsed=new DOMParser().parseFromString(`<root>${child}</root>`,'application/xml');for(const e of [...parsed.documentElement.children])el.append(input.importNode(e,true));}
    for(const child of object.children)append(child,el);return el;
  };append(actual);
  readXmlDocument(input,doc,atomElements,bondElements);
  for(const object of [...Object.values(doc.depiction.objects??{}),...Object.values(doc.graph.reactions??{})]){
    if(object.source?.format!=='cdxml')continue;const source=sources.get(xmlAtPath(input,object.source.path)!);if(!source)fail('CDX 图元来源绑定无效');object.source={format:'cdx',serial:source.serial};
  }
}

/** Supported fields are encoded independently; untouched native properties stay byte-for-byte in the source. */
export function cdxDrawingChanges(before:DrawingObject,after:DrawingObject):Map<number,Uint8Array|undefined>{
  const out=new Map<number,Uint8Array|undefined>();
  const int=(n:number,width=2,signed=false)=>{const min=signed?-(2**(width*8-1)):0,max=signed?2**(width*8-1)-1:2**(width*8)-1;if(!Number.isInteger(n)||n<min||n>max)fail('图元数值超出 CDX 范围');const b=new Uint8Array(width),v=new DataView(b.buffer);if(width===2)v.setUint16(0,n,true);else v.setUint32(0,n,true);return b;};
  for(const [tagText,key]of Object.entries(geometry)){
    if(JSON.stringify(before.geometry[key])===JSON.stringify(after.geometry[key]))continue;let values=after.geometry[key]?.slice();
    const tag=Number(tagText);if(values&&[0x0200,0x0204].includes(tag))for(let i=0;i<values.length;i+=2)[values[i],values[i+1]]=[values[i+1],values[i]];
    const bytes=values?new Uint8Array(values.length*4):undefined;values?.forEach((n,i)=>bytes!.set(int(Math.round(n*65536),4,true),i*4));out.set(tag,bytes);
  }
  for(const key of new Set([...Object.keys(before.attributes),...Object.keys(after.attributes)])){
    if(before.attributes[key]===after.attributes[key])continue;
    const bracket=writeBracketProperty(key,after.attributes[key]);if(bracket){out.set(...bracket);continue;}
    let tag=Object.keys(scalarNames).map(Number).find(t=>scalarNames[t]===key)??Object.keys(enums).map(Number).find(t=>enums[t].name===key);
    if(key.startsWith('CDXProperty')){tag=parseInt(key.slice(11),16);const value=after.attributes[key];if(value!==undefined&&!/^(?:[\da-f]{2})*$/i.test(value))fail('CDX 图元附加参数必须是完整十六进制字节');out.set(tag,value===undefined?undefined:Uint8Array.from(value.match(/../g)??[],v=>parseInt(v,16)));continue;}
    if(tag===undefined)fail(`CDX 图元属性 ${key} 尚未实现写入`);
    const value=after.attributes[key];if(value===undefined){out.set(tag,undefined);continue;}
    const enumeration=enums[tag],code=enumeration?Object.keys(enumeration.values).map(Number).find(n=>enumeration.values[n]===value):Number(value);if(code===undefined)fail('CDX 图元枚举无效');out.set(tag,int(code));
  }
  if(JSON.stringify(before.runs)!==JSON.stringify(after.runs)){
    const parts=(after.runs??[]).map(run=>{if(/[^\x20-\x7e\r\n]/.test(run.text))fail('CDX 图元文本写入目前支持 ASCII；请使用 CDXML 保存其他字符');return run;});
    const text=parts.map(r=>r.text).join(''),bytes=new Uint8Array(2+parts.length*10+text.length);bytes.set(int(parts.length));let offset=0;
    parts.forEach((run,i)=>{const a=run.attributes;bytes.set(int(offset),2+i*10);bytes.set(int(Number(a.font??3)),4+i*10);bytes.set(int(Number(a.face??0)),6+i*10);bytes.set(int(Math.round(Number(a.size??10)*20)),8+i*10);bytes.set(int(Number(a.color??0)),10+i*10);offset+=run.text.length;});bytes.set(new TextEncoder().encode(text),2+parts.length*10);out.set(0x0700,bytes);
  }
  return out;
}

export const cdxReactionProperties=roles;
