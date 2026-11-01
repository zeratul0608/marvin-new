// Optional validation tool; pass a Playwright module URL or install it separately.
const { chromium } = await import(process.argv[2] || 'playwright');
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const out='docs/validation/cdxml'; await mkdir(out,{recursive:true});
const cases=[
  ['cdx-simple','tests/fixtures/cdx/dimethylamine-simple.cdx',false],
  ['cdx-styled','tests/fixtures/cdx/dimethylamine-styled.cdx',false],
  ['cdxml-simple-edited','tests/fixtures/cdxml/dimethylamine-simple.cdxml',true],
  ['cdxml-styled-edited','tests/fixtures/cdxml/dimethylamine-styled.cdxml',true],
  ['ethanol-mrv','public/examples/ethanol.mrv',false],
  ['aspirin',null,false], ['isotopes-charges-hydrogens','properties',false], ['wedge','wedge',false],
];
const browser=await chromium.launch({channel:'chrome',headless:true});
const report=[];
try {
 const page=await browser.newPage({acceptDownloads:true}); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:5173/');
 await page.waitForFunction(()=>!!window.moleculeEditor);
 for(const [name,file,edit] of cases){
  const data=file&&file.includes('/')?Array.from(await readFile(file)):null;
  const before=await page.evaluate(async ({file,data,edit})=>{
    const sdk=await import('/src/index.ts'); const api=window.moleculeEditor;
    if(data) api.import({data:new Uint8Array(data),name:file.split('/').at(-1)});
    else if(file==='properties'){
      const d=sdk.emptyDocument('同位素与电荷');
      const c=sdk.addAtom(d,'C',{x:0,y:0},{isotope:13,hydrogens:{mode:'fixed',count:3}});
      const n=sdk.addAtom(d,'N',{x:1.5,y:0},{isotope:15,charge:1,hydrogens:{mode:'fixed',count:3}});
      sdk.addAtom(d,'Cl',{x:4,y:0},{charge:-1,hydrogens:{mode:'fixed',count:0}});sdk.addBond(d,c,n);
      api.import({data:JSON.stringify(d),format:'json'});
    }else if(file==='wedge'){
      const d=sdk.emptyDocument('楔线端点'); const c=sdk.addAtom(d,'C',{x:0,y:0});
      for(const [i,e]of ['F','Cl','Br','I'].entries()) {const a=sdk.addAtom(d,e,{x:Math.cos(i*Math.PI/2)*1.5,y:Math.sin(i*Math.PI/2)*1.5});const b=sdk.addBond(d,c,a);if(i===0)d.depiction.bonds[b]={style:'wedge',from:c};}
      api.import({data:JSON.stringify(d),format:'json'});
    }else api.import({data:JSON.stringify(sdk.exampleDocument('aspirin')),format:'json'});
    if(edit){const n=Object.values(api.getDocument().graph.atoms).find(a=>a.element==='N');api.applyEdits({operations:[{type:'update-atom',atomId:n.id,changes:{isotope:15}}]});}
    const d=api.getDocument(); return {formula:sdk.molecularFormula(d),atoms:Object.keys(d.graph.atoms).length,bonds:Object.keys(d.graph.bonds).length,sourceWarnings:d.source?.issues.filter(i=>i.severity!=='info').length??0};
  },{file,data,edit});
  await page.locator('[data-action="export"]').click();
  await page.locator('.export-format').selectOption('cdxml');
  const blocked=await page.locator('[data-action="download-export"]').isDisabled();
  assert.equal(blocked,before.sourceWarnings>0);
  if(blocked)await page.locator('.allow-lossy').check();
  const downloadPromise=page.waitForEvent('download'); await page.locator('[data-action="download-export"]').click();
  const download=await downloadPromise; assert.match(download.suggestedFilename(),/\.cdxml$/);
  const target=`${out}/${name}.cdxml`;await download.saveAs(target);
  const output=await readFile(target,'utf8');
  const after=await page.evaluate(async text=>{const s=await import('/src/index.ts');const d=s.importDocument({data:text}).document;return{formula:s.molecularFormula(d),atoms:Object.keys(d.graph.atoms).length,bonds:Object.keys(d.graph.bonds).length};},output);
  assert.equal(after.formula,before.formula);assert.equal(after.atoms,before.atoms);assert.equal(after.bonds,before.bonds);
  report.push({name,file:target,...before,lossConfirmed:blocked,reimport:after});
  await page.locator('.export-dialog [data-action="close-dialog"]').click();
 }
 assert.deepEqual(errors,[]); await writeFile(`${out}/browser-results.json`,JSON.stringify({cases:report,pageErrors:errors},null,2)+'\n');
 console.log(JSON.stringify(report));
}finally{await browser.close();}
