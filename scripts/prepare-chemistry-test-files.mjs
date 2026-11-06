import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import initRDKit from '@rdkit/rdkit';
import {Window} from 'happy-dom';
const window=new Window();for(const key of ['window','document','HTMLElement','customElements','DOMParser','XMLSerializer'])globalThis[key]=key==='window'?window:window[key];
const sdk=await import('../dist-sdk/chemical-editor.js'),engine=sdk.createChemistryEngine(await initRDKit()),out='docs/validation/chemistry-engine';
await mkdir(out,{recursive:true});
const cases=[['aspirin','CC(=O)Oc1ccccc1C(=O)O'],['fused-ring','c1ccc2ccccc2c1'],['bridged-ring','C1CC2CCC1C2'],['spiro-ring','C1CCC2(CC1)CCCC2'],['alanine-S','N[C@@H](C)C(=O)O'],['alkene-E','C/C=C/C'],['alkene-Z','C/C=C\\C'],['pyrrole','c1cc[nH]c1'],['isotope','[13CH3][18OH]'],['ammonium','[NH4+]']];
const results=[];
for(const [name,smiles]of cases){
  const doc=engine.importSmiles(smiles,name),analysis=engine.analyze(doc);
  // Intentionally crowd only achiral/unspecified drawings. Specified E/Z and
  // tetrahedral configurations keep their initial geometry as a reference.
  if(!Object.keys(analysis.stereoAtoms).length&&!Object.keys(analysis.stereoBonds).length)Object.values(doc.depiction.positions).forEach((p,i)=>{p.x=i*.15;p.y=0;});
  const clean=engine.cleanup2D(doc).document;
  assert.equal(engine.analyze(clean).smiles,analysis.smiles);
  for(const [stage,document]of [['before',doc],['clean',clean]])for(const format of ['cdx','cdxml']){
    const exported=sdk.exportDocument(document,{format}),file=`${name}-${stage}.${format}`;
    const back=sdk.importDocument({data:exported.data,format}).document;
    assert.equal(engine.analyze(back).smiles,analysis.smiles,file);
    await writeFile(`${out}/${file}`,format==='cdx'?sdk.decodeCdx(exported.data):exported.data);
    results.push({file,scenario:name,stage,format,inputSmiles:smiles,canonicalIsomericSmiles:analysis.smiles,formula:analysis.formula,molecularWeight:analysis.molecularWeight,exactMass:analysis.exactMass,stereoAtoms:Object.values(analysis.stereoAtoms),stereoBonds:Object.values(analysis.stereoBonds)});
  }
}
await writeFile(`${out}/adapter-results.json`,JSON.stringify({rdkitVersion:engine.version,generatedFrom:'Our own SMILES examples; no commercial sample files redistributed.',results},null,2)+'\n');
console.log(`Prepared and round-tripped ${results.length} CDX/CDXML files using RDKit ${engine.version}.`);
