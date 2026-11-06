import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const { chromium } = await import(process.argv[2] || 'playwright');
const output = '.local/ai-upgrade';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [], failures = [];
const scenarios = [
  { width: 1280, height: 1000, locale: 'zh-CN' }, { width: 1280, height: 1000, locale: 'en' },
  { width: 390, height: 900, locale: 'zh-CN' }, { width: 390, height: 900, locale: 'en' },
];

async function untranslatedPreview(page) {
  return page.evaluate(() => {
    const root = document.querySelector('chemical-editor').shadowRoot.querySelector('.ai-review-slot');
    const findings = [], walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while (node = walker.nextNode()) {
      const owner = node.parentElement, text = node.data.trim();
      if (!owner || !/[\u3400-\u9fff]/u.test(text) || owner.closest('pre,code,svg,[data-i18n-skip]')) continue;
      if (owner.checkVisibility && !owner.checkVisibility()) continue;
      if (!owner.getBoundingClientRect().height) continue;
      if ([...function* () { for (let p = owner; p; p = p.parentElement) yield p; }()].some(p => p.tagName === 'DETAILS' && !p.open && !p.querySelector(':scope>summary')?.contains(owner))) continue;
      findings.push(text);
    }
    return [...new Set(findings)];
  });
}

try {
  for (const scenario of scenarios) {
    const { locale, ...viewport } = scenario, page = await browser.newPage({ viewport }), errors = [], prefix = `${viewport.width}-${locale}`;
    page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(15000);
    const editor = page.locator('chemical-editor').first();
    const field = name => editor.locator(`[data-ai-field="${name}"]`), action = name => editor.locator(`[data-ai-action="${name}"]`);
    const pending = editor.locator('.ai-review-slot .ai-edit-preview[data-review-state="pending"]');
    const approve = editor.locator('.ai-review-slot [data-ai-action="approve-edit"]'), reject = editor.locator('.ai-review-slot [data-ai-action="reject-edit"]');
    const finished = () => page.waitForFunction(() => document.querySelector('chemical-editor').shadowRoot.querySelector('[data-ai-action="stop"]').disabled);
    const snapshot = () => page.evaluate(() => window.moleculeEditor.getSnapshot());
    const isotope = () => page.evaluate(() => Object.values(window.moleculeEditor.getDocument().graph.atoms).find(atom => atom.element === 'O').isotope);
    const send = async text => { await field('message').fill(text); await action('send').click(); };
    try {
      await page.goto(process.env.AI_UPGRADE_TEST_URL || 'http://127.0.0.1:5173/'); await page.waitForFunction(() => !!window.moleculeEditor);
      const initial = await page.evaluate(async locale => {
        const sdk = await import('/src/index.ts'), api = window.moleculeEditor;
        api.unregisterPlugin('ai-assistant'); api.setLocale(locale); api.setDocument(sdk.exampleDocument('ethanol'));
        const oxygen = Object.values(api.getDocument().graph.atoms).find(atom => atom.element === 'O').id; api.setSelection({ atomIds: [oxygen] });
        window.aiUpgradeRequests = []; window.aiUpgradeMode = 'edit'; window.aiUpgradeCallCounter = 0;
        api.registerPlugin(sdk.createAiAssistantPlugin({ transport: { complete: async (request, signal) => {
          window.aiUpgradeRequests.push(structuredClone(request));
          if (window.aiUpgradeMode === 'fail') return new Promise((_resolve, reject) => {
            window.aiUpgradeFail = () => reject(new Error('Offline test transport'));
            signal?.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
          });
          if (window.aiUpgradeMode === 'respond' || request.messages.at(-1).role === 'tool') return { text: 'The requested tool result has been checked.', toolCalls: [] };
          const title = window.aiUpgradeNextTitle; window.aiUpgradeNextTitle = undefined;
          const operations = title ? [{ type: 'rename', title }] : [{ type: 'update-atom', atomId: oxygen, changes: { isotope: 18 } }];
          return { text: '', toolCalls: [{ id: `browser-edit-${++window.aiUpgradeCallCounter}`, name: 'apply_edits', arguments: JSON.stringify({ expectedRevision: api.getSnapshot().revision, operations }) }] };
        } } }));
        api.showPluginPanel('ai-assistant'); return { snapshot: api.getSnapshot(), svg: api.exportSvg(), oxygen };
      }, locale);
      assert.equal(await field('preview-edits').isChecked(), false, 'Existing direct mode must remain the default');
      await send(locale === 'en' ? 'Label the selected oxygen with oxygen-18.' : '把选中的氧标记为氧-18。'); await finished();
      assert.equal(await isotope(), 18); assert.equal(await editor.locator('.ai-edit-preview').count(), 0);
      await editor.locator('.commandbar [data-action="undo"]').click(); assert.deepEqual((await snapshot()).document, initial.snapshot.document);

      await field('preview-edits').check(); const beforeReview = await snapshot();
      await send(locale === 'en' ? 'Preview the oxygen-18 isotope label.' : '先预览氧-18同位素标记。'); await pending.waitFor({ state: 'visible' });
      assert.deepEqual(await snapshot(), beforeReview, 'A pending proposal changed the document');
      assert.equal(await field('allow-edits').isDisabled(), true); assert.equal(await field('preview-edits').isDisabled(), true);
      assert.equal(await action('send').isDisabled(), true); assert.equal(await approve.isEnabled(), true);
      const imageSources = await pending.locator('img').evaluateAll(images => images.map(image => image.getAttribute('src')));
      assert.equal(imageSources.length, 2); assert.ok(imageSources.every(src => src.startsWith('data:image/svg+xml;charset=utf-8,')));
      assert.equal(await pending.locator('svg,script').count(), 0, 'Preview SVG must not enter the live DOM');
      const initialPreviewMetrics = await editor.locator('.ai-review-slot').evaluate(node => {
        const slot=node.getBoundingClientRect(),actions=node.querySelector('.ai-edit-preview>.ai-actions').getBoundingClientRect();
        return {height:node.clientHeight,scrollHeight:node.scrollHeight,top:node.scrollTop,chatHeight:node.parentElement.clientHeight,
          diagramsVisible:[...node.querySelectorAll('.ai-preview-figures img')].every(image=>{const r=image.getBoundingClientRect();return r.height>=100&&r.top>=slot.top-1&&r.bottom<=Math.min(slot.bottom,actions.top)+1;})};
      });
      assert.ok(initialPreviewMetrics.height>=200,'The pending preview does not provide a readable review area');
      assert.equal(initialPreviewMetrics.diagramsVisible,true,'Before/after diagrams are hidden behind the preview controls or outside the review area');
      await page.screenshot({ path: `${output}/${prefix}-initial-preview.png` });
      await approve.click({ trial: true });
      const missing = locale === 'en' ? await untranslatedPreview(page) : [];
      assert.deepEqual(missing,[],'The English preview contains untranslated interface labels');
      await page.screenshot({ path: `${output}/${prefix}-pending.png` });
      await approve.click(); await finished(); assert.equal(await isotope(), 18);
      assert.equal(await editor.locator('.ai-edit-preview[data-review-state="applied"]').count(), 1);
      await editor.locator('.commandbar [data-action="undo"]').click(); assert.deepEqual((await snapshot()).document, initial.snapshot.document);

      // Source strings are visible as text only; rejecting cannot run either the source or a later tool.
      const hostile = '<img src=x onerror="window.AI_UPGRADE_PWNED=true"><script>window.AI_UPGRADE_PWNED=true</script>';
      await page.evaluate(title => { window.aiUpgradeNextTitle = title; }, hostile);
      const beforeReject = await snapshot(), callsBeforeReject = await page.evaluate(() => window.aiUpgradeRequests.length);
      await send('Preview title data only'); await pending.waitFor({ state: 'visible' });
      await pending.locator('summary').click();
      assert.ok((await pending.innerText()).includes('<img'));
      assert.equal(await pending.locator('script').count(), 0); assert.equal(await pending.locator('img').count(), 2);
      assert.equal(await page.evaluate(() => window.AI_UPGRADE_PWNED), undefined);
      await reject.click(); await finished(); assert.deepEqual(await snapshot(), beforeReject);
      assert.equal(await page.evaluate(() => window.aiUpgradeRequests.length), callsBeforeReject + 1);

      await send('Preview another label'); await pending.waitFor({ state: 'visible' });
      await page.evaluate(() => window.moleculeEditor.applyEdits({ operations: [{ type: 'rename', title: 'Manually changed while reviewing' }] }));
      const manual = await snapshot(); assert.equal(await approve.isDisabled(), true, 'A stale preview still permits application');
      await reject.click(); await finished(); assert.deepEqual(await snapshot(), manual);

      await send('Stop this pending preview'); await pending.waitFor({ state: 'visible' });
      const beforeStop = await snapshot(); await action('stop').click(); await finished();
      await editor.locator('.ai-review-slot').waitFor({ state: 'hidden' }); assert.deepEqual(await snapshot(), beforeStop);
      assert.equal(await field('allow-edits').isEnabled(), true);
      assert.equal(await field('message').inputValue(), 'Stop this pending preview');

      // A failure must not overwrite text the user typed during the request.
      await page.evaluate(() => { window.aiUpgradeMode = 'fail'; });
      await send('Original failed request'); await page.waitForFunction(() => typeof window.aiUpgradeFail === 'function');
      await field('message').fill('A newer unsent draft'); await page.evaluate(() => window.aiUpgradeFail()); await finished();
      assert.equal(await field('message').inputValue(), 'A newer unsent draft');
      await action('restore-request').click(); assert.equal(await field('message').inputValue(), 'A newer unsent draft');
      await field('message').fill(''); await action('restore-request').click(); assert.equal(await field('message').inputValue(), 'Original failed request');

      await action('clear').click(); await page.evaluate(() => { window.aiUpgradeMode = 'respond'; });
      const presets = editor.locator('.ai-presets button');
      for (let index = 0; index < await presets.count(); index++) {
        await presets.nth(index).click();
        const value = await field('message').inputValue();
        if (locale === 'en') assert.ok(!/[\u3400-\u9fff]/u.test(value), 'English locale inserted a Chinese preset instruction');
        else assert.ok(/[\u3400-\u9fff]/u.test(value));
      }
      await action('send').click(); await finished();
      const prompt = await page.evaluate(() => window.aiUpgradeRequests.at(-1).systemPrompt);
      assert.ok(prompt.includes(locale === 'en' ? 'Reply in concise English' : '请用中文简洁回复'));
      assert.deepEqual(await snapshot(), beforeStop);
      await page.screenshot({ path: `${output}/${prefix}-completed.png` });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      assert.deepEqual(errors, []);
      results.push({ viewport, locale, defaultDirect: true, previewApproval: true, undo: true, rejectionNoMutation: true, staleBlocked: true, pendingStop: true, runningModesDisabled: true, draftRecovery: true, englishPresetsAndLanguage: true, inertSvgImages: true, sourceTextNotExecutable: true, initialPreviewMetrics, untranslatedPreview: missing, errors });
      console.log(`Verified ${prefix}: real editor and runner, optional preview, approval/rejection/stale/stop, recovery and locale; ${missing.length} untranslated preview item(s)`);
    } catch (error) {
      failures.push({ viewport, locale, error: error.message, stack: error.stack, errors });
      await page.screenshot({ path: `${output}/${prefix}-failure.png` }).catch(() => {}); console.error(`Failed ${prefix}: ${error.message}`);
    } finally { await page.close(); }
  }
} finally {
  await browser.close(); await writeFile(`${output}/ui-results.json`, JSON.stringify({ browser: 'Chrome', modelTransport: 'controlled mock; actual editor and runner', results, failures }, null, 2) + '\n');
}
assert.deepEqual(failures, [], `${failures.length} AI upgrade UI scenario(s) failed`);
