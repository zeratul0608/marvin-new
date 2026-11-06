import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

// Model responses are controlled; editor transactions, review UI and RDKit are real.
const { chromium } = await import(process.argv[2] || 'playwright');
const output = '.local/ai-chemistry';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [], failures = [];
const scenarios = [
  { width: 1280, height: 1000, locale: 'zh-CN' }, { width: 1280, height: 1000, locale: 'en' },
  { width: 390, height: 900, locale: 'zh-CN' }, { width: 390, height: 900, locale: 'en' },
];

async function untranslatedInterface(page) {
  return page.evaluate(() => {
    const root=document.querySelector('chemical-editor').shadowRoot.querySelector('.ai-assistant');
    const excluded='style,script,pre,code,svg,option,[data-i18n-skip]';
    const visible=node=>{
      if(node.checkVisibility&&!node.checkVisibility())return false;
      if(!node.getBoundingClientRect().height)return false;
      for(let parent=node;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS'&&!parent.open&&!parent.querySelector(':scope>summary')?.contains(node))return false;
      return true;
    };
    const missing=[],walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;
    while(node=walker.nextNode()){
      const parent=node.parentElement,text=node.data.trim();
      if(parent&&text&&/[\u3400-\u9fff]/u.test(text)&&!parent.closest(excluded+',textarea')&&visible(parent))missing.push(text);
    }
    for(const parent of root.querySelectorAll('[aria-label],[placeholder],[title]')){
      if(parent.closest(excluded)||!visible(parent))continue;
      for(const name of ['aria-label','placeholder','title']){const value=parent.getAttribute(name);if(value&&/[\u3400-\u9fff]/u.test(value))missing.push(value);}
    }
    return [...new Set(missing)];
  });
}

try {
  for (const scenario of scenarios) {
    const { locale, ...viewport } = scenario, page = await browser.newPage({ viewport });
    const errors = [], assets = [], assetRequests = [], remote = [];
    const url = process.env.AI_CHEMISTRY_TEST_URL || 'http://127.0.0.1:5173/';
    const origin = new URL(url).origin, prefix = `${viewport.width}-${locale}`;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      const target = request.url();
      if (target.includes('/rdkit-')) assetRequests.push(target);
      if (/^https?:/u.test(target) && new URL(target).origin !== origin) remote.push(target);
    });
    page.on('response', response => {
      if (response.url().includes('/rdkit-')) assets.push({ path: new URL(response.url()).pathname, status: response.status(), type: response.headers()['content-type'] });
    });
    page.setDefaultTimeout(45000);
    const editor = page.locator('chemical-editor').first();
    const field = name => editor.locator(`[data-ai-field="${name}"]`);
    const action = name => editor.locator(`[data-ai-action="${name}"]`);
    const pending = editor.locator('.ai-review-slot .ai-edit-preview[data-review-state="pending"]');
    const approve = editor.locator('.ai-review-slot [data-ai-action="approve-edit"]');
    const reject = editor.locator('.ai-review-slot [data-ai-action="reject-edit"]');
    const snapshot = () => page.evaluate(() => window.moleculeEditor.getSnapshot());
    const finished = () => page.waitForFunction(() => document.querySelector('chemical-editor').shadowRoot.querySelector('[data-ai-action="stop"]').disabled);
    const send = async text => { await field('message').fill(text); await action('send').click(); };
    const lastResponse = () => page.evaluate(() => window.aiChemistryToolResults.at(-1));
    try {
      await page.goto(url); await page.waitForFunction(() => !!window.moleculeEditor);
      const initial = await page.evaluate(async locale => {
        const sdk = await import('/src/index.ts'), api = window.moleculeEditor;
        window.aiChemistrySdk = sdk;
        api.unregisterPlugin('ai-assistant'); api.setLocale(locale);
        const document = sdk.exampleDocument('ethanol'), ids = Object.keys(document.graph.atoms);
        document.depiction.positions[ids[0]] = { x: 0, y: 0 };
        document.depiction.positions[ids[1]] = { x: 5, y: 2 };
        document.depiction.positions[ids[2]] = { x: 5, y: 8 };
        document.source = { format: 'mrv', raw: 'PRIVATE_AI_CHEMISTRY_SOURCE', fingerprint: '', issues: [] };
        api.setDocument(document); api.setSelection({ atomIds: [] });
        window.aiChemistryRequests = []; window.aiChemistryToolResults = [];
        window.aiChemistryMode = 'analyze'; window.aiChemistryIds = [];
        window.aiChemistrySmiles = 'N[C@@H](C)C(=O)O'; window.aiChemistryCall = 0;
        api.registerPlugin(sdk.createAiAssistantPlugin({ transport: { complete: async request => {
          if (JSON.stringify(request).includes('PRIVATE_AI_CHEMISTRY_SOURCE')) throw Error('Original source entered a model request');
          window.aiChemistryRequests.push(structuredClone(request));
          if (request.messages.at(-1).role === 'tool') {
            const response = JSON.parse(request.messages.at(-1).content);
            window.aiChemistryToolResults.push(response);
            const result = response.result;
            const analysis = result?.analysis ?? (result?.engine === 'RDKit' ? result : undefined);
            // Deliberately inaccurate model prose proves the separate result card
            // displays the real engine event, not numbers extracted from a reply.
            return { text: analysis ? 'Model prose placeholder: molecular weight 9999; SMILES MODEL_ONLY.' : response.ok ? 'The real computation and editor result were checked.' : 'The tool refused the operation. The document was preserved.', toolCalls: [] };
          }
          const mode = window.aiChemistryMode, current = api.getSnapshot();
          const name = mode === 'analyze' ? 'analyze_molecule' : mode === 'cleanup' ? 'cleanup_molecule_2d' : 'import_smiles';
          const args = mode === 'import' ? { expectedRevision: current.revision, smiles: window.aiChemistrySmiles, title: 'Typed SMILES input' }
            : { expectedRevision: current.revision, atomIds: window.aiChemistryIds };
          return { text: '', toolCalls: [{ id: `chemistry-browser-${++window.aiChemistryCall}`, name, arguments: JSON.stringify(args) }] };
        } } }));
        api.showPluginPanel('ai-assistant');
        return { snapshot: api.getSnapshot(), svg: api.exportSvg() };
      }, locale);
      assert.equal(assetRequests.length, 0, 'RDKit assets loaded before any chemistry request');
      await field('allow-edits').uncheck();
      await send(locale === 'en' ? 'Calculate properties for the complete document without editing it.' : '只读计算完整文档的分子性质。');
      await finished();
      const analyzed = await lastResponse(); assert.equal(analyzed.ok, true, 'Read-only chemistry analysis failed');
      const analysis = analyzed.result.analysis ?? analyzed.result;
      assert.equal(analysis.engine, 'RDKit'); assert.ok(analysis.version);
      assert.equal(analysis.formula, 'C2H6O'); assert.equal(analysis.smiles, 'CCO');
      assert.ok(Math.abs(analysis.molecularWeight - 46.069) < .05);
      assert.ok(Math.abs(analysis.exactMass - 46.04186) < .01);
      for (const value of Object.values(analysis.descriptors)) assert.equal(Number.isFinite(value), true);
      assert.deepEqual(await snapshot(), initial.snapshot, 'Analysis changed the document, selection or history');
      assert.equal(await editor.locator('.ai-review-slot').isVisible(), false);
      const calculation=editor.locator('.ai-chemistry-analysis');
      assert.equal(await calculation.count(),1);
      assert.equal(await calculation.getAttribute('data-ai-analysis'),String(initial.snapshot.revision));
      assert.equal(await calculation.getAttribute('data-stale'),'false');
      assert.ok((await calculation.innerText()).includes(`RDKit ${analysis.version}`));
      const values=await calculation.locator('.ai-analysis-values dd').allTextContents();
      assert.equal(values[0],analysis.formula);assert.equal(values[1],`${analysis.molecularWeight.toFixed(3)} g/mol`);
      assert.equal(values[2],`${analysis.exactMass.toFixed(6)} Da`);
      const smilesField=calculation.locator('[data-ai-analysis-smiles]');
      assert.equal(await smilesField.inputValue(),analysis.smiles);assert.equal(await smilesField.evaluate(node=>node.readOnly),true);
      assert.ok(!(await calculation.innerText()).includes('9999'),'The model prose contaminated authoritative calculation values');
      if(locale==='en')assert.deepEqual(await untranslatedInterface(page),[],'English calculation/presets contain untranslated UI');
      assert.ok(assets.some(asset => asset.path.endsWith('.wasm') && asset.status === 200 && asset.type === 'application/wasm'));
      assert.ok(assets.some(asset => asset.path.endsWith('.js') && asset.status === 200));
      const assetCount = assetRequests.length;
      await calculation.evaluate(node=>{node.scrollIntoView({block:'nearest'});});
      await page.screenshot({ path: `${output}/${prefix}-analysis.png` });
      await page.evaluate(()=>window.moleculeEditor.applyEdits({operations:[{type:'rename',title:'A newer manual revision'}]}));
      assert.equal(await calculation.getAttribute('data-stale'),'true','An old calculated result remained marked current after a manual revision');
      await editor.locator('.commandbar [data-action="undo"]').click();
      assert.deepEqual((await snapshot()).document,initial.snapshot.document);
      assert.equal(await calculation.getAttribute('data-stale'),'true','Undo must not pretend an earlier result belongs to the latest revision');
      await action('clear').click();assert.equal(await calculation.count(),0,'Clear conversation retained a stale calculation card');

      await field('allow-edits').check(); await field('preview-edits').check();
      await page.evaluate(() => { window.aiChemistryMode = 'cleanup'; });
      const beforeCleanup = await snapshot();
      await send(locale === 'en' ? 'Preview two-dimensional cleanup of the complete molecule, preserving chemistry.' : '预览整理整个分子的二维结构，保留化学内容。');
      await pending.waitFor({ state: 'visible' });
      assert.deepEqual(await snapshot(), beforeCleanup, 'Cleanup committed before preview approval');
      assert.equal(await pending.locator('img').count(), 2);
      const reviewMetrics = await editor.locator('.ai-review-slot').evaluate(node => {
        const slot = node.getBoundingClientRect(), buttons = node.querySelector('.ai-edit-preview>.ai-actions').getBoundingClientRect();
        return { height: node.clientHeight, imagesVisible: [...node.querySelectorAll('.ai-preview-figures img')].every(img => { const r=img.getBoundingClientRect(); return r.top>=slot.top-1&&r.bottom<=Math.min(slot.bottom,buttons.top)+1; }) };
      });
      assert.ok(reviewMetrics.height >= 200); assert.equal(reviewMetrics.imagesVisible, true);
      if(locale==='en')assert.deepEqual(await untranslatedInterface(page),[],'English cleanup preview contains untranslated UI');
      await page.screenshot({ path: `${output}/${prefix}-cleanup-preview.png` });
      await approve.click(); await finished();
      const cleanupResponse = await lastResponse(); assert.equal(cleanupResponse.ok, true);
      const cleaned = await snapshot();
      assert.deepEqual(cleaned.document.graph, beforeCleanup.document.graph);
      assert.deepEqual(cleaned.document.source, beforeCleanup.document.source);
      assert.notDeepEqual(cleaned.document.depiction.positions, beforeCleanup.document.depiction.positions);
      assert.equal(cleaned.revision, beforeCleanup.revision + 1);
      await editor.locator('.commandbar [data-action="undo"]').click();
      assert.deepEqual((await snapshot()).document, beforeCleanup.document);

      await page.evaluate(() => { window.aiChemistryMode = 'import'; });
      const beforeImport = await snapshot();
      await send(locale === 'en' ? 'Replace the document with this exact SMILES: N[C@@H](C)C(=O)O. Preview first.' : '用这一条明确的SMILES替换文档并先预览：N[C@@H](C)C(=O)O');
      await pending.waitFor({ state: 'visible' }); assert.deepEqual(await snapshot(), beforeImport);
      if(locale==='en')assert.deepEqual(await untranslatedInterface(page),[],'English SMILES preview contains untranslated UI');
      await page.screenshot({ path: `${output}/${prefix}-smiles-preview.png` });
      await approve.click(); await finished();
      assert.equal((await lastResponse()).ok, true);
      const imported = await page.evaluate(async () => {
        const sdk = window.aiChemistrySdk, engine = await sdk.loadChemistryEngine(), actual=window.moleculeEditor.getDocument();
        const expected=engine.importSmiles(window.aiChemistrySmiles,'Typed SMILES input');
        return {document:actual,analysis:engine.analyze(actual),expectedSmiles:engine.analyze(expected).smiles};
      });
      assert.equal(imported.analysis.smiles, imported.expectedSmiles);
      assert.equal(imported.analysis.formula, 'C3H7NO2');
      assert.equal(Object.values(imported.analysis.stereoAtoms).filter(label => label === 'S').length, 1);
      assert.equal(imported.document.title, 'Typed SMILES input');
      assert.ok(!JSON.stringify(imported.document).includes('PRIVATE_AI_CHEMISTRY_SOURCE'));
      await editor.locator('.commandbar [data-action="undo"]').click();
      assert.deepEqual((await snapshot()).document, beforeImport.document);

      const beforeReject = await snapshot();
      await page.evaluate(() => { window.aiChemistrySmiles='CCN'; });
      await send('Preview replacing with the explicitly provided SMILES CCN.');
      await pending.waitFor({ state: 'visible' }); await reject.click(); await finished();
      assert.deepEqual(await snapshot(), beforeReject, 'Rejected SMILES import changed the document');

      await field('allow-edits').uncheck(); const beforeReadonly = await snapshot();
      await send('Attempt SMILES CCN in read-only mode.'); await finished();
      assert.equal((await lastResponse()).ok, false); assert.deepEqual(await snapshot(), beforeReadonly);

      await page.evaluate(() => {
        const api=window.moleculeEditor, doc=api.getDocument(), id=Object.keys(doc.graph.atoms)[0];
        doc.graph.atoms[id].queryConstraints={ringBondCount:'NoRingBonds'}; api.setDocument(doc); api.setSelection({atomIds:[]});
        window.aiChemistryMode='analyze'; window.aiChemistryIds=[];
      });
      const queried = await snapshot();
      await send('Analyze the queried structure without removing its query constraints.'); await finished();
      assert.equal((await lastResponse()).ok, false); assert.deepEqual(await snapshot(), queried);
      await field('allow-edits').check();
      await page.evaluate(() => {window.aiChemistryMode='cleanup';});
      await send('Try cleanup without simplifying queries.'); await finished();
      assert.equal((await lastResponse()).ok, false); assert.deepEqual(await snapshot(), queried);
      assert.equal(await editor.locator('.ai-review-slot').isVisible(), false);

      await page.evaluate(() => {
        const api=window.moleculeEditor,doc=window.aiChemistrySdk.exampleDocument('ethanol');api.setDocument(doc);
        const first=Object.keys(doc.graph.atoms)[0];api.setSelection({atomIds:[first]});window.aiChemistryIds=[first];window.aiChemistryMode='analyze';
      });
      const partial = await snapshot();
      await send('Analyze only this incomplete selected part without expanding scope.'); await finished();
      assert.equal((await lastResponse()).ok, false); assert.deepEqual(await snapshot(), partial);
      assert.equal(assetRequests.length, assetCount, 'The shared chemistry engine loaded its assets again for every tool call');
      assert.deepEqual(remote, [], 'Chemistry calculation contacted an external service'); assert.deepEqual(errors, []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: `${output}/${prefix}-protected-query.png` });
      results.push({ viewport,locale,actualRDKit:true,readOnlyAnalysis:true,formula:analysis.formula,molecularWeight:analysis.molecularWeight,smiles:analysis.smiles,
        authoritativeAnalysisCard:true,modelProseDoesNotAlterValues:true,readonlySmiles:true,resultRevisionLabel:true,staleResultMarked:true,clearRemovesAnalysis:true,englishNewInterfaceTranslated:true,
        lazyLocalAssets:true,assetRequests,assets,cleanupPreview:true,cleanupPreservesGraphAndSource:true,cleanupUndo:true,smilesPreview:true,smilesStereochemistryPreserved:true,
        smilesUndo:true,rejectedImportUnchanged:true,readOnlyImportBlocked:true,queryNotSimplified:true,partialSelectionNotExpanded:true,reviewMetrics,errors });
      console.log(`Verified ${prefix}: real RDKit analysis/cleanup/SMILES, preview/undo and protected chemistry`);
    } catch (error) {
      failures.push({viewport,locale,error:error.message,stack:error.stack,errors,assets,remote});
      await page.screenshot({path:`${output}/${prefix}-failure.png`}).catch(()=>{});
      console.error(`Failed ${prefix}: ${error.message}`);
    } finally {await page.close();}
  }
} finally {
  await browser.close();
  await writeFile(`${output}/browser-results.json`,JSON.stringify({browser:'Chrome',modelTransport:'controlled mock; real RDKit, editor and AI runner',results,failures},null,2)+'\n');
}
assert.deepEqual(failures,[],`${failures.length} AI chemistry browser scenario(s) failed`);
