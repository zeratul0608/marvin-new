import type { MainModule } from '@rdkit/rdkit';
import { createChemistryEngine, type ChemistryEngine } from './engine';

/** Locally shipped, pinned WASM assets. No structure data leaves this browser. */
export const RDKIT_PACKAGE_VERSION = '2026.9.1';
let loading:Promise<ChemistryEngine>|undefined;
export function loadChemistryEngine():Promise<ChemistryEngine>{
  if(!loading)loading=(async()=>{
    if(typeof document==='undefined')throw new Error('浏览器计算模块需要 DOM；Node.js 请使用 createChemistryEngine 注入 RDKit 模块。');
    const base=new URL(['rdkit',RDKIT_PACKAGE_VERSION].join('-')+'/',import.meta.url);
    const host=globalThis as typeof globalThis&{initRDKitModule?:(options:unknown)=>Promise<MainModule>};
    if(!host.initRDKitModule)await new Promise<void>((resolve,reject)=>{
      const script=document.createElement('script');script.src=new URL('RDKit_minimal.js',base).href;script.async=true;
      const timeout=setTimeout(()=>{script.remove();reject(new Error('本地化学计算模块加载超时，请检查应用的静态资源。'));},30000);
      script.onload=()=>{clearTimeout(timeout);resolve();};script.onerror=()=>{clearTimeout(timeout);script.remove();reject(new Error('本地化学计算模块未能加载，请确认 RDKit 静态资源已部署。'));};document.head.append(script);
    });
    if(!host.initRDKitModule)throw new Error('RDKit 模块入口缺失');
    const module=await host.initRDKitModule({locateFile:(name:string)=>new URL(name,base).href});
    return createChemistryEngine(module);
  })().catch(error=>{loading=undefined;throw error;});
  return loading;
}
