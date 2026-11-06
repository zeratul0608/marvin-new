import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { showAdvancedEditor } from './browser-advanced-ui.mjs';
const { chromium } = await import(process.argv[2] || 'playwright');
const output = 'docs/validation/chemdraw26'; await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ acceptDownloads: true });
  const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('http://127.0.0.1:5173/'); await page.waitForFunction(() => !!window.moleculeEditor);
  const scenarios = ['ethanol', 'aspirin', 'caffeine', 'benzene', 'singlet', 'doublet', 'triplet', 'dashed', 'bold', 'hash', 'double-left', 'double-right', 'attachment'];
  const results = [];
  for (const scenario of scenarios) {
    const expected = await page.evaluate(async scenario => {
      const sdk = await import('/src/index.ts');
      let doc;
      if (['singlet', 'doublet', 'triplet'].includes(scenario)) {
        doc = sdk.emptyDocument(scenario); const radical = ['singlet', 'doublet', 'triplet'].indexOf(scenario) + 1;
        sdk.addAtom(doc, 'C', { x: 0, y: 0 }, { radical, hydrogens: { mode: 'fixed', count: radical === 2 ? 3 : 2 } });
      } else if (scenario === 'attachment') {
        doc = sdk.importDocument({ data: '<CDXML><page><fragment><n id="1" p="0 0" NumHydrogens="3"/><n id="2" p="30 0" NodeType="ExternalConnectionPoint" ExternalConnectionType="Diamond"/><b B="1" E="2"/></fragment></page></CDXML>' }).document;
        delete doc.source;
      } else {
        doc = sdk.exampleDocument(['ethanol', 'aspirin', 'caffeine', 'benzene'].includes(scenario) ? scenario : 'ethanol');
        const b = Object.values(doc.graph.bonds)[0];
        if (['dashed', 'bold', 'hash'].includes(scenario)) doc.depiction.bonds[b.id] = { style: scenario, from: b.atoms[0] };
        if (scenario.startsWith('double-')) { b.order = 2; doc.depiction.bonds[b.id] = { style: 'plain', from: b.atoms[0], doublePosition: scenario.slice(7) }; }
      }
      doc.title = scenario; window.moleculeEditor.setDocument(doc);
      const sig = d => ({ formula: sdk.molecularFormula(d), atoms: Object.values(d.graph.atoms).map(({ id, ...a }) => a), orders: Object.values(d.graph.bonds).map(b => b.order), styles: Object.values(d.depiction.bonds).map(({ from, ...rest }) => rest) });
      return sig(doc);
    }, scenario);
    for (const format of ['cdx', 'cdxml']) {
      await page.locator('[data-action="export"]').click();
      await page.locator('.export-format').selectOption(format);
      assert.equal(await page.locator('[data-action="download-export"]').isDisabled(), false);
      if (format === 'cdx') {
        assert.match(await page.locator('.export-source').inputValue(), /CDX 二进制文件/);
        assert.equal(await page.locator('[data-action="copy-export"]').isDisabled(), true);
      }
      const downloadWait = page.waitForEvent('download'); await page.locator('[data-action="download-export"]').click();
      const download = await downloadWait, file = `${scenario}.${format}`;
      assert.equal(download.suggestedFilename(), file); await download.saveAs(`${output}/${file}`);
      await page.locator('.export-dialog [data-action="close-dialog"]').click();
      const result = await page.evaluate(async ({ bytes, format }) => {
        const sdk = await import('/src/index.ts');
        const doc = sdk.importDocument({ data: new Uint8Array(bytes) }).document;
        const sig = d => ({ formula: sdk.molecularFormula(d), atoms: Object.values(d.graph.atoms).map(({ id, ...a }) => a), orders: Object.values(d.graph.bonds).map(b => b.order), styles: Object.values(d.depiction.bonds).map(({ from, ...rest }) => rest) });
        const original = sdk.exportSourceFile(doc);
        // A layout-only source save must still support all new model fields.
        for (const p of Object.values(doc.depiction.positions)) p.x += .25;
        const saved = sdk.exportSourceFile(doc);
        const back = sdk.importDocument({ data: saved.data, format }).document;
        return { signature: sig(doc), savedSignature: sig(back), preserved: saved.preservation, originalUnchanged: original.passthrough };
      }, { bytes: Array.from(await readFile(`${output}/${file}`)), format });
      assert.deepEqual(result.signature, expected); assert.deepEqual(result.savedSignature, expected);
      assert.equal(result.preserved, 'preserved'); assert.equal(result.originalUnchanged, true);
      results.push({ file, scenario, format, formula: expected.formula, atoms: expected.atoms.length, bonds: expected.orders.length, signature: expected, sourceSave: 'preserved' });
    }
  }
  // Exercise the plugin command and actual undo stack, without touching the user's browser draft.
  const layout = await page.evaluate(async () => {
    const sdk = await import('/src/index.ts'), api = window.moleculeEditor, doc = sdk.exampleDocument('ethanol');
    sdk.addAtom(doc, 'O', { x: 0, y: 0 }); api.setDocument(doc);
    const original = api.getDocument(); await api.executeCommand('structure-layout.arrange-row');
    const changed = api.getDocument(), graphUnchanged = JSON.stringify(original.graph) === JSON.stringify(changed.graph);
    const positionsChanged = JSON.stringify(original.depiction.positions) !== JSON.stringify(changed.depiction.positions);
    api.undo(); const undoRestores = JSON.stringify(api.getDocument()) === JSON.stringify(original);
    api.redo(); const redoRestores = JSON.stringify(api.getDocument()) === JSON.stringify(changed);
    return { graphUnchanged, positionsChanged, undoRestores, redoRestores };
  });
  assert.deepEqual(layout, { graphUnchanged: true, positionsChanged: true, undoRestores: true, redoRestores: true });
  // Verify the new inspector fields are available and their edits reach the document.
  await page.evaluate(async () => {
    const sdk = await import('/src/index.ts'), api = window.moleculeEditor, doc = sdk.exampleDocument('ethanol'); api.setDocument(doc);
    api.setSelection({ atomIds: [Object.keys(doc.graph.atoms)[0]] });
  });
  await showAdvancedEditor(page, 'properties');
  const radical = page.locator('[data-property="radical"]'); assert.equal(await radical.isVisible(), true); await radical.selectOption('2');
  const radicalEdited = await page.evaluate(() => Object.values(window.moleculeEditor.getDocument().graph.atoms)[0].radical === 2);
  const bondId = await page.evaluate(() => {
    const api = window.moleculeEditor; api.undo(); const next = api.getDocument(), bond = Object.values(next.graph.bonds)[0];
    bond.order = 2; api.setDocument(next); api.setSelection({ atomIds: [], bondId: bond.id }); api.showPluginPanel(); return bond.id;
  });
  const doublePosition = page.locator('[data-bond-property="doublePosition"]'); assert.equal(await doublePosition.isVisible(), true); await doublePosition.selectOption('left');
  const ui = { radicalEdited, doublePositionEdited: await page.evaluate(id => window.moleculeEditor.getDocument().depiction.bonds[id]?.doublePosition === 'left', bondId) };
  assert.deepEqual(ui, { radicalEdited: true, doublePositionEdited: true });
  assert.deepEqual(pageErrors, []);
  await page.screenshot({ path: `${output}/editor.png`, fullPage: true });
  await writeFile(`${output}/browser-results.json`, JSON.stringify({ downloads: results.length, layout, ui, pageErrors, results }, null, 2));
  console.log(`Validated ${results.length} real downloads, source saves, layout undo/redo and inspector controls.`);
} finally { await browser.close(); }
