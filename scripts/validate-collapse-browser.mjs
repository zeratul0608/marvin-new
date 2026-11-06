import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {showAdvancedEditor} from './browser-advanced-ui.mjs';
const {chromium}=await import(process.argv[2]||'playwright');
const output='docs/validation/collapse',cases=JSON.parse(await readFile(`${output}/adapter-results.json`,'utf8')).results;
assert.equal(cases.length,6,'Expected the six independently prepared contraction examples');
await mkdir('.local/collapse-downloads',{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),results=[];
try{
 const page=await browser.newPage({viewport:{width:1600,height:1100},acceptDownloads:true}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:5173/');await page.waitForFunction(()=>!!window.moleculeEditor);
 for(const test of cases){
  await page.locator('[data-action="import"]').first().click();
  await page.locator('.file-input').setInputFiles(`${output}/${test.original}`);
  await page.waitForFunction(name=>document.querySelector('chemical-editor').shadowRoot.querySelector('.import-filename').textContent===name,test.original);
  await page.locator('[data-action="apply-import"]').click();
  await page.waitForFunction(()=>!document.querySelector('chemical-editor').shadowRoot.querySelector('.import-dialog').open);
  const before=await page.evaluate(async indices=>{
   const sdk=await import('/src/index.ts'),api=window.moleculeEditor,doc=api.getDocument(),ids=Object.keys(doc.graph.atoms);
   if(indices.some(i=>!ids[i]))throw Error('Prepared selection index is missing from the imported graph');
   api.setSelection({atomIds:indices.map(i=>ids[i])});api.showPluginPanel();
   return {document:JSON.stringify(doc),rootAtoms:ids.length,summary:sdk.knownChemicalSummary(doc)};
  },test.selectedIndices);
  await showAdvancedEditor(page,'fragments');
  await page.locator('details.collapse-controls > summary').click();
  await page.locator('[data-collapse-label]').fill(test.label);
  await page.locator('[data-action="collapse-substructure"]').click();
  const collapsed=await page.evaluate(async label=>{
   const sdk=await import('/src/index.ts'),api=window.moleculeEditor,doc=api.getDocument(),wrappers=Object.values(doc.graph.atoms).filter(a=>a.substructure);
   if(wrappers.length!==1||wrappers[0].substructure.label!==label)throw Error('Visible contraction did not create the expected editable abbreviation');
   const review=await api.executeCommand('structure-review.review'),summary=sdk.knownChemicalSummary(doc);
   if(review.formalCharge!==summary.formalCharge||review.isotopeAtomCount!==summary.isotopeAtomCount||review.chemicalSummaryComplete!==summary.complete)throw Error('Visible review command lost recursive charge or isotope information');
   return {document:JSON.stringify(doc),wrapperId:wrappers[0].id,rootAtoms:Object.keys(doc.graph.atoms).length,summary};
  },test.label);
  assert.equal(collapsed.rootAtoms,before.rootAtoms-test.selectedIndices.length+1);
  assert.deepEqual(collapsed.summary,before.summary);
  assert.deepEqual(collapsed.summary,test.summary);
  assert.equal(await page.locator('.drawing [data-atom]').count(),collapsed.rootAtoms);
  await page.locator('[data-action="undo"]').first().click();
  assert.equal(await page.evaluate(()=>JSON.stringify(window.moleculeEditor.getDocument())),before.document);
  await page.locator('[data-action="redo"]').first().click();
  assert.equal(await page.evaluate(()=>JSON.stringify(window.moleculeEditor.getDocument())),collapsed.document);
  await page.locator('[data-action="export"]').first().click();
  await page.locator('.export-format').selectOption('source');
  assert.equal(await page.locator('[data-action="download-export"]').isDisabled(),false);
  const pending=page.waitForEvent('download');await page.locator('[data-action="download-export"]').click();
  const download=await pending,file=`.local/collapse-downloads/${test.scenario}-collapsed.cdxml`;await download.saveAs(file);
  await page.locator('.export-dialog [data-action="close-dialog"]').click();
  const downloaded=await page.evaluate(async({base64,expected})=>{
   const sdk=await import('/src/index.ts'),{equivalentDocuments}=await import('/scripts/document-correspondence.mjs'),api=window.moleculeEditor,doc=api.getDocument();
   const data=new TextDecoder().decode(Uint8Array.from(atob(base64),c=>c.charCodeAt(0))),back=sdk.importDocument({data}).document;
   if(!equivalentDocuments(sdk,back,doc))throw Error('Actual downloaded source changed the contracted model');
   const wrapper=Object.values(back.graph.atoms).find(a=>a.substructure);if(!wrapper)throw Error('Downloaded source no longer contains an editable abbreviation');
   const expanded=sdk.applyDocumentEdits(back,[{type:'expand-substructure',atomId:wrapper.id,recursive:true}]).document,engine=await sdk.loadChemistryEngine(),analysis=engine.analyze(expanded);
   if(analysis.smiles!==expected)throw Error('Downloaded source changed chemical identity after expansion');
   return {smiles:analysis.smiles,summary:sdk.knownChemicalSummary(back),stereoAtoms:Object.values(analysis.stereoAtoms)};
  },{base64:(await readFile(file)).toString('base64'),expected:test.canonicalIsomericSmiles});
  assert.deepEqual(downloaded.summary,test.summary);
  assert.equal(await page.evaluate(()=>JSON.stringify(window.moleculeEditor.getDocument())),collapsed.document);
  await page.evaluate(id=>{const api=window.moleculeEditor;api.setSelection({atomIds:[id]});api.showPluginPanel();api.fit();},collapsed.wrapperId);
  if(test.scenario==='charged-isotope'){
   await page.evaluate(()=>window.moleculeEditor.showPluginPanel('structure-review'));
   await page.screenshot({path:'.local/collapse-charged-summary.png'});
   await page.evaluate(()=>window.moleculeEditor.showPluginPanel());
  }
  if(test.scenario==='phenyl')await page.screenshot({path:'.local/collapse-phenyl.png'});
  await showAdvancedEditor(page,'fragments');
  await page.locator('[data-action="expand-substructure-recursive"]').click();
  const restored=await page.evaluate(async expected=>{
   const sdk=await import('/src/index.ts'),doc=window.moleculeEditor.getDocument(),engine=await sdk.loadChemistryEngine(),analysis=engine.analyze(doc);
   if(Object.values(doc.graph.atoms).some(a=>a.substructure||a.attachment))throw Error('UI recursive expansion left a collapsed node or bound virtual port');
   if(analysis.smiles!==expected)throw Error('UI expansion changed chemical identity');
   return {atoms:analysis.atomCount,bonds:analysis.bondCount,smiles:analysis.smiles,summary:sdk.knownChemicalSummary(doc),stereoAtoms:Object.values(analysis.stereoAtoms)};
  },test.canonicalIsomericSmiles);
  assert.equal(restored.atoms,test.atomCount);assert.equal(restored.bonds,test.bondCount);assert.deepEqual(restored.summary,test.summary);
  assert.equal(await page.locator('.drawing [data-atom]').count(),test.atomCount);
  results.push({file:test.original,scenario:test.scenario,label:test.label,selectedIndices:test.selectedIndices,rootAtomsBefore:before.rootAtoms,rootAtomsCollapsed:collapsed.rootAtoms,chemicalSummary:collapsed.summary,canonicalIsomericSmiles:restored.smiles,stereoAtoms:restored.stereoAtoms,visibleFileImport:true,visibleContraction:true,visibleAtomCounts:true,recursiveChargeAndIsotope:true,undoRedo:true,sourceDownloadRoundtrip:true,downloadedExpansionChemicalIdentity:true,visibleRecursiveExpansion:true});
  console.log(`Verified ${test.scenario}: visible contraction, recursive summary, undo, source download and UI expansion`);
 }
 assert.deepEqual(errors,[]);
 await writeFile(`${output}/browser-results.json`,JSON.stringify({browser:'Chrome',results,errors,aiTested:false},null,2)+'\n');
}finally{await browser.close();}
