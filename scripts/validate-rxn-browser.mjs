import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {showAdvancedEditor} from './browser-advanced-ui.mjs';
const {chromium}=await import(process.argv[2]||'playwright');
const directory='docs/validation/rxn',downloads='.local/rxn-downloads';
await mkdir(downloads,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),results=[];
try{
 const page=await browser.newPage({viewport:{width:1600,height:1100},acceptDownloads:true}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto(process.env.RXN_TEST_URL||'http://127.0.0.1:5173/');
 await page.waitForFunction(()=>!!window.moleculeEditor);
 for(const version of ['v2000','v3000']){
  const file=`reaction-center-${version}.rxn`;
  await page.locator('[data-action="import"]').first().click();
  await page.locator('.file-input').setInputFiles(`${directory}/${file}`);
  await page.waitForFunction(name=>document.querySelector('chemical-editor').shadowRoot.querySelector('.import-filename').textContent===name,file);
  await page.locator('[data-action="apply-import"]').click();
  await page.waitForFunction(()=>!document.querySelector('chemical-editor').shadowRoot.querySelector('.import-dialog').open);
  await page.locator('[data-inspector-plugin=""]').click();
  const initial=await page.evaluate(()=>{
   const doc=window.moleculeEditor.getDocument(),steps=Object.values(doc.graph.reactions||{});
   if(steps.length!==1)throw Error('Import did not produce one reaction');
   const step=steps[0],ref=step.reactants[0];
   if(ref?.kind!=='molecule')throw Error('Reactant is not a molecule');
   const atom=ref.atomIds.map(id=>doc.graph.atoms[id]).find(a=>a.atomMap===1);
   if(!atom||atom.isotope!==13)throw Error('Expected mapped carbon-13 reactant');
   return {id:atom.id,before:JSON.stringify(doc)};
  });
  await page.locator('[data-tool="select"]').first().click();
  await page.locator(`[data-atom="${initial.id}"] .atom-hit`).click();
  const isotope=page.locator('[data-property="isotope"]');
  assert.equal(await isotope.isVisible(),true);
  assert.equal(await isotope.inputValue(),'13');
  await showAdvancedEditor(page,'properties');
  assert.equal(await page.locator('[data-property="atomMap"]').isVisible(),true);
  assert.equal(await page.locator('[data-property="atomMap"]').inputValue(),'1');
  await page.evaluate(()=>window.moleculeEditor.showPluginPanel());
  await isotope.fill('14');await isotope.dispatchEvent('change');
  const after=await page.evaluate(id=>{
   const doc=window.moleculeEditor.getDocument();
   if(doc.graph.atoms[id].isotope!==14)throw Error('Visible isotope edit did not apply');
   return JSON.stringify(doc);
  },initial.id);
  await page.locator('[data-action="undo"]').first().click();
  assert.equal(await page.evaluate(()=>JSON.stringify(window.moleculeEditor.getDocument())),initial.before);
  await page.locator('[data-action="redo"]').first().click();
  assert.equal(await page.evaluate(()=>JSON.stringify(window.moleculeEditor.getDocument())),after);
  const formats=[];
  for(const format of ['rxn','rxn-v3000']){
   await page.locator('[data-action="export"]').first().click();
   await page.locator('.export-format').selectOption(format);
   assert.equal(await page.locator('.allow-lossy').isChecked(),false);
   assert.equal(await page.locator('[data-action="download-export"]').isDisabled(),false);
   const pending=page.waitForEvent('download');
   await page.locator('[data-action="download-export"]').click();
   const download=await pending,out=`${downloads}/${version}-to-${format}.rxn`;
   await download.saveAs(out);
   await page.locator('.export-dialog [data-action="close-dialog"]').click();
   const proof=await page.evaluate(async({base64,format})=>{
    const sdk=await import('/src/index.ts'),data=new TextDecoder().decode(Uint8Array.from(atob(base64),c=>c.charCodeAt(0)));
    if(data.split('\n')[0]!== (format==='rxn'?'$RXN':'$RXN V3000'))throw Error('Downloaded header does not match selected format');
    const back=sdk.importDocument({data}).document;
    const signature=doc=>{
     const steps=Object.values(doc.graph.reactions||{});if(steps.length!==1)throw Error('Expected exactly one reaction');
     const step=steps[0];if(step.below.length||step.arrows.length||step.pluses.length)throw Error('RXN import fabricated reaction graphics');
     const roles=[step.reactants,step.products,step.above].map(refs=>refs.map(ref=>{
      if(ref.kind!=='molecule')throw Error('Reaction role changed into a document object');
      const ids=new Set(ref.atomIds),atoms=ref.atomIds.map(id=>doc.graph.atoms[id]);
      return {atoms:atoms.map(a=>({element:a.element,isotope:a.isotope??0,charge:a.charge,map:a.atomMap??0})).sort((a,b)=>a.map-b.map||a.element.localeCompare(b.element)),bonds:Object.values(doc.graph.bonds).filter(b=>b.atoms.every(id=>ids.has(id))).map(b=>({maps:b.atoms.map(id=>doc.graph.atoms[id].atomMap??0).sort((a,b)=>a-b),order:b.order,reactionParticipation:b.reactionParticipation??null}))};
     }));
     const pairs=(step.atomMappings||[]).flatMap(mapping=>{if(mapping.mode!=='specified')throw Error('Mapping mode changed');return mapping.atoms.map(([a,b])=>[doc.graph.atoms[a].atomMap,doc.graph.atoms[b].atomMap]);}).sort((a,b)=>a[0]-b[0]);
     return {roles,pairs};
    };
    const expected=signature(window.moleculeEditor.getDocument()),actual=signature(back);
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('Actual file download changed reaction roles, maps or chemistry');
    if(actual.roles[0][0].atoms.find(a=>a.map===1)?.isotope!==14||actual.roles[1][0].atoms.find(a=>a.map===1)?.isotope!==13)throw Error('Edited reactant and original product isotope were not preserved separately');
    return {roles:actual.roles.map(r=>r.length),maps:actual.roles.map(role=>role.map(mol=>mol.atoms.map(a=>a.map))),pairs:actual.pairs,reactantIsotope:14,productIsotope:13,reactionCenters:actual.roles.slice(0,2).map(role=>role[0].bonds[0].reactionParticipation)};
   },{base64:(await readFile(out)).toString('base64'),format});
   assert.deepEqual(proof.roles,[1,1,1]);assert.deepEqual(proof.pairs,[[1,1],[2,2]]);
   assert.deepEqual(proof.reactionCenters,['MakeAndChange','ChangeType']);
   formats.push({format,suggestedFilename:download.suggestedFilename(),...proof});
  }
  results.push({file,visibleFileInputImport:true,visibleIsotopeEdit:true,undoRedo:true,strictExport:true,downloads:formats});
  console.log(`Verified ${file}: file input, visible isotope edit, undo/redo and both actual RXN downloads.`);
 }
 assert.deepEqual(errors,[]);
 await writeFile(`${directory}/browser-results.json`,JSON.stringify({browser:'Chrome',results,errors,aiTested:false},null,2)+'\n');
}finally{await browser.close();}
