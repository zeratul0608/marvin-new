import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createAppServer } from '../server/start.mjs';

// This gateway has its own process-local configuration. The running workbench's
// model settings and keys are never read or changed by this validation.
const { chromium } = await import(process.argv[2] || 'playwright');
const output = '.local/ai-chemistry'; await mkdir(output, { recursive: true });
const server = createAppServer({ dist: 'dist-sdk', ai: { env: {
  AI_PROTOCOL: 'chat-completions', AI_BASE_URL: 'http://127.0.0.1:8000/v1', AI_MODEL: 'qwen3.6-27b',
}, timeoutMs: 180000 } });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const base = `http://127.0.0.1:${server.address().port}`, asset = await stat('dist-sdk/chemical-editor.js');
const report = { model: 'qwen3.6-27b', modelEndpoint: 'http://127.0.0.1:8000/v1', isolatedGateway: true,
  developmentGatewayModified: false, actualRDKit: true, enableThinking: false, sdkBuiltAt: asset.mtime.toISOString(), sdkBytes: asset.size,
  startedAt: new Date().toISOString(), results: [], failures: [], pageErrors: [], assets: [] };
const cases = [
  { id: 'readonly-properties', locale: 'zh-CN', readonly: true, tool: 'analyze_molecule',
    instruction: '请使用真实的本地化学计算工具，读取当前完整分子的分子式、平均分子量和异构 SMILES，然后简短说明结果。只读，不修改结构、选区或视图；数值须来自计算结果，不能估算。' },
  { id: 'stereo-smiles-reviewed', locale: 'en', review: true, tool: 'import_smiles',
    instruction: 'Replace the entire document with this exact user-provided single-molecule SMILES: N[C@@H](C)C(=O)O. Use local SMILES import and preserve its specified stereochemistry. Set the document title to Provided SMILES. Show the edit preview first, then apply one import batch after approval. Do not make any other edits. Reply briefly in English.' },
  { id: 'cleanup-reviewed', locale: 'zh-CN', review: true, tool: 'cleanup_molecule_2d',
    instruction: '仅使用真实的本地二维清理计算，整理当前完整分子的二维排版，保留全部原子、化学键、化学属性、标题和来源记录。先显示修改前后预览，确认后只提交一次清理批次。不要导入、换模板、改变元素或重建分子。' },
];
let browser;
try {
  const saved = await fetch(base + '/api/ai/config', { method: 'POST', headers: {
    'content-type': 'application/json', 'x-molecule-ai': '1', origin: base,
  }, body: JSON.stringify({ protocol: 'chat-completions', baseUrl: report.modelEndpoint, model: report.model, enableThinking: false }) });
  assert.equal(saved.ok, true, 'Unable to configure the isolated gateway');
  const config = await saved.json(); assert.equal(config.hasApiKey, false); assert.equal(config.enableThinking, false);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('response', response => { if (response.url().includes('/rdkit-')) report.assets.push({ path: new URL(response.url()).pathname, status: response.status(), type: response.headers()['content-type'] }); });
  await page.goto(base + '/test-files/index.html');
  await page.setContent('<!doctype html><html><head><meta charset="utf-8"><title>Real Qwen chemistry validation</title></head><body style="margin:16px;font-family:Segoe UI,sans-serif"><h1 style="font-size:20px">Real Qwen + RDKit chemistry validation</h1><div id="editor"></div><pre id="proof" style="white-space:pre-wrap;font-size:12px"></pre></body></html>');
  for (const entry of cases) {
    const started = Date.now(); console.log(`Testing real ${report.model} and RDKit: ${entry.id}`);
    try {
      const result = await page.evaluate(async entry => {
        const sdk = await import('/chemical-editor.js');
        const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
          : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
        const equal = (left, right) => canonical(left) === canonical(right);
        window.aiChemistryIntegrationEditor?.destroy();
        const document = sdk.exampleDocument('ethanol'); document.title = 'AI chemistry validation';
        const ids = Object.keys(document.graph.atoms);
        document.depiction.positions[ids[0]] = { x: 0, y: 0 }; document.depiction.positions[ids[1]] = { x: 5, y: 2 }; document.depiction.positions[ids[2]] = { x: 5, y: 8 };
        const sentinel = 'PRIVATE_CHEMISTRY_SOURCE_NOT_FOR_MODEL';
        document.source = { format: 'mrv', raw: sentinel, fingerprint: '', issues: [] };
        const api = sdk.createChemicalEditor({ container: window.document.querySelector('#editor'), document, locale: entry.locale });
        window.aiChemistryIntegrationEditor = api; api.setSelection({ atomIds: [] });
        const before = api.getSnapshot(), client = sdk.createAiClient('/api/ai'), requests = [], events = [], proposals = [];
        const transport = { complete: async (request, signal) => {
          if (JSON.stringify(request).includes(sentinel)) throw Error('The original source entered a model request');
          const turn = await client.transport.complete(request, signal);
          requests.push({ round: requests.length + 1, messageCount: request.messages.length, text: turn.text, toolCalls: turn.toolCalls }); return turn;
        } };
        const reviewEdits = entry.review ? async proposal => {
          const unchanged = equal(api.getDocument(), before.document) && api.getSnapshot().revision === before.revision;
          const sourceFree = !JSON.stringify(proposal).includes(sentinel) && !Object.hasOwn(proposal.before, 'source') && !Object.hasOwn(proposal.after, 'source');
          proposals.push({ tool: proposal.tool, expectedRevision: proposal.expectedRevision, title: proposal.title,
            summary: proposal.summary, totalChanges: proposal.totalChanges, changes: proposal.changes, unchangedBeforeApproval: unchanged, sourceFree, accepted: proposal.tool === entry.tool });
          if (!unchanged || !sourceFree) throw Error('Unsafe edit proposal');
          // The test user approves only the explicitly requested operation.
          return proposal.tool === entry.tool;
        } : undefined;
        const run = await sdk.runAiAssistant(api, transport, { message: entry.instruction, locale: entry.locale, allowEdits: !entry.readonly,
          reviewEdits, signal: AbortSignal.timeout(240000), onEvent: event => { if (event.type !== 'artifact') events.push(structuredClone(event)); } });
        const after = api.getSnapshot(), responses = run.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
        const successfulTools = events.filter(event => event.type === 'tool-end' && event.ok).map(event => event.name);
        const responseAnalysis = responses.map(response => response.result?.analysis).find(analysis => analysis?.engine === 'RDKit');
        const eventAnalysis = events.find(event => event.type === 'chemistry-analysis')?.analysis;
        const checks = {
          actualRequestedTool: successfulTools.includes(entry.tool), modelCompleted: run.completed === true,
          sourceExcludedFromRequests: true, previewsSourceFree: proposals.every(proposal => proposal.sourceFree),
          unchangedUntilApproval: proposals.every(proposal => proposal.unchangedBeforeApproval),
          expectedPreview: !entry.review || proposals.length === 1 && proposals[0].tool === entry.tool && proposals[0].accepted,
          expectedRevision: after.revision === before.revision + (entry.readonly ? 0 : 1), oneStepUndo: true,
        };
        let chemistry;
        if (entry.id === 'readonly-properties') {
          chemistry = responseAnalysis;
          checks.analysisReturned = !!chemistry;
          checks.analysisEventMatchesTool = !!eventAnalysis && equal(eventAnalysis, chemistry);
          checks.accurateMolecularWeight = !!chemistry && Math.abs(chemistry.molecularWeight - 46.069) < .05;
          checks.accurateFormulaAndSmiles = chemistry?.formula === 'C2H6O' && chemistry?.smiles === 'CCO';
          checks.documentAndSelectionUnchanged = equal(after, before);
        } else {
          const engine = await sdk.loadChemistryEngine(); chemistry = engine.analyze(after.document);
          if (entry.id === 'stereo-smiles-reviewed') {
            const expected = engine.analyze(engine.importSmiles('N[C@@H](C)C(=O)O', 'Provided SMILES'));
            checks.exactSmilesChemistry = chemistry.smiles === expected.smiles && chemistry.formula === 'C3H7NO2';
            checks.specifiedStereochemistry = Object.values(chemistry.stereoAtoms).filter(label => label === 'S').length === 1;
            checks.requestedTitle = after.document.title === 'Provided SMILES';
          } else {
            checks.graphUnchanged = equal(after.document.graph, before.document.graph);
            checks.sourceUnchanged = equal(after.document.source, before.document.source);
            checks.titleUnchanged = after.document.title === before.document.title;
            checks.coordinatesActuallyCleaned = !equal(after.document.depiction.positions, before.document.depiction.positions);
            checks.chemicalIdentityUnchanged = chemistry.smiles === engine.analyze(before.document).smiles;
          }
          api.undo(); checks.oneStepUndo = equal(api.getDocument(), before.document);
        }
        window.document.querySelector('#proof').textContent = JSON.stringify({ scenario: entry.id, reply: run.text, chemistry, checks }, null, 2);
        return { id: entry.id, locale: entry.locale, instruction: entry.instruction, beforeRevision: before.revision, afterRevision: after.revision,
          text: run.text, completed: run.completed, toolCount: run.toolCount, rounds: requests.length, requests, events, proposals, toolResults: responses, chemistry, checks };
      }, entry);
      result.durationMs = Date.now() - started; report.results.push(result);
      await page.screenshot({ path: `${output}/model-${entry.id}.png` });
      for (const [name, passed] of Object.entries(result.checks)) assert.equal(passed, true, `${entry.id}: ${name} failed`);
      assert.ok(result.toolCount > 0, 'Model prose alone does not prove a calculation');
      console.log(`Verified ${entry.id}: ${result.rounds} model rounds / ${result.toolCount} real tool calls`);
    } catch (error) {
      report.failures.push({ id: entry.id, error: error.message, stack: error.stack, durationMs: Date.now() - started });
      await page.screenshot({ path: `${output}/model-${entry.id}-failure.png` }).catch(() => {});
      console.error(`Failed ${entry.id}: ${error.message}`);
    }
    await writeFile(`${output}/model-results.json`, JSON.stringify(report, null, 2) + '\n');
  }
  assert.deepEqual(report.pageErrors, [], 'Browser errors occurred');
  assert.ok(report.assets.some(asset => asset.path.endsWith('.wasm') && asset.status === 200 && asset.type === 'application/wasm'), 'The built SDK did not load its real local RDKit WASM');
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  report.finishedAt = new Date().toISOString(); await writeFile(`${output}/model-results.json`, JSON.stringify(report, null, 2) + '\n');
}
assert.deepEqual(report.failures, [], `${report.failures.length} real Qwen chemistry scenario(s) failed`);
