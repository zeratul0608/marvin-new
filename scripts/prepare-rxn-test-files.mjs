import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {Window} from 'happy-dom';
const window=new Window();for(const key of ['window','document','HTMLElement','customElements','DOMParser','XMLSerializer'])globalThis[key]=key==='window'?window:window[key];
const sdk=await import('../dist-sdk/chemical-editor.js'),out='docs/validation/rxn';await mkdir(out,{recursive:true});
function mapped(edited=false,centers=false){
 const doc=sdk.emptyDocument('Mapped isotope oxidation'),a=sdk.addAtom(doc,'C',{x:0,y:0},{isotope:edited?14:13,atomMap:1}),b=sdk.addAtom(doc,'O',{x:1.5,y:0},{atomMap:2}),c=sdk.addAtom(doc,'C',{x:5,y:0},{isotope:13,atomMap:1}),d=sdk.addAtom(doc,'O',{x:6.5,y:0},{atomMap:2}),agent=sdk.addAtom(doc,'Na',{x:3,y:2},{charge:1,hydrogens:{mode:'fixed',count:0}}),left=sdk.addBond(doc,a,b),right=sdk.addBond(doc,c,d,2);
 if(centers){doc.graph.bonds[left].reactionParticipation='MakeAndChange';doc.graph.bonds[right].reactionParticipation='ChangeType';}
 doc.graph.reactions={step:{id:'step',schemeId:'scheme',reactants:[{kind:'molecule',atomIds:[a,b]}],products:[{kind:'molecule',atomIds:[c,d]}],above:[{kind:'molecule',atomIds:[agent]}],below:[],arrows:[],pluses:[]}};
 return {doc,reference:`[${edited?14:13}CH3:1][OH:2]>[Na+]>[13CH2:1]=[O:2]`};
}
function chiral(){
 const doc=sdk.emptyDocument('Mapped stereochemical identity'),roles=[];
 for(const offset of [0,6]){
  const center=sdk.addAtom(doc,'C',{x:offset,y:0},{atomMap:1}),atoms=[center,...[['F',1.5,0],['Cl',0,1.5],['Br',0,-1.5],['C',-1.5,0]].map(([e,x,y],i)=>sdk.addAtom(doc,e,{x:offset+x,y},{atomMap:i+2}))];
  for(const atom of atoms.slice(1)){const bond=sdk.addBond(doc,center,atom);if(atom===atoms[4])doc.depiction.bonds[bond]={style:'wedge',from:center};}roles.push({kind:'molecule',atomIds:atoms});
 }
 doc.graph.reactions={step:{id:'step',schemeId:'scheme',reactants:[roles[0]],products:[roles[1]],above:[],below:[],arrows:[],pluses:[]}};
 return {doc,reference:'[C@@:1]([F:2])([Cl:3])([Br:4])[CH3:5]>>[C@@:1]([F:2])([Cl:3])([Br:4])[CH3:5]'};
}
const results=[];
for(const [scenario,fixture]of [['mapped-original',mapped()],['mapped-edited',mapped(true)],['reaction-center',mapped(false,true)],['chiral',chiral()]])for(const format of ['rxn','rxn-v3000']){
 const file=`${scenario}-${format==='rxn'?'v2000':'v3000'}.rxn`,data=sdk.exportDocument(fixture.doc,{format}).data,back=sdk.importDocument({data}).document,step=Object.values(back.graph.reactions)[0];
 assert.deepEqual([step.reactants.length,step.products.length,step.above.length],[1,1,scenario==='chiral'?0:1]);
 assert.deepEqual(Object.values(back.graph.atoms).map(a=>a.atomMap??0),Object.values(fixture.doc.graph.atoms).map(a=>a.atomMap??0));
 await writeFile(`${out}/${file}`,data);results.push({file,format,scenario,referenceSmiles:fixture.reference,roles:[1,1,scenario==='chiral'?0:1],reactionCenter:scenario==='reaction-center'?[12,8]:undefined});
}
for(const version of ['v2000','v3000']){
 const file=`native-${version}.rxn`;let raw;try{raw=await readFile(`${out}/${file}`,'utf8');}catch{continue;}
 const format=version==='v2000'?'rxn':'rxn-v3000',doc=sdk.importDocument({data:raw}).document;doc.title='Native fixture rebuilt';const rebuilt=`native-${version}-rebuilt.rxn`;await writeFile(`${out}/${rebuilt}`,sdk.exportDocument(doc,{format}).data);
 for(const name of [file,rebuilt])results.push({file:name,format,scenario:'native-roundtrip',referenceSmiles:'[13CH3:1][OH:2]>O>[13CH2:1]=[O:2]',roles:[1,1,1]});
}
await writeFile(`${out}/adapter-results.json`,JSON.stringify({scope:'Self-constructed reactions; optional native RDKit fixtures are also generated from our own reaction SMILES.',results},null,2)+'\n');
console.log(`Prepared ${results.length} RXN files with role/map checks.`);
