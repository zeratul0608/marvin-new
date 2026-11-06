import {bracketUsages,polymerFlipTypes,polymerRepeatPatterns} from '../core/polymers';
import {fail} from './shared';
export const bracketObjectNames:Record<number,string>={0x8017:'bracketedgroup',0x8018:'bracketattachment',0x8019:'crossingbond'};
export const bracketReferenceProperties:Record<number,string>={0x0a27:'BracketedObjectIDs',0x0a2b:'GraphicID',0x0a2c:'BondID',0x0a2d:'InnerAtomID'};
const enums:Record<number,{name:string;values:readonly string[]}>={0x0a24:{name:'BracketUsage',values:bracketUsages},0x0a25:{name:'PolymerRepeatPattern',values:polymerRepeatPatterns},0x0a26:{name:'PolymerFlipType',values:polymerFlipTypes}};
const uint=(bytes:Uint8Array)=>{if(![1,2,4].includes(bytes.length))fail('CDX 括号属性整数长度无效');const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.length);return bytes.length===1?v.getUint8(0):bytes.length===2?v.getUint16(0,true):v.getUint32(0,true);};
export function readBracketProperty(tag:number,bytes:Uint8Array):[string,string]|undefined{
  if(enums[tag]){const e=enums[tag],value=e.values[uint(bytes)];if(value===undefined)fail('CDX 括号属性枚举无效');return [e.name,value];}
  if(bracketReferenceProperties[tag]){if(bytes.length%4||tag!==0x0a27&&bytes.length!==4)fail('CDX 括号引用长度无效');return [bracketReferenceProperties[tag],Array.from({length:bytes.length/4},(_,i)=>uint(bytes.subarray(i*4,i*4+4))).join(' ')];}
  if(tag===0x0a28){if(bytes.length!==8)fail('CDX 重复次数必须为 FLOAT64');const value=new DataView(bytes.buffer,bytes.byteOffset,8).getFloat64(0,true);if(!Number.isFinite(value)||value<=0)fail('CDX 重复次数必须为正数');return ['RepeatCount',String(value)];}
  if(tag===0x0a29){if(bytes.length!==2)fail('CDX 组分顺序长度无效');return ['ComponentOrder',String(new DataView(bytes.buffer,bytes.byteOffset,2).getInt16(0,true))];}
  if(tag===0x0a2a){if(bytes.length<2)fail('CDX SRU 标签截断');const styles=uint(bytes.subarray(0,2)),start=2+10*styles;if(start>bytes.length||bytes.subarray(start).some(b=>b>127||b<32))fail('CDX SRU 标签的此字符集尚未完整映射，请使用 CDXML');return ['SRULabel',new TextDecoder().decode(bytes.subarray(start))];}
}
export function writeBracketProperty(name:string,value:string|undefined):[number,Uint8Array|undefined]|undefined{
  const tag=Object.keys(enums).map(Number).find(t=>enums[t].name===name)??({RepeatCount:0x0a28,ComponentOrder:0x0a29,SRULabel:0x0a2a}as Record<string,number>)[name];
  if(tag===undefined)return;if(value===undefined)return [tag,undefined];
  if(enums[tag]){const code=enums[tag].values.indexOf(value);if(code<0)fail('CDX 括号枚举无效');return [tag,Uint8Array.of(code)];}
  if(tag===0x0a28){const n=Number(value);if(!Number.isFinite(n)||n<=0)fail('重复次数必须为有限正数');const bytes=new Uint8Array(8);new DataView(bytes.buffer).setFloat64(0,n,true);return [tag,bytes];}
  if(tag===0x0a29){const n=Number(value);if(!Number.isInteger(n)||n<0||n>32767)fail('组分顺序超出 CDX 范围');const bytes=new Uint8Array(2);new DataView(bytes.buffer).setInt16(0,n,true);return [tag,bytes];}
  if(/[^\x20-\x7e]/.test(value))fail('CDX SRU 标签写入目前支持 ASCII；其他字符请保存 CDXML');
  return [tag,Uint8Array.of(0,0,...new TextEncoder().encode(value))];
}
