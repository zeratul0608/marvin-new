import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {showAdvancedEditor} from './browser-advanced-ui.mjs';

const {chromium}=await import(process.argv[2]||'playwright');
const directory='docs/validation/query-constraints',downloads='.local/query-constraints-downloads';
await mkdir(downloads,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),results=[],failures=[],errors=[],consoleErrors=[];
const page=await browser.newPage({viewport:{width:1660,height:1180},acceptDownloads:true});
page.setDefaultTimeout(25000);
page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
const editor=page.locator('chemical-editor').first();
const serialized=()=>page.evaluate(()=>JSON.stringify(window.moleculeEditor.getDocument()));
async function importFile(file){
 await editor.locator('[data-action="import"]').first().click();
 await editor.locator('.file-input').setInputFiles(file);
 await page.waitForFunction(name=>document.querySelector('chemical-editor').shadowRoot.querySelector('.import-filename').textContent===name,path.basename(file));
 await editor.locator('[data-action="apply-import"]').click();
 await page.waitForFunction(()=>!document.querySelector('chemical-editor').shadowRoot.querySelector('.import-dialog').open);
}
async function openDetails(selector){
 const details=editor.locator(selector);await details.waitFor({state:'visible'});
 if(!await details.evaluate(node=>node.open))await details.locator('summary').click();
}
async function atomField(field,value,kind='select'){
 await showAdvancedEditor(page,'queries');
 await openDetails('details.advanced-query-controls');
 const control=editor.locator(`[data-query-constraint="${field}"]`);assert.equal(await control.isVisible(),true);
 if(kind==='number'){await control.fill(String(value));await control.press('Tab');}
 else if(kind==='checkbox'){if(value)await control.check();else await control.uncheck();}
 else await control.selectOption(value);
}
async function topology(value){
 await showAdvancedEditor(page,'queries');
 await openDetails('details.bond-query-controls');
 await editor.locator('[data-bond-topology]').selectOption(value);
}
async function history(before,after){
 await editor.locator('[data-action="undo"]').first().click();assert.equal(await serialized(),before,'Actual undo button did not restore the previous document');
 await editor.locator('[data-action="redo"]').first().click();assert.equal(await serialized(),after,'Actual redo button did not restore the query edit');
}
async function downloadSource(file,stage,expected){
 await editor.locator('[data-action="export"]').first().click();await editor.locator('.export-format').selectOption('source');
 assert.equal(await editor.locator('[data-action="download-export"]').isDisabled(),false,await editor.locator('.export-message').textContent());
 const pending=page.waitForEvent('download');await editor.locator('[data-action="download-export"]').click();const download=await pending;
 const output=`${downloads}/${path.basename(file,path.extname(file))}-${stage}${path.extname(file)}`;await download.saveAs(output);
 await editor.locator('.export-dialog [data-action="close-dialog"]').click();
 const proof=await page.evaluate(async({base64,expected})=>{
  const sdk=await import('/src/index.ts'),{equivalentDocuments}=await import('/scripts/document-correspondence.mjs'),bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),back=sdk.importDocument({data:bytes}).document;
  if(!equivalentDocuments(sdk,back,JSON.parse(expected)))throw Error('Actual source download changed the full chemical model, query constraints or native topology state');
  const carbon=Object.values(back.graph.atoms).find(atom=>atom.element==='C');if(!carbon||carbon.query)throw Error('A concrete constrained carbon was converted into a wildcard query');
  return {format:back.source.format,completeProjection:true,concreteCarbonRetained:true,atomConstraints:carbon.queryConstraints??null,bondTopologies:Object.values(back.graph.bonds).map(bond=>bond.topology??null)};
 },{base64:(await readFile(output)).toString('base64'),expected});
 return {...proof,actualDownload:true,file:path.basename(output),suggestedFilename:download.suggestedFilename()};
}

try{
 for(const file of ['native-all-fields.cdxml','native-all-fields.cdx']){
  try{
   await page.goto('http://127.0.0.1:5173/');await page.waitForFunction(()=>!!window.moleculeEditor);
   await importFile(`${directory}/${file}`);
   const ids=await page.evaluate(()=>{
    const api=window.moleculeEditor,doc=api.getDocument(),carbon=Object.values(doc.graph.atoms).find(atom=>atom.element==='C'&&atom.queryConstraints),bond=Object.values(doc.graph.bonds)[0];
    if(!carbon||!bond)throw Error('Native fixture lacks its concrete carbon query or topology bond');
    api.setSelection({atomIds:[carbon.id]});api.showPluginPanel();return {atomId:carbon.id,bondId:bond.id,element:carbon.element,initial:carbon.queryConstraints};
   });
   await atomField('substituentsExactly',0,'number');
   await atomField('substituentsUpTo',255,'number');
   await atomField('ringBondCount','AsDrawn');
   await atomField('unsaturatedBonds','MustBeAbsent');
   await atomField('reactionStereo','Retention');
   await atomField('reactionChange',false,'checkbox');
   assert.equal(await page.evaluate(id=>Object.hasOwn(window.moleculeEditor.getDocument().graph.atoms[id].queryConstraints,'reactionChange'),ids.atomId),false,'Unchecking exact-change must remove the predicate, not create false');
   await atomField('reactionChange',true,'checkbox');
   const atomProof=await page.evaluate(id=>{
    const doc=window.moleculeEditor.getDocument(),atom=doc.graph.atoms[id],q=atom.queryConstraints;
    if(atom.element!=='C'||atom.query||q.substituentsExactly!==0||q.substituentsUpTo!==255||q.ringBondCount!=='AsDrawn'||q.unsaturatedBonds!=='MustBeAbsent'||q.reactionStereo!=='Retention'||q.reactionChange!==true)throw Error('Visible atom query controls did not preserve the concrete element and exact native predicate values');
    const marker=document.querySelector('chemical-editor').shadowRoot.querySelector(`[data-query-constraints="${id}"]`);if(!marker||!marker.textContent.includes('Q'))throw Error('The query condition is missing its real canvas marker');return {element:atom.element,constraints:q,visibleQ:true};
   },ids.atomId);
   const beforeInvalid=await serialized();await atomField('substituentsExactly',256,'number');assert.equal(await serialized(),beforeInvalid,'Invalid UI count partially modified the document');

   await page.evaluate(id=>window.moleculeEditor.setSelection({atomIds:[],bondId:id}),ids.bondId);
   await topology('RingOrChain');assert.equal(await page.evaluate(id=>window.moleculeEditor.getDocument().graph.bonds[id].topology,ids.bondId),'RingOrChain');
   await topology('');assert.equal(await page.evaluate(id=>Object.hasOwn(window.moleculeEditor.getDocument().graph.bonds[id],'topology'),ids.bondId),false);
   await topology('Unspecified');assert.equal(await page.evaluate(id=>window.moleculeEditor.getDocument().graph.bonds[id].topology,ids.bondId),'Unspecified');
   const beforeTopology=await serialized();await topology('RingOrChain');const queried=await serialized();await history(beforeTopology,queried);
   assert.equal(await editor.locator(`[data-query-topology="${ids.bondId}"]`).textContent().then(text=>text.includes('环/链')),true);
   const guarded=await page.evaluate(async()=>{
    const sdk=await import('/src/index.ts'),engine=await sdk.loadChemistryEngine();let message='';try{engine.analyze(window.moleculeEditor.getDocument());}catch(error){message=error.message;}if(!message.includes('查询'))throw Error('Query was treated as a fully defined ordinary molecule');return true;
   });
   const queriedDownload=await downloadSource(file,'queried',queried);
   await page.evaluate(id=>{const api=window.moleculeEditor;api.setSelection({atomIds:[id]});api.showPluginPanel();},ids.atomId);
   await showAdvancedEditor(page,'queries');await openDetails('details.advanced-query-controls');if(file.endsWith('.cdxml')){await editor.locator('details.advanced-query-controls > summary').evaluate(node=>node.scrollIntoView({block:'start'}));await page.screenshot({path:'.local/query-constraints-editor.png'});}

   await page.evaluate(id=>window.moleculeEditor.setSelection({atomIds:[],bondId:id}),ids.bondId);await topology('');
   await page.evaluate(id=>window.moleculeEditor.setSelection({atomIds:[id]}),ids.atomId);await openDetails('details.advanced-query-controls');
   const beforeClear=await serialized();await editor.locator('[data-action="clear-query-constraints"]').click();const cleared=await serialized();await history(beforeClear,cleared);
   const clearProof=await page.evaluate(async({atomId,bondId})=>{
    const sdk=await import('/src/index.ts'),doc=window.moleculeEditor.getDocument(),atom=doc.graph.atoms[atomId];
    if(atom.element!=='C'||atom.queryConstraints||doc.graph.bonds[bondId].topology!==undefined)throw Error('Clearing the actual controls did not restore the concrete ordinary model');
    const root=document.querySelector('chemical-editor').shadowRoot;if(root.querySelector('[data-query-constraints]')||root.querySelector('[data-query-topology]'))throw Error('Cleared query markers are still shown');
    if(!sdk.knownChemicalSummary(doc).complete||sdk.hydrogenCount(doc,atomId)===null)throw Error('Cleared predicates still leave the ordinary model classified as a query');
    const analysis=(await sdk.loadChemistryEngine()).analyze(doc);if(analysis.smiles!=='CN')throw Error(`Unexpected cleared chemical identity: ${analysis.smiles}`);return {allQueriesCleared:true,ordinaryCalculationRestored:true,smiles:analysis.smiles};
   },ids);
   const clearedDownload=await downloadSource(file,'cleared',cleared);
   await importFile(`${downloads}/${clearedDownload.file}`);
   await page.evaluate(async expected=>{const sdk=await import('/src/index.ts'),{equivalentDocuments}=await import('/scripts/document-correspondence.mjs');if(!equivalentDocuments(sdk,window.moleculeEditor.getDocument(),JSON.parse(expected)))throw Error('File-input reimport of the actual cleared source download changed the model');},cleared);
   results.push({file,visibleFileInput:true,visibleAtomQueryEdits:true,...atomProof,reactionChangeUnsetAndRestored:true,invalidInputAtomic:true,topologyStates:['RingOrChain','absent','Unspecified','RingOrChain'],topologyUndoRedo:true,queryComputationGuard:guarded,queriedDownload,visibleClearButton:true,clearUndoRedo:true,...clearProof,clearedDownload,clearedDownloadFileReimport:true});
   console.log(`Verified ${file}: real query controls, native topology states, guard, clear, history and two actual source downloads`);
  }catch(error){failures.push({file,error:error.message,stack:error.stack});await page.screenshot({path:`${downloads}/${file}-failure.png`}).catch(()=>{});console.error(`Failed ${file}: ${error.message}`);}
 }
}finally{
 await writeFile(`${directory}/browser-results.json`,JSON.stringify({browser:'Chrome',scope:'Actual file input, visible native query controls and canvas markers, real undo/redo and source downloads/reimports in both CDX and CDXML. Concrete element identity retained; exact-change removal is absence; explicit topology defaults remain distinct. No AI model test.',summary:{scenarios:2,passed:results.length,failed:failures.length,actualDownloads:results.length*2},results,failures,errors,consoleErrors,aiTested:false},null,2)+'\n');
 await browser.close();
}
assert.deepEqual(failures,[]);assert.deepEqual(errors,[]);assert.deepEqual(consoleErrors,[]);
