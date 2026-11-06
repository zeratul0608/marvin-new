import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {Window} from 'happy-dom';
import {equivalentDocuments} from './document-correspondence.mjs';
const window=new Window();for(const key of ['window','document','HTMLElement','customElements','DOMParser','XMLSerializer'])globalThis[key]=key==='window'?window:window[key];
const sdk=await import('../dist-sdk/chemical-editor.js'),directory='docs/validation/query-constraints',native=JSON.parse(await readFile(`${directory}/native-fixtures.json`,'utf8')),results=[];
const signature=doc=>{const atoms=Object.values(doc.graph.atoms),indices=new Map(atoms.map((a,i)=>[a.id,i]));return {atoms:atoms.map(a=>({element:a.element,...(a.queryConstraints?{queryConstraints:a.queryConstraints}:{})})),bonds:Object.values(doc.graph.bonds).map(b=>({atoms:b.atoms.map(id=>indices.get(id)),order:b.order,...(b.topology!==undefined?{topology:b.topology}:{})}))};};
const save=async(file,format,data)=>writeFile(`${directory}/${file}`,format==='cdx'?sdk.decodeCdx(data):data);
const record=async(scenario,file,format,data,expectedDoc,stage)=>{
 await save(file,format,data);const back=sdk.importDocument({data,format}).document;assert.ok(equivalentDocuments(sdk,back,expectedDoc),`${file}: complete query model differs`);
 results.push({scenario,file,format,stage,expected:signature(expectedDoc)});
};
for(const entry of native.results){
 const data=new Uint8Array(await readFile(`${directory}/${entry.file}`)),original=sdk.importDocument({data,format:entry.format}).document;assert.deepEqual(signature(original),entry.expected);
 results.push({...entry,stage:'independent-native-import'});
 const fresh=structuredClone(original);delete fresh.source;const rebuilt=sdk.exportDocument(fresh,{format:entry.format});await record(entry.scenario,`rebuilt-${entry.scenario}.${entry.format}`,entry.format,rebuilt.data,fresh,'sdk-rebuild-explicit-native-values');
 const carbon=Object.values(original.graph.atoms).find(a=>a.element==='C'),edge=Object.values(original.graph.bonds)[0],queryConstraints={substituentsExactly:0,substituentsUpTo:255,ringBondCount:'AsDrawn',unsaturatedBonds:'MustBeAbsent',reactionStereo:'Retention',...(!carbon.queryConstraints?.reactionChange?{reactionChange:true}:{})};
 const edited=sdk.applyDocumentEdits(original,[{type:'update-atom',atomId:carbon.id,changes:{queryConstraints}},{type:'set-bond-annotations',bondId:edge.id,changes:{topology:'RingOrChain'}}]).document;
 const source=sdk.exportSourceFile(edited);await record(entry.scenario,`edited-${entry.scenario}.${entry.format}`,entry.format,source.data,edited,'source-add-change-and-rxn-clear');
 const other=entry.format==='cdx'?'cdxml':'cdx',converted=sdk.exportDocument(edited,{format:other});await record(entry.scenario,`converted-${entry.scenario}-from-${entry.format}.${other}`,other,converted.data,edited,'strict-cross-format-query-preservation');
 const cleared=sdk.applyDocumentEdits(edited,[{type:'update-atom',atomId:carbon.id,changes:{queryConstraints:null}},{type:'set-bond-annotations',bondId:edge.id,changes:{topology:null}}]).document;
 await record(entry.scenario,`cleared-${entry.scenario}.${entry.format}`,entry.format,sdk.exportSourceFile(cleared).data,cleared,'source-remove-all-query-fields');
 const restored=sdk.importDocument({data:sdk.exportDocument(edited,{format:'json'}).data}).document;assert.equal(JSON.stringify(restored),JSON.stringify(edited));assert.equal(sdk.exportSourceFile(restored).data,source.data);
 const store=new sdk.DocumentStore(original);store.replace(edited);store.undo();assert.equal(JSON.stringify(store.document),JSON.stringify(original));store.redo();assert.equal(JSON.stringify(store.document),JSON.stringify(edited));
}
await writeFile(`${directory}/adapter-results.json`,JSON.stringify({scope:'Native Python-authored fixtures imported by SDK, then freshly rebuilt, chemically query-edited/source-saved, strictly cross-converted and completely cleared. Every SDK output is fully reparsed and compared; JSON and history are also verified. No query matching or ordinary-molecule calculation is claimed.',nativeInputs:native.results.length,filesPrepared:results.length,results},null,2)+'\n');console.log(`Verified ${native.results.length} native inputs and prepared ${results.length} query files.`);
