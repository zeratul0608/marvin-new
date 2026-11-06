import {afterEach,describe,expect,it} from 'vitest';
import {addAtom,addBond,emptyDocument,clone,validateDocument} from '../src/core/model';
import {knownChemicalSummary} from '../src/core/chemical-summary';
import {createChemicalEditor} from '../src/editor/chemical-editor';
import {structureReviewPlugin} from '../src/plugins/structure-review';
import {importDocument} from '../src/formats';
import {abbreviationXml} from './fixtures/abbreviation-fixture';
import type {ChemicalDocument} from '../src/core/types';

function enclose(child:ChemicalDocument,label='fragment'):ChemicalDocument{
  const doc=emptyDocument();addAtom(doc,'*',{x:0,y:0},{substructure:{kind:'abbreviation',label,fragments:[{document:child,attachmentOrder:[]}],connections:[]}});return doc;
}
afterEach(()=>{document.body.replaceChildren();localStorage.clear();});
describe('defined chemistry summaries',()=>{
  it('counts explicit charges and isotopes recursively through nested abbreviations',()=>{
    const child=emptyDocument();addAtom(child,'N',{x:0,y:0},{charge:1,isotope:15});const doc=enclose(enclose(child));
    expect(validateDocument(doc)).toEqual([]);expect(knownChemicalSummary(doc)).toEqual({knownChemicalAtomCount:1,formalCharge:1,isotopeAtomCount:1,complete:true,incompleteReasons:[]});
  });
  it('counts repeated uses of one child document independently',()=>{
    const child=emptyDocument();addAtom(child,'O',{x:0,y:0},{charge:-1,isotope:18});const doc=enclose(child);addAtom(doc,'*',{x:3,y:0},{substructure:{kind:'abbreviation',label:'second',fragments:[{document:child,attachmentOrder:[]}],connections:[]}});
    expect(knownChemicalSummary(doc)).toMatchObject({knownChemicalAtomCount:2,formalCharge:-2,isotopeAtomCount:2,complete:true});
  });
  it('does not count a bound virtual port as an atom or as incomplete chemistry',()=>{
    const doc=importDocument({data:abbreviationXml}).document;
    expect(Object.keys(doc.graph.atoms)).toHaveLength(2);expect(knownChemicalSummary(doc)).toMatchObject({knownChemicalAtomCount:3,formalCharge:0,isotopeAtomCount:0,complete:true});
  });
  it('marks unbound ports incomplete while still counting defined ordinary atoms',()=>{
    const doc=emptyDocument(),carbon=addAtom(doc,'C',{x:0,y:0},{isotope:13}),port=addAtom(doc,'*',{x:1.5,y:0},{attachment:'external',hydrogens:{mode:'fixed',count:0}});addBond(doc,carbon,port);
    expect(knownChemicalSummary(doc)).toEqual({knownChemicalAtomCount:1,formalCharge:0,isotopeAtomCount:1,complete:false,incompleteReasons:['未绑定的模板连接点']});
  });
  it('does not add alternative candidates together or report their cancellation as total charge',()=>{
    const positive=emptyDocument(),negative=emptyDocument();addAtom(positive,'N',{x:0,y:0},{charge:1,isotope:15});addAtom(negative,'O',{x:0,y:0},{charge:-1,isotope:18});
    const doc=emptyDocument();addAtom(doc,'O',{x:3,y:0},{charge:-1,isotope:18});addAtom(doc,'*',{x:0,y:0},{substructure:{kind:'alternatives',label:'A or B',fragments:[{document:positive,attachmentOrder:[]},{document:negative,attachmentOrder:[]}],connections:[]}});
    expect(knownChemicalSummary(doc)).toEqual({knownChemicalAtomCount:1,formalCharge:-1,isotopeAtomCount:1,complete:false,incompleteReasons:['未选定的备选结构']});
  });
  it('does not double-count a wrapper aggregate charge or isotope annotation',()=>{
    const child=emptyDocument();addAtom(child,'N',{x:0,y:0},{charge:1,isotope:15});const doc=enclose(child),wrapper=Object.values(doc.graph.atoms)[0];wrapper.charge=1;wrapper.isotope=13;
    expect(knownChemicalSummary(doc)).toMatchObject({knownChemicalAtomCount:1,formalCharge:1,isotopeAtomCount:1,complete:false,incompleteReasons:['缩写整体注释与内部图的对应未确定']});
  });
  it('marks query, unresolved labels and repeat groups as partial without inventing atoms',()=>{
    const doc=emptyDocument(),carbon=addAtom(doc,'C',{x:0,y:0},{isotope:13});addAtom(doc,'*',{x:3,y:0},{query:{kind:'any'}});addAtom(doc,'*',{x:4,y:0},{namedFragment:{type:'Nickname',label:'unknown'}});
    doc.depiction.objects={repeat:{id:'repeat',tag:'bracketedgroup',attributes:{BracketUsage:'SRU'},geometry:{},references:{BracketedObjectIDs:[{kind:'atom',id:carbon}]},children:[],atomIds:[]}};
    const summary=knownChemicalSummary(doc);expect(summary).toMatchObject({knownChemicalAtomCount:1,formalCharge:0,isotopeAtomCount:1,complete:false});expect(summary.incompleteReasons).toEqual(expect.arrayContaining(['查询结构','未定义内部图的名称','聚合物、重复或混合物组']));
  });
  it('keeps the old canvas counts and exposes recursive totals through the real review plugin',async()=>{
    const child=emptyDocument();addAtom(child,'N',{x:0,y:0},{charge:1,isotope:15});const doc=enclose(child),before=clone(doc),editor=createChemicalEditor({container:document.body,document:doc,plugins:[structureReviewPlugin]});
    try{
      const summary=await editor.executeCommand('structure-review.review');expect(summary).toMatchObject({atomCount:1,bondCount:0,formalCharge:1,isotopeAtomCount:1,knownChemicalAtomCount:1,chemicalSummaryComplete:true});
      const panel=editor.shadowRoot!.querySelector('[data-plugin-panel="structure-review.summary"]')!.textContent!;expect(panel).toContain('画布节点 / 键');expect(panel).toContain('总形式电荷');expect(panel).toContain('+1');expect(editor.getDocument()).toEqual(before);
    }finally{editor.destroy();}
  });
  it('labels incomplete quantities as partial in the visible review panel',async()=>{
    const doc=emptyDocument();addAtom(doc,'*',{x:0,y:0},{query:{kind:'any'}});const editor=createChemicalEditor({container:document.body,document:doc,plugins:[structureReviewPlugin]});
    try{
      const summary=await editor.executeCommand('structure-review.review');expect(summary).toMatchObject({chemicalSummaryComplete:false});const panel=editor.shadowRoot!.querySelector('[data-plugin-panel="structure-review.summary"]')!.textContent!;
      expect(panel).toContain('形式电荷（已定义图）');expect(panel).not.toContain('总形式电荷');expect(panel).toContain('仅统计已定义部分');
    }finally{editor.destroy();}
  });
});
