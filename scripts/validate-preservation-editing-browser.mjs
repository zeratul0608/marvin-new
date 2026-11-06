const { chromium } = await import(process.argv[2] || 'playwright');
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const out = 'docs/validation/preservation-expanded'; await mkdir(out, { recursive: true });
const scenarios = ['isotope-charge', 'element', 'add-atom', 'add-to-label', 'delete-atom', 'delete-bond', 'rewire-bond', 'live-preview'];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ acceptDownloads: true }); const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:5173/'); await page.waitForFunction(() => !!window.moleculeEditor);
  const cdxInput = Array.from(await readFile('tests/fixtures/cdx/dimethylamine-styled.cdx'));
  const cdxmlInput = await readFile('tests/fixtures/cdxml/dimethylamine-styled.cdxml', 'utf8');
  // Give both input formats an independent rectangle. CDXML also has a comment and CDATA text.
  const annotated = await page.evaluate(async ({ cdxInput, cdxmlInput }) => {
    const { parseCdxTree } = await import('/src/formats/cdx.ts');
    const uint = (n, width = 2) => Array.from({ length: width }, (_, i) => n >>> (i * 8) & 255);
    const bytes = new Uint8Array(cdxInput), root = parseCdxTree(bytes), page = root.children.find(o => o.tag === 0x8001);
    const graphic = [...uint(0x8007), ...uint(30, 4), ...uint(0x0204), ...uint(16), ...[200,200,220,220].flatMap(v => uint(v * 65536, 4)), ...uint(0x0a00), ...uint(2), ...uint(3), 0, 0];
    const cdx = [...bytes.subarray(0, page.end - 2), ...graphic, ...bytes.subarray(page.end - 2)];
    const extra = '<!-- untouched annotation --><graphic id="30" GraphicType="Rectangle" BoundingBox="200 200 220 220"/><t id="31" p="240 240"><s font="3"><![CDATA[keep <note> & text]]></s></t>';
    return { cdx, cdxml: cdxmlInput.replace('</page>', extra + '</page>'), graphic };
  }, { cdxInput, cdxmlInput });
  await writeFile(`${out}/input-annotated.cdx`, Buffer.from(annotated.cdx)); await writeFile(`${out}/input-annotated.cdxml`, annotated.cdxml);
  const report = [];
  for (const kind of ['cdx', 'cdxml']) for (const scenario of scenarios) {
    await page.locator('[data-action="import"]').first().click();
    await page.locator('.file-input').setInputFiles(`${out}/input-annotated.${kind}`);
    await page.locator('[data-action="apply-import"]').click();
    await page.waitForFunction(() => !document.querySelector('chemical-editor').shadowRoot.querySelector('.import-dialog').open);
    if (scenario === 'live-preview') { await page.locator('[data-action="export"]').click(); await page.locator('.export-format').selectOption('source'); }
    const expected = await page.evaluate(async scenario => {
      const sdk = await import('/src/index.ts'), api = window.moleculeEditor, doc = api.getDocument();
      const n = Object.values(doc.graph.atoms).find(a => a.element === 'N'), cs = Object.values(doc.graph.atoms).filter(a => a.element === 'C');
      if (scenario === 'live-preview') n.isotope = 15;
      else if (scenario === 'isotope-charge') { n.isotope = 15; n.charge = 1; n.hydrogens = { mode: 'fixed', count: 2 }; }
      else if (scenario === 'element') n.element = 'P';
      else if (scenario === 'add-atom') { const p = doc.depiction.positions[cs[0].id], id = sdk.addAtom(doc, 'O', { x: p.x + 1, y: p.y + 1 }); sdk.addBond(doc, cs[0].id, id); }
      else if (scenario === 'add-to-label') { const p = doc.depiction.positions[n.id], id = sdk.addAtom(doc, 'C', { x: p.x, y: p.y - 1.5 }); sdk.addBond(doc, n.id, id); n.charge = 1; }
      else if (scenario === 'delete-atom') { sdk.removeAtom(doc, cs[0].id); n.hydrogens = { mode: 'auto' }; }
      else if (scenario === 'delete-bond') { sdk.removeBond(doc, Object.keys(doc.graph.bonds)[0]); n.hydrogens = { mode: 'auto' }; }
      else { Object.values(doc.graph.bonds)[0].atoms = [cs[1].id, cs[0].id]; n.hydrogens = { mode: 'auto' }; }
      api.setDocument(doc);
      const revision = api.getSnapshot().revision;
      const saved = await api.execute({ method: 'export_source', params: {} });
      if (api.getSnapshot().revision !== revision) throw new Error('Export changed editor state');
      return { formula: sdk.molecularFormula(doc), atoms: Object.keys(doc.graph.atoms).length, bonds: Object.keys(doc.graph.bonds).length, preservation: saved.preservation };
    }, scenario);
    if (scenario !== 'live-preview') { await page.locator('[data-action="export"]').click(); await page.locator('.export-format').selectOption('source'); }
    assert.equal(await page.locator('.allow-lossy').isVisible(), false);
    assert.equal(await page.locator('[data-action="download-export"]').isDisabled(), false);
    const wait = page.waitForEvent('download'); await page.locator('[data-action="download-export"]').click();
    const download = await wait, file = `${kind}-${scenario}.${kind}`; await download.saveAs(`${out}/${file}`);
    assert.ok(download.suggestedFilename().endsWith(`.${kind}`));
    await page.locator('.export-dialog [data-action="close-dialog"]').click();
    const result = await page.evaluate(async ({ output, kind, originalXml, graphic }) => {
      const sdk = await import('/src/index.ts'), { parseCdxTree } = await import('/src/formats/cdx.ts');
      const raw = new Uint8Array(output), imported = sdk.importDocument({ data: raw }).document;
      let unrelatedPreserved;
      if (kind === 'cdx') {
        const all = o => [o, ...o.children.flatMap(all)], objects = all(parseCdxTree(raw));
        const g = objects.find(o => o.tag === 0x8007 && o.id === 30);
        unrelatedPreserved = !!g && JSON.stringify(Array.from(raw.subarray(g.start, g.end))) === JSON.stringify(graphic);
      } else {
        const parse = text => new DOMParser().parseFromString(text.replace(/<!DOCTYPE[^>]*>/gi, ''), 'application/xml');
        const text = new TextDecoder().decode(raw), now = parse(text), before = parse(originalXml);
        unrelatedPreserved = ['fonttable', 'colortable', 'graphic[id="30"]', 't[id="31"]'].every(selector => now.querySelector(selector).outerHTML === before.querySelector(selector).outerHTML) && text.includes('<!-- untouched annotation -->') && text.includes('<![CDATA[keep <note> & text]]>');
      }
      return { formula: sdk.molecularFormula(imported), atoms: Object.keys(imported.graph.atoms).length, bonds: Object.keys(imported.graph.bonds).length, unrelatedPreserved };
    }, { output: Array.from(await readFile(`${out}/${file}`)), kind, originalXml: annotated.cdxml, graphic: annotated.graphic });
    assert.deepEqual({ formula: result.formula, atoms: result.atoms, bonds: result.bonds }, { formula: expected.formula, atoms: expected.atoms, bonds: expected.bonds });
    assert.equal(result.unrelatedPreserved, true); assert.equal(expected.preservation, 'preserved');
    report.push({ file, kind, scenario, ...result, preservation: expected.preservation });
  }
  assert.deepEqual(errors, []);
  await writeFile(`${out}/browser-results.json`, JSON.stringify({ cases: report, pageErrors: errors }, null, 2) + '\n');
  console.log(JSON.stringify({ cases: report.length, pageErrors: errors, unrelatedPreserved: report.every(c => c.unrelatedPreserved) }));
} finally { await browser.close(); }
