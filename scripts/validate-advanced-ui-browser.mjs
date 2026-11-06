import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { showAdvancedEditor } from './browser-advanced-ui.mjs';

const { chromium } = await import(process.argv[2] || 'playwright');
const output = '.local/advanced-ui';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [], failures = [];
const viewports = [{ width: 1600, height: 1100 }, { width: 1280, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }];
try {
  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(15000);
    const editor = page.locator('chemical-editor').first();
    try {
      await page.goto(process.env.ADVANCED_UI_TEST_URL || 'http://127.0.0.1:5173/');
      await page.waitForFunction(() => !!window.moleculeEditor);
      const toggle = editor.locator('[data-action="toggle-advanced"]');
      assert.equal(await toggle.isVisible(), true, 'The advanced entry must be available at every supported viewport');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await editor.locator('#advanced-tools').isVisible(), false, 'The demo must start with advanced tools collapsed');
      const before = await page.evaluate(async () => {
        const sdk = await import('/src/index.ts'), api = window.moleculeEditor;
        api.setDocument(sdk.exampleDocument('ethanol'));
        const atomId = Object.keys(api.getDocument().graph.atoms)[0]; api.setSelection({ atomIds: [atomId] }); api.showPluginPanel();
        window.advancedUiChanges = 0; window.advancedUiSelections = 0;
        api.addEventListener('change', () => window.advancedUiChanges++);
        api.addEventListener('selectionchange', () => window.advancedUiSelections++);
        return { atomId, snapshot: api.getSnapshot(), svg: api.exportSvg() };
      });
      for (const property of ['element', 'charge', 'isotope']) assert.equal(await editor.locator(`.inspector-content [data-property="${property}"]`).isVisible(), true);
      await page.screenshot({ path: `${output}/${viewport.width}-basic.png` });
      await toggle.click();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      assert.equal(await editor.locator('#advanced-tools').isVisible(), true);
      for (const section of ['properties', 'queries', 'fragments', 'document']) {
        await editor.locator(`[data-advanced-section="${section}"]`).click();
        assert.equal(await editor.locator(`[data-advanced-section="${section}"]`).getAttribute('aria-pressed'), 'true');
        for (const panel of ['properties', 'queries', 'fragments', 'document']) assert.equal(await editor.locator(`[data-advanced-panel="${panel}"]`).isVisible(), panel === section);
      }
      await toggle.click();
      assert.deepEqual(await page.evaluate(() => window.moleculeEditor.getSnapshot()), before.snapshot, 'Changing the editing workspace modified history or selection');
      assert.equal(await page.evaluate(() => window.moleculeEditor.exportSvg()), before.svg, 'Changing the editing workspace modified the chemical depiction');
      assert.deepEqual(await page.evaluate(() => ({ changes: window.advancedUiChanges, selections: window.advancedUiSelections })), { changes: 0, selections: 0 });

      // Native keyboard activation must not be consumed by canvas shortcuts.
      await toggle.focus(); await toggle.press('Enter');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      await editor.locator('[data-advanced-section="queries"]').focus();
      await editor.locator('[data-advanced-section="queries"]').press('Space');
      assert.equal(await editor.locator('[data-advanced-section="queries"]').getAttribute('aria-pressed'), 'true');
      const closeAdvanced = editor.locator('[data-action="close-advanced"]');
      await closeAdvanced.focus(); await closeAdvanced.press('Enter');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await toggle.evaluate(node => node.getRootNode().activeElement === node), true, 'Collapsing advanced controls stranded keyboard focus');

      await showAdvancedEditor(page, 'queries');
      const details = editor.locator('details.advanced-query-controls');
      if (!await details.evaluate(node => node.open)) await details.locator('summary').click();
      const input = editor.locator('[data-query-constraint="substituentsExactly"]');
      assert.equal(await input.isVisible(), true); await input.fill('2'); await input.press('Tab');
      const queried = await page.evaluate(id => {
        const api = window.moleculeEditor, doc = api.getDocument();
        if (doc.graph.atoms[id].queryConstraints?.substituentsExactly !== 2) throw Error('The visible query field did not edit the selected atom');
        return JSON.stringify(doc);
      }, before.atomId);
      assert.equal(await editor.locator(`[data-query-constraints="${before.atomId}"]`).isVisible(), true);
      await editor.locator('[data-action="undo"]:visible').first().click();
      assert.deepEqual(await page.evaluate(() => window.moleculeEditor.getDocument()), before.snapshot.document);
      await editor.locator('[data-action="redo"]:visible').first().click();
      assert.equal(await page.evaluate(() => JSON.stringify(window.moleculeEditor.getDocument())), queried);
      await page.screenshot({ path: `${output}/${viewport.width}-queries.png` });

      // Built-in assistant controls must stay reachable after sharing space with the advanced header.
      // These are UI-only checks; no model request is sent.
      await page.locator('[data-page="ai"]').click();
      const clearChat = editor.locator('.ai-actions button').filter({hasText:'清空对话'});
      await clearChat.click({trial:true});
      assert.equal(await clearChat.evaluate(button => {
        const bounds=button.getBoundingClientRect(), chat=button.closest('[data-ai-view="chat"]').getBoundingClientRect();
        return bounds.top>=chat.top && bounds.bottom<=chat.bottom;
      }),true,'The assistant composer is clipped by the advanced inspector');
      await editor.locator('.extension-commands>summary').click();
      const commandBounds = await editor.locator('.plugin-toolbar').evaluate(node => ({width:node.clientWidth,scroll:node.scrollWidth}));
      assert.ok(commandBounds.scroll <= commandBounds.width+1,'Builtin commands overflow the shared sidebar');
      assert.ok(await editor.locator('.plugin-toolbar button').count() >= 5);
      await editor.locator('.extension-commands>summary').click();

      await page.evaluate(() => {
        window.advancedUiMounts = 0; window.advancedUiDisposals = 0;
        window.moleculeEditor.registerPlugin({ id: 'advanced-ui-validation', name: 'UI state verification', version: '1.0.0', apiVersion: 1, activate(context) {
          let output;
          context.addPanel({ id: 'state', title: 'Persistent state', mount(container) {
            window.advancedUiMounts++;
            const input = document.createElement('input'); input.dataset.advancedUiDraft = ''; input.setAttribute('aria-label', 'Plugin draft');
            output = document.createElement('output'); output.dataset.advancedUiResult = ''; output.textContent = 'ready';
            container.append(input, output); window.advancedUiPanel = container;
            return () => { window.advancedUiDisposals++; };
          } });
          context.registerCommand({ id: 'finish', title: 'Verify retained panel', execute() { output.textContent = 'finished'; return 'finished'; } });
        } });
        window.moleculeEditor.showPluginPanel('advanced-ui-validation');
      });
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      assert.equal(await editor.locator('[data-advanced-section="extensions"]').getAttribute('aria-pressed'), 'true');
      const draft = editor.locator('[data-advanced-ui-draft]'); assert.equal(await draft.isVisible(), true); await draft.fill('Preserve this draft');
      await toggle.click();
      assert.equal(await draft.isVisible(), false);
      assert.equal(await editor.locator(`[data-query-constraints="${before.atomId}"]`).isVisible(), true, 'Collapsing tools removed a chemical canvas annotation');
      await showAdvancedEditor(page, 'extensions');
      await editor.locator('[data-inspector-plugin="advanced-ui-validation"]').click();
      assert.equal(await draft.inputValue(), 'Preserve this draft');
      await toggle.click();
      assert.equal(await page.evaluate(() => window.moleculeEditor.executeCommand('advanced-ui-validation.finish')), 'finished');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'A plugin command did not reveal its result panel');
      assert.equal(await draft.isVisible(), true);
      assert.equal(await editor.locator('[data-advanced-ui-result]').innerText(), 'finished');
      assert.deepEqual(await page.evaluate(() => ({ mounts: window.advancedUiMounts, disposals: window.advancedUiDisposals, samePanel: window.moleculeEditor.shadowRoot.querySelector('[data-advanced-ui-draft]').parentElement === window.advancedUiPanel })), { mounts: 1, disposals: 0, samePanel: true });
      assert.equal(await page.evaluate(() => JSON.stringify(window.moleculeEditor.getDocument())), queried);
      await page.screenshot({ path: `${output}/${viewport.width}-extensions.png` });
      await toggle.click();
      const overflow = await page.evaluate(() => ({ document: document.documentElement.scrollWidth > innerWidth + 1, editor: document.querySelector('chemical-editor').getBoundingClientRect().width > innerWidth + 1 }));
      assert.deepEqual(overflow, { document: false, editor: false }, 'The page or editor overflows the viewport horizontally');
      assert.deepEqual(errors, []);
      results.push({ viewport, defaultCollapsed: true, basicPropertiesVisible: true, realToggleAndCategories: true, nativeKeyboardAndFocus: true, uiChangesPreserveDocumentRevisionSelectionHistory: true, chemicalDepictionUnchanged: true, visibleQueryEdit: true, queryUndoRedo: true, collapsedQueryMarkerRetained: true, builtinCommandsContained: true, assistantControlsReachable: true, pluginAutoOpen: true, pluginStatePreserved: true, pluginMountedOnce: true, noHorizontalPageOverflow: true, errors });
      console.log(`Verified ${viewport.width}px: basic/advanced UI, visible query edit, history and persistent plugin state`);
    } catch (error) {
      failures.push({ viewport, error: error.message, stack: error.stack, errors });
      await page.screenshot({ path: `${output}/${viewport.width}-failure.png` }).catch(() => {});
      console.error(`Failed ${viewport.width}px: ${error.message}`);
    } finally { await page.close(); }
  }
} finally {
  await browser.close();
  await writeFile(`${output}/browser-results.json`, JSON.stringify({ browser: 'Chrome', aiTested: false, results, failures }, null, 2) + '\n');
}
assert.deepEqual(failures, [], `${failures.length} responsive advanced UI scenario(s) failed`);
