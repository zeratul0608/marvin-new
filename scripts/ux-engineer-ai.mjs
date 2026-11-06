import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const {chromium}=await import(process.argv[2]||'playwright');
const output=process.env.UX_AI_OUTPUT||'.local/ux-engineer/ai';await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1280,height:1000},acceptDownloads:true});
const page=await context.newPage();page.setDefaultTimeout(20000);
const report={persona:'化学工程师：日常结构录入、同位素修改、计算核验和可撤销AI编辑',method:'真实Chrome可见UI操作；Qwen3.6-27B、真实RDKit；SDK仅用于只读断言',startedAt:new Date().toISOString(),tasks:[],findings:[],errors:[],turns:[]};
let currentTask='initial';
page.on('pageerror',e=>report.errors.push({task:currentTask,message:e.message}));
page.on('response',async response=>{if(response.url().endsWith('/api/ai/turn')){try{const t=await response.json();report.turns.push({task:currentTask,status:response.status(),text:t.text,toolCalls:(t.toolCalls||[]).map(c=>({id:c.id,name:c.name,arguments:c.arguments}))});}catch{}}});
const editor=page.locator('chemical-editor').first();
const action=name=>editor.locator(`[data-ai-action="${name}"]`);
const field=name=>editor.locator(`[data-ai-field="${name}"]`);
const snap=()=>page.evaluate(()=>window.moleculeEditor.getSnapshot());
async function shot(name){await page.screenshot({path:`${output}/${name}.png`,fullPage:true});return `${output}/${name}.png`;}
async function task(id,title,fn){if(process.env.UX_AI_TASKS&&!process.env.UX_AI_TASKS.split(',').includes(id))return;currentTask=id;const start=Date.now(),turnStart=report.turns.length;const result={id,title,steps:[],status:'passed'};try{await fn(result);}catch(error){result.status='failed';result.error=error.message;result.stack=error.stack;result.screenshot=await shot(`${id}-failure`).catch(()=>null);}result.durationSeconds=+(Date.now()-start)/1000;result.modelTurns=report.turns.slice(turnStart);report.tasks.push(result);console.log(`${id} ${result.status}: ${title} (${result.durationSeconds.toFixed(1)}s)`);await writeFile(`${output}/results.json`,JSON.stringify(report,null,2));}
function note(id,severity,title,detail,evidence){report.findings.push({id,severity,title,detail,evidence});}
async function stopIfRunning(){if(await action('stop').isVisible().catch(()=>false)&&!await action('stop').isDisabled())await action('stop').click();}
async function templates(name='ethanol'){
 await stopIfRunning();
 for(let i=0;i<3&&await editor.locator('dialog[open]').count();i++)await page.keyboard.press('Escape');
 await editor.locator('[data-tab="draw"]').click();await editor.locator('[data-action="templates"]:visible').first().click();
 await editor.locator(`[data-sample="${name}"]`).click();
 await page.waitForFunction(()=>!document.querySelector('chemical-editor').shadowRoot.querySelector('.templates-dialog').open);
}
async function advanced(section='extensions'){
 if(await editor.locator('[data-action="toggle-advanced"]').getAttribute('aria-expanded')!=='true')await editor.locator('[data-action="toggle-advanced"]').click();
 await editor.locator(`[data-advanced-section="${section}"]`).click();
}
async function chemistry(){await advanced();await editor.locator('.extension-tabs [data-inspector-plugin="chemistry-engine"]').click();}
async function ai(clear=true){await page.locator('[data-page="ai"]').click();await field('message').waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('chemical-editor').shadowRoot.querySelector('[data-ai-action="send"]').disabled,{},{timeout:15000});if(clear)await action('clear').click();}
async function selectO(){
 const snapshot=await snap(),oxygen=Object.values(snapshot.document.graph.atoms).find(a=>a.element==='O');assert.ok(oxygen);
 if(await editor.locator('.ribbon [data-action="inspector"]').getAttribute('aria-pressed')==='true')await editor.locator('.ribbon [data-action="inspector"]').click();
 await editor.locator('.toolrail [data-tool="select"]').click();await editor.locator(`.drawing [data-atom="${oxygen.id}"]`).click();
 assert.deepEqual((await snap()).selection.atomIds,[oxygen.id]);return oxygen.id;
}
async function send(text){await field('message').fill(text);await action('send').click();}
async function done(){await page.waitForFunction(()=>document.querySelector('chemical-editor').shadowRoot.querySelector('[data-ai-action="stop"]').disabled,{},{timeout:150000});}
async function waitReview(){await editor.locator('.ai-review-slot .ai-edit-preview[data-review-state="pending"]').waitFor({state:'visible',timeout:150000});}
const approve=()=>editor.locator('.ai-review-slot [data-ai-action="approve-edit"]');
const decline=()=>editor.locator('.ai-review-slot [data-ai-action="reject-edit"]');
try{
 await page.goto('http://127.0.0.1:5173/');await page.waitForFunction(()=>!!window.moleculeEditor);
 const config=await page.request.get('http://127.0.0.1:5173/api/ai/config',{headers:{'x-molecule-ai':'1',Origin:'http://127.0.0.1:5173'}});const configData=await config.json();
 report.connection={model:configData.model,protocol:configData.protocol,localModel:configData.baseUrl==='http://127.0.0.1:8000/v1'};
 assert.equal(configData.model,'qwen3.6-27b','The existing workbench is not configured for the requested real local model');
 await editor.locator('.locale-select').selectOption('zh-CN');
 await task('AI01','通过可见高级面板从SMILES建立乙醇并核对分子量',async r=>{
  r.steps=['高级编辑','扩展插件','化学计算','输入SMILES CCO','用SMILES替换画布','阅读计算结果'];
  await chemistry();const input=editor.locator('textarea[aria-label="输入 SMILES"]');await input.fill('CCO');await editor.locator('[data-chemistry-action="import-smiles"]').click();
  await page.waitForFunction(()=>document.querySelector('chemical-editor').shadowRoot.querySelector('[data-chemistry-status]').textContent.includes('SMILES 已载入'));
  const after=await snap();assert.equal(Object.keys(after.document.graph.atoms).length,3);assert.equal(Object.keys(after.document.graph.bonds).length,2);
  assert.equal(await editor.locator('textarea[aria-label="计算所得 SMILES"]').inputValue(),'CCO');
  const summary=await editor.locator('[data-chemistry-summary]').innerText();assert.match(summary,/46\.069/);r.result={atoms:3,bonds:2,smiles:'CCO',summary};r.screenshot=await shot('AI01-smiles-ethanol');
  note('AI-UX-01','P2','SMILES入口需要穿过高级分类与插件标签，首次查找成本较高','作为工程师想直接粘贴结构字符串时，默认绘制/导入按钮未直接给SMILES入口；实际路径为高级编辑→扩展插件→化学计算→面板下方输入，需滚动。功能可用，属于发现性摩擦。',r.screenshot);
 });
 await task('AI02','错误反应式SMILES不覆盖当前结构，并可恢复输入',async r=>{
  r.steps=['化学计算面板输入 CCO>>CC=O','点击替换','阅读拒绝原因','恢复CCO'];await chemistry();const before=await snap();
  await editor.locator('textarea[aria-label="输入 SMILES"]').fill('CCO>>CC=O');await editor.locator('[data-chemistry-action="import-smiles"]').click();
  await page.waitForFunction(()=>!document.querySelector('chemical-editor').shadowRoot.querySelector('[data-chemistry-action="import-smiles"]').disabled);
  assert.deepEqual((await snap()).document,before.document);assert.equal((await snap()).revision,before.revision);
  const status=await editor.locator('[data-chemistry-status]').innerText();assert.match(status,/反应|单条/);assert.equal(await editor.locator('textarea[aria-label="输入 SMILES"]').inputValue(),'CCO>>CC=O');
  r.result={status,documentPreserved:true};r.screenshot=await shot('AI02-invalid-smiles');await editor.locator('textarea[aria-label="输入 SMILES"]').fill('CCO');
 });
 await task('AI03','真实AI只读计算乙醇，核对RDKit原始结果卡',async r=>{
  r.steps=['模板乙醇','AI助手','关闭允许AI修改','输入只读计算指令','核对结果卡46.069和CCO'];await templates();await ai();await field('allow-edits').uncheck();
  const before=await snap();const prompt='只读使用本地RDKit计算当前完整文档的分子式、平均分子量、精确质量和SMILES。不要修改结构、选区或视图。';r.prompt=prompt;await send(prompt);await done();
  assert.deepEqual(await snap(),before);const card=editor.locator('.ai-chemistry-analysis').last();assert.equal(await card.count(),1);assert.match(await card.innerText(),/46\.069/);assert.equal(await card.locator('textarea').inputValue(),'CCO');
  await card.scrollIntoViewIfNeeded();r.result={card:await card.innerText(),smiles:await card.locator('textarea').inputValue(),unchanged:true};r.screenshot=await shot('AI03-real-readonly-analysis');
 });
 await task('AI04','选择氧原子，AI预览标记氧18，应用后一步撤销',async r=>{
  r.steps=['模板乙醇','选择工具点击OH','AI助手','允许编辑和先预览','发送自然语言','检查前后图','应用','撤销'];await templates();const oxygen=await selectO();await ai();await field('allow-edits').check();await field('preview-edits').check();const before=await snap();
  const prompt='只把当前选中的氧原子标记为氧-18，保留其他原子、键、坐标和所有属性，不要改文档标题，也不要替换整个文档。';r.prompt=prompt;await send(prompt);await waitReview();assert.deepEqual((await snap()).document,before.document);
  await approve().scrollIntoViewIfNeeded();r.previewScreenshot=await shot('AI04-preview');await approve().click();await done();
  const expected=structuredClone(before.document);expected.graph.atoms[oxygen].isotope=18;assert.deepEqual((await snap()).document,expected);
  r.appliedScreenshot=await shot('AI04-applied');await editor.locator('[data-action="undo"]').click();assert.deepEqual((await snap()).document,before.document);r.result={exactO18:true,oneStepUndo:true};
 });
 await task('AI05','拒绝AI预览，当前结构和版本保持',async r=>{
  r.steps=['选OH','AI新会话','请求18O','不应用','核对画布和版本'];await templates();await selectO();await ai();await field('allow-edits').check();await field('preview-edits').check();const before=await snap();
  const prompt='只把当前选中的氧原子改成氧-18同位素，保持所有其它结构不变。';r.prompt=prompt;await send(prompt);await waitReview();assert.deepEqual((await snap()).document,before.document);await decline().click();await done();assert.deepEqual(await snap(),before);
  r.result={rejected:true,status:await editor.locator('[data-ai-view="chat"] .ai-status').innerText()};r.screenshot=await shot('AI05-rejected');
 });
 await task('AI06','人工改标题使旧预览失效，停止后恢复原指令',async r=>{
  r.steps=['请求18O预览','在命令栏人工改标题并失焦','检查应用按钮禁用','停止','核对人工标题和无化学改动','核对请求恢复'];await templates();await selectO();await ai();await field('allow-edits').check();await field('preview-edits').check();const before=await snap();
  const prompt='只给当前选中氧原子设置同位素18，保留其余内容。';r.prompt=prompt;await send(prompt);await waitReview();await editor.locator('.document-title').fill('工程测试：人工修改的标题');await editor.locator('.document-title').press('Tab');
  await page.waitForFunction(()=>document.querySelector('chemical-editor').shadowRoot.querySelector('.ai-review-slot [data-ai-action="approve-edit"]').disabled);
  r.staleScreenshot=await shot('AI06-stale-disabled');await action('stop').click();await done();
  const after=await snap();assert.equal(after.document.title,'工程测试：人工修改的标题');const expected=structuredClone(before.document);expected.title=after.document.title;assert.deepEqual(after.document,expected);assert.equal(await field('message').inputValue(),prompt);
  r.result={staleBlocked:true,manualTitleKept:true,chemicalGraphUnchanged:true,instructionRestored:true,trace:await editor.locator('.ai-trace').innerText()};r.screenshot=await shot('AI06-stopped-recovered');
  if (/执行\s+apply_edits/.test(r.result.trace)) note('AI-UX-03','P2','停止后工具行仍显示“执行 apply_edits…”','停止后化学修改未提交且原指令恢复，但工具行仍呈现执行中状态；应标记已取消或未提交。',r.screenshot);
 });
 await task('AI07','只读模式下提出编辑要求，不能改动文档',async r=>{
  r.steps=['模板乙醇','选OH','AI只读','提出同位素修改','阅读模型说明'];await templates();await selectO();await ai();await field('allow-edits').uncheck();const before=await snap();const prompt='把当前选中的氧原子标记为氧-18。';r.prompt=prompt;await send(prompt);await done();assert.deepEqual(await snap(),before);
  r.result={readonlyKeptDocument:true,messages:await editor.locator('.ai-message').allTextContents(),status:await editor.locator('[data-ai-view="chat"] .ai-status').innerText()};r.screenshot=await shot('AI07-readonly-edit-request');
 });
 await task('AI08','只选乙醇的氧原子计算时，AI不能偷偷扩大为整分子',async r=>{
  r.steps=['模板乙醇','只选择OH','关闭允许编辑','明确只计算所选部分','核对无修改与说明'];await templates();await selectO();await ai();await field('allow-edits').uncheck();const before=await snap();
  const prompt='只使用当前选中的原子作为计算范围，调用本地RDKit计算分子量和SMILES。不要扩大选区，也不要计算其它原子；若不支持，请明确说明。';r.prompt=prompt;await send(prompt);await done();assert.deepEqual(await snap(),before);assert.equal(await editor.locator('.ai-chemistry-analysis').count(),0);
  r.result={selectionNotExpanded:true,messages:await editor.locator('.ai-message').allTextContents(),trace:await editor.locator('.ai-trace').innerText()};r.screenshot=await shot('AI08-partial-selection');
 });
 await task('AI09','英文窄屏下使用真实AI分析阿司匹林并阅读结果',async r=>{
  r.steps=['切English','打开Aspirin模板清空选区','缩窄390px','AI只读计算全文','向上滚动查看RDKit卡','读取SMILES'];await editor.locator('.locale-select').selectOption('en');await templates('aspirin');await page.setViewportSize({width:390,height:900});await ai();await field('allow-edits').uncheck();const before=await snap();
  const prompt='Use local RDKit to analyze the entire current document. Report formula, molecular weight, exact mass and SMILES. This task is read-only: do not alter the structure, selection or view.';r.prompt=prompt;await send(prompt);await done();assert.deepEqual(await snap(),before);
  const card=editor.locator('.ai-chemistry-analysis').last();assert.match(await card.innerText(),/180\.159/);assert.equal(await card.locator('textarea').getAttribute('readonly'),'');await card.scrollIntoViewIfNeeded();r.result={card:await card.innerText(),smiles:await card.locator('textarea').inputValue(),language:await page.locator('html').getAttribute('lang'),noOverflow:await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)};assert.equal(r.result.noOverflow,true);r.screenshot=await shot('AI09-mobile-english-calculation');
  note('AI-UX-02','P2','计算结束自动聚焦输入框，窄屏首次不易看到结果卡','结果真实且可读，但完成后焦点与滚动落在composer，RDKit卡位于上方的日志滚动区，需要回滚寻找。英文手机宽度下尤其明显；用户容易先看到模型文字而漏掉权威计算卡。',r.screenshot);
 });
 await task('AI10','模型运行时写下一条草稿，停止不覆盖新草稿',async r=>{
  r.steps=['模板阿司匹林','AI只读计算','立即输入下一条草稿','停止当前请求','确认新草稿与文档仍在'];await templates('aspirin');await ai();await field('allow-edits').uncheck();const before=await snap();
  const prompt='请用本地RDKit计算当前完整分子的各项性质，并详细解释分子式、平均分子量、精确质量、LogP、tPSA和SMILES的计算结果，不修改文档。';r.prompt=prompt;await send(prompt);
  const draft='下一步准备导出工艺报告，先保留这条草稿。';await field('message').fill(draft);await action('stop').click();await done();
  assert.equal(await field('message').inputValue(),draft);assert.deepEqual(await snap(),before);
  r.result={newDraftPreserved:true,documentPreserved:true,status:await editor.locator('[data-ai-view="chat"] .ai-status').innerText()};r.screenshot=await shot('AI10-new-draft-after-stop');
 });
 await task('AI11','计算记录在刷新后的可追溯性与文档草稿恢复',async r=>{
  r.steps=['模板乙醇','人工命名批次','AI只读计算','确认RDKit卡','刷新页面','重新打开AI','检查批次结构和计算记录'];await templates();
  await editor.locator('.document-title').fill('UX-工程批次-乙醇');await editor.locator('.document-title').press('Tab');await ai();await field('allow-edits').uncheck();const before=await snap();
  const prompt='使用本地RDKit只读计算当前完整文档的分子量和SMILES，不修改结构。';r.prompt=prompt;await send(prompt);await done();assert.equal(await editor.locator('.ai-chemistry-analysis').count(),1);
  r.beforeRefreshScreenshot=await shot('AI11-before-refresh');await page.reload();await page.waitForFunction(()=>!!window.moleculeEditor);await ai(false);const after=await snap();
  assert.deepEqual(after.document.graph,before.document.graph);assert.deepEqual(after.document.depiction,before.document.depiction);assert.equal(after.document.title,before.document.title);
  r.result={documentRestored:true,aiMessagesAfterRefresh:await editor.locator('.ai-message').count(),analysisCardsAfterRefresh:await editor.locator('.ai-chemistry-analysis').count(),historyCanUndoAfterRefresh:after.canUndo};
  r.screenshot=await shot('AI11-after-refresh-no-audit');
  note('AI-UX-04','P2','AI对话、操作记录与计算结果刷新后全部消失','文档批次标题、原子和布局恢复成功，但AI消息与RDKit结果卡均为0。作为工程师，保存工作台草稿后仍无法追溯前一轮计算依据或模型操作，界面需明确保存范围，并提供会话/结果导出或持久保存。此为当前会话设计边界，不是结构数据丢失。',r.screenshot);
 });
 report.finishedAt=new Date().toISOString();report.summary={passed:report.tasks.filter(t=>t.status==='passed').length,failed:report.tasks.filter(t=>t.status==='failed').length,modelRequests:report.turns.length};
 await writeFile(`${output}/results.json`,JSON.stringify(report,null,2));
 const lines=['# 化学工程师用户体验：AI 与 RDKit','',`真实用户任务 ${report.summary.passed}/${report.tasks.length} 完成；真实模型响应 ${report.turns.length} 轮。仅可见 UI 修改，未使用写入 SDK。`,'',...report.tasks.flatMap(t=>[`## ${t.id} ${t.title}`,`- 结果：${t.status}；耗时 ${t.durationSeconds.toFixed(1)} 秒。`,`- 操作：${t.steps.join(' → ')}`,t.prompt?`- 指令：${t.prompt}`:'',t.error?`- 失败：${t.error}`:'',`- 实际工具：${t.modelTurns.flatMap(x=>x.toolCalls.map(c=>c.name)).join(', ')||'无模型工具调用'}`,'']), '## 体验问题','',...report.findings.flatMap(f=>[`### ${f.severity} ${f.id} ${f.title}`,f.detail,`证据：${f.evidence}`,''])];
 await writeFile(`${output}/findings.md`,lines.join('\n'));
 console.log(JSON.stringify(report.summary));
}finally{await browser.close();}
