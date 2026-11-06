import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { showAdvancedEditor } from './browser-advanced-ui.mjs';

const { chromium } = await import(process.argv[2] || 'playwright');
const directory = 'docs/validation/expanded-groups', downloads = '.local/expanded-group-downloads';
const cases = JSON.parse(await readFile(`${directory}/adapter-results.json`, 'utf8')).results;
assert.equal(cases.length, 5, 'Expected the five independently prepared group-view scenarios');
await mkdir(downloads, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [], failures = [], errors = [];
const page = await browser.newPage({ viewport: { width: 1660, height: 1160 }, acceptDownloads: true });
page.setDefaultTimeout(20000);
page.on('pageerror', error => errors.push(error.message));
const editor = page.locator('chemical-editor').first();

async function importFile(file) {
  await editor.locator('[data-action="import"]').first().click();
  await editor.locator('.file-input').setInputFiles(file);
  await page.waitForFunction(name => document.querySelector('chemical-editor').shadowRoot.querySelector('.import-filename').textContent === name, path.basename(file));
  await editor.locator('[data-action="apply-import"]').click();
  await page.waitForFunction(() => !document.querySelector('chemical-editor').shadowRoot.querySelector('.import-dialog').open);
}

async function assertDocument(expected) {
  assert.equal(await page.evaluate(() => JSON.stringify(window.moleculeEditor.getDocument())), expected, 'The visible editor history differs from the expected document');
}

async function clickExpanded(target, kind) {
  const index = await page.evaluate(({ target, kind }) => {
    const nodes = [...document.querySelector('chemical-editor').shadowRoot.querySelectorAll(`.drawing [data-expanded-${kind}]`)];
    return nodes.findIndex(node => node.getAttribute(`data-expanded-${kind}`) === target[`${kind}Id`] && node.getAttribute('data-expanded-path') === JSON.stringify(target.path));
  }, { target, kind });
  assert.ok(index >= 0, `The real ${kind} hit with the complete nested path is missing`);
  const hit = editor.locator(`.drawing [data-expanded-${kind}]`).nth(index).locator(`.${kind}-hit`);
  if (kind === 'bond') {
    // Horizontal SVG lines have a zero-height geometric bounding box even
    // though their real stroke is clickable. Use its actual screen midpoint.
    const point = await hit.evaluate(node => {
      const box = node.getBBox(), center = new DOMPoint(box.x + box.width / 2, box.y + box.height / 2).matrixTransform(node.getScreenCTM());
      return { x: center.x, y: center.y };
    });
    await page.mouse.click(point.x, point.y);
  } else await hit.click();
  const dialog = editor.locator('dialog[aria-label="编辑内部化学片段"]');
  await dialog.waitFor({ state: 'visible' });
  const selection = await dialog.locator('chemical-editor').evaluate(child => ({ selection: child.getSelection(), atoms: Object.keys(child.getDocument().graph.atoms).length }));
  assert.ok(selection.atoms > 0, 'The nested editor mounted an empty document');
  if (kind === 'atom') assert.deepEqual(selection.selection.atomIds, [target.atomId], 'Clicking a card did not focus the intended local atom');
  else { assert.deepEqual(selection.selection.atomIds, []); assert.equal(selection.selection.bondId, target.bondId, 'Clicking a card did not focus the intended local bond'); }
  assert.equal(await dialog.locator('select[aria-label="内部片段"]').inputValue(), String(target.path.at(-1).fragment));
  return dialog;
}

try {
  for (const test of cases) {
    try {
      await page.goto('http://127.0.0.1:5173/');
      await page.waitForFunction(() => !!window.moleculeEditor);
      await importFile(`${directory}/${test.original}`);
      const initial = await page.evaluate(() => {
        const api = window.moleculeEditor, doc = api.getDocument(), atom = Object.values(doc.graph.atoms).find(a => a.substructure);
        if (!atom) throw Error('Prepared original has no real editable child graph');
        api.setSelection({ atomIds: [atom.id] }); api.showPluginPanel();
        return { document: JSON.stringify(doc), wrapperId: atom.id, rootAtoms: Object.keys(doc.graph.atoms).length, branches: atom.substructure.fragments.length };
      });
      assert.equal(initial.branches, test.branches);
      const recursive = test.scenario.endsWith('nested');
      await showAdvancedEditor(page, 'fragments');
      await editor.locator(`[data-action="${recursive ? 'show-substructure-recursive' : 'toggle-substructure-display'}"]`).click();
      const shown = await page.evaluate(async ({ initial, recursive }) => {
        const sdk = await import('/src/index.ts'), doc = window.moleculeEditor.getDocument();
        const expected = sdk.applyDocumentEdits(JSON.parse(initial.document), [{ type: 'set-substructure-display', atomId: initial.wrapperId, expanded: true, recursive }]).document;
        if (JSON.stringify(doc) !== JSON.stringify(expected)) throw Error('The visible expansion changed the graph, annotations or references');
        const panel = document.querySelector('chemical-editor').shadowRoot;
        const cards = [...panel.querySelectorAll('.drawing [data-expanded-card]')];
        const targets = cards.map(card => {
          const path = JSON.parse(card.getAttribute('data-expanded-path')); let child = doc;
          for (const scope of path) child = child.graph.atoms[scope.atomId].substructure.fragments[scope.fragment].document;
          const atom = Object.values(child.graph.atoms).find(a => a.element !== '*' && !a.attachment && !a.substructure);
          if (!atom) throw Error('Prepared card lacks an ordinary editable atom');
          const bond = Object.values(child.graph.bonds).find(b => {
            const [a, c] = b.atoms.map(id => child.depiction.positions[id]); return Math.hypot(a.x - c.x, a.y - c.y) > .1;
          });
          if (card.querySelector('[data-atom], [data-bond], [data-drawing]')) throw Error('Child graph still exposes root event selectors');
          if (card.querySelectorAll('[data-expanded-atom]').length !== Object.keys(child.graph.atoms).length || card.querySelectorAll('[data-expanded-bond]').length !== Object.keys(child.graph.bonds).length) throw Error('Expanded card omitted actual chemical nodes or edges');
          return { path, atomId: atom.id, element: atom.element, isotope: (atom.isotope ?? ({ H: 1, C: 12, N: 14, O: 16, S: 32, P: 31, F: 19, Cl: 35, Br: 79, I: 127 }[atom.element] ?? 100)) + 1, ...(bond ? { bondId: bond.id } : {}) };
        });
        if (!targets.length) throw Error('No expanded cards appeared after the actual UI button');
        return { document: JSON.stringify(doc), cards: cards.length, targets, rootAtomHits: panel.querySelectorAll('.drawing [data-atom]').length };
      }, { initial, recursive });
      assert.equal(shown.rootAtomHits, initial.rootAtoms);
      await editor.locator('[data-action="undo"]').first().click(); await assertDocument(initial.document);
      await editor.locator('[data-action="redo"]').first().click(); await assertDocument(shown.document);

      const targets = recursive ? [shown.targets.reduce((deepest, current) => current.path.length > deepest.path.length ? current : deepest)] : shown.targets.filter(target => target.path.length === 1);
      if (recursive) assert.ok(targets[0].path.length > 1, 'Nested test did not expose a nested path');
      else assert.equal(targets.length, initial.branches, 'Not all alternative candidates were offered as editable cards');
      const edits = [];
      for (const target of targets) {
        const before = await page.evaluate(() => JSON.stringify(window.moleculeEditor.getDocument()));
        const dialog = await clickExpanded(target, 'atom');
        const input = dialog.locator('chemical-editor').locator('[data-property="isotope"]');
        await input.fill(String(target.isotope)); await input.press('Tab');
        await page.waitForFunction(({ atomId, isotope }) => {
          const root = document.querySelector('chemical-editor').shadowRoot;
          const child = root.querySelector('dialog[aria-label="编辑内部化学片段"] chemical-editor');
          return child?.getDocument().graph.atoms[atomId]?.isotope === isotope;
        }, target);
        if (recursive) await page.screenshot({ path: '.local/expanded-group-nested-editor.png' });
        await dialog.locator('[data-nested-save]').click(); await dialog.waitFor({ state: 'detached' });
        const after = await page.evaluate(async ({ before, target }) => {
          const sdk = await import('/src/index.ts'), baseline = JSON.parse(before), rootId = target.path[0].atomId, group = structuredClone(baseline.graph.atoms[rootId].substructure);
          let active = group;
          for (let i = 0; i < target.path.length - 1; i++) active = active.fragments[target.path[i].fragment].document.graph.atoms[target.path[i + 1].atomId].substructure;
          const fragment = active.fragments[target.path.at(-1).fragment];
          fragment.document = sdk.applyDocumentEdits(fragment.document, [{ type: 'update-atom', atomId: target.atomId, changes: { isotope: target.isotope } }]).document;
          const expected = sdk.applyDocumentEdits(baseline, [{ type: 'set-substructure', atomId: rootId, substructure: group }]).document;
          const actual = window.moleculeEditor.getDocument();
          if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error('Saving the nested editor changed annotations, alternatives, boundary mappings or document references');
          return JSON.stringify(actual);
        }, { before, target });
        await editor.locator('[data-action="undo"]').first().click(); await assertDocument(before);
        await editor.locator('[data-action="redo"]').first().click(); await assertDocument(after);
        edits.push({ element: target.element, isotope: target.isotope, pathDepth: target.path.length, candidate: target.path.at(-1).fragment + 1, realCardClick: true, childFocus: true, visibleIsotopeEdit: true, parentSave: true, undoRedo: true });
      }

      const bondTarget = targets.find(target => target.bondId), final = await page.evaluate(() => JSON.stringify(window.moleculeEditor.getDocument()));
      if (bondTarget) { const dialog = await clickExpanded(bondTarget, 'bond'); await dialog.locator('[data-nested-close]').click(); await dialog.waitFor({ state: 'detached' }); await assertDocument(final); }
      if (recursive) { await editor.locator('.toast').waitFor({ state: 'hidden' }); await page.screenshot({ path: '.local/expanded-group-views.png' }); }
      await editor.locator('[data-action="export"]').first().click();
      await editor.locator('.export-format').selectOption('source');
      assert.equal(await editor.locator('[data-action="download-export"]').isDisabled(), false, await editor.locator('.export-message').textContent());
      const pending = page.waitForEvent('download'); await editor.locator('[data-action="download-export"]').click();
      const download = await pending, file = `${downloads}/${test.scenario}-edited.cdxml`; await download.saveAs(file);
      await editor.locator('.export-dialog [data-action="close-dialog"]').click();
      const sourceProof = await page.evaluate(async ({ base64, expected }) => {
        const sdk = await import('/src/index.ts'), { equivalentDocuments } = await import('/scripts/document-correspondence.mjs');
        const data = new TextDecoder().decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0))), back = sdk.importDocument({ data }).document;
        if (!equivalentDocuments(sdk, back, JSON.parse(expected))) throw Error('Actual source download did not preserve the complete edited model and display state');
        return { completeProjection: true, rootAtoms: Object.keys(back.graph.atoms).length, branches: Object.values(back.graph.atoms).find(a => a.substructure).substructure.fragments.length };
      }, { base64: (await readFile(file)).toString('base64'), expected: final });
      assert.equal(sourceProof.rootAtoms, initial.rootAtoms); assert.equal(sourceProof.branches, initial.branches);
      await importFile(file);
      const restored = await page.evaluate(async ({ expected, count }) => {
        const sdk = await import('/src/index.ts'), { equivalentDocuments } = await import('/scripts/document-correspondence.mjs'), doc = window.moleculeEditor.getDocument();
        if (!equivalentDocuments(sdk, doc, JSON.parse(expected))) throw Error('Reimporting the real source download lost edited chemistry or display state');
        const cards = document.querySelector('chemical-editor').shadowRoot.querySelectorAll('.drawing [data-expanded-card]').length;
        if (cards !== count) throw Error('Reimporting the downloaded source did not restore all cards');
        return { cards, sourceDownloadReimport: true };
      }, { expected: final, count: shown.cards });

      // Also exercise the separately prepared expanded file through the actual
      // file input, rather than validating only our own downloaded output.
      await importFile(`${directory}/${test.expanded}`);
      const prepared = await page.evaluate(async ({ base64, count }) => {
        const sdk = await import('/src/index.ts'), { equivalentDocuments } = await import('/scripts/document-correspondence.mjs');
        const raw = new TextDecoder().decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0))), expected = sdk.importDocument({ data: raw }).document;
        if (!equivalentDocuments(sdk, window.moleculeEditor.getDocument(), expected)) throw Error('Prepared expanded source changed on visible import');
        const cards = document.querySelector('chemical-editor').shadowRoot.querySelectorAll('.drawing [data-expanded-card]').length;
        if (cards !== count) throw Error('Prepared expanded file did not restore its saved view state');
        return { cards, preparedExpandedFileImport: true };
      }, { base64: (await readFile(`${directory}/${test.expanded}`)).toString('base64'), count: shown.cards });
      results.push({ scenario: test.scenario, original: test.original, expanded: test.expanded, rootAtoms: initial.rootAtoms, branches: initial.branches, cards: shown.cards, visibleOriginalImport: true, realExpansionButton: true, expansionUndoRedo: true, edits, allCandidatesRetained: true, wrapperAnnotationsRetained: true, documentReferencesRetained: true, boundaryMappingsRetained: true, bondClickAndFocus: bondTarget ? true : 'not applicable: this fixture has no bonds', sourceDownloadRoundtrip: sourceProof, ...restored, ...prepared });
      console.log(`Verified ${test.scenario}: ${shown.cards} real cards, ${edits.length} focused chemistry edits, history and source download/reimport`);
    } catch (error) {
      failures.push({ scenario: test.scenario, error: error.message, stack: error.stack });
      await page.screenshot({ path: `${downloads}/${test.scenario}-failure.png` }).catch(() => {});
      console.error(`Failed ${test.scenario}: ${error.message}`);
    }
  }
} finally {
  await writeFile(`${directory}/browser-results.json`, JSON.stringify({ browser: 'Chrome', scope: 'Own fixtures only. Actual file input, expanded graph atom/bond clicks, child-editor isotope edits, parent save, undo/redo, actual source downloads and file reimports. No AI test.', summary: { scenarios: cases.length, passed: results.length, failed: failures.length, actualChildEdits: results.reduce((count, result) => count + result.edits.length, 0) }, results, failures, errors, aiTested: false }, null, 2) + '\n');
  await browser.close();
}
assert.deepEqual(failures, []); assert.deepEqual(errors, []);
