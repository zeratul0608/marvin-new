import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const {chromium}=await import(process.argv[2]||'playwright');
const out=process.env.UX_OUTPUT_DIR||'.local/ux-engineer/exchange';await mkdir(`${out}/downloads`,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1600,height:1050},acceptDownloads:true});
const page=await context.newPage(),errors=[],results=[],findings=[];
page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(20000);
const e=page.locator('chemical-editor').first();
const snapshot=()=>page.evaluate(()=>window.moleculeEditor.getSnapshot());
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value);
const atomLabel=atom=>JSON.stringify({element:atom.element,charge:atom.charge,isotope:atom.isotope??null,atomMap:atom.atomMap??null,radical:atom.radical??null,query:atom.query??null,queryConstraints:atom.queryConstraints??null});
function chemistry(doc){
 const atoms=Object.values(doc.graph.atoms),bonds=Object.values(doc.graph.bonds);
 const degree=id=>bonds.filter(b=>b.atoms.includes(id)).length;
 return {atoms:atoms.map(a=>atomLabel(a)).sort(),bonds:bonds.map(b=>({atoms:b.atoms.map(id=>`${atomLabel(doc.graph.atoms[id])}|degree:${degree(id)}`).sort(),order:b.order,topology:b.topology??null,reactionParticipation:b.reactionParticipation??null})).sort((a,b)=>canonical(a).localeCompare(canonical(b))),drawings:Object.keys(doc.depiction.objects??{}).length,reactions:Object.keys(doc.graph.reactions??{}).length};
}
async function dismiss(){for(let i=0;i<3;i++){if(!await page.locator('dialog:visible').count())break;await page.keyboard.press('Escape');}}
async function shot(name){const file=`${out}/${name}.png`;await page.screenshot({path:file,fullPage:true});return file;}
async function importFile(file,{expectError=false}={}){
 await dismiss();await e.locator('[data-action="import"]').click();
 const chooser=page.waitForEvent('filechooser');await e.locator('[data-action="choose-file"]').click();await(await chooser).setFiles(path.resolve(file));
 await page.waitForFunction(name=>document.querySelector('chemical-editor').shadowRoot.querySelector('.import-filename').textContent===name,path.basename(file));
 await e.locator('[data-action="apply-import"]').click();
 if(expectError){await e.locator('.import-message.error').waitFor({state:'visible'});return await e.locator('.import-message').innerText();}
 await e.locator('.import-dialog').waitFor({state:'hidden'});
 return snapshot();
}
async function editIsotope(){
 const before=await snapshot(),atom=Object.values(before.document.graph.atoms).find(a=>!a.query&&!a.attachment&&!a.substructure&&!a.namedFragment&&!a.multiAttachment&&a.element==='C')??Object.values(before.document.graph.atoms).find(a=>!a.query&&!a.attachment&&!a.substructure&&!a.namedFragment&&!a.multiAttachment);
 assert.ok(atom,'Expected editable ordinary atom');
 await e.locator('[data-tool="select"]').first().click();await e.locator(`[data-atom="${atom.id}"] .atom-hit`).click();
 if(!await e.locator('.inspector-content').isVisible())await e.locator('.inspector-tabs [data-inspector-plugin=""]').click();
 const input=e.locator('[data-property="isotope"]');assert.equal(await input.isVisible(),true);
 const isotope=atom.isotope===13?14:atom.element==='N'?15:atom.element==='O'?18:13;
 await input.fill(String(isotope));await input.press('Tab');
 const after=await snapshot();assert.equal(after.document.graph.atoms[atom.id].isotope,isotope);
 assert.equal(after.revision,before.revision+1);
 return {atomId:atom.id,element:atom.element,isotope,before,after};
}
async function exportFile(format,name,{preserveFilename=false,currentPreview=false}={}){
 if(!currentPreview){await dismiss();await e.locator('[data-action="export"]').click();await e.locator('.export-format').selectOption(format);}
 else assert.equal(await e.locator('.export-format').inputValue(),format);
 const blocked=await e.locator('[data-action="download-export"]').isDisabled(),message=await e.locator('.export-message').innerText();
 if(blocked)return{blocked,message,format};
 const wait=page.waitForEvent('download');await e.locator('[data-action="download-export"]').click();const download=await wait;
 if(preserveFilename)await mkdir(`${out}/downloads/${name}`,{recursive:true});
 const file=preserveFilename?`${out}/downloads/${name}/${download.suggestedFilename()}`:`${out}/downloads/${name}${path.extname(download.suggestedFilename())}`;await download.saveAs(file);
 const bytes=await readFile(file);await e.locator('.export-dialog [data-action="close-dialog"]').first().click();
 return {blocked:false,message,format,file,suggestedFilename:download.suggestedFilename(),bytes:bytes.length};
}
async function task(id,title,fn){
 const start=Date.now();try{await dismiss();const detail=await fn();results.push({id,title,status:detail.status??'passed',durationMs:Date.now()-start,...detail});console.log(`${id}: ${results.at(-1).status}`);}
 catch(error){const evidence=await shot(`${id}-failed`).catch(()=>null);results.push({id,title,status:'failed',error:error.message,durationMs:Date.now()-start,evidence});console.log(`${id}: FAILED ${error.message}`);}
}
try{
 await page.goto('http://127.0.0.1:5173/');await page.waitForFunction(()=>!!window.moleculeEditor);
 await task('EX01','CDX试剂文件导入、同位素标记、源格式保存、重开',async()=>{
  await importFile('public/test-files/01-basic-cdx/rdkit-ethanol.cdx');const edit=await editIsotope();const saved=await exportFile('source','EX01-preserved-ethanol');assert.equal(saved.blocked,false,saved.message);
  const reimport=await importFile(saved.file);assert.deepEqual(chemistry(reimport.document),chemistry(edit.after.document));
  return{file:'rdkit-ethanol.cdx',saved,element:edit.element,isotope:edit.isotope,evidence:await shot('EX01-reopened')};
 });
 await task('EX02','CDXML结构导入、修改、CDXML保存和重开',async()=>{
  await importFile('public/test-files/02-cdxml/aspirin.cdxml');const edit=await editIsotope(),saved=await exportFile('cdxml','EX02-aspirin-edited');assert.equal(saved.blocked,false,saved.message);
  const reimport=await importFile(saved.file);assert.deepEqual(chemistry(reimport.document),chemistry(edit.after.document));return{saved,atomCount:Object.keys(reimport.document.graph.atoms).length,evidence:await shot('EX02-reopened')};
 });
 await task('EX03','通过源码粘贴导入CDXML，导出MOL V3000重开',async()=>{
  await e.locator('[data-action="import"]').click();await e.locator('.import-source').fill(await readFile('public/examples/ethanol.cdxml','utf8'));await e.locator('[data-action="apply-import"]').click();await e.locator('.import-dialog').waitFor({state:'hidden'});
  const edit=await editIsotope(),saved=await exportFile('mol-v3000','EX03-ethanol-v3000');assert.equal(saved.blocked,false,saved.message);
  const reimport=await importFile(saved.file);assert.deepEqual(chemistry(reimport.document),chemistry(edit.after.document));return{saved,evidence:await shot('EX03-mol-reopened')};
 });
 await task('EX04','MOL导入后修改，再保存MOL V2000重开',async()=>{
  await importFile(`${out}/downloads/EX03-ethanol-v3000.mol`);const edit=await editIsotope(),saved=await exportFile('mol','EX04-ethanol-v2000');assert.equal(saved.blocked,false,saved.message);
  const reimport=await importFile(saved.file);assert.deepEqual(chemistry(reimport.document),chemistry(edit.after.document));return{saved,evidence:await shot('EX04-mol-v2000')};
 });
 await task('EX05','原生JSON保存完整文档、重新打开并再次保存',async()=>{
  await importFile('public/test-files/04-preservation/annotated-moved.cdxml');const edit=await editIsotope(),saved=await exportFile('json','EX05-full-document');assert.equal(saved.blocked,false,saved.message);
  const reimport=await importFile(saved.file);assert.deepEqual(reimport.document,edit.after.document);
  const saved2=await exportFile('json','EX05-full-document-second-save');assert.equal(saved2.blocked,false,saved2.message);
  return{saved,secondSave:saved2,exactDocumentPreserved:true,evidence:await shot('EX05-native-json')};
 });
 await task('EX06','RXN反应文件修改反应物同位素、V3000导出重开',async()=>{
  await importFile('public/test-files/13-rxn/reaction-center-v2000.rxn');const edit=await editIsotope(),saved=await exportFile('rxn-v3000','EX06-reaction-edited');assert.equal(saved.blocked,false,saved.message);
  const reimport=await importFile(saved.file);assert.deepEqual(chemistry(reimport.document),chemistry(edit.after.document));
  const step=Object.values(reimport.document.graph.reactions)[0],overview=await e.locator('.overview-card').innerText(),evidence=await shot('EX06-rxn-reopened');
  await e.locator('[data-action="toggle-advanced"]').click();await e.locator('[data-advanced-section="document"]').click();
  const reaction=e.locator('[data-advanced-panel="document"] details.property-section').first();await reaction.locator('summary').click();const roleOptions=await reaction.locator('[data-reaction-role="reactants"] option').allTextContents();const roleEvidence=await shot('EX06-reaction-role-editor');
  findings.push({id:'EX-F04',severity:'P2',type:'scientific-ux',title:'反应文档默认分子概览未说明分子式为反应物、产物和试剂的全文合计',steps:['导入reaction-center-v2000.rxn','核对反应画布和默认分子概览','进入高级编辑→文档与反应'],actual:'画布三个分子片段无角色/方向提示，默认分子概览显示C2H6NaO2全文合计并提示基础检查通过。实际已解析反应物/产物/试剂各1，只有高级栏能核对角色。',expected:'反应文档显示反应概览与角色分区；若显示合计分子式应明确标成全文元素合计，不能让工程师误作单分子式',evidence,secondaryEvidence:roleEvidence});
  if(new Set(roleOptions).size<roleOptions.length)findings.push({id:'EX-F05',severity:'P2',type:'ux',title:'反应角色编辑候选标签重复，难以区分反应物与产物',steps:['导入reaction-center-v2000.rxn','高级编辑→文档与反应→反应步骤1','查看反应物或产物候选'],actual:'两个不同分子均显示“分子片段 · 2 个原子”，缺少名称、分子式或画布定位；修改角色时无法从标签判断对应结构。',expected:'候选显示可区分的名称/分子式/序号，并支持与画布高亮联动',evidence:roleEvidence});
  return{status:'friction',saved,reactionRoles:{reactants:step.reactants.length,products:step.products.length,agents:step.above.length},overview,roleOptions,evidence,roleEvidence};
 });
 await task('EX07','已修改结构后下载原始CDX，检查是否确实原样',async()=>{
  const source='public/test-files/01-basic-cdx/dimethylamine-styled.cdx';await importFile(source);await editIsotope();
  const saved=await exportFile('original','EX07-imported-original');assert.equal(saved.blocked,false,saved.message);assert.deepEqual(await readFile(saved.file),await readFile(source));
  return{saved,originalBytesPreserved:true,evidence:await shot('EX07-after-original-download')};
 });
 await task('EX08','复杂样式CDX的保留保存与跨格式CDXML导出',async()=>{
  await importFile('public/test-files/01-basic-cdx/dimethylamine-styled.cdx');await editIsotope();
  const kept=await exportFile('source','EX08-styled-preserved');assert.equal(kept.blocked,false,kept.message);
  const cross=await exportFile('cdxml','EX08-styled-cross-format');const evidence=await shot('EX08-cross-format-report');
  assert.equal(cross.blocked,true);assert.equal(await e.locator('.export-status').innerText(),'需要确认信息损失');assert.doesNotMatch(cross.message,/0x3/);
  await e.locator('[data-action="export-issues"]').click();assert.match(await e.locator('.issue-list').innerText(),/0x3/);const reportEvidence=await shot('EX08-direct-conversion-report');await e.locator('.issues-dialog [data-action="close-dialog"]').first().click();
  assert.equal(await e.locator('.export-format').inputValue(),'cdxml');
  await e.locator('[data-action="export-source-format"]').click();assert.equal(await e.locator('.export-format').inputValue(),'source');assert.equal(await e.locator('[data-action="download-export"]').isDisabled(),false);
  await e.locator('.export-format').selectOption('cdxml');assert.equal(await e.locator('.allow-lossy').isDisabled(),false);await e.locator('.allow-lossy').check();assert.equal(await e.locator('[data-action="download-export"]').isDisabled(),false);
  const optedLossy=await exportFile('cdxml','EX08-explicit-lossy',{currentPreview:true});assert.equal(optedLossy.blocked,false,optedLossy.message);const imported=await importFile(optedLossy.file);assert.equal(Object.keys(imported.document.graph.atoms).length,3);
  return{status:'passed',sourceSave:kept,cross,optedLossy,directReport:true,sourceRecommendationWorks:true,explicitLossConsentRequired:true,evidence,reportEvidence};
 });
 await task('EX09','查询结构导出MOL时防止无声丢失条件，转回JSON保留',async()=>{
  await importFile('public/test-files/15-query-constraints/native-all-fields.cdxml');const before=await snapshot();
  const blocked=await exportFile('mol','EX09-query-loss');assert.equal(blocked.blocked,true);assert.equal(await e.locator('.allow-lossy').isChecked(),false);
  const evidence=await shot('EX09-loss-blocked');
  assert.equal(await e.locator('.lossy-option').isVisible(),false);assert.equal(await e.locator('.allow-lossy').isDisabled(),true);assert.equal(await e.locator('.export-status').innerText(),'暂不支持此转换');assert.match(blocked.message,/不能通过允许有损导出解除/);
  await e.locator('[data-action="export-json"]').click();const kept=await exportFile('json','EX09-query-safe',{currentPreview:true});assert.equal(kept.blocked,false,kept.message);const back=await importFile(kept.file);assert.deepEqual(back.document,before.document);
  return{status:'passed',lossBlocked:true,message:blocked.message,ineffectiveConsentHidden:true,ineffectiveConsentDisabled:true,directJsonRecommendation:true,safeSave:kept,evidence};
 });
 await task('EX10','损坏CDX导入报错后保留原文档，可取消继续编辑',async()=>{
  await importFile('public/test-files/02-cdxml/aspirin.cdxml');const before=await snapshot();
  const message=await importFile('public/test-files/03-expected-errors/truncated-ethanol.cdx',{expectError:true});const after=await snapshot();assert.deepEqual(after.document,before.document);
  const evidence=await shot('EX10-invalid-import');await e.locator('.import-dialog [data-action="close-dialog"]').first().click();const edit=await editIsotope();return{message,oldDocumentPreserved:true,canContinueEditing:edit.after.revision>after.revision,evidence};
 });
 await task('EX11','导入第二份文件替换当前工作，可撤销恢复',async()=>{
  await importFile('public/test-files/02-cdxml/aspirin.cdxml');const edit=await editIsotope();
  await e.locator('[data-action="import"]').click();const importHelp=await e.locator('.import-dialog').innerText(),evidence=await shot('EX11-import-replacement-affordance');
  const warnsReplacement=/替换|覆盖|replace|overwrite/i.test(importHelp);
  assert.equal(warnsReplacement,true);assert.match(await e.locator('.import-replacement-notice').innerText(),/替换当前整份文档.*不会追加.*撤销恢复/);assert.equal(await e.locator('[data-action="apply-import"]').innerText(),'替换当前文档');
  await e.locator('.import-dialog [data-action="close-dialog"]').first().click();await importFile('public/examples/ethanol.mrv');assert.equal(Object.keys((await snapshot()).document.graph.atoms).length,3);
  await e.locator('[data-action="undo"]').click();assert.deepEqual((await snapshot()).document,edit.after.document);
  return{status:'passed',importHelp,warnsReplacement,undoRestoresDocument:true,evidence};
 });
 await task('EX12','重命名工艺结构，导出SVG插图并检查文件名和内容',async()=>{
  await importFile('public/test-files/02-cdxml/aspirin.cdxml');const name='工艺中间体 A - 13C';await e.locator('.document-title').fill(name);await e.locator('.document-title').press('Tab');
  const saved=await exportFile('svg','EX12-engineering-figure');assert.equal(saved.blocked,false,saved.message);assert.ok(saved.suggestedFilename.includes(name));const xml=await readFile(saved.file,'utf8');assert.match(xml,/<svg/);assert.match(xml,/<path|<line|<text/);
  return{saved,vectorFileValid:true,evidence:await shot('EX12-svg-saved')};
 });
 await task('EX13','源CDXML移动原子后保留保存，重开检验位置',async()=>{
  await importFile('public/test-files/02-cdxml/aspirin.cdxml');await e.locator('[data-tool="select"]').first().click();
  const before=await snapshot(), atom=Object.values(before.document.graph.atoms).find(a=>a.element==='O');const hit=e.locator(`[data-atom="${atom.id}"] .atom-hit`),box=await hit.boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+35,box.y+box.height/2-25,{steps:8});await page.mouse.up();
  const after=await snapshot();assert.notDeepEqual(after.document.depiction.positions[atom.id],before.document.depiction.positions[atom.id]);
  const saved=await exportFile('source','EX13-layout-preserved');assert.equal(saved.blocked,false,saved.message);const reimport=await importFile(saved.file);assert.deepEqual(chemistry(reimport.document),chemistry(after.document));
  const lengths=doc=>Object.values(doc.graph.bonds).map(b=>{const [a,c]=b.atoms.map(id=>doc.depiction.positions[id]);return Math.hypot(a.x-c.x,a.y-c.y);}).sort((a,b)=>a-b);
  const expected=lengths(after.document),actual=lengths(reimport.document);expected.forEach((length,i)=>assert.ok(Math.abs(length-actual[i])<.015,`bond length drift ${length} -> ${actual[i]}`));
  return{saved,dragDelta:{x:35,y:-25},bondLengthsPreserved:true,evidence:await shot('EX13-layout-reopened')};
 });
 await task('EX14','修改文档名称后使用源格式保存，检查名称是否保留',async()=>{
  await importFile('public/examples/ethanol.cdxml');const renamed='工艺批次 ETOH-13C';await e.locator('.document-title').fill(renamed);await e.locator('.document-title').press('Tab');
  const saved=await exportFile('source','EX14-renamed-source',{preserveFilename:true});
  if(saved.blocked){return{status:'friction',saved,evidence:await shot('EX14-renamed-source-blocked')};}
  const back=await importFile(saved.file),titlePreserved=back.document.title===renamed;
  const evidence=await shot('EX14-renamed-source-reopened');
  if(!titlePreserved)findings.push({id:'EX-F04',severity:'P2',type:'ux',title:'源格式保留保存后文档名称未保留',steps:['导入ethanol.cdxml','名称改成工艺批次 ETOH-13C','源格式保留保存并重开'],actual:`下载名${saved.suggestedFilename}，重开title=${back.document.title}`,expected:'文档名称的持久化语义应清楚；无法写回时提示，或另设明确的另存为文件名',evidence});
  return{status:titlePreserved?'passed':'friction',saved,titlePreserved,reopenedTitle:back.document.title,evidence};
 });
 await dismiss();
 await writeFile(`${out}/results.json`,JSON.stringify({browser:'Chrome',viewport:{width:1600,height:1050},method:'All user mutations through visible UI and file chooser. Read-only snapshot assertions; isolated browser context. Automation timings are not human task-time measurements. Not a ChemDraw interoperability certification.',results,findings,pageErrors:errors},null,2)+'\n');
 const counts=Object.fromEntries(['passed','friction','blocked','failed'].map(status=>[status,results.filter(r=>r.status===status).length]));
 await writeFile(`${out}/findings.md`,`# 化学工程师体验：文件交换与保存\n\n${results.length} 项用户任务：${JSON.stringify(counts)}。独立 Chrome context，所有导入、修改、导出和重开通过可见 UI；未修改生产代码。时长为自动操作用时，不是人工学习或任务用时。没有把这些样例等同全部格式语义或真实 ChemDraw 往返认证。\n\n`+findings.map(f=>`## ${f.id} ${f.severity} ${f.title}\n\n复现：${f.steps.join(' → ')}\n\n实际：${f.actual}\n\n期望：${f.expected}\n\n证据：${f.evidence}\n`).join('\n')+'\n## 任务结果\n\n'+results.map(r=>`- ${r.id} ${r.status}：${r.title}${r.error?' — '+r.error:''}`).join('\n')+'\n');
 console.log(JSON.stringify({counts,findings:findings.length,pageErrors:errors}));
 if(results.some(result=>result.status==='failed')||errors.length)process.exitCode=1;
}finally{await context.close();await browser.close();}
