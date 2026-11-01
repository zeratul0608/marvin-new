// Run with Vite running. Optional first argument: a Playwright module URL.
const { chromium } = await import(process.argv[2] || 'playwright');
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const out = 'docs/validation/cdx';
await mkdir(out, { recursive: true });
const cases = [
  ['dimethylamine-simple', 'C2H7N', 3, 2], ['dimethylamine-styled', 'C2H7N', 3, 2],
  ['rdkit-ethanol', 'C2H6O', 3, 2], ['rdkit-benzene', 'C6H6', 6, 6],
  ['rdkit-isotopes-charges', 'CH6ClN', 3, 1],
];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto('http://127.0.0.1:5173/');
  await page.waitForFunction(() => !!window.moleculeEditor);
  const results = [];
  for (const [name, formula, atoms, bonds] of cases) {
    const file = `tests/fixtures/cdx/${name}.cdx`, bytes = await readFile(file);
    await copyFile(file, `${out}/${name}.cdx`);
    await page.locator('[data-action="import"]').first().click();
    await page.locator('.file-input').setInputFiles(file);
    await page.waitForFunction(() => document.querySelector('chemical-editor').shadowRoot.querySelector('.import-source').readOnly);
    await page.locator('[data-action="apply-import"]').click();
    await page.waitForFunction(() => !document.querySelector('chemical-editor').shadowRoot.querySelector('.import-dialog').open);
    const result = await page.evaluate(async original => {
      const sdk = await import('/src/index.ts'), api = window.moleculeEditor;
      const doc = api.getDocument();
      const sameBytes = d => JSON.stringify(Array.from(sdk.decodeCdx(d.source.raw))) === JSON.stringify(original);
      const before = JSON.stringify(doc), atomId = Object.keys(doc.graph.atoms)[0];
      api.applyEdits({ operations: [{ type: 'update-atom', atomId, changes: { isotope: 14 } }] });
      const editable = api.getDocument().graph.atoms[atomId].isotope === 14;
      api.undo(); const undo = JSON.stringify(api.getDocument()) === before;
      const native = api.export({ format: 'json' }).data;
      api.import({ data: native });
      const draftPreserved = sameBytes(api.getDocument());
      const cdxml = api.export({ format: 'cdxml', allowLossy: true }).data;
      const mol = api.export({ format: 'mol-v3000', allowLossy: true }).data;
      return { formula: sdk.molecularFormula(doc), atoms: Object.keys(doc.graph.atoms).length,
        bonds: Object.keys(doc.graph.bonds).length, sourceFormat: doc.source.format,
        warnings: doc.source.issues.length, editable, undo, originalPreserved: sameBytes(doc), draftPreserved,
        cdxmlFormula: sdk.molecularFormula(sdk.importDocument({ data: cdxml }).document),
        molFormula: sdk.molecularFormula(sdk.importDocument({ data: mol }).document), cdxml, mol };
    }, Array.from(bytes));
    assert.equal(result.formula, formula); assert.equal(result.atoms, atoms); assert.equal(result.bonds, bonds);
    for (const flag of ['editable', 'undo', 'originalPreserved', 'draftPreserved']) assert.equal(result[flag], true);
    assert.equal(result.cdxmlFormula, formula); assert.equal(result.molFormula, formula);
    await writeFile(`${out}/${name}.cdxml`, result.cdxml); await writeFile(`${out}/${name}.mol`, result.mol);
    delete result.cdxml; delete result.mol;
    results.push({ file: `${name}.cdx`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...result });
  }
  // Real browser drag/drop, followed by malformed binary and unsupported chemistry through the file chooser.
  const ethanol = Array.from(await readFile('tests/fixtures/cdx/rdkit-ethanol.cdx'));
  await page.evaluate(raw => {
    const dataTransfer = new DataTransfer(); dataTransfer.items.add(new File([new Uint8Array(raw)], 'drag-ethanol.cdx'));
    document.querySelector('chemical-editor').shadowRoot.querySelector('.canvas-area').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  }, ethanol);
  await page.waitForFunction(() => window.moleculeEditor.getDocument().source?.name === 'drag-ethanol.cdx');
  const stereo = await readFile('tests/fixtures/cdx/rdkit-ring-stereo1.cdx');
  await copyFile('tests/fixtures/cdx/rdkit-ring-stereo1.cdx', `${out}/rdkit-ring-stereo1.cdx`);
  const version = Buffer.from(ethanol); version[8] = 5;
  const failures = [];
  for (const [name, buffer] of [['unsupported-ring-stereo', stereo], ['truncated', Buffer.from(ethanol).subarray(0, 50)], ['invalid-version', version], ['fake-cdx', Buffer.from('not a CDX file')]]) {
    const before = await page.evaluate(() => JSON.stringify(window.moleculeEditor.getDocument()));
    await page.locator('[data-action="import"]').first().click();
    await page.locator('.file-input').setInputFiles({ name: `${name}.cdx`, mimeType: 'application/octet-stream', buffer });
    await page.locator('[data-action="apply-import"]').click();
    await page.waitForFunction(() => document.querySelector('chemical-editor').shadowRoot.querySelector('.import-message').classList.contains('error'));
    const message = await page.locator('.import-message').innerText();
    assert.equal(await page.evaluate(() => JSON.stringify(window.moleculeEditor.getDocument())), before);
    failures.push({ name, rejected: true, documentUnchanged: true, message });
    await page.locator('[aria-label="关闭导入"]').click();
  }
  assert.deepEqual(pageErrors, []);
  const report = { cases: results, dragDrop: true, failures, pageErrors };
  await writeFile(`${out}/browser-results.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
