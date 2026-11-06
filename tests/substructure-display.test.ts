import {describe,expect,it} from 'vitest';
import {applyDocumentEdits,type EditOperation} from '../src/core/edits';
import {clone,validateDocument} from '../src/core/model';
import {substructureDisplayReplacer} from '../src/core/substructure-display';
import {DocumentStore} from '../src/core/store';
import {importDocument,exportDocument,exportSourceFile} from '../src/formats';
import {stereoProjection} from '../src/formats/stereo';
import {expandedViewTagName,expandedViewXml} from '../src/formats/xml-substructure-display';
import {abbreviationXml,recursiveAbbreviationXml} from './fixtures/abbreviation-fixture';
import type {ChemicalDocument} from '../src/core/types';

const load=(raw=abbreviationXml)=>importDocument({data:raw}).document;
const wrapper=(doc:ChemicalDocument)=>Object.values(doc.graph.atoms).find(a=>a.substructure)!;
const show=(doc:ChemicalDocument,expanded=true,recursive=false)=>applyDocumentEdits(doc,[{type:'set-substructure-display',atomId:wrapper(doc).id,expanded,recursive}]).document;
const groups=(doc:ChemicalDocument)=>{const result:NonNullable<ReturnType<typeof wrapper>['substructure']>[]=[];const visit=(d:ChemicalDocument)=>{for(const atom of Object.values(d.graph.atoms))if(atom.substructure){result.push(atom.substructure);for(const fragment of atom.substructure.fragments)visit(fragment.document);}};visit(doc);return result;};
const projection=(doc:ChemicalDocument)=>JSON.parse(JSON.stringify(stereoProjection(doc)));
const chemistry=(doc:ChemicalDocument)=>JSON.stringify({graph:doc.graph,depiction:doc.depiction},substructureDisplayReplacer);
const xml=(raw:string)=>new DOMParser().parseFromString(raw,'application/xml');
const withoutMarkers=(raw:string)=>{const parsed=xml(raw);for(const el of parsed.querySelectorAll(`objecttag[Name="${expandedViewTagName}"]`))el.remove();return new XMLSerializer().serializeToString(parsed.documentElement);};

describe('expanded substructure presentation with retained chemical hierarchy',()=>{
  it('keeps annotations, real chemistry, IDs and references while changing presentation',()=>{
    const doc=load(),atom=wrapper(doc);Object.assign(atom,{charge:-1,isotope:13,atomMap:7,radical:2,residueId:12,connectionType:'Peptide',cipLabel:'R',spatial:[1,2,3],enhancedStereo:{type:'And',group:2}});const before=clone(doc),opened=show(doc);
    expect(doc).toEqual(before);expect(wrapper(opened).substructure!.display).toBe('expanded');expect(chemistry(opened)).toBe(chemistry(doc));expect(Object.keys(opened.graph.atoms)).toEqual(Object.keys(doc.graph.atoms));expect(wrapper(opened).cipLabel).toBe('R');expect(validateDocument(opened)).toEqual([]);
    expect(()=>applyDocumentEdits(opened,[{type:'expand-substructure',atomId:atom.id}])).toThrow('整体电荷');
    expect(show(opened,false)).toEqual(doc);
  });
  it('recursively toggles all real branches without selecting or deleting alternatives',()=>{
    const doc=load(recursiveAbbreviationXml),nested=wrapper(doc).substructure!.fragments[0].document,alias=wrapper(nested),group=alias.substructure!;group.kind='alternatives';group.fragments.push(clone(group.fragments[0]));group.connections=[];
    // Alternatives with no external bond remain unresolved and retain both graphs.
    for(const bond of Object.values(nested.graph.bonds))if(bond.atoms.includes(alias.id))delete nested.graph.bonds[bond.id];
    for(const id of Object.keys(nested.depiction.bonds))if(!nested.graph.bonds[id])delete nested.depiction.bonds[id];
    const before=clone(doc),one=show(doc);expect(groups(one).map(g=>g.display)).toEqual(['expanded',undefined]);
    const all=show(doc,true,true);expect(groups(all).every(g=>g.display==='expanded')).toBe(true);expect(groups(all)[1].fragments).toHaveLength(2);expect(chemistry(all)).toBe(chemistry(before));expect(show(all,false,true)).toEqual(before);
  });
  it('is one history step and survives schema-v1 JSON restoration',()=>{
    const doc=load(recursiveAbbreviationXml),opened=show(doc,true,true),store=new DocumentStore(doc);store.replace(opened);store.undo();expect(store.document).toEqual(doc);store.redo();expect(store.document).toEqual(opened);
    const restored=importDocument({data:exportDocument(opened,{format:'json'}).data}).document;expect(restored.schemaVersion).toBe(1);expect(JSON.stringify(restored)).toBe(JSON.stringify(opened));expect(groups(load()).every(g=>g.display===undefined)).toBe(true);
  });
  it('does not invalidate existing CIP caches for recursive display plus title changes',()=>{
    const doc=load(recursiveAbbreviationXml);Object.values(doc.graph.atoms)[0].cipLabel='R';wrapper(doc).cipLabel='S';const child=wrapper(doc).substructure!.fragments[0].document;Object.values(child.graph.atoms)[0].cipLabel='R';
    const opened=applyDocumentEdits(doc,[{type:'set-substructure-display',atomId:wrapper(doc).id,expanded:true,recursive:true},{type:'rename',title:'View'}]).document;
    expect(Object.values(opened.graph.atoms)[0].cipLabel).toBe('R');expect(wrapper(opened).cipLabel).toBe('S');expect(Object.values(wrapper(opened).substructure!.fragments[0].document.graph.atoms)[0].cipLabel).toBe('R');
    const changed=applyDocumentEdits(opened,[{type:'update-atom',atomId:Object.keys(opened.graph.atoms)[0],changes:{element:'O'}}]).document;expect(Object.values(changed.graph.atoms)[0].cipLabel).toBeUndefined();
  });
  it('strictly rejects malformed display operations and model states atomically',()=>{
    const doc=load(),id=wrapper(doc).id,before=clone(doc),operations=[{type:'set-substructure-display',atomId:id,expanded:1},{type:'set-substructure-display',atomId:id,expanded:true,recursive:1},{type:'set-substructure-display',atomId:id,expanded:true,unknown:true},{type:'set-substructure-display',atomId:Object.keys(doc.graph.atoms)[0],expanded:true},{type:'set-substructure-display',atomId:'missing',expanded:true}];
    for(const operation of operations)expect(()=>applyDocumentEdits(doc,[operation as EditOperation])).toThrow();expect(doc).toEqual(before);
    for(const value of ['collapsed',false,null]){const bad=clone(doc);Object.assign(wrapper(bad).substructure!,{display:value});expect(()=>validateDocument(bad)).toThrow('显示状态无效');}
  });
  it('source-saves only a standard hidden String objecttag without rewriting chemistry or native styling',()=>{
    const raw=abbreviationXml.replace('id="3" p=','id="3" AS="R" p=').replace('id="20"','id="20" ResidueID="9" ExternalConnectionType="Peptide" AS="R"').replace('</page>','<graphic id="1000" GraphicType="Symbol" SymbolType="LonePair"><represent attribute="Radical" object="20"/></graphic><bioshape id="1001" BioShapeType="DNA" PrivateObjectID="20" xyz="0 50 0"/></page>'),doc=show(load(raw)),saved=exportSourceFile(doc),back=load(saved.data);
    expect(projection(back)).toEqual(projection(doc));expect(withoutMarkers(saved.data)).toBe(withoutMarkers(raw));const marker=xml(saved.data).querySelector(`n[id="20"] > objecttag[Name="${expandedViewTagName}"]`)!;expect(marker.getAttribute('TagType')).toBe('String');expect(marker.getAttribute('Value')).toBe('1');expect(marker.getAttribute('Visible')).toBe('no');
    expect(xml(saved.data).querySelector('n[id="20"]')!.getAttribute('AS')).toBe('R');expect(Object.values(back.graph.atoms).find(a=>!a.substructure)!.cipLabel).toBe('R');expect(wrapper(back).residueId).toBe(9);expect(wrapper(back).connectionType).toBe('Peptide');expect(xml(saved.data).querySelector('represent')!.getAttribute('object')).toBe('20');
    const restored=importDocument({data:exportDocument(doc,{format:'json'}).data}).document;expect(exportSourceFile(restored).data).toBe(saved.data);
  });
  it('persists recursive flags in source CDXML and removes them without rewriting native fragments',()=>{
    const original=load(recursiveAbbreviationXml),opened=show(original,true,true),saved=exportSourceFile(opened),back=load(saved.data);expect(projection(back)).toEqual(projection(opened));expect(xml(saved.data).querySelectorAll(`objecttag[Name="${expandedViewTagName}"]`)).toHaveLength(2);expect(withoutMarkers(saved.data)).toBe(withoutMarkers(recursiveAbbreviationXml));
    const closed=show(back,false,true),closedSaved=exportSourceFile(closed);expect(xml(closedSaved.data).querySelectorAll(`objecttag[Name="${expandedViewTagName}"]`)).toHaveLength(0);expect(projection(load(closedSaved.data))).toEqual(projection(original));
  });
  it('preserves native drawing decimal spellings for view-only saves but writes real geometry edits',()=>{
    const raw=abbreviationXml.replace('</page>','<graphic id="1000" GraphicType="Rectangle" RectangleType="Plain" BoundingBox="10.00 20.00 30.00 40.00"/><t id="1001" p="12.00 34.00"><s font="3" size="10">Caption</s></t></page>'),opened=show(load(raw)),saved=exportSourceFile(opened);expect(withoutMarkers(saved.data)).toBe(withoutMarkers(raw));
    expect(xml(saved.data).querySelector('graphic')!.getAttribute('BoundingBox')).toBe('10.00 20.00 30.00 40.00');expect(xml(saved.data).querySelector('t[id="1001"]')!.getAttribute('p')).toBe('12.00 34.00');
    const rectangle=Object.values(opened.depiction.objects!).find(o=>o.tag==='graphic')!,edited=applyDocumentEdits(opened,[{type:'update-drawing',objectId:rectangle.id,changes:{geometry:{BoundingBox:[11,22,33,44]}}}]).document,changed=exportSourceFile(edited);expect(xml(changed.data).querySelector('graphic')!.getAttribute('BoundingBox')).toBe('11 22 33 44');expect(projection(load(changed.data))).toEqual(projection(edited));
    delete edited.source;const rebuilt=exportDocument(edited,{format:'cdxml'});expect(xml(rebuilt.data).querySelector('graphic')!.getAttribute('BoundingBox')).toBe('11 22 33 44');
  });
  it('round-trips expanded view through freshly rebuilt CDXML with strict projection checks',()=>{
    const opened=show(load(recursiveAbbreviationXml),true,true);delete opened.source;const saved=exportDocument(opened,{format:'cdxml'}),back=load(saved.data);expect(projection(back)).toEqual(projection(opened));expect(groups(back).every(g=>g.display==='expanded')).toBe(true);
  });
  it('retains all unresolved alternative fragments through source and fresh CDXML view round-trips',()=>{
    const original=load(),detached=applyDocumentEdits(original,[{type:'remove-bond',bondId:Object.keys(original.graph.bonds)[0]}]).document,group=clone(wrapper(detached).substructure!);group.kind='alternatives';group.label='A or B';group.fragments.push(clone(group.fragments[0]));
    const alternatives=applyDocumentEdits(detached,[{type:'set-substructure',atomId:wrapper(detached).id,substructure:group}]).document;delete alternatives.source;
    const source=load(exportDocument(alternatives,{format:'cdxml'}).data),opened=show(source,true,true),saved=exportSourceFile(opened),back=load(saved.data);expect(projection(back)).toEqual(projection(opened));expect(wrapper(back).substructure!.fragments).toHaveLength(2);expect(wrapper(back).substructure!.kind).toBe('alternatives');
    expect(withoutMarkers(saved.data)).toBe(withoutMarkers(source.source!.raw));expect(()=>applyDocumentEdits(opened,[{type:'expand-substructure',atomId:wrapper(opened).id}])).toThrow('备选组');
    delete opened.source;expect(projection(load(exportDocument(opened,{format:'cdxml'}).data))).toEqual(projection(back));
  });
  it('keeps view flags when the internal graph is subsequently chemically edited and source-saved',()=>{
    const opened=show(load()),group=clone(wrapper(opened).substructure!),child=group.fragments[0].document,oxygen=Object.values(child.graph.atoms).find(a=>a.element==='O')!;group.fragments[0].document=applyDocumentEdits(child,[{type:'update-atom',atomId:oxygen.id,changes:{element:'S'}}]).document;
    const edited=applyDocumentEdits(opened,[{type:'set-substructure',atomId:wrapper(opened).id,substructure:group}]).document,saved=exportSourceFile(edited),back=load(saved.data);expect(projection(back)).toEqual(projection(edited));expect(wrapper(back).substructure!.display).toBe('expanded');expect(xml(saved.data).querySelector('n[Z="2"]')!.getAttribute('Element')).toBe('16');
  });
  it('rejects duplicate, malformed and misplaced reserved view markers',()=>{
    const insert=(tag:string)=>abbreviationXml.replace('<fragment id="100"',`${tag}<fragment id="100"`);
    for(const tag of [expandedViewXml+expandedViewXml,expandedViewXml.replace('Value="1"','Value="0"'),expandedViewXml.replace('TagType="String"','TagType="Long"'),expandedViewXml.replace('/>','><t><s>hidden chemistry</s></t></objecttag>')])expect(()=>load(insert(tag))).toThrow('视图标记');
    expect(()=>load(abbreviationXml.replace('<n id="3" p="0 0"/>',`<n id="3" p="0 0">${expandedViewXml}</n>`))).toThrow('视图标记');
  });
});
