import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { showAdvancedEditor } from './browser-advanced-ui.mjs';
const { chromium } = await import(process.argv[2] || 'playwright');
const output = 'docs/validation/stereochemistry'; await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1440, height: 1080 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:5173/'); await page.waitForFunction(() => !!window.moleculeEditor);
  const results = [];
  for (const scenario of ['tetra-original', 'tetra-inverted', 'tetra-mirrored', 'alkene-trans', 'alkene-cis']) {
    await page.evaluate(async scenario => {
      const sdk = await import('/src/index.ts'), api = window.moleculeEditor;
      const doc = sdk.emptyDocument(scenario); let center;
      if (scenario.startsWith('tetra')) {
        center = sdk.addAtom(doc, 'C', { x: 0, y: 0 });
        const positions = [{ x: 1.5, y: 0 }, { x: 0, y: 1.5 }, { x: -1.5, y: 0 }, { x: 0, y: -1.5 }];
        const refs = ['F', 'Cl', 'Br', 'I'].map((element, i) => sdk.addBond(doc, center, sdk.addAtom(doc, element, positions[i])));
        doc.depiction.bonds[refs[0]] = { style: 'wedge', from: center };
        doc.graph.atoms[center].geometry = { type: 'tetrahedral', bondOrdering: refs };
        api.setDocument(doc); api.setSelection({ atomIds: [center] });
      } else {
        const ids = [{ x: -1, y: 1 }, { x: 0, y: 0 }, { x: 1.5, y: 0 }, { x: 2.5, y: -1 }].map(p => sdk.addAtom(doc, 'C', p));
        sdk.addBond(doc, ids[0], ids[1]); center = sdk.addBond(doc, ids[1], ids[2], 2); sdk.addBond(doc, ids[2], ids[3]);
        doc.graph.bonds[center].circularOrdering = sdk.circularOrderingFromDrawing(doc, center);
        api.setDocument(doc); api.setSelection({ atomIds: [], bondId: center });
      }
      window.stereoBefore = api.getDocument(); api.showPluginPanel(); api.fit();
    }, scenario);
    await showAdvancedEditor(page, 'properties');
    if (scenario === 'tetra-inverted') await page.locator('[data-action="invert-atom-stereo"]').click();
    if (scenario === 'alkene-cis') await page.locator('[data-action="invert-double-stereo"]').click();
    if (scenario === 'tetra-mirrored') {
      await page.locator('[data-tab="structure"]').click(); await page.locator('[data-action="select-all"]').click();
      await page.locator('#structure-panel [data-transform="mirror-horizontal"]').click();
    }
    const expected = await page.evaluate(async scenario => {
      const { stereoProjection } = await import('/src/formats/stereo.ts'), api = window.moleculeEditor, after = api.getDocument();
      if (['tetra-inverted', 'alkene-cis', 'tetra-mirrored'].includes(scenario)) {
        api.undo(); if (JSON.stringify(api.getDocument()) !== JSON.stringify(window.stereoBefore)) throw new Error('Undo did not restore complete stereo state');
        api.redo(); if (JSON.stringify(api.getDocument()) !== JSON.stringify(after)) throw new Error('Redo did not restore complete stereo state');
      }
      return stereoProjection(after);
    }, scenario);
    for (const format of ['cdx', 'cdxml']) {
      await page.locator('[data-action="export"]').click(); await page.locator('.export-format').selectOption(format);
      assert.equal(await page.locator('[data-action="download-export"]').isDisabled(), false);
      const pending = page.waitForEvent('download'); await page.locator('[data-action="download-export"]').click();
      const download = await pending, file = `${scenario}.${format}`; await download.saveAs(`${output}/${file}`);
      await page.locator('.export-dialog [data-action="close-dialog"]').click();
      const check = await page.evaluate(async ({ bytes, format }) => {
        const sdk = await import('/src/index.ts'), { stereoProjection } = await import('/src/formats/stereo.ts');
        const doc = sdk.importDocument({ data: new Uint8Array(bytes), format }).document;
        for (const p of Object.values(doc.depiction.positions)) { p.x += .125; p.y += .125; }
        const saved = sdk.exportSourceFile(doc), back = sdk.importDocument({ data: saved.data, format }).document;
        if (JSON.stringify(stereoProjection(doc)) !== JSON.stringify(stereoProjection(back))) throw new Error('Source save changed stereo references or depiction');
        for (const p of Object.values(doc.depiction.positions)) { p.x -= .125; p.y -= .125; }
        return stereoProjection(doc);
      }, { bytes: Array.from(await readFile(`${output}/${file}`)), format });
      assert.deepEqual(check, expected); results.push({ scenario, file, format, signature: expected, sourceSaveVerified: true });
    }
    if (scenario === 'tetra-original') await page.screenshot({ path: `${output}/editor.png`, fullPage: true });
  }
  // Exercise a real inspector change that would invalidate the recorded double bond.
  await page.evaluate(() => window.moleculeEditor.showPluginPanel());
  const blocked = await page.evaluate(async () => {
    const api = window.moleculeEditor, original = window.stereoBefore;
    api.setDocument(original); api.setSelection({ atomIds: [], bondId: Object.values(original.graph.bonds).find(b => b.circularOrdering).id });
    const root = api.shadowRoot, order = root.querySelector('#bond-order');
    order.value = '1'; order.dispatchEvent(new Event('change', { bubbles: true }));
    return { unchanged: JSON.stringify(api.getDocument()) === JSON.stringify(original), message: root.querySelector('.toast').textContent };
  });
  assert.equal(blocked.unchanged, true); assert.match(blocked.message, /清除/);
  const drag = await page.evaluate(() => {
    const api = window.moleculeEditor, doc = api.getDocument(), tail = Object.keys(doc.graph.atoms).at(-1);
    api.setTool('select'); api.setSelection({ atomIds: [tail] }); api.fit();
    const svg = api.shadowRoot.querySelector('svg.canvas'), p = doc.depiction.positions[tail];
    const screen = (x, y) => { const point = new DOMPoint(x, -y).matrixTransform(svg.getScreenCTM()); return { x: point.x, y: point.y }; };
    return { from: screen(p.x, p.y), to: screen(p.x, -p.y), before: JSON.stringify(doc) };
  });
  await page.mouse.move(drag.from.x, drag.from.y); await page.mouse.down();
  await page.mouse.move(drag.to.x, drag.to.y, { steps: 10 }); await page.mouse.up();
  const dragBlocked = await page.evaluate(before => ({ unchanged: JSON.stringify(window.moleculeEditor.getDocument()) === before, message: window.moleculeEditor.shadowRoot.querySelector('.toast').textContent }), drag.before);
  assert.equal(dragBlocked.unchanged, true); assert.match(dragBlocked.message, /双键构型/);
  assert.deepEqual(errors, []);
  await writeFile(`${output}/browser-results.json`, JSON.stringify({ results, blocked, dragBlocked, pageErrors: errors }, null, 2));
  console.log(`${results.length} real CDX/CDXML downloads, stereo UI undo/redo, source-save and blocked edit verified.`);
} finally { await browser.close(); }
