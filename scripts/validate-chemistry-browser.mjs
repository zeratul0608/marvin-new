import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createAppServer} from '../server/start.mjs';
const {chromium}=await import(process.argv[2]||'playwright');
await mkdir('docs/validation/chemistry-engine',{recursive:true});
await mkdir('.local',{recursive:true});
const production=createAppServer(),sdkFiles=createAppServer({dist:'dist-sdk'});
const sdk=createServer((req,res)=>{
  if(req.url==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<!doctype html><html lang="zh"><meta charset="utf-8"><title>SDK computation test</title><body></body></html>');}
  else sdkFiles.emit('request',req,res);
});
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`)));
const productionUrl=await listen(production),sdkUrl=await listen(sdk),browser=await chromium.launch({channel:'chrome',headless:true});
const results=[];
try{
  for(const [mode,url]of [['development','http://127.0.0.1:5173'],['production',productionUrl],['sdk',sdkUrl]]){
    const page=await browser.newPage({viewport:{width:1600,height:1100},acceptDownloads:true}),errors=[],assets=[],remote=[];
    page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.url().includes('/rdkit-'))assets.push({path:new URL(r.url()).pathname,status:r.status(),type:r.headers()['content-type']});});
    page.on('request',r=>{if(!r.url().startsWith(url)&&/^https?:/.test(r.url()))remote.push(r.url());});
    await page.goto(url);
    if(mode==='sdk')await page.evaluate(async()=>{const s=await import('/chemical-editor.js');window.testSdk=s;window.moleculeEditor=s.createChemicalEditor({container:document.body,document:s.exampleDocument('ethanol'),plugins:[s.createChemistryPlugin()]});});
    await page.waitForFunction(()=>!!window.moleculeEditor);
    assert.equal(assets.length,0,'Calculation assets should be lazy');
    await page.evaluate(()=>window.moleculeEditor.showPluginPanel('chemistry-engine'));
    const input=page.getByLabel('输入 SMILES',{exact:true});await input.fill('N[C@@H](C)C(=O)O');await page.locator('[data-chemistry-action="import-smiles"]').click();
    await page.waitForFunction(()=>document.querySelector('chemical-editor').shadowRoot.querySelector('[data-chemistry-status]').textContent.startsWith('SMILES 已载入'));
    assert.match(await page.locator('[data-chemistry-summary]').innerText(),/C3H7NO2/);
    const before=await page.evaluate(()=>JSON.stringify(window.moleculeEditor.getDocument()));
    await page.locator('[data-chemistry-action="clean-2d"]').click();await page.waitForFunction(()=>document.querySelector('chemical-editor').shadowRoot.querySelector('[data-chemistry-status]').textContent.startsWith('已清理'));
    await page.locator('[data-chemistry-action="assign-stereo"]').click();await page.waitForFunction(()=>document.querySelector('chemical-editor').shadowRoot.querySelector('[data-chemistry-status]').textContent.startsWith('已更新'));
    assert.equal(await page.locator('[data-cip-atom]').textContent(),'(S)');
    if(mode==='development')await page.screenshot({path:'.local/chemistry-panel.png'});
    const proof=await page.evaluate(async(mode)=>{
      const s=mode==='development'?await import('/src/index.ts'):mode==='sdk'?window.testSdk:null;
      const api=window.moleculeEditor,doc=api.getDocument(),cip=Object.values(doc.graph.atoms).filter(a=>a.cipLabel).map(a=>a.cipLabel);
      if(cip.length!==1||cip[0]!=='S')throw Error('Alanine CIP should be S');
      const labelled=JSON.stringify(doc);api.undo();if(Object.values(api.getDocument().graph.atoms).some(a=>a.cipLabel))throw Error('CIP undo failed');api.redo();if(JSON.stringify(api.getDocument())!==labelled)throw Error('CIP redo failed');
      if(s){const engine=await s.loadChemistryEngine(),cdxml=s.exportDocument(doc,{format:'cdxml'}),back=s.importDocument({data:cdxml.data}).document;if(engine.analyze(back).smiles!==engine.analyze(doc).smiles)throw Error('CDXML changed chemical identity');return {cip,smiles:engine.analyze(doc).smiles,cdxmlRoundtrip:true};}
      return {cip,smiles:null};
    },mode);
    // Drive an actual format download on the production app as well.
    await page.locator('[data-action="export"]').first().click();await page.locator('.export-format').selectOption('cdxml');
    const pending=page.waitForEvent('download');await page.locator('[data-action="download-export"]').click();const download=await pending;
    const downloadPath=`.local/chemistry-${mode}.cdxml`;await download.saveAs(downloadPath);assert.match(await readFile(downloadPath,'utf8'),/<CDXML/);
    await page.locator('.export-dialog [data-action="close-dialog"]').click();
    await input.fill('not-a-molecule');const stable=await page.evaluate(()=>JSON.stringify(window.moleculeEditor.getDocument()));await page.locator('[data-chemistry-action="import-smiles"]').click();
    await page.waitForFunction(()=>!document.querySelector('chemical-editor').shadowRoot.querySelector('[data-chemistry-action="import-smiles"]').disabled);
    assert.equal(await page.evaluate(()=>JSON.stringify(window.moleculeEditor.getDocument())),stable);
    assert.ok(assets.some(a=>a.path.endsWith('.wasm')&&a.status===200&&a.type==='application/wasm'));
    assert.deepEqual(errors,[]);assert.deepEqual(remote,[]);
    results.push({mode,...proof,lazyWasm:true,localRequestsOnly:true,actualButtons:true,undoRedo:true,cdxmlDownload:true,invalidInputAtomic:true,assets,beforeAtoms:JSON.parse(before).graph.atoms?Object.keys(JSON.parse(before).graph.atoms).length:0,errors});
    console.log(`Verified ${mode}: SMILES, cleanup, CIP, undo and CDXML download`);await page.close();
  }
  await writeFile('docs/validation/chemistry-engine/browser-results.json',JSON.stringify({results,aiTested:false},null,2)+'\n');
}finally{await browser.close();await Promise.all([new Promise(r=>production.close(r)),new Promise(r=>sdk.close(r))]);}
