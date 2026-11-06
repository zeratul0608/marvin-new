import assert from 'node:assert/strict';
import {readdir,readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {showAdvancedEditor} from './browser-advanced-ui.mjs';
const {chromium}=await import(process.argv[2]||'playwright');
const root='.local/chemdraw26-unpacked/files',output='docs/validation/chemdraw26';
await mkdir(output,{recursive:true});await mkdir('.local/browser-corpus-downloads',{recursive:true});
async function find(dir,name){for(const entry of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isDirectory()){const hit=await find(p,name);if(hit)return hit;}else if(entry.name===name)return p;}}
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1600,height:1000},acceptDownloads:true}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:5173/');await page.waitForFunction(()=>!!window.moleculeEditor);
  const results=[];
  for(const name of ['Carbon Hybridization.cdxml','Hotkeys Cheat Sheet.cdxml','Shortcuts Cheat Sheet.cdxml','Human Insulin.cdxml','Vasopressin Peptides.cdxml','Stereoisomerism.cdxml','reaction.cdx']){
    const file=await find(root,name);assert.ok(file,name);
    await page.locator('[data-action="import"]').first().click();await page.locator('.file-input').setInputFiles(file);
    await page.waitForFunction(name=>document.querySelector('chemical-editor').shadowRoot.querySelector('.import-filename').textContent===name,name);
    await page.locator('[data-action="apply-import"]').click();await page.waitForFunction(()=>!document.querySelector('chemical-editor').shadowRoot.querySelector('.import-dialog').open);
    const before=await page.evaluate(()=>{const api=window.moleculeEditor,doc=api.getDocument();const atoms=Object.values(doc.graph.atoms),ordinary=a=>!a.substructure&&!a.query&&!a.attachment&&!a.namedFragment&&!a.multiAttachment;const atom=atoms.find(a=>a.element==='C'&&ordinary(a))??atoms.find(ordinary);if(!atom)throw Error('No ordinary atom');api.setSelection({atomIds:[atom.id]});api.showPluginPanel();return {id:atom.id,isotope:atom.isotope,atoms:Object.keys(doc.graph.atoms).length,bonds:Object.keys(doc.graph.bonds).length,drawings:Object.keys(doc.depiction.objects??{}).length,reactions:Object.keys(doc.graph.reactions??{}).length,revision:api.getSnapshot().revision};});
    await page.locator('#atom-isotope').fill(String(before.isotope?before.isotope+1:13));await page.locator('#atom-isotope').dispatchEvent('change');
    await page.evaluate(({id,isotope,revision})=>{const api=window.moleculeEditor;if(api.getDocument().graph.atoms[id].isotope!==(isotope?isotope+1:13))throw Error('Visible isotope edit failed');const after=JSON.stringify(api.getDocument());api.undo();if(api.getDocument().graph.atoms[id].isotope!==isotope)throw Error('Undo failed');api.redo();if(JSON.stringify(api.getDocument())!==after)throw Error('Redo failed');if(api.getSnapshot().revision<=revision)throw Error('No history revision');},before);
    await page.locator('[data-action="export"]').first().click();await page.locator('.export-format').selectOption('source');assert.equal(await page.locator('[data-action="download-export"]').isDisabled(),false);
    const pending=page.waitForEvent('download');await page.locator('[data-action="download-export"]').click();const download=await pending,downloaded=path.join('.local/browser-corpus-downloads',name);await download.saveAs(downloaded);await page.locator('.export-dialog [data-action="close-dialog"]').click();
    const roundtrip=await page.evaluate(async({base64,format})=>{const {importDocument,documentProjection}=await import('/src/index.ts'),doc=window.moleculeEditor.getDocument(),bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),back=importDocument({data:bytes,format}).document;const normalize=v=>JSON.stringify(v,(_k,n)=>typeof n==='number'?Math.round(n*1e6)/1e6:n);if(normalize(documentProjection(back))!==normalize(documentProjection(doc)))throw Error('Downloaded document projection differs');return true;},{base64:(await readFile(downloaded)).toString('base64'),format:name.endsWith('.cdx')?'cdx':'cdxml'});
    results.push({file:name,...before,roundtrip,uiImport:true,uiChemicalEdit:true,undoRedo:true,downloaded:true});
    console.log(`Verified ${name}`);
  }
  const importLocal=async(file)=>{await page.locator('[data-action="import"]').first().click();await page.locator('.file-input').setInputFiles(file);await page.waitForFunction(name=>document.querySelector('chemical-editor').shadowRoot.querySelector('.import-filename').textContent===name,path.basename(file));await page.locator('[data-action="apply-import"]').click();await page.waitForFunction(()=>!document.querySelector('chemical-editor').shadowRoot.querySelector('.import-dialog').open);};
  await importLocal('public/test-files/08-document-editing/nested-original.cdxml');
  await page.evaluate(()=>{const api=window.moleculeEditor;api.setSelection({atomIds:[Object.values(api.getDocument().graph.atoms).find(a=>a.substructure).id]});api.showPluginPanel();});
  await showAdvancedEditor(page,'fragments');
  await page.locator('[data-action="edit-substructure"]').click();
  await page.evaluate(()=>{const child=window.moleculeEditor.shadowRoot.querySelector('[data-nested-editor] chemical-editor'),oxygen=Object.values(child.getDocument().graph.atoms).find(a=>a.element==='O');child.setSelection({atomIds:[oxygen.id]});});
  await page.locator('[data-nested-editor] #atom-element').selectOption('S');await page.locator('[data-nested-save]').click();
  await page.evaluate(async()=>{const api=window.moleculeEditor,group=()=>Object.values(api.getDocument().graph.atoms).find(a=>a.substructure).substructure,has=element=>Object.values(group().fragments[0].document.graph.atoms).some(a=>a.element===element);if(!has('S'))throw Error('Nested UI save failed');api.undo();if(!has('O'))throw Error('Nested undo failed');api.redo();const sdk=await import('/src/index.ts'),back=sdk.importDocument({data:sdk.exportSourceFile(api.getDocument()).data}).document;if(!Object.values(Object.values(back.graph.atoms).find(a=>a.substructure).substructure.fragments[0].document.graph.atoms).some(a=>a.element==='S'))throw Error('Nested source save failed');});
  await importLocal('public/test-files/08-document-editing/multipage.cdxml');
  await page.evaluate(()=>window.moleculeEditor.showPluginPanel());
  const secondPage=await page.evaluate(()=>Object.values(window.moleculeEditor.getDocument().depiction.objects).filter(o=>o.tag==='page')[1].id);await page.locator('[data-document-page]').selectOption(secondPage);
  assert.equal(await page.locator('.drawing [data-atom]').count(),1);assert.equal(await page.evaluate(()=>Object.keys(window.moleculeEditor.getDocument().graph.atoms).length),3);
  await importLocal('public/test-files/08-document-editing/reaction-original.cdxml');
  const arrow=await page.evaluate(()=>{const api=window.moleculeEditor;api.setTool('select');const arrow=Object.values(api.getDocument().depiction.objects).find(o=>o.tag==='arrow');return {id:arrow.id,tail:arrow.geometry.Tail3D};});
  const rect=await page.locator(`[data-drawing="${arrow.id}"]`).boundingBox();assert.ok(rect);await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);await page.mouse.down();await page.mouse.move(rect.x+rect.width/2+30,rect.y+rect.height/2+20,{steps:5});await page.mouse.up();
  await page.evaluate(async before=>{const api=window.moleculeEditor,tail=api.getDocument().depiction.objects[before.id].geometry.Tail3D;if(JSON.stringify(tail)===JSON.stringify(before.tail))throw Error('Real pointer drag did not move arrow');const sdk=await import('/src/index.ts');sdk.importDocument({data:sdk.exportSourceFile(api.getDocument()).data});},arrow);
  assert.deepEqual(errors,[]);
  await page.evaluate(()=>window.moleculeEditor.fit());await page.screenshot({path:'.local/document-render.png'});
  await writeFile(`${output}/document-browser-results.json`,JSON.stringify({browser:'Chrome',aiTested:false,results,nestedEditor:{visibleElementChange:true,save:true,undoRedo:true,sourceRoundtrip:true},pageSelection:{visibleAtoms:1,totalAtoms:3},realPointerArrowDrag:true,errors},null,2));
  console.log(JSON.stringify({success:results.length,errors},null,2));
}finally{await browser.close();}
