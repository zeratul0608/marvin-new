import {readdir,readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {Window} from 'happy-dom';
import {equivalentDocuments} from './document-correspondence.mjs';
const root='.local/chemdraw26-unpacked/files',output='docs/validation/expansion';await mkdir(output,{recursive:true});
const retry=process.argv.includes('--retry-failures')?JSON.parse(await readFile(`${output}/corpus-results.json`,'utf8')):undefined;
let window=new Window();const bind=()=>{for(const key of ['window','document','HTMLElement','customElements','DOMParser','XMLSerializer'])globalThis[key]=key==='window'?window:window[key];};bind();
const s=await import('../dist-sdk/chemical-editor.js'),files=[];
async function scan(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())await scan(p);else if(e.name.endsWith('.cdxml'))files.push(p);}}await scan(root);
const results=retry?[...retry.results]:[],failures=[],protectedCases=retry?[...retry.protectedCases]:[];
for(const file of files){
  const relative=path.relative(root,file).replaceAll('\\','/'),targets=retry?.failures.filter(f=>f.file===relative);if(retry&&!targets.length)continue;
  const raw=await readFile(file,'utf8');if(raw.trim()==='THIS FILE IS NOT A VALID INPUT FILE')continue;
  const doc=s.importDocument({data:raw}).document;
  const atoms=Object.values(doc.graph.atoms).filter(a=>a.substructure);
  if(retry)for(const target of targets)if(atoms.filter(a=>a.substructure.label===target.label&&a.substructure.connections.length===target.ports).length!==1)throw Error('Retry target is ambiguous; rerun the full audit');
  for(const atom of atoms){
    if(retry&&!targets.some(t=>t.label===atom.substructure.label&&t.ports===atom.substructure.connections.length))continue;
    if(process.env.EXPANSION_AUDIT_PROGRESS)console.log(`${path.basename(file)}: ${atom.substructure.label}`);
    const item={file:path.relative(root,file).replaceAll('\\','/'),label:atom.substructure.label,ports:atom.substructure.connections.length};
    let expanded;
    try{expanded=s.applyDocumentEdits(doc,[{type:'expand-substructure',atomId:atom.id}]).document;}
    catch(e){protectedCases.push({...item,stage:'edit',reason:e.message});continue;}
    try{
      const saved=s.exportSourceFile(expanded),back=s.importDocument({data:saved.data}).document;
      if(!equivalentDocuments(s,back,expanded))throw Error('Expanded source projection differs after identity correspondence');
      results.push({...item,expanded:true,sourceSaved:true});
    }catch(e){failures.push({...item,stage:'save',reason:e.message});}
    if(process.memoryUsage().heapUsed>100_000_000){await window.happyDOM.close();window=new Window();bind();globalThis.gc?.();}
  }
  if(process.memoryUsage().heapUsed>150_000_000){await window.happyDOM.close();window=new Window();bind();globalThis.gc?.();}
}
const summary={files:files.length,applicableTopLevelGroups:results.length+failures.length+protectedCases.length,editedAndSourceSaved:results.length,protected:protectedCases.length,saveFailures:failures.length};
await writeFile(`${output}/corpus-results.json`,JSON.stringify({summary,...(retry?{targetedFailuresRechecked:retry.failures.length}:{}),scope:'Each top-level abbreviation expanded independently; explicit unsupported/ambiguous cases reported as protected, not successful.'+(retry?' Targeted retries retain the prior full-audit results.':' Full file-set audit.'),results,protectedCases,failures},null,2)+'\n');
console.log(JSON.stringify({summary,protectionReasons:Object.fromEntries([...new Set(protectedCases.map(c=>c.reason))].map(r=>[r,protectedCases.filter(c=>c.reason===r).length])),failureReasons:Object.fromEntries([...new Set(failures.map(c=>c.reason))].map(r=>[r,failures.filter(c=>c.reason===r).length]))},null,2));if(failures.length)process.exitCode=1;
