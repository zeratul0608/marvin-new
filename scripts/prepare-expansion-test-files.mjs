import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {Window} from 'happy-dom';
import initRDKit from '@rdkit/rdkit';
import {abbreviationXml,twoPortXml,chiralAbbreviationXml,recursiveAbbreviationXml} from '../tests/fixtures/abbreviation-fixture.ts';
const window=new Window();for(const key of ['window','document','HTMLElement','customElements','DOMParser','XMLSerializer'])globalThis[key]=key==='window'?window:window[key];
const sdk=await import('../dist-sdk/chemical-editor.js'),engine=sdk.createChemistryEngine(await initRDKit()),out='docs/validation/expansion';await mkdir(out,{recursive:true});
const results=[];
for(const [name,raw]of [['ether',abbreviationXml],['two-port',twoPortXml],['chiral',chiralAbbreviationXml],['recursive',recursiveAbbreviationXml]]){
  await writeFile(`${out}/${name}-original.cdxml`,raw);const doc=sdk.importDocument({data:raw}).document,wrapper=Object.values(doc.graph.atoms).find(a=>a.substructure);
  const expanded=sdk.applyDocumentEdits(doc,[{type:'expand-substructure',atomId:wrapper.id,recursive:true}]).document,analysis=engine.analyze(expanded),source=sdk.exportSourceFile(expanded).data;
  const fresh=structuredClone(expanded);delete fresh.source;
  for(const [format,data]of [['cdxml',source],['cdx',sdk.exportDocument(fresh,{format:'cdx'}).data]]){
    const file=`${name}-expanded.${format}`,back=sdk.importDocument({data,format}).document;assert.equal(engine.analyze(back).smiles,analysis.smiles);
    await writeFile(`${out}/${file}`,format==='cdx'?sdk.decodeCdx(data):data);results.push({file,scenario:name,format,canonicalIsomericSmiles:analysis.smiles,formula:analysis.formula,atomCount:analysis.atomCount,bondCount:analysis.bondCount,stereoAtoms:Object.values(analysis.stereoAtoms),stereoBonds:Object.values(analysis.stereoBonds)});
  }
}
await writeFile(`${out}/adapter-results.json`,JSON.stringify({source:'Own independently constructed nested CDXML examples.',filesPrepared:12,results},null,2)+'\n');console.log('Prepared 12 expansion files; 8 expanded CDX/CDXML outputs chemically verified.');
