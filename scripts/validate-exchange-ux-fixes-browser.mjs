import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';

const {chromium}=await import(process.argv[2]||'playwright');
const out='.local/ux-fixes/exchange';await mkdir(`${out}/downloads`,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
const page=await context.newPage(),results=[],errors=[];
page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(15000);
const e=page.locator('chemical-editor').first(),snapshot=()=>page.evaluate(()=>window.moleculeEditor.getSnapshot());
const button=action=>e.locator(`[data-action="${action}"]:visible`).first();
const dismiss=async()=>{for(let i=0;i<4&&await page.locator('dialog:visible').count();i++)await page.keyboard.press('Escape');};
async function importFile(file){
 await dismiss();await button('import').click();const chooser=page.waitForEvent('filechooser');await button('choose-file').click();await(await chooser).setFiles(path.resolve(file));
 await page.waitForFunction(name=>document.querySelector('chemical-editor').shadowRoot.querySelector('.import-filename').textContent===name,path.basename(file));
 await button('apply-import').click();await e.locator('.import-dialog').waitFor({state:'hidden'});
}
async function task(id,title,fn){
 try{const detail=await fn();const evidence=`${out}/${id}.png`;await page.screenshot({path:evidence,fullPage:true});results.push({id,title,status:'passed',...detail,evidence});}
 catch(error){results.push({id,title,status:'failed',error:error.message});await page.screenshot({path:`${out}/${id}-failure.png`,fullPage:true});}
}
try{
 await page.goto('http://127.0.0.1:5173/');await page.waitForFunction(()=>!!window.moleculeEditor);
 await task('EXFIX01','导入明确替换，取消保留原文档',async()=>{
  const before=await snapshot();await button('import').click();assert.match(await e.locator('.import-replacement-notice').innerText(),/替换当前整份文档/);assert.equal(await button('apply-import').innerText(),'替换当前文档');
  await page.screenshot({path:`${out}/EXFIX01-import-confirmation.png`,fullPage:true});
  await e.locator('.import-source').fill(await readFile('public/examples/ethanol.cdxml','utf8'));await e.locator('.import-dialog [data-action="close-dialog"]').first().click();assert.deepEqual((await snapshot()).document,before.document);
 });
 await task('EXFIX02','拖入文件先确认，应用及撤销恢复',async()=>{
  const before=(await snapshot()).document,data=await readFile('public/examples/ethanol.cdxml','utf8');
  await page.evaluate(({data})=>{const transfer=new DataTransfer();transfer.items.add(new File([data],'dropped-ethanol.cdxml',{type:'text/xml'}));document.querySelector('chemical-editor').shadowRoot.querySelector('.canvas-area').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));},{data});
  await e.locator('.import-dialog').waitFor({state:'visible'});assert.deepEqual((await snapshot()).document,before);
  await button('apply-import').click();assert.equal(Object.keys((await snapshot()).document.graph.atoms).length,3);await button('undo').click();assert.deepEqual((await snapshot()).document,before);
 });
 await task('EXFIX03','复杂CDX跨格式可直达报告和源格式保留保存',async()=>{
  await importFile('tests/fixtures/cdx/dimethylamine-styled.cdx');const state=await snapshot(),atom=Object.values(state.document.graph.atoms).find(atom=>atom.element==='N');
  await e.locator('button[data-tool="select"]').click();await e.locator(`[data-atom="${atom.id}"] .atom-hit`).click();await e.locator('#atom-isotope').fill('15');await e.locator('#atom-isotope').press('Tab');
  await button('export').click();await e.locator('.export-format').selectOption('cdxml');assert.equal(await e.locator('.export-status').innerText(),'需要确认信息损失');assert.doesNotMatch(await e.locator('.export-message').innerText(),/0x3/);
  await page.screenshot({path:`${out}/EXFIX03-conversion-guidance.png`,fullPage:true});
  await button('export-issues').click();assert.match(await e.locator('.issue-list').innerText(),/0x3/);await page.screenshot({path:`${out}/EXFIX03-conversion-report.png`,fullPage:true});await e.locator('.issues-dialog [data-action="close-dialog"]').first().click();assert.equal(await e.locator('.export-format').inputValue(),'cdxml');
  await button('export-source-format').click();assert.equal(await e.locator('.export-format').inputValue(),'source');assert.equal(await button('download-export').isDisabled(),false);
  const expected=(await snapshot()).document,wait=page.waitForEvent('download');await button('download-export').click();const download=await wait,file=`${out}/downloads/${download.suggestedFilename()}`;await download.saveAs(file);
  await importFile(file);assert.equal(Object.values((await snapshot()).document.graph.atoms).find(atom=>atom.element==='N').isotope,15);
  return{download:file,expectedIsotope:expected.graph.atoms[atom.id].isotope};
 });
 await task('EXFIX04','查询MOL硬限制隐藏无效许可，JSON实际下载重开完整',async()=>{
  await importFile('public/test-files/15-query-constraints/native-all-fields.cdxml');const before=(await snapshot()).document;
  await button('export').click();await e.locator('.export-format').selectOption('mol');assert.equal(await e.locator('.export-status').innerText(),'暂不支持此转换');assert.equal(await e.locator('.lossy-option').isVisible(),false);assert.equal(await e.locator('.allow-lossy').isDisabled(),true);assert.equal(await button('download-export').isDisabled(),true);
  await page.screenshot({path:`${out}/EXFIX04-hard-limit.png`,fullPage:true});
  await button('export-json').click();const wait=page.waitForEvent('download');await button('download-export').click();const download=await wait,file=`${out}/downloads/${download.suggestedFilename()}`;await download.saveAs(file);await importFile(file);assert.deepEqual((await snapshot()).document,before);
  return{completeJsonRoundTrip:true};
 });
 await task('EXFIX05','可接受映射损失仍需明确确认，切格式后清除许可',async()=>{
  await importFile('public/examples/ethanol.cdxml');const atom=Object.values((await snapshot()).document.graph.atoms)[0];await e.locator('button[data-tool="select"]').click();await e.locator(`[data-atom="${atom.id}"] .atom-hit`).click();
  if(await e.locator('[data-action="toggle-advanced"]').getAttribute('aria-expanded')!=='true')await button('toggle-advanced').click();await e.locator('[data-advanced-section="properties"]').click();const map=e.locator('[data-property="atomMap"]');await map.fill('1');await map.press('Tab');
  await button('export').click();await e.locator('.export-format').selectOption('cdxml');assert.equal(await e.locator('.export-status').innerText(),'需要确认信息损失');assert.equal(await button('download-export').isDisabled(),true);await e.locator('.allow-lossy').check();assert.equal(await button('download-export').isDisabled(),false);await e.locator('.export-format').selectOption('json');await e.locator('.export-format').selectOption('cdxml');assert.equal(await e.locator('.allow-lossy').isChecked(),false);assert.equal(await button('download-export').isDisabled(),true);
 });
 await task('EXFIX06','英文窄屏提示和推荐操作完整可用',async()=>{
  await dismiss();await importFile('public/test-files/15-query-constraints/native-all-fields.cdxml');await e.locator('.locale-select').selectOption('en');await page.setViewportSize({width:390,height:844});await button('export').click();await e.locator('.export-format').selectOption('mol');
  for(const selector of ['.export-status','.export-message','[data-action="export-json"]','[data-action="export-issues"]'])assert.doesNotMatch(await e.locator(selector).innerText(),/[\u3400-\u9fff]/u);
  await page.screenshot({path:`${out}/EXFIX06-english-hard-limit.png`,fullPage:true});
  await button('export-json').click();assert.equal(await e.locator('.export-format').inputValue(),'json');assert.equal(await button('download-export').isDisabled(),false);
 });
}finally{
 await writeFile(`${out}/results.json`,JSON.stringify({method:'Chrome real UI only; SDK snapshots read-only; source files self-generated repository fixtures',results,errors,harnessCorrections:[{task:'EXFIX05',issue:'The first-run select-tool locator also matched the SVG carrying data-tool=select.',fix:'Scope the locator to button[data-tool=select]; no product code changed for this correction.',originalReport:`${out}/first-run.json`}]},null,2)+'\n');await browser.close();
}
console.log(JSON.stringify({tasks:results.length,passed:results.filter(row=>row.status==='passed').length,results,errors},null,2));
if(results.some(row=>row.status==='failed')||errors.length)process.exitCode=1;
