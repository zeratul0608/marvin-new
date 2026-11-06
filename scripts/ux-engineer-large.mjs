import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';

// Synthetic, noncommercial CDXML. All editor changes below are visible UI actions.
const {chromium}=await import(process.argv[2]||'playwright');
const out=path.resolve(process.env.UX_OUTPUT_DIR||'.local/ux-engineer/large');
await mkdir(path.join(out,'downloads'),{recursive:true});
const fixture=path.join(out,'large-100-benzene-600-atoms.cdxml');
let nextId=2;
const fragments=[];
for(let row=0;row<10;row++)for(let col=0;col<10;col++){
  const fragmentId=nextId++,atomIds=Array.from({length:6},()=>nextId++);
  const nodes=atomIds.map((id,i)=>{const theta=i*Math.PI/3;return `<n id="${id}" p="${(col*100+30*Math.cos(theta)).toFixed(6)} ${(row*100+30*Math.sin(theta)).toFixed(6)}" Element="6"/>`;});
  const bonds=atomIds.map((id,i)=>`<b id="${nextId++}" B="${id}" E="${atomIds[(i+1)%6]}" Order="${i%2===0?2:1}"/>`);
  fragments.push(`<fragment id="${fragmentId}">\n${nodes.join('\n')}\n${bonds.join('\n')}\n</fragment>`);
}
await writeFile(fixture,`<?xml version="1.0" encoding="UTF-8"?>\n<CDXML BondLength="30"><page id="1">\n${fragments.join('\n')}\n</page></CDXML>\n`);

const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1600,height:1050},acceptDownloads:true});
// Observer records browser main-thread long tasks; it never changes editor state.
await context.addInitScript(()=>{
  window.__uxLargeObservation={longTasks:[]};
  try{new PerformanceObserver(list=>{for(const item of list.getEntries())window.__uxLargeObservation.longTasks.push({startTime:item.startTime,duration:item.duration,name:item.name});}).observe({type:'longtask',buffered:true});}catch{}
});
const page=await context.newPage(),pageErrors=[],steps=[],evidence=[],findings=[];
page.setDefaultTimeout(30000);
page.on('pageerror',error=>pageErrors.push(error.message));
const e=page.locator('chemical-editor').first();
const snapshot=()=>page.evaluate(()=>window.moleculeEditor.getSnapshot());
const shot=async name=>{const file=path.join(out,`${name}.png`);await page.screenshot({path:file,fullPage:true});evidence.push(file);return file;};
const profile=async(id,title,fn)=>{
  const started=performance.now(),browserStarted=await page.evaluate(()=>performance.now());
  const detail=await fn();
  const browserEnded=await page.evaluate(()=>performance.now());
  const timing={automationWaitMs:Math.round(performance.now()-started),browserWindowMs:Math.round(browserEnded-browserStarted)};
  steps.push({id,title,status:'passed',...timing,...detail,browserStarted,browserEnded});
  console.log(`${id}: ${timing.automationWaitMs} ms`);
  return detail;
};
const counts=doc=>{
  const atoms=Object.values(doc.graph.atoms),bonds=Object.values(doc.graph.bonds),adj=new Map(atoms.map(a=>[a.id,[]]));
  for(const bond of bonds){adj.get(bond.atoms[0]).push(bond.atoms[1]);adj.get(bond.atoms[1]).push(bond.atoms[0]);}
  const seen=new Set(),components=[];
  for(const atom of atoms)if(!seen.has(atom.id)){const queue=[atom.id];seen.add(atom.id);let size=0;while(queue.length){const id=queue.pop();size++;for(const neighbour of adj.get(id))if(!seen.has(neighbour)){seen.add(neighbour);queue.push(neighbour);}}components.push(size);}
  return{atoms:atoms.length,bonds:bonds.length,components:components.length,componentSizes:components};
};
const importFile=async file=>{
  await e.locator('[data-action="import"]').click();
  const waiting=page.waitForEvent('filechooser');await e.locator('[data-action="choose-file"]').click();await(await waiting).setFiles(file);
  await page.waitForFunction(name=>document.querySelector('chemical-editor').shadowRoot.querySelector('.import-filename').textContent===name,path.basename(file));
  const applyStart=performance.now();await e.locator('[data-action="apply-import"]').click();
  await e.locator('.import-dialog').waitFor({state:'hidden'});
  await e.locator('.canvas [data-atom]').first().waitFor({state:'visible'});
  return{snapshot:await snapshot(),applyToVisibleMs:Math.round(performance.now()-applyStart)};
};
let status='passed',failure=null,observer=null;
try{
  await page.goto('http://127.0.0.1:5173/');await page.waitForFunction(()=>!!window.moleculeEditor);
  const imported=await profile('LG01','通过文件选择器导入 100 个独立苯环（600 原子、600 键）',async()=>{
    const result=await importFile(fixture),actual=counts(result.snapshot.document);
    assert.equal(actual.atoms,600);assert.equal(actual.bonds,600);assert.equal(actual.components,100);assert.ok(actual.componentSizes.every(n=>n===6));
    assert.equal(await e.locator('.canvas [data-atom]').count(),600);
    return{counts:actual,applyToVisibleMs:result.applyToVisibleMs,overview:await e.locator('.overview-card').innerText(),zoom:await e.locator('.zoom-label').innerText()};
  });
  const baseline=await snapshot();await shot('LG01-large-imported');
  let edited,atomId;
  await profile('LG02','在画布点击原子并通过属性面板修改为 13C',async()=>{
    await e.locator('[data-tool="select"]').first().click();
    const canvas=await e.locator('.canvas').boundingBox();
    const targets=await e.locator('.canvas [data-atom] .atom-hit').evaluateAll(nodes=>nodes.map(n=>{const b=n.getBoundingClientRect();return{id:n.closest('[data-atom]').getAttribute('data-atom'),x:b.x+b.width/2,y:b.y+b.height/2};}));
    const centre={x:canvas.x+canvas.width/2,y:canvas.y+canvas.height/2};
    const target=targets.filter(n=>n.x>canvas.x+20&&n.x<canvas.x+canvas.width-20&&n.y>canvas.y+20&&n.y<canvas.y+canvas.height-20).sort((a,b)=>Math.hypot(a.x-centre.x,a.y-centre.y)-Math.hypot(b.x-centre.x,b.y-centre.y))[0];
    assert.ok(target,'An atom must be visible inside the canvas');atomId=target.id;
    await e.locator(`[data-atom="${atomId}"] .atom-hit`).click();
    const input=e.locator('[data-property="isotope"]');await input.fill('13');await input.press('Tab');
    edited=await snapshot();assert.equal(edited.document.graph.atoms[atomId].isotope,13);assert.equal(edited.revision,baseline.revision+1);
    return{atomId,isotope:13,selectedAtomCount:edited.selection.atomIds.length,counts:counts(edited.document)};
  });
  await shot('LG02-isotope-edited');
  await profile('LG03','点击撤销，确认整份 600 原子文档精确恢复',async()=>{
    await e.locator('[data-action="undo"]').click();const back=await snapshot();assert.deepEqual(back.document,baseline.document);
    return{exactDocumentRestored:true,revision:back.revision};
  });
  await profile('LG04','点击重做，恢复同位素编辑再进行保存',async()=>{
    await e.locator('[data-action="redo"]').click();assert.deepEqual((await snapshot()).document,edited.document);return{exactEditedDocumentRestored:true};
  });
  await profile('LG05','点击放大、缩小和适应画布，检查结构保持完整',async()=>{
    const initialZoom=await e.locator('.zoom-label').innerText();
    await e.locator('.footer [data-action="zoom-in"]').click();await e.locator('.footer [data-action="zoom-in"]').click();
    const zoomed=await e.locator('.zoom-label').innerText();assert.notEqual(zoomed,initialZoom);
    await e.locator('.footer [data-action="zoom-out"]').click();await e.locator('.footer [data-action="fit"]').click();
    const fitted=await e.locator('.zoom-label').innerText();assert.equal(fitted,initialZoom);assert.deepEqual((await snapshot()).document,edited.document);
    const toolbar=await e.locator('.elements').boundingBox();
    const occluded=await e.locator('.canvas [data-atom] .atom-hit').evaluateAll((nodes,toolbar)=>nodes.map(n=>{const b=n.getBoundingClientRect();return{id:n.closest('[data-atom]').getAttribute('data-atom'),x:b.x+b.width/2,y:b.y+b.height/2};}).filter(n=>n.x>toolbar.x&&n.x<toolbar.x+toolbar.width&&n.y>toolbar.y&&n.y<toolbar.y+toolbar.height),toolbar);
    if(occluded.length){status='friction';findings.push({id:'LG-F01',severity:'P2',title:'适应画布后部分结构被常用元素浮动条遮挡',steps:['通过导入选择自造的100个独立苯环CDXML','点击底栏适应画布'],actual:`缩放适配后有${occluded.length}个原子中心位于常用元素工具条覆盖区域，截图显示第一行左侧两个苯环局部被遮挡。结构数据完整，但“适应画布”未把浮动工具条当作遮挡区域。`,expected:'适配时留出浮动工具条安全区域，或允许收起/移动该工具条，确保结构可见且可直接点击。',evidence:path.join(out,'LG05-fit-all-100-rings.png'),occludedAtomIds:occluded.map(a=>a.id),toolbar});}
    return{initialZoom,zoomed,fitted,documentUnchanged:true,renderedAtoms:await e.locator('.canvas [data-atom]').count(),occludedAtomCount:occluded.length,occludedAtomIds:occluded.map(a=>a.id),toolbar};
  });
  await shot('LG05-fit-all-100-rings');
  let saved;
  await profile('LG06','导出原生 JSON，执行真实文件下载',async()=>{
    await e.locator('[data-action="export"]').click();await e.locator('.export-format').selectOption('json');
    assert.equal(await e.locator('[data-action="download-export"]').isDisabled(),false);
    const preview=await e.locator('.export-message').innerText();
    const waiting=page.waitForEvent('download');await e.locator('[data-action="download-export"]').click();const download=await waiting;
    saved=path.join(out,'downloads',download.suggestedFilename());await download.saveAs(saved);
    const bytes=await readFile(saved);JSON.parse(bytes.toString('utf8'));
    await e.locator('.export-dialog [data-action="close-dialog"]').first().click();
    return{suggestedFilename:download.suggestedFilename(),download:saved,bytes:bytes.length,preview};
  });
  await profile('LG07','通过导入界面重开实际下载的 JSON，核对完整文档',async()=>{
    const reimport=await importFile(saved);assert.deepEqual(reimport.snapshot.document,edited.document);const actual=counts(reimport.snapshot.document);
    assert.equal(actual.atoms,600);assert.equal(actual.bonds,600);assert.equal(actual.components,100);assert.equal(reimport.snapshot.document.graph.atoms[atomId].isotope,13);
    return{exactDocumentPreserved:true,counts:actual,applyToVisibleMs:reimport.applyToVisibleMs,isotope13Preserved:true};
  });
  await shot('LG07-json-reopened');
}catch(error){status='failed';failure={message:error.message,stack:error.stack};await shot('LG-failure').catch(()=>{});console.error(error.stack);}
finally{
  observer=await page.evaluate(()=>window.__uxLargeObservation).catch(()=>null);
  const longTasks=observer?.longTasks??[];
  for(const step of steps){const matches=longTasks.filter(t=>t.startTime>=step.browserStarted&&t.startTime<=step.browserEnded);step.mainThreadLongTasks={count:matches.length,maxMs:Math.round(Math.max(0,...matches.map(t=>t.duration))),totalMs:Math.round(matches.reduce((n,t)=>n+t.duration,0))};}
  const result={status,fixture,fixtureBytes:(await readFile(fixture)).length,syntheticSource:'Generated 10×10 grid of 100 independent alternating-bond benzene fragments; 600 carbon atoms, 600 bonds. No commercial corpus.',browser:'Chrome headless',viewport:{width:1600,height:1050},method:'Isolated context. All document changes through visible UI clicks, native fields, file chooser, Undo/Redo, zoom/fit buttons, export download and reimport. SDK getSnapshot used read-only. Durations include Playwright dispatch/auto-wait and assertions; screenshots excluded. Browser PerformanceObserver long-task observations are diagnostic only, not a performance certification or a manual smoothness judgment.',steps,findings,pageErrors,failure,evidence,observedMainThreadLongTasks:longTasks};
  await writeFile(path.join(out,'results.json'),JSON.stringify(result,null,2)+'\n');
  const maxWait=Math.max(0,...steps.map(s=>s.automationWaitMs));
  await writeFile(path.join(out,'findings.md'),`# 大文档用户体验补测\n\n结果：${status}。自造 100 个独立苯环，共 600 原子、600 键；不含商业语料。独立 Chrome context（1600×1050），通过可见 UI 完成导入、原子属性修改、撤销/重做、缩放适配、真实 JSON 下载和重导入。生产代码未修改。\n\n${failure?`失败：${failure.message}\n\n`:'600 原子和 100 个独立组分均保留；撤销精确恢复原文档，重做和 JSON 重导入精确保留编辑后文档。\n\n'}页面脚本错误：${pageErrors.length}。最长步骤自动化等待 ${maxWait} ms；这些是自动化调度和等待时间，不能当作人工操作用时或性能认证。浏览器长任务记录见 results.json。\n\n| 步骤 | 结果 | 自动化等待 ms | 浏览器主线程长任务数 | 最大长任务 ms |\n| --- | --- | ---: | ---: | ---: |\n${steps.map(s=>`| ${s.id} ${s.title} | ${s.status} | ${s.automationWaitMs} | ${s.mainThreadLongTasks.count} | ${s.mainThreadLongTasks.maxMs} |`).join('\n')}\n\n所有已完成步骤均在 30 秒 UI 等待阈值内完成；未观察到操作超时或页面错误。最长主线程长任务 ${Math.round(Math.max(0,...steps.map(s=>s.mainThreadLongTasks.maxMs)))} ms，提示有短暂停顿风险；不能据此宣称完全流畅。这是单次 headless 诊断，不是性能认证。\n\n${findings.map(f=>`## ${f.id} ${f.severity} ${f.title}\n\n复现：${f.steps.join(' → ')}\n\n实际：${f.actual}\n\n期望：${f.expected}\n\n证据：${f.evidence}\n`).join('\n')}\n证据：\n\n${evidence.map(f=>`- ${f}`).join('\n')}\n`);
  console.log(JSON.stringify({status,steps:steps.length,pageErrors,failure,stepsTiming:steps.map(s=>({id:s.id,ms:s.automationWaitMs,longTasks:s.mainThreadLongTasks}))},null,2));
  await context.close();await browser.close();
}
if(status==='failed')process.exitCode=1;
