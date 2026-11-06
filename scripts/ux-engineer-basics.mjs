import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';

const {chromium}=await import(process.argv[2]||'playwright');
const out=process.env.UX_OUTPUT_DIR||'.local/ux-engineer/basics';await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
const page=await context.newPage(),errors=[],results=[],findings=[];
page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(15000);
const editor=page.locator('chemical-editor').first();
const snap=()=>page.evaluate(()=>window.moleculeEditor.getSnapshot());
const shot=async(name)=>{const path=`${out}/${name}.png`;await page.screenshot({path,fullPage:true});return path;};
const clickAction=action=>editor.locator(`[data-action="${action}"]:visible`).first().click();
const atom=id=>editor.locator(`[data-atom="${id}"] .atom-hit`);
async function run(id,title,fn){
  const start=Date.now();
  try{const detail=await fn()||{};results.push({id,title,status:'pass',durationMs:Date.now()-start,...detail,evidence:await shot(id)});}
  catch(error){results.push({id,title,status:'failed',durationMs:Date.now()-start,error:error.message,evidence:await shot(id+'-failure')});console.error(`${id}: ${error.message}`);}
}
async function clear(){await clickAction('clear');await editor.locator('.clear-dialog [data-action="confirm-clear"]').click();}
async function drag(from,to){await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:8});await page.mouse.up();}
const center=box=>({x:box.x+box.width/2,y:box.y+box.height/2});
let ethanol,oxygen;
try{
 await page.goto('http://127.0.0.1:5173/');await page.waitForFunction(()=>!!window.moleculeEditor);
 await run('B01','初次打开和基础/高级功能发现',async()=>{
  assert.equal(await editor.locator('[data-action="toggle-advanced"]').getAttribute('aria-expanded'),'false');
  assert.equal(await editor.locator('[data-tool="bond"]').first().isVisible(),true);
  return{initialAtoms:Object.keys((await snap()).document.graph.atoms).length,observation:'默认示例有结构；基础工具可见，高级工具初始收起。'};
 });
 await run('B02','取消清空不损失文档',async()=>{
  const before=await snap();await clickAction('clear');await editor.locator('.clear-dialog [data-action="close-dialog"]').last().click();assert.deepEqual(await snap(),before);
 });
 await run('B03','从空白手绘乙醇',async()=>{
  await clear();await editor.locator('[data-tool="bond"]').first().click();
  const canvas=await editor.locator('.canvas').boundingBox(),start={x:canvas.x+canvas.width*.35,y:canvas.y+canvas.height*.52};
  await drag(start,{x:start.x+100,y:start.y});let state=await snap();assert.equal(Object.keys(state.document.graph.atoms).length,2);
  const end=center(await atom(state.selection.atomIds[0]).boundingBox());await drag(end,{x:end.x+95,y:end.y-55});
  await editor.locator('[data-element="O"]').click();state=await snap();
  assert.equal(Object.keys(state.document.graph.atoms).length,3);assert.equal(Object.keys(state.document.graph.bonds).length,2);
  assert.equal(Object.values(state.document.graph.atoms).filter(a=>a.element==='O').length,1);
  oxygen=Object.values(state.document.graph.atoms).find(a=>a.element==='O').id;ethanol=state.document;
  return{formula:await editor.locator('.formula').innerText(),readOnlyProof:state.document.graph,interaction:'两次真实拖动绘制碳骨架，然后将端点换为氧。'};
 });
 await run('B04','文档命名及同位素基本属性',async()=>{
  const title=editor.locator('.document-title');await title.fill('工艺研发 · 溶剂乙醇 V1');await title.press('Tab');
  await editor.locator('[data-tool="select"]').click();await atom(oxygen).click();
  const field=editor.locator('#atom-isotope');await field.fill('18');await field.press('Tab');
  const state=await snap();assert.equal(state.document.graph.atoms[oxygen].isotope,18);assert.equal(state.document.title,'工艺研发 · 溶剂乙醇 V1');
 });
 await run('B05','字段失焦后的Ctrl+Z是否可预期',async()=>{
  const before=await snap();await page.keyboard.press('Control+z');const after=await snap();
  if(after.document.graph.atoms[oxygen].isotope===18){
   findings.push({id:'B-F01',severity:'P2',title:'属性提交后的焦点与原生撤销交互不一致',steps:['先命名文档','修改氧同位素为18','Tab离开字段','Ctrl+Z','再次点击同位素字段并输入'],expected:'撤销目标与焦点可预期，继续输入应进入被点击的字段。',actual:'文档仍为18O；独立复现中浏览器原生Undo回退标题输入，后续标题失焦提交触发重绘，可能丢失属性输入焦点。顶部Undo对已提交事务工作正常。',evidence:[`${out}/B05.png`,`${out}/undo-debug.md`,`${out}/undo-debug.json`]});
   return{status:'friction',unchanged:JSON.stringify(before)===JSON.stringify(after),isotopeFieldAfterNativeUndo:await editor.locator('#atom-isotope').inputValue()};
  }
  assert.equal(after.document.graph.atoms[oxygen].isotope,undefined);await clickAction('redo');
 });
 await run('B06','撤销重做按钮准确恢复',async()=>{
  // End any pending native title edit before testing document history independently.
  await editor.locator('.canvas').focus();
  const title=(await snap()).document.title;
  for(const value of ['19','18']){
   const field=editor.locator('#atom-isotope');await field.click();await field.fill(value);await field.press('Tab');await editor.locator('.canvas').focus();
   const state=await snap();assert.equal(state.document.graph.atoms[oxygen].isotope,Number(value));assert.equal(state.document.title,title);
  }
  assert.equal((await snap()).document.graph.atoms[oxygen].isotope,18);
  await clickAction('undo');assert.equal((await snap()).document.graph.atoms[oxygen].isotope,19);
  await clickAction('redo');assert.equal((await snap()).document.graph.atoms[oxygen].isotope,18);
 });
 await run('B07','错误数值保护及输入恢复',async()=>{
  const before=await snap(),field=editor.locator('#atom-isotope');await field.fill('0');await field.press('Tab');
  assert.deepEqual(await snap(),before);assert.equal(await editor.locator('#atom-isotope').inputValue(),'18');
  return{message:await editor.locator('.toast').innerText()};
 });
 await run('B08','全选、旋转、画布快捷键撤销',async()=>{
  await editor.locator('.canvas').focus();await page.keyboard.press('Control+a');const before=await snap();assert.equal(before.selection.atomIds.length,3);
  await editor.locator('.selection-toolbar [data-transform="rotate-right"]').click();const rotated=await snap();assert.deepEqual(rotated.document.graph,before.document.graph);assert.notDeepEqual(rotated.document.depiction.positions,before.document.depiction.positions);
  await page.keyboard.press('Control+z');assert.deepEqual((await snap()).document,before.document);
 });
 await run('B09','画布缩放、平移和适应结构',async()=>{
  const before=(await snap()).document,box=await editor.locator('.canvas').boundingBox();await page.mouse.move(box.x+box.width*.45,box.y+box.height*.5);await page.mouse.wheel(0,-250);
  await editor.locator('[data-tool="pan"]').click();await drag({x:box.x+box.width*.4,y:box.y+box.height*.55},{x:box.x+box.width*.4+80,y:box.y+box.height*.55+40});await clickAction('fit');assert.deepEqual((await snap()).document,before);
  return{zoom:await editor.locator('.zoom-label').innerText()};
 });
 await run('B10','命令搜索能否用中文元素名发现元素',async()=>{
  await page.keyboard.press('Control+k');const search=editor.locator('.command-search');await search.fill('氧');const count=await editor.locator('.search-results [data-command]').count();
  if(count===0)findings.push({id:'B-F02',severity:'P3',title:'中文元素名搜索没有结果',steps:['Ctrl+K','输入“氧”'],expected:'能找到元素 O。',actual:'没有结果，需要知道元素符号 O。',evidence:`${out}/B10-search-empty.png`});
  const result={status:count?'pass':'friction',results:count,text:await editor.locator('.search-results').innerText()};await shot('B10-search-empty');await page.keyboard.press('Escape');return result;
 });
 await run('B11','保存快捷键在标题焦点中的行为',async()=>{
  await page.evaluate(()=>window.addEventListener('keydown',event=>{if(event.ctrlKey&&event.key.toLowerCase()==='s')window.uxSaveKey={defaultPrevented:event.defaultPrevented,target:event.composedPath()[0]?.tagName};}));
  await editor.locator('.document-title').focus();await page.keyboard.press('Control+s');
  const opened=await editor.locator('.export-dialog').evaluate(node=>node.open);
  if(!opened)findings.push({id:'B-F03',severity:'P2',title:'编辑标题后Ctrl+S不打开结构导出',steps:['聚焦文档名称','Ctrl+S'],expected:'打开结构保存/导出。',actual:'结构导出没有打开，需要点击导出按钮或先把焦点移回画布。',evidence:`${out}/B11.png`});
  if(opened)await editor.locator('.export-dialog [data-action="close-dialog"]').click();return{status:opened?'pass':'friction',exportOpened:opened,observedKeyEvent:await page.evaluate(()=>window.uxSaveKey)};
 });
 await run('B12','刷新恢复草稿和当前文档',async()=>{
  const before=(await snap()).document;await page.reload();await page.waitForFunction(()=>!!window.moleculeEditor);const after=await snap();assert.deepEqual(after.document,before);
  return{canUndoAfterReload:after.canUndo,observation:'刷新恢复当前结构；编辑历史不跨刷新。'};
 });
 await run('B13','两个工作页是否会覆盖本地草稿',async()=>{
  const second=await context.newPage();await second.goto('http://127.0.0.1:5173/');await second.waitForFunction(()=>!!window.moleculeEditor);
  const secondEditor=second.locator('chemical-editor').first();await secondEditor.locator('[data-tool="select"]').click();await secondEditor.locator(`[data-atom="${oxygen}"] .atom-hit`).click();
  const charge=secondEditor.locator('#atom-charge');await charge.fill('-1');await charge.press('Tab');
  const secondBefore=await second.evaluate(()=>window.moleculeEditor.getDocument());assert.equal(secondBefore.graph.atoms[oxygen].charge,-1);await second.screenshot({path:`${out}/B13-second-saved.png`});
  const title=editor.locator('.document-title');await title.fill('工艺研发 · 主工作页再次保存');await title.press('Tab');
  await second.reload();await second.waitForFunction(()=>!!window.moleculeEditor);
  const recovered=await second.evaluate(()=>window.moleculeEditor.getDocument());await second.screenshot({path:`${out}/B13-second-after-reload.png`});
  if(recovered.graph.atoms[oxygen].charge!==-1)findings.push({id:'B-F04',severity:'P1',title:'多标签页的本地草稿静默覆盖',steps:['工作页A有乙醇','同一浏览器另开B，修改O电荷为−1，显示已保存本机','A改文档名触发保存','刷新B'],expected:'B自己的草稿可恢复，或明确提示跨工作页冲突。',actual:'B的−1电荷消失，恢复A的结构；覆盖前没有冲突提示。',evidence:[`${out}/B13-second-saved.png`,`${out}/B13-second-after-reload.png`]});
  await second.close();return{status:recovered.graph.atoms[oxygen].charge===-1?'pass':'failed',chargeBefore:secondBefore.graph.atoms[oxygen].charge,chargeAfter:recovered.graph.atoms[oxygen].charge,recoveredTitle:recovered.title};
 });
 await run('B14','从环工具构建稠合双环的效率',async()=>{
  await clear();await editor.locator('[data-tool="benzene"]').first().click();const box=await editor.locator('.canvas').boundingBox();await page.mouse.click(box.x+box.width*.45,box.y+box.height*.5);
  const before=await snap(),bondId=Object.keys(before.document.graph.bonds)[0];assert.equal(Object.keys(before.document.graph.atoms).length,6);
  await editor.locator(`[data-bond="${bondId}"] .bond-hit`).click();const after=await snap();
  const count=Object.keys(after.document.graph.atoms).length;
  if(count===12)findings.push({id:'B-F05',severity:'P2',kind:'capability-gap',title:'环工具不提供沿已有键生成稠合环',steps:['放置一个苯环','保持苯环工具，点击已有环的一条键'],expected:'能便捷生成共享两个碳的稠合双环，或明确说明该操作只放置独立环。',actual:'新增独立6碳环，合计12碳；需要手工连接或通过SMILES导入目标稠环。',evidence:`${out}/B14.png`});
  return{status:count===12?'limited':'pass',atomCount:count,bondCount:Object.keys(after.document.graph.bonds).length,formula:await editor.locator('.formula').innerText()};
 });
 await run('B15','中英文切换是否改变结构或历史',async()=>{
  const before=await snap();await editor.locator('.locale-select').selectOption('en');assert.deepEqual(await snap(),before);assert.equal(await editor.locator('[data-action="export"]').getAttribute('aria-label'),'Export');
 });
 await run('B16','窄屏属性面板与画布返回路径',async()=>{
  await page.setViewportSize({width:390,height:844});await clickAction('inspector');
  const expanded=await editor.locator('.inspector').isVisible();if(!expanded)await clickAction('inspector');
  assert.equal(await editor.locator('.inspector').isVisible(),true);const inspectorBox=await editor.locator('.inspector').boundingBox(),canvasBox=await editor.locator('.canvas').boundingBox();
  await editor.locator('.inspector-content [data-action="inspector"]').click();assert.equal(await editor.locator('.inspector').isVisible(),false);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  return{inspectorWidth:inspectorBox.width,canvasWidth:canvasBox.width,observation:'窄屏右侧为覆盖面板，可用关闭按钮回到画布。'};
 });
}finally{
 await writeFile(`${out}/results.json`,JSON.stringify({persona:'化工研发工程师场景化走查',browser:'Chrome headless; real visible UI mutations',viewport:{width:1440,height:1000},results,findings,errors,readOnlySdkAssertions:true,productionCodeModified:false,harnessCorrections:[{task:'B06',issue:'首轮受B05原生标题Undo的待提交输入影响，同位素19实际未写入模型，不能据此判定历史损坏。',fix:'独立定位后，B06先结束待提交标题，再逐步验证每次同位素及标题后测试Undo/Redo。焦点问题单独记录B-F01。',originalReport:`${out}/first-run.json`,debugReport:`${out}/undo-debug.md`}]},null,2)+'\n');
 await browser.close();
}
console.log(JSON.stringify({tasks:results.length,statuses:results.reduce((counts,row)=>(counts[row.status]=(counts[row.status]||0)+1,counts),{}),findings:findings.map(f=>({id:f.id,severity:f.severity,title:f.title})),errors},null,2));
