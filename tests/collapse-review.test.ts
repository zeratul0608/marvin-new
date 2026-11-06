import {describe,expect,it} from 'vitest';
import {addAtom,addBond,clone,emptyDocument,validateDocument} from '../src/core/model';
import {applyDocumentEdits} from '../src/core/edits';

describe('contraction reference review',()=>{
  it('does not broaden a partial molecular reference to all contents of a contracted label',()=>{
    const doc=emptyDocument(),a=addAtom(doc,'C',{x:0,y:0}),b=addAtom(doc,'O',{x:1.5,y:0}),c=addAtom(doc,'C',{x:3,y:0});addBond(doc,a,b);addBond(doc,b,c);
    // SDK-created references may identify a molecular fragment, and current
    // document validation explicitly accepts such a nonempty member subset.
    doc.depiction.objects={note:{id:'note',tag:'annotation',attributes:{Keyword:'fragment-note',Content:'Only oxygen'},geometry:{},references:{BasisObjects:[{kind:'molecule',atomIds:[b]}]},children:[],atomIds:[]}};
    expect(validateDocument(doc)).toEqual([]);const before=clone(doc);
    expect(()=>applyDocumentEdits(doc,[{type:'collapse-substructure',atomIds:[b,c],label:'OMe'}])).toThrow(/引用|范围|边界/);
    expect(doc).toEqual(before);
  });
  it('can keep a complete molecular reference when all selected members are included',()=>{
    const doc=emptyDocument(),a=addAtom(doc,'C',{x:0,y:0}),b=addAtom(doc,'O',{x:1.5,y:0}),c=addAtom(doc,'C',{x:3,y:0});addBond(doc,a,b);addBond(doc,b,c);
    doc.depiction.objects={note:{id:'note',tag:'annotation',attributes:{Keyword:'fragment-note'},geometry:{},references:{BasisObjects:[{kind:'molecule',atomIds:[b,c]}]},children:[],atomIds:[]}};
    const collapsed=applyDocumentEdits(doc,[{type:'collapse-substructure',atomIds:[b,c],label:'OMe',ref:'$group'}]),wrapperId=collapsed.created.atoms.$group;
    expect(collapsed.document.depiction.objects!.note.references.BasisObjects).toEqual([{kind:'molecule',atomIds:[wrapperId]}]);
    const expanded=applyDocumentEdits(collapsed.document,[{type:'expand-substructure',atomId:wrapperId}]).document;
    expect(expanded.depiction.objects!.note.references.BasisObjects).toEqual([{kind:'molecule',atomIds:[b,c]}]);
  });
});
