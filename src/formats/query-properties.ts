import type {AtomQueryConstraints, Bond} from '../core/types';
import {atomRingBondCounts as ringBondCounts,atomUnsaturatedBonds as unsaturatedBondConditions,atomReactionStereos as reactionStereoConditions,bondTopologies} from '../core/query';
import {fail, integer} from './shared';

export {ringBondCounts,unsaturatedBondConditions,reactionStereoConditions,bondTopologies};
export const atomQueryXmlFields=['SubstituentsExactly','SubstituentsUpTo','RingBondCount','UnsaturatedBonds','RxnChange','RxnStereo'] as const;

const enumeration=<T extends string>(value:string,allowed:readonly T[],name:string):T=>{
 if(!(allowed as readonly string[]).includes(value))fail(`${name} 查询条件无效`,'INVALID_QUERY_CONSTRAINT');return value as T;
};
const count=(value:string)=>{const n=integer(value);if(!Number.isSafeInteger(n)||n<0||n>255)fail('取代数查询必须为 0–255 的整数','INVALID_QUERY_CONSTRAINT');return n;};

/** Query restrictions are independent of the element / generic-node selector. */
export function readXmlQueryConstraints(node:Element):AtomQueryConstraints|undefined{
 const result:AtomQueryConstraints={};
 if(node.hasAttribute('SubstituentsExactly'))result.substituentsExactly=count(node.getAttribute('SubstituentsExactly')!);
 if(node.hasAttribute('SubstituentsUpTo'))result.substituentsUpTo=count(node.getAttribute('SubstituentsUpTo')!);
 if(node.hasAttribute('RingBondCount'))result.ringBondCount=enumeration(node.getAttribute('RingBondCount')!,ringBondCounts,'环键数');
 if(node.hasAttribute('UnsaturatedBonds'))result.unsaturatedBonds=enumeration(node.getAttribute('UnsaturatedBonds')!,unsaturatedBondConditions,'不饱和键');
 if(node.hasAttribute('RxnStereo'))result.reactionStereo=enumeration(node.getAttribute('RxnStereo')!,reactionStereoConditions,'反应立体');
 if(node.hasAttribute('RxnChange')){const value=enumeration(node.getAttribute('RxnChange')!,['yes','no'],'反应变化');if(value==='yes')result.reactionChange=true;}
 return Object.keys(result).length?result:undefined;
}
export function queryConstraintXmlProperties(value:AtomQueryConstraints|undefined):Record<string,string>{
 if(!value)return {};
 return {...(value.substituentsExactly!==undefined?{SubstituentsExactly:String(value.substituentsExactly)}:{}),...(value.substituentsUpTo!==undefined?{SubstituentsUpTo:String(value.substituentsUpTo)}:{}),...(value.ringBondCount!==undefined?{RingBondCount:value.ringBondCount}:{}),...(value.unsaturatedBonds!==undefined?{UnsaturatedBonds:value.unsaturatedBonds}:{}),...(value.reactionChange?{RxnChange:'yes'}:{}),...(value.reactionStereo!==undefined?{RxnStereo:value.reactionStereo}:{})};
}
export function readXmlBondTopology(node:Element):Bond['topology']{
 return node.hasAttribute('Topology')?enumeration(node.getAttribute('Topology')!,bondTopologies,'键拓扑'):undefined;
}

// Published CDX SDK: INT8 enumerations, UINT8 counts and a zero-length implied
// Boolean. RingBondCount's Unspecified code is signed -1, not numeric zero.
export const atomQueryCdxTags=[0x0425,0x0426,0x0427,0x0428,0x0435,0x0436] as const;
const ringCodes:Record<number,NonNullable<AtomQueryConstraints['ringBondCount']>>={[-1]:'Unspecified',0:'NoRingBonds',1:'AsDrawn',2:'SimpleRing',3:'Fusion',4:'SpiroOrHigher'};
function byte(bytes:Uint8Array,signed=false):number{
 if(bytes.length!==1)fail('CDX 查询条件字段长度必须为一个字节','INVALID_QUERY_CONSTRAINT');return signed?new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getInt8(0):bytes[0];
}
const codeFor=(values:Record<number,string>,value:string)=>{const entry=Object.entries(values).find(([,label])=>label===value);if(!entry)fail('CDX 查询条件枚举无效','INVALID_QUERY_CONSTRAINT');return Number(entry[0]);};
export function queryConstraintCdxProperties(value:AtomQueryConstraints|undefined):Map<number,Uint8Array>{
 const result=new Map<number,Uint8Array>();if(!value)return result;
 const set=(tag:number,n:number)=>result.set(tag,new Uint8Array([n&255]));
 if(value.substituentsExactly!==undefined)set(0x0436,value.substituentsExactly);
 if(value.substituentsUpTo!==undefined)set(0x0435,value.substituentsUpTo);
 if(value.ringBondCount!==undefined)set(0x0425,codeFor(ringCodes,value.ringBondCount));
 if(value.unsaturatedBonds!==undefined)set(0x0426,unsaturatedBondConditions.indexOf(value.unsaturatedBonds));
 if(value.reactionStereo!==undefined)set(0x0428,reactionStereoConditions.indexOf(value.reactionStereo));
 if(value.reactionChange)result.set(0x0427,new Uint8Array());return result;
}
/** Also used by source CDX -> CDXML conversion, so no query tag can disappear. */
export function queryCdxPropertyToXml(tag:number,bytes:Uint8Array):[string,string]|undefined{
 if(tag===0x0436)return ['SubstituentsExactly',String(byte(bytes))];
 if(tag===0x0435)return ['SubstituentsUpTo',String(byte(bytes))];
 if(tag===0x0427){if(bytes.length!==0)fail('CDX RxnChange 必须使用零长度隐含布尔值','INVALID_QUERY_CONSTRAINT');return ['RxnChange','yes'];}
 const value=tag===0x0425?ringCodes[byte(bytes,true)]:tag===0x0426?unsaturatedBondConditions[byte(bytes)]:tag===0x0428?reactionStereoConditions[byte(bytes)]:undefined;
 if([0x0425,0x0426,0x0428].includes(tag)){if(value===undefined)fail('CDX 查询条件枚举超出支持范围','INVALID_QUERY_CONSTRAINT');return [tag===0x0425?'RingBondCount':tag===0x0426?'UnsaturatedBonds':'RxnStereo',value];}
 return;
}
export function readCdxQueryConstraints(properties:ReadonlyMap<number,Uint8Array>):AtomQueryConstraints|undefined{
 const result:AtomQueryConstraints={};
 for(const tag of atomQueryCdxTags){const bytes=properties.get(tag);if(!bytes)continue;const [name,value]=queryCdxPropertyToXml(tag,bytes)!;
  if(name==='SubstituentsExactly')result.substituentsExactly=Number(value);
  else if(name==='SubstituentsUpTo')result.substituentsUpTo=Number(value);
  else if(name==='RingBondCount')result.ringBondCount=value as AtomQueryConstraints['ringBondCount'];
  else if(name==='UnsaturatedBonds')result.unsaturatedBonds=value as AtomQueryConstraints['unsaturatedBonds'];
  else if(name==='RxnStereo')result.reactionStereo=value as AtomQueryConstraints['reactionStereo'];
  else result.reactionChange=true;
 }
 return Object.keys(result).length?result:undefined;
}
export function bondTopologyCdxProperties(bond:Bond):Map<number,Uint8Array>{
 return bond.topology===undefined?new Map():new Map([[0x0606,new Uint8Array([bondTopologies.indexOf(bond.topology)])]]);
}
export function readCdxBondTopology(properties:ReadonlyMap<number,Uint8Array>):Bond['topology']{
 const bytes=properties.get(0x0606);if(!bytes)return;const value=bondTopologies[byte(bytes)];if(value===undefined)fail('CDX 键拓扑枚举无效','INVALID_QUERY_CONSTRAINT');return value;
}
