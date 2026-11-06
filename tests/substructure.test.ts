import { afterEach, describe, expect, it } from 'vitest';
import { addAtom, addBond, clone, molecularFormula, validateDocument } from '../src/core/model';
import { applyDocumentEdits } from '../src/core/edits';
import { exportDocument, importDocument } from '../src/formats';
import { exportSourceFile } from '../src/formats/preservation';
import { stereoProjection } from '../src/formats/stereo';
import { createChemicalEditor, type ChemicalEditorElement } from '../src/editor/chemical-editor';
import { getAiEditorContext } from '../src/ai/context';

const raw = `<CDXML><page id="1"><fragment id="2"><n id="3" p="0 0"/><n id="20" p="30 0" NodeType="Fragment"><fragment id="100" ConnectionOrder="103"><n id="101" p="30 0" Element="8" NumHydrogens="0"/><n id="102" p="60 0"/><n id="103" p="0 0" NodeType="ExternalConnectionPoint"/><b id="104" B="101" E="102"/><b id="105" B="101" E="103"/></fragment><t><s font="3" size="10">OCH3</s></t></n><b id="30" B="3" E="20"/></fragment></page></CDXML>`;
const signature = (doc: Parameters<typeof stereoProjection>[0]) => JSON.parse(JSON.stringify(stereoProjection(doc)));
afterEach(() => document.body.replaceChildren());
describe('real editable nested chemistry', () => {
  it('parses a collapsed atom as an editable child graph with explicit boundary mapping', () => {
    const { document: doc } = importDocument({ data: raw }), atoms = Object.values(doc.graph.atoms);
    expect(atoms).toHaveLength(2); const group = atoms.find(a => a.substructure)!.substructure!;
    expect(group.fragments[0].attachmentOrder).toHaveLength(1);
    expect(Object.values(group.fragments[0].document.graph.atoms).map(a => a.element)).toEqual(['O', 'C', '*']);
    expect(group.connections[0].atomId).toBe(group.fragments[0].attachmentOrder[0]);
    expect(molecularFormula(doc)).toBe('C2H6O');
    const rebuilt = clone(doc); delete rebuilt.source;
    expect(signature(importDocument({ data: exportDocument(rebuilt, { format: 'cdxml' }).data }).document)).toEqual(signature(doc));
  });
  it('source-saves child chemical edits, wrapper movement and renamed labels independently', () => {
    const doc = importDocument({ data: raw }).document, atom = Object.values(doc.graph.atoms).find(a => a.substructure)!;
    const group = clone(atom.substructure!), inner = group.fragments[0].document, oxygen = Object.values(inner.graph.atoms).find(a => a.element === 'O')!;
    group.fragments[0].document = applyDocumentEdits(inner, [{ type: 'update-atom', atomId: oxygen.id, changes: { element: 'S' } }]).document;
    const changed = applyDocumentEdits(doc, [{ type: 'set-substructure', atomId: atom.id, substructure: group }, { type: 'set-position', atomId: atom.id, position: { x: 3, y: 1 } }]).document;
    expect(molecularFormula(changed)).toBe('C2H6S');
    expect(signature(importDocument({ data: exportSourceFile(changed).data }).document)).toEqual(signature(changed));
    changed.graph.atoms[atom.id].substructure!.label = 'SCH3';
    const json = importDocument({ data: exportDocument(changed, { format: 'json' }).data, format: 'json' }).document;
    expect(signature(importDocument({ data: exportSourceFile(json).data }).document)).toEqual(signature(changed));
  });
  it('rejects unbound or deleted boundary ports and recursive graphs', () => {
    const doc = importDocument({ data: raw }).document, atom = Object.values(doc.graph.atoms).find(a => a.substructure)!;
    const bad = clone(doc); bad.graph.atoms[atom.id].substructure!.connections = [];
    expect(() => validateDocument(bad)).toThrow(/缺少内部连接/);
    const cycle = clone(doc); cycle.graph.atoms[atom.id].substructure!.fragments[0].document = cycle;
    expect(() => validateDocument(cycle)).toThrow(/循环/);
  });
  it('deletes an outer bond and synchronizes the corresponding internal mapping',()=>{
    const doc=importDocument({data:raw}).document,bondId=Object.keys(doc.graph.bonds)[0];
    const changed=applyDocumentEdits(doc,[{type:'remove-bond',bondId}]).document,back=importDocument({data:exportSourceFile(changed).data}).document;
    expect(signature(back)).toEqual(signature(changed));expect(Object.values(back.graph.atoms).find(a=>a.substructure)!.substructure!.connections).toEqual([]);
  });
  it('rebinds an external bond to another real port without swapping the chemical attachment on save',()=>{
    const doc=importDocument({data:raw}).document,atom=Object.values(doc.graph.atoms).find(a=>a.substructure)!,group=clone(atom.substructure!),fragment=group.fragments[0],carbon=Object.values(fragment.document.graph.atoms).find(a=>a.element==='C')!;
    const port=addAtom(fragment.document,'*',{x:4,y:0},{attachment:'external',hydrogens:{mode:'fixed',count:0}});addBond(fragment.document,carbon.id,port);fragment.attachmentOrder.push(port);group.connections[0].atomId=port;
    const changed=applyDocumentEdits(doc,[{type:'set-substructure',atomId:atom.id,substructure:group}]).document,back=importDocument({data:exportSourceFile(changed).data}).document;
    expect(signature(back)).toEqual(signature(changed));
  });
  it('opens a child editor, commits child edits as one parent transaction, and supports parent undo', () => {
    const doc = importDocument({ data: raw }).document, atomId = Object.values(doc.graph.atoms).find(a => a.substructure)!.id;
    const editor = createChemicalEditor({ container: document.body, document: doc }); editor.setSelection({ atomIds: [atomId] });
    editor.showAdvancedEditor('fragments');
    editor.shadowRoot!.querySelector<HTMLButtonElement>('[data-action="edit-substructure"]')!.click();
    const dialog = editor.shadowRoot!.querySelector<HTMLDialogElement>('dialog[aria-label="编辑内部化学片段"]')!;
    const child = dialog.querySelector('chemical-editor') as ChemicalEditorElement;
    const oxygen = Object.values(child.getDocument().graph.atoms).find(a => a.element === 'O')!;
    child.setSelection({ atomIds: [oxygen.id] }); const element = child.shadowRoot!.querySelector<HTMLSelectElement>('#atom-element')!;
    element.value = 'S'; element.dispatchEvent(new Event('change', { bubbles: true }));
    expect(editor.getDocument()).toEqual(doc);
    dialog.querySelector<HTMLButtonElement>('[data-nested-save]')!.click(); expect(molecularFormula(editor.getDocument())).toBe('C2H6S');
    expect(editor.shadowRoot!.contains(dialog)).toBe(false); editor.undo(); expect(editor.getDocument()).toEqual(doc);
    // Source-free context is recursive: inner raw XML must not leak into model context.
    expect(JSON.stringify(getAiEditorContext(editor))).not.toContain('"raw"'); editor.destroy();
  });
});
