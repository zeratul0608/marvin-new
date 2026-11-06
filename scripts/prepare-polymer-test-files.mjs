import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {Window} from 'happy-dom';
import {polymerCdx,polymerXml} from '../tests/fixtures/polymer-fixture.ts';
const window=new Window();for(const key of ['window','document','HTMLElement','customElements','DOMParser','XMLSerializer'])globalThis[key]=key==='window'?window:window[key];
const sdk=await import('../dist-sdk/chemical-editor.js'),out='docs/validation/polymers';await mkdir(out,{recursive:true});
const nested=polymerXml.replace('<bracketedgroup id="12"','<bracketedgroup id="17" BracketUsage="Copolymer" BracketedObjectIDs="12"><bracketedgroup id="12"').replace('</bracketedgroup>','</bracketedgroup></bracketedgroup>');
const results=[];
for(const [name,input]of [['sru',polymerXml],['multiple',polymerCdx()],['nested',nested]]){
  const original=sdk.importDocument({data:input}).document,id=Object.values(original.depiction.objects).find(o=>o.tag==='bracketedgroup').id;
  const edited=sdk.applyDocumentEdits(original,[{type:'update-polymer',objectId:id,changes:{usage:name==='nested'?'Copolymer':'MultipleGroup',repeatCount:5.25,label:'m',repeatPattern:'HeadToHead',flipType:'Flip'}}]).document;
  for(const [stage,doc]of [['original',original],['edited',edited]]){
    const saved=sdk.exportSourceFile(doc),file=`${name}-${stage}.${saved.format}`,back=sdk.importDocument({data:saved.data}).document;
    assert.deepEqual(sdk.documentProjection(back),sdk.documentProjection(doc));
    await writeFile(`${out}/${file}`,saved.format==='cdx'?sdk.decodeCdx(saved.data):saved.data);
    results.push({file,format:saved.format,groups:Object.values(doc.depiction.objects).filter(o=>o.tag==='bracketedgroup').map(o=>{const g=sdk.getPolymerGroup(doc,o.id),atoms=Object.keys(doc.graph.atoms),bonds=Object.keys(doc.graph.bonds);return {usage:g.usage,repeatPattern:g.repeatPattern,flipType:g.flipType,repeatCount:g.repeatCount,label:g.label,atomIndices:g.atomIds.map(id=>atoms.indexOf(id)),crossings:g.crossings.map(c=>({bondIndex:bonds.indexOf(c.bondId),innerAtomIndex:atoms.indexOf(c.innerAtomId)}))};})});
    if(saved.format==='cdx'){
      const xml=sdk.exportDocument(doc,{format:'cdxml'}).data,converted=`${name}-${stage}-converted.cdxml`;await writeFile(`${out}/${converted}`,xml);results.push({...results.at(-1),file:converted,format:'cdxml'});
    }
  }
}
await writeFile(`${out}/adapter-results.json`,JSON.stringify({scope:'Own independently assembled binary and XML fixtures; source edits and mapped CDX-to-CDXML conversion.',results},null,2)+'\n');console.log(`Prepared ${results.length} polymer files with semantic round-trip verification.`);
