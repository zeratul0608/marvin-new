import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {Window} from 'happy-dom';
import initRDKit from '@rdkit/rdkit';
const window=new Window();for(const key of ['window','document','HTMLElement','customElements','DOMParser','XMLSerializer'])globalThis[key]=key==='window'?window:window[key];
const sdk=await import('../dist-sdk/chemical-editor.js'),engine=sdk.createChemistryEngine(await initRDKit()),out='docs/validation/collapse';await mkdir(out,{recursive:true});
const cases=[
 {name:'ether',smiles:'CCOC',label:'OMe',choose:doc=>Object.keys(doc.graph.atoms).slice(2)},
 {name:'two-port',smiles:'OCCN',label:'CH2CH2',choose:doc=>Object.values(doc.graph.atoms).filter(a=>a.element==='C').map(a=>a.id)},
 {name:'chiral',smiles:'C[C@](F)(Cl)Br',label:'Chiral',choose:doc=>Object.keys(doc.graph.atoms)},
 {name:'charged-isotope',smiles:'[15NH3+]C',label:'Amino',choose:doc=>Object.values(doc.graph.atoms).filter(a=>a.element==='N').map(a=>a.id)},
 {name:'alkene',smiles:'C/C=C/C',label:'Alkene',choose:doc=>Object.keys(doc.graph.atoms)},
 {name:'phenyl',smiles:'c1ccccc1CCO',label:'Ph',choose:doc=>Object.keys(doc.graph.atoms).slice(0,6)},
];
const results=[];
for(const test of cases){
 const seed=engine.importSmiles(test.smiles,test.name),original=sdk.exportDocument(seed,{format:'cdxml'}).data,doc=sdk.importDocument({data:original}).document,ids=test.choose(doc),result=sdk.applyDocumentEdits(doc,[{type:'collapse-substructure',atomIds:ids,label:test.label,ref:'$group'}]),collapsed=result.document,id=result.created.atoms.$group;
 const source=sdk.exportSourceFile(collapsed).data,back=sdk.importDocument({data:source}).document,parsedWrapper=Object.values(back.graph.atoms).find(a=>a.substructure),expanded=sdk.applyDocumentEdits(back,[{type:'expand-substructure',atomId:parsedWrapper.id,recursive:true}]).document,analysis=engine.analyze(expanded);
 assert.equal(analysis.smiles,engine.analyze(doc).smiles);assert.deepEqual(sdk.knownChemicalSummary(collapsed),sdk.knownChemicalSummary(doc));
 const restored=sdk.applyDocumentEdits(collapsed,[{type:'expand-substructure',atomId:id,recursive:true}]).document;assert.equal(engine.analyze(restored).smiles,analysis.smiles);
 for(const [stage,data]of [['original',original],['collapsed',source],['restored',sdk.exportSourceFile(restored).data]])await writeFile(`${out}/${test.name}-${stage}.cdxml`,data);
 results.push({scenario:test.name,original:`${test.name}-original.cdxml`,collapsed:`${test.name}-collapsed.cdxml`,restored:`${test.name}-restored.cdxml`,canonicalIsomericSmiles:analysis.smiles,formula:analysis.formula,atomCount:analysis.atomCount,bondCount:analysis.bondCount,stereoAtoms:Object.values(analysis.stereoAtoms),selectedIndices:ids.map(id=>Object.keys(doc.graph.atoms).indexOf(id)),label:test.label,summary:sdk.knownChemicalSummary(collapsed)});
}
await writeFile(`${out}/adapter-results.json`,JSON.stringify({scope:'Own SMILES examples; source contraction, reload, expansion and restore with chemical identity and recursive-summary checks.',filesPrepared:18,results},null,2)+'\n');console.log('Prepared 18 original/collapsed/restored CDXML files.');
