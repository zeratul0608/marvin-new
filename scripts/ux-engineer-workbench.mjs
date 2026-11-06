import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const {chromium}=await import(process.argv[2]||'playwright');
const output=process.env.UX_OUTPUT_DIR||'.local/ux-engineer/workbench';await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1280,height:1000},permissions:['clipboard-read','clipboard-write'],acceptDownloads:true});
const page=await context.newPage();page.setDefaultTimeout(18000);
const editor=page.locator('chemical-editor').first();
const report={persona:'化学工程师：日常结构审阅、排版与重复片段编辑',method:'Chrome独立context真实UI操作；只读getSnapshot/getDiagnostics验证，不调用写入SDK；clipboard权限只授予测试context',startedAt:new Date().toISOString(),tasks:[],findings:[],pageErrors:[]};
page.on('pageerror',e=>report.pageErrors.push(e.message));
const snap=()=>page.evaluate(()=>window.moleculeEditor.getSnapshot());
const diagnostics=()=>page.evaluate(()=>window.moleculeEditor.getDiagnostics());
const panel=id=>editor.locator(`[data-plugin-panel="${id}"]`);
async function shot(name){const path=`${output}/${name}.png`;await page.screenshot({path,fullPage:true});return path;}
async function task(id,title,steps,fn){const start=Date.now(),r={id,title,steps,status:'passed'};try{await fn(r);}catch(e){r.status='failed';r.error=e.message;r.stack=e.stack;r.screenshot=await shot(`${id}-failure`).catch(()=>null);}r.durationSeconds=(Date.now()-start)/1000;report.tasks.push(r);console.log(`${id} ${r.status} (${r.durationSeconds.toFixed(1)}s)`);await writeFile(`${output}/results.json`,JSON.stringify(report,null,2));}
async function templates(name='ethanol'){
 for(let i=0;i<3&&await editor.locator('dialog[open]').count();i++)await page.keyboard.press('Escape');
 await editor.locator('[data-tab="draw"]').click();await editor.locator('[data-action="templates"]:visible').first().click();await editor.locator(`[data-sample="${name}"]`).click();
 await page.waitForFunction(()=>!document.querySelector('chemical-editor').shadowRoot.querySelector('.templates-dialog').open);
}
async function extension(id){
 if(await editor.locator('[data-action="toggle-advanced"]').getAttribute('aria-expanded')!=='true')await editor.locator('[data-action="toggle-advanced"]').click();
 await editor.locator('[data-advanced-section="extensions"]').click();await editor.locator(`.extension-tabs [data-inspector-plugin="${id}"]`).click();
}
async function closeInspector(){const button=editor.locator('.ribbon [data-action="inspector"]');if(await button.getAttribute('aria-pressed')==='true')await button.click();}
async function selectAtom(id){await closeInspector();await editor.locator('.toolrail [data-tool="select"]').click();await editor.locator(`.drawing [data-atom="${id}"]`).click();assert.deepEqual((await snap()).selection.atomIds,[id]);}
async function selectAll(){const before=await snap(),atoms=Object.values(before.document.graph.atoms);await selectAtom((atoms.find(a=>a.element==='O')||atoms[0]).id);await page.keyboard.press('Control+a');assert.equal((await snap()).selection.atomIds.length,Object.keys((await snap()).document.graph.atoms).length);}
function finding(id,severity,title,detail,evidence){report.findings.push({id,severity,title,detail,evidence});}
try{
 await page.goto('http://127.0.0.1:5173/');await page.waitForFunction(()=>!!window.moleculeEditor);await editor.locator('.locale-select').selectOption('zh-CN');
 await task('WB01','审阅正常乙醇，摘要与基础检查含义清楚',['模板乙醇','高级编辑→扩展插件→结构审阅','刷新摘要','核对分子式、节点/键、片段、形式电荷、诊断和校验范围'],async r=>{
  await templates();await extension('structure-review');const before=await snap();await panel('structure-review.summary').getByRole('button',{name:'刷新摘要',exact:true}).click();
  const rows=await panel('structure-review.summary').locator('dl').innerText(),scope=await panel('structure-review.summary').locator('p').innerText();
  assert.match(rows,/C2H6O/);assert.match(rows,/3 \/ 2/);assert.match(rows,/基础诊断\s+0/);assert.match(scope,/不包含完整化学合理性/);assert.equal((await diagnostics()).length,0);assert.deepEqual(await snap(),before);
  r.result={rows,scope,readOnly:true};r.screenshot=await shot('WB01-normal-review');
 });
 await task('WB02','问题可发现但兼容报告不能定位错误原子',['模板乙醇','选择有两条键的中间碳','按F改成两价氟以制造基础价态告警','结构审阅显示诊断','基本属性→查看报告','点击问题文本','检查选区定位','一次撤销恢复'],async r=>{
  await templates();const original=await snap(),carbon=Object.values(original.document.graph.atoms).find(a=>a.element==='C'&&Object.values(original.document.graph.bonds).filter(b=>b.atoms.includes(a.id)).length===2);assert.ok(carbon);
  await selectAtom(carbon.id);await page.keyboard.press('F');assert.equal((await snap()).document.graph.atoms[carbon.id].element,'F');
  const diags=await diagnostics();assert.ok(diags.some(d=>d.code==='VALENCE_UNRESOLVED'&&d.objectId===carbon.id));await extension('structure-review');r.summary=await panel('structure-review.summary').locator('dl').innerText();assert.match(r.summary,/基础诊断\s+1/);
  const other=Object.values(original.document.graph.atoms).find(a=>a.element==='O');await selectAtom(other.id);await extension('structure-review');await editor.locator('.inspector-tabs [data-inspector-plugin=""]').click();await editor.locator('[data-action="issues"]:visible').click();
  const issue=editor.locator('.issues-dialog .issue').filter({hasText:'VALENCE_UNRESOLVED'});const before=await snap();assert.deepEqual(before.selection.atomIds,[other.id]);assert.notEqual(other.id,carbon.id);await issue.click();assert.deepEqual(await snap(),before);assert.deepEqual((await snap()).selection.atomIds,[other.id]);
  r.result={diagnostics:diags,diagnosticTargetAtomId:carbon.id,selectionBeforeIssueClick:before.selection.atomIds,selectionAfterIssueClick:(await snap()).selection.atomIds,reportText:await editor.locator('.issue-list').innerText(),issueMarkup:await issue.evaluate(el=>el.outerHTML),selectionUnchangedOnClick:true,descriptionContainsId:(await issue.innerText()).includes(carbon.id)};
  r.screenshot=await shot('WB02-diagnostic-no-locate');await page.keyboard.press('Escape');await editor.locator('[data-action="undo"]').click();assert.deepEqual((await snap()).document,original.document);
  finding('WB-UX-01','P2','结构问题报告缺少对象定位','制造两价F后，结构审阅正确显示1项基础诊断；查看报告能读到“F 的氢数或价态暂无法由基础规则确定”，但该行仅div，无对象标签或定位按钮，点击不会选中/定位原子。真实诊断含objectId，UI未承接；大结构有多个同元素时需人工寻找。当前基础审阅范围本身已明确，不将缺少完整化学校验计为bug。',r.screenshot);
 });
 await task('WB03','可见结构排版按钮保留化学语义并一步撤销',['化学计算面板SMILES输入CCO.CC(=O)O','使用SMILES替换','结构排版→片段横向排列','核对图与位置','一次撤销','统一键长（等比例）','核对图和中位键长','一次撤销'],async r=>{
  await extension('chemistry-engine');await editor.locator('textarea[aria-label="输入 SMILES"]').fill('CCO.CC(=O)O');await editor.locator('[data-chemistry-action="import-smiles"]').click();
  await page.waitForFunction(()=>document.querySelector('chemical-editor').shadowRoot.querySelector('[data-chemistry-status]').textContent.includes('SMILES 已载入'));
  await extension('structure-layout');const before=await snap();await panel('structure-layout.layout').getByRole('button',{name:'片段横向排列',exact:true}).click();const row=await snap();assert.deepEqual(row.document.graph,before.document.graph);assert.notDeepEqual(row.document.depiction.positions,before.document.depiction.positions);
  r.arrangedScreenshot=await shot('WB03-row-layout');await editor.locator('[data-action="undo"]').click();assert.deepEqual((await snap()).document,before.document);
  await panel('structure-layout.layout').getByRole('button',{name:'统一键长（等比例）',exact:true}).click();const normalized=await snap();assert.deepEqual(normalized.document.graph,before.document.graph);
  const length=b=>{const [a,c]=b.atoms.map(id=>normalized.document.depiction.positions[id]);return Math.hypot(a.x-c.x,a.y-c.y);};const lengths=Object.values(normalized.document.graph.bonds).map(length);
  const unseen=new Set(Object.keys(normalized.document.graph.atoms)),medians=[];while(unseen.size){const atoms=new Set([unseen.values().next().value]);for(const id of atoms){unseen.delete(id);for(const b of Object.values(normalized.document.graph.bonds))if(b.atoms.includes(id))for(const next of b.atoms)if(unseen.has(next))atoms.add(next);}const values=Object.values(normalized.document.graph.bonds).filter(b=>atoms.has(b.atoms[0])).map(length).sort((a,b)=>a-b);if(values.length)medians.push((values[Math.floor((values.length-1)/2)]+values[Math.floor(values.length/2)])/2);}assert.ok(medians.every(n=>Math.abs(n-1.5)<1e-8));
  r.result={atoms:Object.keys(before.document.graph.atoms).length,bonds:Object.keys(before.document.graph.bonds).length,graphPreservedForBothActions:true,normalizedBondLengths:lengths,perFragmentMedianBondLengths:medians};r.screenshot=await shot('WB03-normalized');await editor.locator('[data-action="undo"]').click();assert.deepEqual((await snap()).document,before.document);r.result.bothSingleUndoRestoredExactDocument=true;
 });
 await task('WB04','真实画布Ctrl+C/V复制粘贴能力核查',['模板乙醇','标题输入已知文本并通过键盘复制，验证浏览器剪贴板可用','全选画布','Ctrl+C','读取剪贴板','Ctrl+V','核对原子数/版本和文档是否变化','查看快捷键说明'],async r=>{
  await templates();const marker='UX-clipboard-probe-ethanol';const title=editor.locator('.document-title');await title.fill(marker);await title.press('Tab');await title.click();await title.press('Control+a');await title.press('Control+c');await page.waitForFunction(async()=>await navigator.clipboard.readText()==='UX-clipboard-probe-ethanol');
  await selectAll();const before=await snap();await page.keyboard.press('Control+c');const copied=await page.evaluate(()=>navigator.clipboard.readText());await page.keyboard.press('Control+v');const after=await snap();
  r.result={clipboardPermissionConfirmed:true,clipboardAfterCanvasCopy:copied,copyReplacedClipboard:copied!==marker,pasteChangedDocument:JSON.stringify(before.document)!==JSON.stringify(after.document),atomsBefore:Object.keys(before.document.graph.atoms).length,atomsAfter:Object.keys(after.document.graph.atoms).length,revisionBefore:before.revision,revisionAfter:after.revision};
  assert.equal(copied,marker);assert.deepEqual(after,before);r.status='unsupported';r.screenshot=await shot('WB04-copy-paste-no-action');
  await page.keyboard.press('?');r.shortcutGuide=await editor.locator('.shortcuts-dialog').innerText();r.guideScreenshot=await shot('WB04-shortcuts-no-copy-paste');await page.keyboard.press('Escape');
  finding('WB-UX-02','P2','画布缺少常用复制/粘贴结构能力，快捷键无反馈','独立Chrome已授予clipboard权限，标题文本Ctrl+C确认剪贴板可用；全选乙醇后Ctrl+C未写入结构，Ctrl+V也不改变3原子/2键或文档版本。快捷键表未列复制/粘贴，属于尚未提供的常用能力而非权限错误。工程师重复片段或跨文档搬运需另走导出/导入，建议提供菜单入口、Ctrl+C/V及范围/不支持格式反馈。',r.screenshot);
 });
 await task('WB05','删除所选氧与全图后均可一步撤销',['模板乙醇','选OH','按Delete','核对只删氧及相连键','一次撤销完整恢复','全选','按Delete','一次撤销完整恢复'],async r=>{
  await templates();const original=await snap(),oxygen=Object.values(original.document.graph.atoms).find(a=>a.element==='O');await selectAtom(oxygen.id);await page.keyboard.press('Delete');const one=await snap();assert.equal(Object.keys(one.document.graph.atoms).length,2);assert.equal(Object.keys(one.document.graph.bonds).length,1);assert.equal(one.document.graph.atoms[oxygen.id],undefined);
  await editor.locator('[data-action="undo"]').click();assert.deepEqual((await snap()).document,original.document);await selectAll();await page.keyboard.press('Delete');const empty=await snap();assert.equal(Object.keys(empty.document.graph.atoms).length,0);assert.equal(Object.keys(empty.document.graph.bonds).length,0);
  r.deletedScreenshot=await shot('WB05-delete-all');await editor.locator('[data-action="undo"]').click();assert.deepEqual((await snap()).document,original.document);r.result={singleOxygenDeleteExact:true,allDeleteClearsGraph:true,bothSingleUndoRestoredExactDocument:true};r.screenshot=await shot('WB05-undo-restored');
 });
 report.harnessCorrections=['首轮WB03把“各片段中位键长1.5”等比例缩放误断言为“所有键长恰好1.5”；纠正为按UI说明逐片段检查中位数。','首轮WB04/WB05画布定位器误写为.canvas svg；第二轮定位到svg.canvas后固定坐标又位于浮动元素栏下。最终改为点击实际可见OH再Ctrl+A；浏览器clipboard路径本身可用。前两轮原始记录保存在first-run.json、second-run.json。'];
 report.finishedAt=new Date().toISOString();report.summary={tasks:report.tasks.length,passed:report.tasks.filter(t=>t.status==='passed').length,failed:report.tasks.filter(t=>t.status==='failed').length,unsupported:report.tasks.filter(t=>t.status==='unsupported').length,productionFilesModified:false,clipboardPermissionsContextOnly:true};
 await writeFile(`${output}/results.json`,JSON.stringify(report,null,2));
 const md=['# 化学工程师工作台体验补测','',`${report.summary.passed}/${report.summary.tasks} 项完成，${report.summary.unsupported} 项为未提供能力，${report.summary.failed} 项执行失败。真实Chrome UI；只读SDK断言；独立context，未改生产代码。`,'',...report.tasks.flatMap(t=>[`## ${t.id} ${t.title}`,'',`状态：${t.status}；耗时${t.durationSeconds.toFixed(1)}秒（自动操作含系统等待，并非人工完成时长）。`,`操作：${t.steps.join(' → ')}`,t.error?`失败：${t.error}`:'',`证据：${t.screenshot||t.arrangedScreenshot}`,'']),...report.findings.flatMap(f=>[`## ${f.severity} ${f.id} ${f.title}`,'',f.detail,`证据：${f.evidence}`,''])];await writeFile(`${output}/findings.md`,md.join('\n'));console.log(JSON.stringify(report.summary));
}finally{await browser.close();}
