/** A collision fallback, not the normal identity of a promoted child object. */
export function expandedId(kind:'a'|'b',wrapper:string,inner:string):string{
  const text=`${wrapper.length}:${wrapper}${inner}`;let hash=14695981039346656037n;
  for(let i=0;i<text.length;i++){hash^=BigInt(text.charCodeAt(i));hash=BigInt.asUintN(64,hash*1099511628211n);}
  return `${kind}_expanded_${hash.toString(16).padStart(16,'0')}`;
}

/** Retain the existing child identity when its parent namespace is free. The
 * same choice is used by editing and trusted native-source reconstruction. */
export function promotedId(kind:'a'|'b',wrapper:string,inner:string,occupied:ReadonlySet<string>):string{
  return occupied.has(inner)?expandedId(kind,wrapper,inner):inner;
}
