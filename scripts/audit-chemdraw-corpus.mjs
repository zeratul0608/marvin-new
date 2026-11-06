// Read only locally supplied files. No ChemDraw program, libraries or scripts are executed.
import { Window } from 'happy-dom';
import { readdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
let window = new Window();
for (const key of ['window', 'document', 'HTMLElement', 'customElements', 'DOMParser', 'XMLSerializer']) globalThis[key] = key === 'window' ? window : window[key];
const sdk = await import('../dist-sdk/chemical-editor.js');
const root = process.argv[2] || '.local/chemdraw26-unpacked/files';
const output = process.argv[3] || '.local/chemdraw26-corpus-results.json';
async function walk(dir) { const result = []; for (const e of await readdir(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) result.push(...await walk(p)); else if (/\.(cdx|cdxml)$/i.test(e.name)) result.push(p); } return result; }
const signature = doc => JSON.parse(JSON.stringify(sdk.documentProjection(doc), (_key, value) => typeof value === 'number' ? Math.round(value * 1e6) / 1e6 : value));
function equalSignature(actual,expected) {
  const first=(a,b,path='$')=>{
    if(typeof a!==typeof b||a===null||b===null||typeof a!=='object')return a===b?undefined:path;
    const keys=new Set([...Object.keys(a),...Object.keys(b)]);for(const key of keys){const diff=first(a[key],b[key],`${path}.${key}`);if(diff)return diff;}
  };
  const difference=first(signature(actual),signature(expected));if(difference)throw new Error(`Saved document differs at ${difference}`);
}
const results = [];
async function resetDom(){if(process.memoryUsage().heapUsed<150_000_000)return;await window.happyDOM.close();window=new Window();for(const key of ['window','document','HTMLElement','customElements','DOMParser','XMLSerializer'])globalThis[key]=key==='window'?window:window[key];globalThis.gc?.();}
function chemicalEdit(doc) {
  const atoms = Object.values(doc.graph.atoms), atom = atoms.find(a => a.element === 'C' && !a.query && !a.substructure && !a.attachment) ?? atoms.find(a => !a.query && !a.substructure && !a.attachment);
  if (atom) {
    const masses = { H: 2, C: 13, N: 15, O: 18, S: 34, P: 32, F: 19, Cl: 37, Br: 81, I: 127 };
    return sdk.applyDocumentEdits(doc, [{ type: 'update-atom', atomId: atom.id, changes: { isotope: atom.isotope ? atom.isotope + 1 : masses[atom.element] ?? 100 } }]).document;
  }
  for (const a of atoms) if (a.substructure) for (let i = 0; i < a.substructure.fragments.length; i++) {
    const changed = chemicalEdit(a.substructure.fragments[i].document);
    if (changed) { const group = structuredClone(a.substructure); group.fragments[i].document = changed; return sdk.applyDocumentEdits(doc, [{ type: 'set-substructure', atomId: a.id, substructure: group }]).document; }
  }
  const query = atoms.find(a => a.query?.kind === 'generic');
  if (query) return sdk.applyDocumentEdits(doc, [{ type: 'update-atom', atomId: query.id, changes: { query: { kind: 'generic', label: query.query.label + '_test' } } }]).document;
}
for (const p of await walk(root)) {
  if(process.env.CHEMDRAW_AUDIT_FILE&&!p.endsWith(process.env.CHEMDRAW_AUDIT_FILE))continue;
  if(process.env.CHEMDRAW_AUDIT_PROGRESS)console.log(path.relative(root,p));
  await resetDom();
  const row = { file: path.relative(root, p).replaceAll('\\', '/') };
  const inputBytes = new Uint8Array(await readFile(p));
  if (/ChemScript\/Examples\/Example\.00[12]\/Input\/file04\.cdxml$/.test(row.file) && new TextDecoder().decode(inputBytes).trim() === 'THIS FILE IS NOT A VALID INPUT FILE') {
    results.push({ ...row, excluded: true, reason: 'Intentionally invalid input; excluded from the valid-file target.' }); continue;
  }
  let doc;
  try {
    const r = sdk.importDocument({ data: inputBytes }); doc = r.document;
    Object.assign(row, { ok: true, atoms: Object.keys(doc.graph.atoms).length, bonds: Object.keys(doc.graph.bonds).length, drawings: Object.keys(doc.depiction.objects ?? {}).length, reactions: Object.keys(doc.graph.reactions ?? {}).length, warnings: r.issues.length });
  } catch (e) { Object.assign(row, { ok: false, code: e.issues?.[0]?.code, message: e.message }); }
  if (doc) {
    try {
      assert.equal(sdk.exportSourceFile(doc).data, doc.source.raw); row.originalPreserved = true;
      for (const p of Object.values(doc.depiction.positions)) { p.x += .125; p.y += .125; }
      await resetDom();const source = sdk.exportSourceFile(doc);await resetDom();const back = sdk.importDocument({ data: source.data, format: source.format }).document;
      equalSignature(back,doc); row.translatedSourceSaved = true;
    } catch (e) { row.translatedSourceSaved = false; row.saveMessage = e.message; }
    try {
      await resetDom();const edited = chemicalEdit(doc);
      if (edited) {
        row.chemicalEditApplicable = true;
        const saved = sdk.exportSourceFile(edited);await resetDom();const back = sdk.importDocument({ data: saved.data, format: saved.format }).document;
        equalSignature(back,edited); row.chemicalEditSaved = true;
      } else row.chemicalEditApplicable = false;
    } catch (e) { row.chemicalEditApplicable = true; row.chemicalEditSaved = false; row.chemicalEditMessage = e.message; }
    try {
      await resetDom();const objects = Object.values(doc.depiction.objects ?? {}), object = objects.find(o => o.tag === 't' && o.runs?.some(r => r.text) && (o.geometry.p || o.geometry.BoundingBox)) ?? objects.find(o => !['page','group'].includes(o.tag) && Object.keys(o.geometry).length);
      if (object) {
        row.drawingEditApplicable = true;
        const edited = sdk.applyDocumentEdits(doc, [{type:'move-drawing',objectId:object.id,delta:{x:.125,y:.125}}, ...(object.runs?.length ? [{type:'update-drawing',objectId:object.id,changes:{runs:object.runs.map((run,i)=>({...run,text:run.text+(i===0?' [test]':'')}))}}] : [])]).document;
        const saved = sdk.exportSourceFile(edited);await resetDom();const back = sdk.importDocument({data:saved.data,format:saved.format}).document;
        equalSignature(back,edited); row.drawingEditSaved = true;
      } else row.drawingEditApplicable = false;
    } catch(e) { row.drawingEditApplicable = true; row.drawingEditSaved = false; row.drawingEditMessage = e.message; }
    try {
      const step=Object.values(doc.graph.reactions??{})[0];
      if(step){
        row.reactionEditApplicable=true;await resetDom();
        const edited=sdk.applyDocumentEdits(doc,[{type:'update-reaction',stepId:step.id,changes:{reactants:step.products,products:step.reactants}}]).document;
        const saved=sdk.exportSourceFile(edited);await resetDom();const back=sdk.importDocument({data:saved.data,format:saved.format}).document;
        equalSignature(back,edited);row.reactionEditSaved=true;
      }else row.reactionEditApplicable=false;
    }catch(e){row.reactionEditApplicable=true;row.reactionEditSaved=false;row.reactionEditMessage=e.message;}
    if(!row.chemicalEditApplicable&&!row.drawingEditApplicable){
      row.emptyEditApplicable=true;
      try{await resetDom();const edited=sdk.applyDocumentEdits(doc,[{type:'add-atom',element:'O',position:{x:0,y:0}}]).document;const saved=sdk.exportSourceFile(edited);await resetDom();const back=sdk.importDocument({data:saved.data,format:saved.format}).document;equalSignature(back,edited);row.emptyEditSaved=true;}catch(e){row.emptyEditSaved=false;row.emptyEditMessage=e.message;}
    }
  }
  results.push(row);
  if(results.length%25===0)await writeFile(output+'.partial',JSON.stringify(results,null,2));
}
const groups = {};
for (const r of results) if (!r.ok && !r.excluded) groups[r.message] = (groups[r.message] || 0) + 1;
const summary = { total: results.length, validTotal: results.filter(r => !r.excluded).length, excluded: results.filter(r => r.excluded).length, success: results.filter(r => r.ok).length, originalPreserved: results.filter(r => r.originalPreserved).length, translatedSourceSaved: results.filter(r => r.translatedSourceSaved).length,
  chemicalEditApplicable: results.filter(r => r.chemicalEditApplicable).length, chemicalEditSaved: results.filter(r => r.chemicalEditSaved).length,
  drawingEditApplicable: results.filter(r => r.drawingEditApplicable).length, drawingEditSaved: results.filter(r => r.drawingEditSaved).length,
  reactionEditApplicable: results.filter(r=>r.reactionEditApplicable).length,reactionEditSaved:results.filter(r=>r.reactionEditSaved).length,
  emptyEditApplicable:results.filter(r=>r.emptyEditApplicable).length,emptyEditSaved:results.filter(r=>r.emptyEditSaved).length,
  editVerifiedFiles:results.filter(r=>r.ok&&r.translatedSourceSaved&&['chemical','drawing','reaction','empty'].every(kind=>!r[kind+'EditApplicable']||r[kind+'EditSaved'])).length,
  chemicalEditFailures: Object.entries(results.filter(r => r.chemicalEditMessage).reduce((groups, row) => ({ ...groups, [row.chemicalEditMessage]: (groups[row.chemicalEditMessage] ?? 0) + 1 }), {})).sort((a,b) => b[1]-a[1]),
  failures: Object.entries(groups).sort((a, b) => b[1] - a[1]) };
let comparison;
if (process.argv[4]) {
  const previous = JSON.parse(await readFile(process.argv[4], 'utf8')).results;
  comparison = { previousSuccess: previous.filter(r => r.ok).length, currentSuccess: summary.success,
    newlySuccessful: results.filter(r => r.ok && !previous.find(p => p.file === r.file)?.ok).length,
    regressions: previous.filter(r => r.ok && !results.find(p => p.file === r.file)?.ok).map(r => r.file) };
}
await writeFile(output, JSON.stringify({ summary, ...(comparison ? { comparison } : {}), results }, null, 2));
await unlink(output+'.partial').catch(error=>{if(error.code!=='ENOENT')throw error;});
console.log(JSON.stringify(summary, null, 2));
if (comparison) console.log(JSON.stringify(comparison, null, 2));
if(summary.editVerifiedFiles!==summary.validTotal)process.exitCode=1;
