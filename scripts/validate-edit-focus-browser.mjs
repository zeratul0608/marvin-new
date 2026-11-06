import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const {chromium}=await import(process.argv[2]||'file:///C:/Users/admin/.codex/tools/playwright-mcp/node_modules/playwright/index.mjs');
const out='.local/ux-fixes/focus';await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
const page=await context.newPage(),errors=[],results=[];page.on('pageerror',error=>errors.push(error.message));
const editor=page.locator('chemical-editor').first(),snap=()=>page.evaluate(()=>window.moleculeEditor.getSnapshot());
const action=name=>editor.locator(`[data-action="${name}"]:visible`).first().click();
const active=()=>editor.evaluate(el=>{const node=el.shadowRoot.activeElement;return node?.id||node?.className||node?.tagName||null;});
async function check(id,fn){try{const result=await fn();results.push({id,status:'pass',...result});}catch(error){results.push({id,status:'failed',error:error.message});}await page.screenshot({path:`${out}/${id}.png`});}
try{
 await page.goto('http://127.0.0.1:5173/');await page.waitForFunction(()=>!!window.moleculeEditor);
 await action('templates');await editor.locator('[data-sample="ethanol"]').click();
 const oxygen=Object.values((await snap()).document.graph.atoms).find(atom=>atom.element==='O').id;
 await editor.locator('.document-title').fill('Process ethanol');await editor.locator('.document-title').press('Tab');
 await editor.locator('[data-tool="select"]').click();await editor.locator(`[data-atom="${oxygen}"] .atom-hit`).click();
 await check('F01-tab-native-undo',async()=>{
  await editor.locator('#atom-isotope').fill('18');await editor.locator('#atom-isotope').press('Tab');
  assert.equal(await active(),'atom-hydrogens');await page.keyboard.press('Control+z');
  assert.equal((await snap()).document.graph.atoms[oxygen].isotope,undefined);assert.equal((await snap()).document.title,'Process ethanol');
  await page.keyboard.press('Control+y');assert.equal((await snap()).document.graph.atoms[oxygen].isotope,18);
  return{active:await active(),title:(await snap()).document.title};
 });
 await check('F02-continuous-tab-and-mouse',async()=>{
  await editor.locator('#atom-charge').click();await page.keyboard.press('Control+a');await page.keyboard.type('-1');await page.keyboard.press('Tab');
  assert.equal(await active(),'atom-isotope');await page.keyboard.press('Control+a');await page.keyboard.type('17');await page.keyboard.press('Tab');
  assert.equal((await snap()).document.graph.atoms[oxygen].isotope,17);assert.equal((await snap()).document.graph.atoms[oxygen].charge,-1);
  await editor.locator('#atom-charge').fill('0');await editor.locator('#atom-isotope').click();await page.keyboard.press('Control+a');await page.keyboard.type('18');await page.keyboard.press('Tab');
  assert.equal((await snap()).document.graph.atoms[oxygen].isotope,18);assert.equal((await snap()).document.graph.atoms[oxygen].charge,0);
  return{active:await active(),title:(await snap()).document.title};
 });
 await check('F03-save-pending-title',async()=>{
  await editor.locator('.document-title').fill('Saved without blur');await page.keyboard.press('Control+s');
  assert.equal(await editor.locator('.export-dialog').evaluate(el=>el.open),true);
  const preview=JSON.parse(await editor.locator('.export-source').inputValue());assert.equal(preview.title,'Saved without blur');
  await editor.locator('.export-dialog [data-action="close-dialog"]').click();return{title:preview.title};
 });
 await check('F04-save-pending-field',async()=>{
  await editor.locator('#atom-isotope').fill('19');await page.keyboard.press('Control+s');
  const preview=JSON.parse(await editor.locator('.export-source').inputValue());assert.equal(preview.graph.atoms[oxygen].isotope,19);
  await editor.locator('.export-dialog [data-action="close-dialog"]').click();return{isotope:preview.graph.atoms[oxygen].isotope};
 });
 await check('F05-invalid-save-blocked',async()=>{
  await editor.locator('#atom-isotope').fill('0');await page.keyboard.press('Control+s');
  assert.equal(await editor.locator('.export-dialog').evaluate(el=>el.open),false);assert.equal((await snap()).document.graph.atoms[oxygen].isotope,19);
  return{message:await editor.locator('.toast').innerText()};
 });
}finally{await writeFile(`${out}/results.json`,JSON.stringify({results,errors,uiOnlyMutations:true},null,2));await browser.close();}
console.log(JSON.stringify({results,errors},null,2));
if(results.some(result=>result.status!=='pass')||errors.length)process.exitCode=1;
