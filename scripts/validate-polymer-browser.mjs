import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {showAdvancedEditor} from './browser-advanced-ui.mjs';
const {chromium}=await import(process.argv[2]||'playwright');
await mkdir('.local/polymer-downloads',{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),results=[];
try{
  const page=await browser.newPage({viewport:{width:1600,height:1100},acceptDownloads:true}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:5173/');await page.waitForFunction(()=>!!window.moleculeEditor);
  for(const name of ['sru-original.cdxml','multiple-original.cdx','nested-original.cdxml']){
    await page.locator('[data-action="import"]').first().click();await page.locator('.file-input').setInputFiles(`docs/validation/polymers/${name}`);
    await page.waitForFunction(name=>document.querySelector('chemical-editor').shadowRoot.querySelector('.import-filename').textContent===name,name);await page.locator('[data-action="apply-import"]').click();
    await page.waitForFunction(()=>!document.querySelector('chemical-editor').shadowRoot.querySelector('.import-dialog').open);
    await page.evaluate(()=>window.moleculeEditor.showPluginPanel());
    await showAdvancedEditor(page,'document');
    const group=await page.evaluate(()=>Object.values(window.moleculeEditor.getDocument().depiction.objects).find(o=>o.tag==='bracketedgroup').id);
    await page.locator('[data-document-object]').selectOption(group);assert.ok(await page.locator('[data-polymer-members] option:checked').count()>=2);
    await page.locator('[data-polymer-field="usage"]').selectOption('MultipleGroup');
    await page.locator('[data-polymer-field="repeatCount"]').fill('9.75');await page.locator('[data-polymer-field="repeatCount"]').dispatchEvent('change');
    await page.locator('[data-polymer-field="repeatPattern"]').selectOption('HeadToHead');await page.locator('[data-polymer-field="flipType"]').selectOption('Flip');
    await page.locator('[data-polymer-field="label"]').fill('repeat');await page.locator('[data-polymer-field="label"]').dispatchEvent('change');
    assert.ok(await page.locator('[data-bracket-type="Square"]').count()>=2);assert.ok((await page.locator('[data-polymer-label]').allTextContents()).includes('9.75'));
    const proof=await page.evaluate(async id=>{
      const sdk=await import('/src/index.ts'),api=window.moleculeEditor,doc=api.getDocument(),group=sdk.getPolymerGroup(doc,id);if(group.repeatCount!==9.75||group.repeatPattern!=='HeadToHead'||group.flipType!=='Flip'||group.label!=='repeat')throw Error('Visible edit failed');
      api.undo();if(sdk.getPolymerGroup(api.getDocument(),id).label==='repeat')throw Error('Undo failed');api.redo();if(JSON.stringify(api.getDocument())!==JSON.stringify(doc))throw Error('Redo failed');
      const engine=await sdk.loadChemistryEngine();let message='';try{engine.analyze(doc);}catch(e){message=e.message;}if(!message.includes('整个分子'))throw Error('Polymer was reported as a normal molecule');return {groups:Object.values(doc.depiction.objects).filter(o=>o.tag==='bracketedgroup').length,members:group.atomIds.length,crossings:group.crossings.length,calculationGuard:true};
    },group);
    const stable=await page.evaluate(()=>JSON.stringify(window.moleculeEditor.getDocument()));await page.locator('[data-polymer-field="repeatCount"]').fill('0');await page.locator('[data-polymer-field="repeatCount"]').dispatchEvent('change');assert.equal(await page.evaluate(()=>JSON.stringify(window.moleculeEditor.getDocument())),stable);
    await page.locator('[data-action="export"]').first().click();await page.locator('.export-format').selectOption('source');assert.equal(await page.locator('[data-action="download-export"]').isDisabled(),false);
    const pending=page.waitForEvent('download');await page.locator('[data-action="download-export"]').click();const download=await pending,file=`.local/polymer-downloads/${name}`;await download.saveAs(file);await page.locator('.export-dialog [data-action="close-dialog"]').click();
    await page.evaluate(async base64=>{const sdk=await import('/src/index.ts'),api=window.moleculeEditor,bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),back=sdk.importDocument({data:bytes}).document;if(JSON.stringify(sdk.documentProjection(back))!==JSON.stringify(sdk.documentProjection(api.getDocument())))throw Error('Actual download lost polymer semantics');},(await readFile(file)).toString('base64'));
    if(name==='multiple-original.cdx'){await page.evaluate(()=>window.moleculeEditor.fit());await page.screenshot({path:'.local/polymer-editor.png'});}
    results.push({file:name,...proof,visibleEdits:true,undoRedo:true,invalidInputAtomic:true,downloadedSourceRoundtrip:true});console.log(`Verified ${name}: typed edit, bracket drawing, undo and actual source download`);
  }
  assert.deepEqual(errors,[]);await writeFile('docs/validation/polymers/browser-results.json',JSON.stringify({browser:'Chrome',results,errors,aiTested:false},null,2)+'\n');
}finally{await browser.close();}
