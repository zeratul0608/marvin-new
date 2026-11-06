import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';

const {chromium}=await import(process.argv[2]||'file:///C:/Users/admin/.codex/tools/playwright-mcp/node_modules/playwright/index.mjs');
const url=process.env.EDITOR_URL||'http://127.0.0.1:5173/';
const out='.local/ux-fixes/draft-ui';await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const errors=[],results=[],contexts=[],navigations=[];
const editor=page=>page.locator('chemical-editor').first();
const snapshot=page=>page.evaluate(()=>window.moleculeEditor.getSnapshot());
const documentOf=async page=>(await snapshot(page)).document;
async function context(){const result=await browser.newContext({viewport:{width:1440,height:1000}});contexts.push(result);return result;}
async function open(context){const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('framenavigated',frame=>{if(frame===page.mainFrame())navigations.push({at:Date.now(),url:frame.url()});});await page.goto(url);await page.waitForFunction(()=>!!window.moleculeEditor);return page;}
async function settled(page,expected){
 const button=editor(page).locator('.draft-versions-toggle');
 await button.waitFor({state:'visible'});
 await page.waitForFunction(expected=>{
  const state=document.querySelector('chemical-editor')?.shadowRoot?.querySelector('.draft-versions-toggle')?.dataset.state;
  return expected?state===expected:['saved','conflict','recovery-only','error'].includes(state);
 },expected);
 return button.getAttribute('data-state');
}
async function rename(page,title){const field=editor(page).locator('.document-title');await field.fill(title);await field.press('Tab');return settled(page);}
async function action(page,name){await editor(page).locator(`[data-action="${name}"]:visible`).first().click();}
async function reload(page){await page.reload();await page.waitForFunction(()=>!!window.moleculeEditor);}
async function versions(page){await action(page,'draft-versions');await editor(page).locator('.draft-version').first().waitFor();return editor(page).locator('.draft-version');}
async function restoreTitle(page,title){
 const rows=await versions(page);
 const row=rows.filter({has:page.locator('strong',{hasText:title})}).first();
 await row.locator('[data-draft-restore]').click();
 await editor(page).locator('.draft-versions-dialog').waitFor({state:'hidden'});
}
async function check(id,title,fn,pageOf){
 const started=Date.now();
 try{const detail=await fn()||{};results.push({id,title,status:'passed',durationMs:Date.now()-started,...detail});}
 catch(error){results.push({id,title,status:'failed',durationMs:Date.now()-started,error:error.stack||error.message});}
 console.log(`${id}: ${results.at(-1).status}`);
 const page=pageOf?.();if(page&&!page.isClosed())await page.screenshot({path:`${out}/${id}.png`,fullPage:true});
}
let main,a,b,aDocument,bDocument,concurrent,c,d,cDoc,dDoc,states,legacyPage;
try{
 await check('DR01','两个工作页交错保存后各自刷新恢复，旧问题不再覆盖',async()=>{
  main=await context();a=await open(main);await settled(a,'saved');
  await action(a,'templates');await editor(a).locator('[data-sample="ethanol"]').click();await settled(a,'saved');
  assert.equal(await rename(a,'Draft A base'),'saved');
  b=await open(main);assert.deepEqual(await documentOf(b),await documentOf(a));
  assert.equal(await rename(b,'Draft B oxygen minus one'),'saved');
  const oxygen=Object.values((await documentOf(b)).graph.atoms).find(atom=>atom.element==='O').id;
  await editor(b).locator('[data-tool="select"]').click();await editor(b).locator(`[data-atom="${oxygen}"] .atom-hit`).click();
  await editor(b).locator('#atom-charge').fill('-1');await editor(b).locator('#atom-charge').press('Tab');assert.equal(await settled(b),'saved');
  bDocument=await documentOf(b);assert.equal(bDocument.graph.atoms[oxygen].charge,-1);
  assert.equal(await rename(a,'Draft A independent'),'conflict');aDocument=await documentOf(a);
  assert.equal(aDocument.graph.atoms[oxygen].charge,0);assert.notEqual(aDocument.title,bDocument.title);
  await reload(a);await reload(b);assert.deepEqual(await documentOf(a),aDocument);assert.deepEqual(await documentOf(b),bDocument);
  await b.screenshot({path:`${out}/B-independent-after-reload.png`});
  return{aCharge:0,bCharge:-1,aTitle:aDocument.title,bTitle:bDocument.title,conflictWasVisible:true,exactReloadRecovery:true};
 },()=>a);
 await check('DR02','草稿列表同时包含双方版本，恢复后一步撤销精确恢复',async()=>{
  assert.ok(a&&b&&aDocument&&bDocument);
  const rows=await versions(a),labels=await rows.locator('strong').allTextContents();
  assert.ok(labels.includes(aDocument.title));assert.ok(labels.includes(bDocument.title));
  await rows.filter({has:a.locator('strong',{hasText:bDocument.title})}).first().locator('[data-draft-restore]').click();
  assert.deepEqual(await documentOf(a),bDocument);await settled(a);
  await action(a,'undo');assert.deepEqual(await documentOf(a),aDocument);await settled(a);
  return{listedTitles:labels,restoreExact:true,undoExact:true};
 },()=>a);
 await check('DR03','同一文档两页同时保存至少一方提示冲突，双方刷新保留修改',async()=>{
  concurrent=await context();c=await open(concurrent);await settled(c,'saved');await rename(c,'Concurrent base');
  d=await open(concurrent);assert.deepEqual(await documentOf(c),await documentOf(d));
  states=await Promise.all([rename(c,'Concurrent C retained'),rename(d,'Concurrent D retained')]);
  assert.ok(states.includes('conflict'),JSON.stringify(states));assert.ok(states.includes('saved'),JSON.stringify(states));
  cDoc=await documentOf(c);dDoc=await documentOf(d);await Promise.all([reload(c),reload(d)]);
  assert.deepEqual(await documentOf(c),cDoc);assert.deepEqual(await documentOf(d),dDoc);
  return{states,cTitle:cDoc.title,dTitle:dDoc.title,exactReloadRecovery:true};
 },()=>d);
 await check('DR04','提交输入后不等待异步保存便立即刷新，最新文档仍可恢复',async()=>{
  assert.ok(d&&dDoc);const before=await documentOf(d),title='Immediate reload kept';
  const field=editor(d).locator('.document-title');await field.fill(title);await field.press('Tab');
  // Intentionally do not await a saved/conflict status: synchronous page recovery must already exist.
  await reload(d);const after=await documentOf(d);assert.deepEqual(after,{...before,title});dDoc=after;
  return{savedTitle:after.title,waitedForAsyncSave:false,exactRecovery:true};
 },()=>d);
 await check('DR05','关闭全部工作页后，新页面可从版本列表恢复非共享分支',async()=>{
  assert.ok(c&&d&&states);const losingDoc=states[0]==='conflict'?await documentOf(c):await documentOf(d);
  await c.close();await d.close();c=await open(concurrent);
  await restoreTitle(c,losingDoc.title);assert.deepEqual(await documentOf(c),losingDoc);await settled(c);
  return{recoveredTitle:losingDoc.title,closedBothOriginalPages:true,exactRecovery:true};
 },()=>c);
 await check('DR06','旧版原始localStorage草稿可迁移，原记录保持原样',async()=>{
  const legacy=structuredClone(aDocument);legacy.id='legacy-draft-ui-fixture';legacy.title='Legacy original draft';
  const raw=JSON.stringify(legacy),key='molecule-workbench:v1',legacyContext=await context();
  await legacyContext.addInitScript(({key,raw})=>{
   if(!sessionStorage.getItem('draft-ui-fixture-seeded')){localStorage.setItem(key,raw);sessionStorage.setItem('draft-ui-fixture-seeded','1');}
  },{key,raw});
  legacyPage=await open(legacyContext);assert.deepEqual(await documentOf(legacyPage),legacy);await settled(legacyPage,'saved');
  assert.equal(await legacyPage.evaluate(key=>localStorage.getItem(key),key),raw);
  const migratedBranches=await legacyPage.evaluate(({key,id})=>Object.keys(localStorage).filter(name=>name.startsWith(`${key}:draft-v2:branch:`)&&JSON.parse(localStorage.getItem(name)).documentId===id).length,{key,id:legacy.id});
  assert.ok(migratedBranches>0,'Legacy migration must create an independent v2 recovery record');
  await rename(legacyPage,'Legacy migrated and edited');const edited=await documentOf(legacyPage);await reload(legacyPage);
  assert.deepEqual(await documentOf(legacyPage),edited);assert.equal(await legacyPage.evaluate(key=>localStorage.getItem(key),key),raw);
  return{oldRawPreserved:true,migratedRecoveryRecords:migratedBranches,editedMigrationReloadExact:true};
 },()=>legacyPage);
 await check('DR07','英文390px草稿入口可操作且无横向溢出',async()=>{
  assert.ok(legacyPage);await legacyPage.setViewportSize({width:390,height:844});
  await editor(legacyPage).locator('.locale-select').selectOption('en');
  const toggle=editor(legacyPage).locator('.draft-versions-toggle');assert.equal(await toggle.isVisible(),true);
  assert.match(await toggle.getAttribute('aria-label'),/draft/i);
  const box=await toggle.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=391,JSON.stringify(box));
  assert.equal(await legacyPage.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await versions(legacyPage);assert.match(await editor(legacyPage).locator('.draft-versions-dialog h2').innerText(),/draft/i);
  assert.equal(await legacyPage.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  return{viewport:390,draftEntryBox:box,horizontalOverflow:false};
 },()=>legacyPage);
}finally{
 const data={browser:'Chrome headless',method:'All edits, recovery, Undo and language changes through visible UI. Snapshots/storage reads assert correctness; addInitScript only seeds the legacy raw-draft fixture.',results,pageErrors:errors,navigations,developmentRunNote:'An earlier run correctly restored the legacy document but timed out waiting for the transient saved state while source files were being edited. That run remains in first-run.json. The unchanged saved-state assertion and explicit v2 recovery-record assertion pass with application source held stable.'};
 await writeFile(`${out}/results.json`,JSON.stringify(data,null,2)+'\n');
 await browser.close();
}
console.log(JSON.stringify({results,pageErrors:errors},null,2));
if(results.some(result=>result.status!=='passed')||errors.length)process.exitCode=1;
