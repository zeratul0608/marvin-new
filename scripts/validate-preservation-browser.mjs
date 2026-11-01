const { chromium } = await import(process.argv[2] || 'playwright');
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const out = 'docs/validation/preservation'; await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ acceptDownloads: true });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:5173/'); await page.waitForFunction(() => !!window.moleculeEditor);
  const openExport = async format => { await page.locator('[data-action="export"]').click(); await page.locator('.export-format').selectOption(format); };
  const closeExport = () => page.locator('.export-dialog [data-action="close-dialog"]').click();
  const download = async name => {
    assert.equal(await page.locator('[data-action="download-export"]').isDisabled(), false);
    const promise = page.waitForEvent('download'); await page.locator('[data-action="download-export"]').click();
    const file = await promise; await file.saveAs(`${out}/${name}`); return file.suggestedFilename();
  };
  const importFile = async path => {
    await page.locator('[data-action="import"]').first().click(); await page.locator('.file-input').setInputFiles(path);
    await page.locator('[data-action="apply-import"]').click();
    await page.waitForFunction(() => !document.querySelector('chemical-editor').shadowRoot.querySelector('.import-dialog').open);
  };

  await importFile('tests/fixtures/cdx/dimethylamine-styled.cdx');
  await page.evaluate(() => {
    const api = window.moleculeEditor, doc = api.getDocument(), n = Object.values(doc.graph.atoms).find(a => a.element === 'N');
    const position = doc.depiction.positions[n.id]; api.applyEdits({ operations: [{ type: 'set-position', atomId: n.id, position: { x: position.x + .01, y: position.y } }] });
  });
  await openExport('source');
  assert.equal(await page.locator('[data-action="copy-export"]').isDisabled(), true);
  assert.equal(await page.locator('.lossy-option').isVisible(), false);
  assert.match(await page.locator('.export-message').innerText(), /保留/);
  assert.match(await download('styled-moved.cdx'), /\.cdx$/);
  await page.locator('.export-format').selectOption('original');
  await download('original-styled.cdx'); await closeExport();
  const original = await readFile('tests/fixtures/cdx/dimethylamine-styled.cdx');
  assert.deepEqual(await readFile(`${out}/original-styled.cdx`), original);

  await page.evaluate(() => { const api = window.moleculeEditor, n = Object.values(api.getDocument().graph.atoms).find(a => a.element === 'N'); api.applyEdits({ operations: [{ type: 'update-atom', atomId: n.id, changes: { isotope: 15 } }] }); });
  await openExport('source');
  assert.equal(await page.locator('[data-action="download-export"]').isDisabled(), true);
  const blockedMessage = await page.locator('.export-message').innerText(); assert.match(blockedMessage, /标签/);
  await page.locator('.export-format').selectOption('original'); assert.equal(await page.locator('[data-action="download-export"]').isDisabled(), false);
  assert.match(await page.locator('.export-message').innerText(), /之后的编辑不包含/);
  await closeExport();

  await importFile('tests/fixtures/cdx/rdkit-ethanol.cdx');
  await page.evaluate(() => { const api = window.moleculeEditor, o = Object.values(api.getDocument().graph.atoms).find(a => a.element === 'O'); api.applyEdits({ operations: [{ type: 'update-atom', atomId: o.id, changes: { isotope: 18, charge: -1, hydrogens: { mode: 'fixed', count: 0 } } }] }); });
  await openExport('source'); await download('ethanol-18o-anion.cdx');
  await page.locator('.export-format').selectOption('cdxml');
  assert.equal(await page.locator('.allow-lossy').isChecked(), false);
  assert.match(await page.locator('.export-message').innerText(), /均已映射/);
  await download('ethanol-18o-anion.cdxml'); await closeExport();

  const xml = '<?xml version="1.0"?><!DOCTYPE CDXML SYSTEM "http://example.invalid/cdxml.dtd"><CDXML><fonttable><font id="9" name="Courier"/></fonttable><page id="1"><!-- independent text and graphic --><fragment id="2"><n id="3" p="0 0" Element="8"/></fragment><t id="8" p="50 50"><s font="9"><![CDATA[keep <text> & symbols]]></s></t><graphic id="7" GraphicType="Rectangle" BoundingBox="40 40 80 80"/></page></CDXML>';
  const cdata = await page.evaluate(async raw => {
    const api = window.moleculeEditor; api.import({ data: raw, name: 'annotated.cdxml' });
    const atomId = Object.keys(api.getDocument().graph.atoms)[0];
    api.applyEdits({ operations: [{ type: 'set-position', atomId, position: { x: .5, y: .25 } }] });
    let result;
    try { result = api.export({ format: 'cdxml' }); } catch (error) { throw new Error(JSON.stringify(error.issues)); }
    const parsed = new DOMParser().parseFromString(result.data, 'application/xml');
    return { preservation: result.preservation, parserError: !!parsed.querySelector('parsererror'),
      label: parsed.querySelector('t').textContent, font: parsed.querySelector('font').getAttribute('name'),
      graphic: parsed.querySelector('graphic').getAttribute('BoundingBox'), comment: result.data.includes('<!-- independent text and graphic -->'),
      cdata: result.data.includes('<![CDATA[keep <text> & symbols]]>'), doctype: result.data.includes('http://example.invalid/cdxml.dtd') };
  }, xml);
  assert.deepEqual(cdata, { preservation: 'preserved', parserError: false, label: 'keep <text> & symbols', font: 'Courier', graphic: '40 40 80 80', comment: true, cdata: true, doctype: true });
  await openExport('cdxml'); await download('annotated-moved.cdxml'); await closeExport();
  assert.deepEqual(errors, []);
  const report = { originalBytesIdentical: true, originalSha256: createHash('sha256').update(original).digest('hex'),
    movedCdxDownloaded: true, editedCdxDownloaded: true, exactMappedCdxmlDownloaded: true,
    binaryCopyDisabled: true, strictSaveIgnoresLossyCheckbox: true, labelEditBlocked: true,
    blockedMessage, originalAvailableAfterBlockedEdit: true, cdata, pageErrors: errors };
  await writeFile(`${out}/browser-results.json`, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
} finally { await browser.close(); }
