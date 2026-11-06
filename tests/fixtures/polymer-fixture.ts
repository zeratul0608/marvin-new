// Independently assembled from the public CDX specification, not our writer.
const uint=(n:number,width=2)=>Array.from({length:width},(_,i)=>(n>>>(8*i))&255);
const prop=(tag:number,bytes:number[])=>[...uint(tag),...uint(bytes.length),...bytes];
const object=(tag:number,id:number,data:number[])=>[...uint(tag),...uint(id,4),...data,0,0];
const coords=(tag:number,values:number[])=>prop(tag,values.flatMap(n=>uint(Math.round(n*65536),4)));
export const polymerXml='<CDXML><page id="1"><fragment id="2"><n id="3" p="0 0"/><n id="4" p="30 0"/><n id="5" p="60 0"/><n id="6" p="90 0"/><b id="7" B="3" E="4"/><b id="8" B="4" E="5"/><b id="9" B="5" E="6"/></fragment><graphic id="10" GraphicType="Bracket" BracketType="Square" BoundingBox="15 20 15 -20"/><graphic id="11" GraphicType="Bracket" BracketType="Square" BoundingBox="75 -20 75 20"/><bracketedgroup id="12" BracketUsage="SRU" PolymerRepeatPattern="HeadToTail" PolymerFlipType="Unspecified" SRULabel="n" BracketedObjectIDs="4 5"><bracketattachment id="13" GraphicID="10"><crossingbond id="14" BondID="7" InnerAtomID="4"/></bracketattachment><bracketattachment id="15" GraphicID="11"><crossingbond id="16" BondID="9" InnerAtomID="5"/></bracketattachment></bracketedgroup></page></CDXML>';
export function polymerCdx(repeat=3.5):Uint8Array{
  const header=[...new TextEncoder().encode('VjCD0100'),4,3,2,1,...Array(10).fill(0)];
  const atoms=[3,4,5,6].flatMap((id,i)=>object(0x8004,id,coords(0x0200,[0,i*30])));
  const bonds=[7,8,9].flatMap((id,i)=>object(0x8005,id,[...prop(0x0604,uint(i+3,4)),...prop(0x0605,uint(i+4,4)),...prop(0x0600,uint(1))]));
  const graphics=[10,11].flatMap((id,i)=>object(0x8007,id,[...prop(0x0a00,uint(6)),...prop(0x0a06,uint(3)),...coords(0x0204,i? [-20,75,20,75]:[20,15,-20,15])]));
  const floating=new Uint8Array(8);new DataView(floating.buffer).setFloat64(0,repeat,true);
  const group=object(0x8017,12,[...prop(0x0a24,[16]),...prop(0x0a25,[0]),...prop(0x0a26,[0]),...prop(0x0a27,[...uint(4,4),...uint(5,4)]),...prop(0x0a28,[...floating]),...prop(0x0a29,uint(2)),...prop(0x0a2a,[0,0,110]),
    ...object(0x8018,13,[...prop(0x0a2b,uint(10,4)),...object(0x8019,14,[...prop(0x0a2c,uint(7,4)),...prop(0x0a2d,uint(4,4))])]),
    ...object(0x8018,15,[...prop(0x0a2b,uint(11,4)),...object(0x8019,16,[...prop(0x0a2c,uint(9,4)),...prop(0x0a2d,uint(5,4))])]),
  ]);
  return new Uint8Array([...header,...object(0x8000,100,object(0x8001,1,[...object(0x8003,2,[...atoms,...bonds]),...graphics,...group]))]);
}
