import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {showAdvancedEditor} from './browser-advanced-ui.mjs';
const {chromium}=await import(process.argv[2]||'playwright');await mkdir('.local/expansion-downloads',{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),results=[];
try{
 const page=await browser.newPage({viewport:{width:1600,height:1100},acceptDownloads:true}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:5173/');await page.waitForFunction(()=>!!window.moleculeEditor);
 for(const name of ['ether','two-port','chiral','recursive']){
  const file=`${name}-original.cdxml`;
  await page.locator('[data-action="import"]').first().click();await page.locator('.file-input').setInputFiles(`docs/validation/expansion/${file}`);
  await page.waitForFunction(name=>document.querySelector('chemical-editor').shadowRoot.querySelector('.import-filename').textContent===name,file);await page.locator('[data-action="apply-import"]').click();await page.waitForFunction(()=>!document.querySelector('chemical-editor').shadowRoot.querySelector('.import-dialog').open);
  const before=await page.evaluate(()=>{const api=window.moleculeEditor,doc=api.getDocument(),atom=Object.values(doc.graph.atoms).find(a=>a.substructure);api.setSelection({atomIds:[atom.id]});api.showPluginPanel();return JSON.stringify(doc);});
  await showAdvancedEditor(page,'fragments');
  await page.locator(`[data-action="${name==='recursive'?'expand-substructure-recursive':'expand-substructure'}"]`).click();
  const proof=await page.evaluate(async()=>{
   const sdk=await import('/src/index.ts'),api=window.moleculeEditor,doc=api.getDocument(),engine=await sdk.loadChemistryEngine(),analysis=engine.analyze(doc);
   if(Object.values(doc.graph.atoms).some(a=>a.substructure||a.attachment))throw Error('Expanded graph still contains a wrapper or bound virtual port');
   return {atoms:analysis.atomCount,bonds:analysis.bondCount,smiles:analysis.smiles,stereoAtoms:Object.values(analysis.stereoAtoms),after:JSON.stringify(doc)};
  });
  await page.locator('[data-action="undo"]').first().click();assert.equal(await page.evaluate(()=>JSON.stringify(window.moleculeEditor.getDocument())),before);await page.locator('[data-action="redo"]').first().click();assert.equal(await page.evaluate(()=>JSON.stringify(window.moleculeEditor.getDocument())),proof.after);
  assert.equal(await page.locator('.drawing [data-atom]').count(),proof.atoms);
  await page.locator('[data-action="export"]').first().click();await page.locator('.export-format').selectOption('source');assert.equal(await page.locator('[data-action="download-export"]').isDisabled(),false);
  const pending=page.waitForEvent('download');await page.locator('[data-action="download-export"]').click();const download=await pending,out=`.local/expansion-downloads/${name}.cdxml`;await download.saveAs(out);await page.locator('.export-dialog [data-action="close-dialog"]').click();
  await page.evaluate(async base64=>{const s=await import('/src/index.ts'),doc=window.moleculeEditor.getDocument(),data=new TextDecoder().decode(Uint8Array.from(atob(base64),c=>c.charCodeAt(0))),back=s.importDocument({data}).document;
   const normalize=d=>JSON.stringify(s.documentProjection(d),(_k,v)=>typeof v==='number'?Math.round(v*1e6)/1e6:v);if(normalize(back)!==normalize(doc))throw Error('Actual source download changed expanded chemistry');},(await readFile(out)).toString('base64'));
  if(name==='chiral'){await page.evaluate(()=>window.moleculeEditor.fit());await page.screenshot({path:'.local/expansion-editor.png'});}
  const {after,...summary}=proof;results.push({file,...summary,visibleExpansion:true,visibleAtomCount:true,undoRedo:true,sourceDownloadRoundtrip:true});console.log(`Verified ${name}: visible expansion, ordinary calculation, undo and source download`);
 }
 assert.deepEqual(errors,[]);await writeFile('docs/validation/expansion/browser-results.json',JSON.stringify({browser:'Chrome',results,errors,aiTested:false},null,2)+'\n');
}finally{await browser.close();}
