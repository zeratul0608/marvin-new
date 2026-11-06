// Locally supplied source files stay private. Only per-target validation results
// are published; grouping is preserved instead of inventing an atom assignment.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {Window} from 'happy-dom';
import {equivalentDocuments} from './document-correspondence.mjs';
let window=new Window();
const bind=()=>{for(const key of ['window','document','HTMLElement','customElements','DOMParser','XMLSerializer'])globalThis[key]=key==='window'?window:window[key];};bind();
const sdk=await import('../dist-sdk/chemical-editor.js');
const directory='docs/validation/expanded-groups',manifest=JSON.parse(await readFile(`${directory}/targets.json`,'utf8')),results=[],failures=[];
const arg=(name,fallback)=>{const index=process.argv.indexOf(name);return index===-1?fallback:process.argv[index+1];},start=Number(arg('--start',0)),end=Number(arg('--end',manifest.targets.length)),output=arg('--output',`${directory}/corpus-results.json`);
assert.ok(Number.isInteger(start)&&Number.isInteger(end)&&start>=0&&end<=manifest.targets.length&&start<end,'Invalid target range');
await mkdir('.local/expanded-group-audit',{recursive:true});
const data=new Map();
const same=(actual,expected)=>assert.ok(equivalentDocuments(sdk,actual,expected),'Complete source projection differs');
const withoutDisplay=doc=>{const copy=structuredClone(doc);const visit=d=>{for(const a of Object.values(d.graph.atoms))if(a.substructure){delete a.substructure.display;a.substructure.fragments.forEach(f=>visit(f.document));}};visit(copy);return copy;};
function editOne(doc){
 const atom=Object.values(doc.graph.atoms).find(a=>a.element!=='*'&&!a.attachment&&!a.substructure);
 if(atom)return {document:sdk.applyDocumentEdits(doc,[{type:'update-atom',atomId:atom.id,changes:{isotope:(atom.isotope??({H:1,C:12,N:14,O:16,S:32,P:31,F:19,Cl:35,Br:79,I:127}[atom.element]??100))+1}}]).document,kind:'isotope'};
 const query=Object.values(doc.graph.atoms).find(a=>a.query);
 if(query){const value=structuredClone(query.query);value.label=(value.label??'query')+'_edited';if(value.kind==='elements')return {document:sdk.applyDocumentEdits(doc,[{type:'set-position',atomId:query.id,position:{x:doc.depiction.positions[query.id].x+.125,y:doc.depiction.positions[query.id].y}}]).document,kind:'query-position'};return {document:sdk.applyDocumentEdits(doc,[{type:'update-atom',atomId:query.id,changes:{query:value}}]).document,kind:'query-condition'};}
 const nested=Object.values(doc.graph.atoms).find(a=>a.substructure);
 if(nested){const group=structuredClone(nested.substructure),proof=editOne(group.fragments[0].document);group.fragments[0].document=proof.document;return {document:sdk.applyDocumentEdits(doc,[{type:'set-substructure',atomId:nested.id,substructure:group}]).document,kind:`nested-${proof.kind}`};}
 throw Error('No actual editable chemical content in branch');
}
for(const [index,target]of manifest.targets.entries()){
 if(index<start||index>=end)continue;
 const row={...target};
 try{
  if(!data.has(target.file))data.set(target.file,await readFile(path.join('.local/chemdraw26-unpacked/files',target.file),'utf8'));
  const raw=data.get(target.file),xml=new DOMParser().parseFromString(raw,'application/xml'),nodes=[...xml.getElementsByTagName('n')].filter(el=>{for(let parent=el.parentElement;parent;parent=parent.parentElement)if(parent.localName==='n')return false;return true;}),matches=nodes.map((el,i)=>({el,i})).filter(({el})=>el.getAttribute('id')===target.nativeId);
  assert.equal(matches.length,1,'Target native identity is ambiguous');
  const doc=sdk.importDocument({data:raw}).document,id=Object.keys(doc.graph.atoms)[matches[0].i],atom=doc.graph.atoms[id];assert.equal(atom.substructure?.label,target.label);
  const shown=sdk.applyDocumentEdits(doc,[{type:'set-substructure-display',atomId:id,expanded:true,recursive:true}]).document;
  same(withoutDisplay(shown),doc);assert.equal(shown.graph.atoms[id].substructure.display,'expanded');
  const svg=sdk.exportSvg(shown);assert.ok(svg.includes('data-expanded-path='));
  const viewSource=sdk.exportSourceFile(shown).data;same(sdk.importDocument({data:viewSource}).document,shown);await writeFile(`.local/expanded-group-audit/${String(index).padStart(4,'0')}-view.cdxml`,viewSource);row.viewSourceSaved=true;
  const group=structuredClone(shown.graph.atoms[id].substructure);row.branches=group.fragments.length;row.edits=[];
  for(const fragment of group.fragments){const proof=editOne(fragment.document);fragment.document=proof.document;row.edits.push(proof.kind);}
  const edited=sdk.applyDocumentEdits(shown,[{type:'set-substructure',atomId:id,substructure:group}]).document;
  const editedSource=sdk.exportSourceFile(edited).data;same(sdk.importDocument({data:editedSource}).document,edited);await writeFile(`.local/expanded-group-audit/${String(index).padStart(4,'0')}-edited.cdxml`,editedSource);row.allBranchesEditedAndSourceSaved=true;
  const json=sdk.importDocument({data:sdk.exportDocument(edited,{format:'json'}).data}).document;assert.ok(JSON.stringify(json)===JSON.stringify(edited),'JSON restoration changed serialized model or source');row.jsonRestored=true;
  const store=new sdk.DocumentStore(doc);store.replace(shown);store.replace(edited);store.undo();assert.deepEqual(store.document,shown);store.redo();assert.deepEqual(store.document,edited);row.undoRedo=true;
  results.push(row);
 }catch(error){failures.push({...row,error:error.message.split('\n')[0].slice(0,300)});}
 if((index-start+1)%10===0)console.log(`Checked ${index-start+1}/${end-start} [${start},${end}); failures=${failures.length}`);
 await window.happyDOM.close();window=new Window();bind();globalThis.gc?.();
}
await mkdir(directory,{recursive:true});const summary={targeted:end-start,expandedGroupView:results.length,editedBranches:results.reduce((n,r)=>n+r.branches,0),allBranchesEditedAndSourceSaved:results.filter(r=>r.allBranchesEditedAndSourceSaved).length,failures:failures.length};
await writeFile(output,JSON.stringify({scope:'Exact previously protected wrappers. Expanded editable group views retain the original wrapper, all alternatives, annotations, original boundary orders and object references. This is not a claim that ambiguous groups became a single flat molecule. Every branch receives an actual chemistry/query edit and is source-saved/reparsed with complete projection comparison, complete serialized-model/source JSON restoration and undo/redo.',range:{start,end},summary,results,failures},null,2)+'\n');console.log(JSON.stringify(summary,null,2));if(failures.length)process.exitCode=1;
