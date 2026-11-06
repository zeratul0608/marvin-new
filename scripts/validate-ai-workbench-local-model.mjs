import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const {chromium}=await import(process.argv[2]||'playwright');
const output='.local/ai-upgrade';await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const report={model:'qwen3.6-27b',ui:'real workbench',passed:false};
try{
 const page=await browser.newPage({viewport:{width:1280,height:1000}});page.setDefaultTimeout(150000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://127.0.0.1:5173/');await page.waitForFunction(()=>!!window.moleculeEditor);
 const editor=page.locator('chemical-editor').first();
 const before=await page.evaluate(async()=>{
  const sdk=await import('/src/index.ts'),api=window.moleculeEditor;api.setDocument(sdk.exampleDocument('ethanol'));
  const oxygen=Object.values(api.getDocument().graph.atoms).find(atom=>atom.element==='O').id;
  api.setSelection({atomIds:[oxygen]});api.showPluginPanel('ai-assistant');return{oxygen,document:api.getDocument()};
 });
 await page.waitForFunction(()=>!document.querySelector('chemical-editor').shadowRoot.querySelector('[data-ai-action="send"]').disabled);
 await editor.locator('[data-ai-field="preview-edits"]').check();
 await editor.locator('[data-ai-field="message"]').fill('只把当前选中的氧原子标记为氧-18，保留其它原子、键和布局，不做其它修改。');
 await editor.locator('[data-ai-action="send"]').click();
 const pending=editor.locator('.ai-review-slot .ai-edit-preview[data-review-state="pending"]');await pending.waitFor({state:'visible'});
 assert.deepEqual(await page.evaluate(()=>window.moleculeEditor.getDocument()),before.document);
 await page.screenshot({path:`${output}/workbench-qwen-preview.png`});
 await editor.locator('.ai-review-slot [data-ai-action="approve-edit"]').click();
 await page.waitForFunction(()=>document.querySelector('chemical-editor').shadowRoot.querySelector('[data-ai-action="stop"]').disabled);
 const after=await page.evaluate(()=>window.moleculeEditor.getDocument());
 const expected=structuredClone(before.document);expected.graph.atoms[before.oxygen].isotope=18;assert.deepEqual(after,expected);
 assert.equal(await editor.locator('.ai-edit-preview[data-review-state="applied"]').count(),1);
 await page.screenshot({path:`${output}/workbench-qwen-applied.png`});
 await editor.locator('[data-action="undo"]').click();assert.deepEqual(await page.evaluate(()=>window.moleculeEditor.getDocument()),before.document);
 assert.deepEqual(errors,[]);
 report.passed=true;report.previewDidNotMutate=true;report.userApprovedRealModelBatch=true;report.exactOxygen18Change=true;report.oneStepUndo=true;report.errors=errors;
 console.log('Real Qwen workbench UI: preview, approval, exact O-18 edit and undo passed');
}catch(error){report.error=error.message;throw error;}
finally{await browser.close();await writeFile(`${output}/workbench-model-results.json`,JSON.stringify(report,null,2)+'\n');}
