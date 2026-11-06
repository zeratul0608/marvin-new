import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
// Backend integration probe: isolated real Chrome pages; this intentionally exercises storage APIs directly.
const {chromium}=await import(process.argv[2] || 'playwright');
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext();
const a=await context.newPage(),b=await context.newPage();
const key='draft-native-'+Date.now();
const results=[];
try {
 await a.goto('http://127.0.0.1:5173/');await a.waitForFunction(()=>!!window.moleculeEditor);await a.waitForLoadState('networkidle');
 await a.evaluate(async key=>{
  const {BrowserDraftStore}=await import('/src/editor/drafts.ts');const {emptyDocument,addAtom}=await import('/src/core/model.ts');
  window.nativeDraft=new BrowserDraftStore({storageKey:key});
  window.nativeDoc=emptyDocument('Original');addAtom(window.nativeDoc,'O',{x:0,y:0});
  window.nativeSeed=await window.nativeDraft.save(window.nativeDoc);
 },key);
 await b.goto('http://127.0.0.1:5173/');await b.waitForFunction(()=>!!window.moleculeEditor);await b.waitForLoadState('networkidle');
 const restore=await b.evaluate(async key=>{const {BrowserDraftStore}=await import('/src/editor/drafts.ts');window.nativeDraft=new BrowserDraftStore({storageKey:key});const restored=window.nativeDraft.restore();window.nativeDoc=restored.record.document;return restored;},key);
 assert.equal(restore.record.document.title,'Original');
 const [ra,rb]=await Promise.all([
  a.evaluate(async()=>{window.nativeDoc.title='Tab A';const r=await window.nativeDraft.save(window.nativeDoc);return {status:r.status,title:r.record.document.title};}),
  b.evaluate(async()=>{Object.values(window.nativeDoc.graph.atoms)[0].charge=-1;const r=await window.nativeDraft.save(window.nativeDoc);return {status:r.status,charge:Object.values(r.record.document.graph.atoms)[0].charge};})
 ]);
 assert.deepEqual([ra.status,rb.status].sort(),['conflict','saved']);results.push({name:'actual-IDB-cross-tab-CAS',ra,rb,passed:true});
 await b.reload();await b.waitForFunction(()=>!!window.moleculeEditor);await b.waitForLoadState('networkidle');
 const recovered=await b.evaluate(async key=>{const {BrowserDraftStore}=await import('/src/editor/drafts.ts');window.nativeDraft=new BrowserDraftStore({storageKey:key});const restored=window.nativeDraft.restore();return {title:restored.record.document.title,charge:Object.values(restored.record.document.graph.atoms)[0].charge,versions:(await window.nativeDraft.list()).length};},key);
 assert.equal(recovered.charge,-1);assert.ok(recovered.versions>=3);results.push({name:'reload-own-branch-preserved',...recovered,passed:true});
 const history=await a.evaluate(async key=>{const {BrowserDraftStore}=await import('/src/editor/drafts.ts');const {emptyDocument}=await import('/src/core/model.ts');const store=new BrowserDraftStore({storageKey:key+'-history'});const doc=emptyDocument('history');for(let i=0;i<45;i++){doc.title=String(i);await store.save(doc);}const versions=await store.list();return {count:versions.length,latest:versions[0].document.title};},key);
 assert.equal(history.count,20);assert.equal(history.latest,'44');results.push({name:'actual-IDB-history-bounded',...history,passed:true});
 await mkdir('.local/ux-fixes',{recursive:true});await writeFile('.local/ux-fixes/draft-backend-native.json',JSON.stringify({browser:'Chrome',results},null,2));console.log(JSON.stringify(results,null,2));
} finally {await browser.close();}
