import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {Window} from 'happy-dom';
import {equivalentDocuments} from './document-correspondence.mjs';
const window=new Window();for(const key of ['window','document','HTMLElement','customElements','DOMParser','XMLSerializer'])globalThis[key]=key==='window'?window:window[key];
const sdk=await import('../dist-sdk/chemical-editor.js'),directory='docs/validation/expanded-groups';await mkdir(directory,{recursive:true});
const inner='<fragment id="100" ConnectionOrder="103"><n id="101" p="30 0" Element="8" NumHydrogens="0"/><n id="102" p="60 0"/><n id="103" p="0 0" NodeType="ExternalConnectionPoint"/><b id="104" B="101" E="102"/><b id="105" B="101" E="103"/></fragment>';
const frame=(contents,tail='')=>`<CDXML><page id="1"><fragment id="2">${contents}</fragment>${tail}</page></CDXML>`;
const base=frame(`<n id="3" p="0 0"/><n id="20" p="30 0" NodeType="Fragment">${inner}<t><s>OMe</s></t></n><b id="30" B="3" E="20"/>`);
const cases=[
 {scenario:'own-peptide',raw:frame('<n id="3" p="-60 0"/><n id="4" p="120 0" Element="7"/><n id="20" p="30 0" NodeType="Fragment" ResidueID="7" ExternalConnectionType="Peptide" BondOrdering="30 31"><fragment id="100" ConnectionOrder="103 108"><n id="101" p="0 0" Element="7" NumHydrogens="1"/><n id="102" p="30 0"/><n id="104" p="60 0"/><n id="105" p="60 30" Element="8" NumHydrogens="0"/><n id="103" p="-30 0" NodeType="ExternalConnectionPoint"/><n id="108" p="90 0" NodeType="ExternalConnectionPoint"/><b id="110" B="101" E="102"/><b id="111" B="102" E="104"/><b id="112" B="104" E="105" Order="2"/><b id="113" B="103" E="101"/><b id="114" B="104" E="108"/></fragment><t><s>Gly</s></t></n><b id="30" B="3" E="20" Connectivity="Linear"/><b id="31" B="20" E="4" Connectivity="Linear"/>')},
 {scenario:'own-alternatives',raw:frame('<n id="20" NodeType="AnonymousAlternativeGroup" p="0 0"><fragment id="100"><n id="101" Element="8" p="0 0" NumHydrogens="2"/></fragment><fragment id="200"><n id="201" Element="7" p="0 0" NumHydrogens="3"/></fragment><t><s>O or N</s></t></n>')},
 {scenario:'own-referenced',raw:base.replace('</page>','<graphic id="800" GraphicType="Symbol" SymbolType="LonePair" BoundingBox="20 5 22 7"><represent id="801" object="20" attribute="Radical"/></graphic></page>')},
 {scenario:'own-inconsistent',raw:base.replace('<b id="30" B="3" E="20"/>','<b id="30" B="3" E="20" Order="1.5"/>')},
 {scenario:'own-nested',raw:frame(`<n id="500" p="-60 0" Element="7"/><n id="2000" p="0 0" NodeType="Fragment" ResidueID="9" ExternalConnectionType="Peptide"><fragment id="3000" ConnectionOrder="4000">${base.split('<fragment id="2">')[1].split('</fragment></page>')[0]}<n id="4000" p="-30 0" NodeType="ExternalConnectionPoint"/><b id="4010" B="3" E="4000"/></fragment><t><s>Nested</s></t></n><b id="5010" B="500" E="2000"/>`)},
];
const results=[];
for(const item of cases){
 const doc=sdk.importDocument({data:item.raw}).document,id=Object.values(doc.graph.atoms).find(a=>a.substructure).id,expanded=sdk.applyDocumentEdits(doc,[{type:'set-substructure-display',atomId:id,expanded:true,recursive:true}]).document,source=sdk.exportSourceFile(expanded).data;
 assert.ok(equivalentDocuments(sdk,sdk.importDocument({data:source}).document,expanded));
 for(const [stage,data]of [['original',item.raw],['expanded',source]])await writeFile(`${directory}/${item.scenario}-${stage}.cdxml`,data);
 results.push({scenario:item.scenario,original:`${item.scenario}-original.cdxml`,expanded:`${item.scenario}-expanded.cdxml`,branches:expanded.graph.atoms[id].substructure.fragments.length,recursive:true,chemistryAndAnnotationsRetained:true});
}
await writeFile(`${directory}/adapter-results.json`,JSON.stringify({scope:'Own examples only. View expansion retains actual group annotations and all alternative branches; no branch selection or assignment is guessed.',filesPrepared:10,results},null,2)+'\n');console.log('Prepared 10 original/expanded group examples.');
