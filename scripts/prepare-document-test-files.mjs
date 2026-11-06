import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {Window} from 'happy-dom';
const window=new Window();for(const key of ['window','document','HTMLElement','customElements','DOMParser','XMLSerializer'])globalThis[key]=key==='window'?window:window[key];
const sdk=await import('../dist-sdk/chemical-editor.js'),out='docs/validation/document-model';await mkdir(out,{recursive:true});
// These are our own synthetic examples, not redistributed commercial samples.
const reaction=(await readFile('tests/document-editing.test.ts','utf8')).match(/const raw=`([^`]+)`;/)[1];
const nested='<CDXML><page id="1"><fragment id="2"><n id="3" p="0 0" NodeType="Fragment" BondOrdering="5 7"><fragment id="10" ConnectionOrder="11 13"><n id="11" p="0 0" NodeType="ExternalConnectionPoint"/><n id="12" p="30 0" Element="8"/><n id="13" p="60 0" NodeType="ExternalConnectionPoint"/><b id="14" B="11" E="12"/><b id="15" B="12" E="13"/></fragment><t p="0 0"><s>O-link</s></t></n><n id="4" p="-30 0"/><n id="6" p="30 0"/><b id="5" B="4" E="3"/><b id="7" B="3" E="6"/></fragment></page></CDXML>';
const multi='<CDXML><page id="1"><fragment id="2"><n id="3" p="0 0"/><n id="4" p="30 0" Element="8"/><b id="5" B="3" E="4"/></fragment><t id="6" p="0 40"><s>Page 1</s></t></page><page id="7"><fragment id="8"><n id="9" p="0 0" Element="7"/></fragment><t id="10" p="0 40"><s>Page 2</s></t></page></CDXML>';
for(const [name,data]of [['reaction-original',reaction],['nested-original',nested],['multipage',multi]]){sdk.importDocument({data});await writeFile(`${out}/${name}.cdxml`,data);}
let doc=sdk.importDocument({data:reaction}).document;
const text=Object.values(doc.depiction.objects).find(o=>o.tag==='t'),arrow=Object.values(doc.depiction.objects).find(o=>o.tag==='arrow');
doc=sdk.applyDocumentEdits(doc,[{type:'update-atom',atomId:Object.keys(doc.graph.atoms)[0],changes:{isotope:13}},{type:'update-drawing',objectId:text.id,changes:{runs:[{...text.runs[0],text:'80 °C'}]}},{type:'move-drawing',objectId:arrow.id,delta:{x:0,y:1}}]).document;
await writeFile(`${out}/reaction-edited.cdxml`,sdk.exportSourceFile(doc).data);
doc=sdk.importDocument({data:nested}).document;const atom=Object.values(doc.graph.atoms).find(a=>a.substructure),group=structuredClone(atom.substructure),inner=group.fragments[0].document,oxygen=Object.values(inner.graph.atoms).find(a=>a.element==='O');
group.fragments[0].document=sdk.applyDocumentEdits(inner,[{type:'update-atom',atomId:oxygen.id,changes:{element:'S'}}]).document;group.label='S-link';doc=sdk.applyDocumentEdits(doc,[{type:'set-substructure',atomId:atom.id,substructure:group}]).document;
await writeFile(`${out}/nested-edited.cdxml`,sdk.exportSourceFile(doc).data);
console.log('Prepared 5 independently constructed document examples.');
