import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createAppServer } from '../server/start.mjs';

// This server owns its AI configuration. It never reads or writes the running
// development gateway, and test prompts use only self-generated molecules.
const { chromium } = await import(process.argv[2] || 'playwright');
const output = '.local/ai-upgrade';
await mkdir(output, { recursive: true });
const server = createAppServer({ dist: 'dist-sdk', ai: { env: {
  AI_PROTOCOL: 'chat-completions', AI_BASE_URL: 'http://127.0.0.1:8000/v1', AI_MODEL: 'qwen3.6-27b',
}, timeoutMs: 180000 } });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const base = `http://127.0.0.1:${server.address().port}`;
const asset = await stat('dist-sdk/chemical-editor.js');
const report = { model: 'qwen3.6-27b', modelEndpoint: 'http://127.0.0.1:8000/v1',
  isolatedGateway: true, developmentGatewayModified: false, enableThinking: false,
  sdkBuiltAt: asset.mtime.toISOString(), sdkBytes: asset.size, startedAt: new Date().toISOString(), results: [], failures: [], pageErrors: [] };
let browser;
const cases = [
  { id: 'oxygen18-direct', locale: 'zh-CN', instruction: '只把当前选中的氧原子标记为氧-18，保持所有其他原子、键、坐标和属性不变。通过编辑工具完成，并简短说明结果。不要更换文档，不要删除或新建原子，用一次编辑批次提交。' },
  { id: 'query-review-approved', locale: 'zh-CN', review: 'approve', instruction: '只为当前选中的碳原子增加“非氢取代数最多为 3”查询条件，保留原有环键数量条件和全部其他化学信息。不要改变元素，不要更换文档，用一次编辑批次提交。先给出修改预览，等应用后再确认结果。' },
  { id: 'english-review-rejected', locale: 'en', review: 'reject', instruction: 'Change only the currently selected carbon atom to nitrogen. Keep all other atoms, bonds, coordinates and properties unchanged. Show an edit preview before applying it. Do not import or replace the document.' },
  { id: 'readonly-check', locale: 'zh-CN', readonly: true, instruction: '读取当前实际分子结构和基础诊断，简洁说明结果。此任务只读，不修改结构、选区或视图；请调用读取或检查工具获取实际数据，不能仅凭文本声称已经检查。' },
];
try {
  const saved = await fetch(base + '/api/ai/config', { method: 'POST', headers: {
    'content-type': 'application/json', 'x-molecule-ai': '1', origin: base,
  }, body: JSON.stringify({ protocol: 'chat-completions', baseUrl: report.modelEndpoint, model: report.model, enableThinking: false }) });
  assert.equal(saved.ok, true, 'Isolated gateway configuration failed');
  const config = await saved.json(); assert.equal(config.enableThinking, false); assert.equal(config.hasApiKey, false);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.setDefaultTimeout(15000);
  await page.goto(base + '/test-files/index.html');
  await page.setContent('<!doctype html><html><head><meta charset="utf-8"><title>Qwen 3.6 SDK validation</title></head><body style="margin:16px;font-family:Segoe UI,sans-serif"><h1 style="font-size:20px">Qwen 3.6 SDK integration validation</h1><div id="editor"></div></body></html>');
  const pageErrors = report.pageErrors; page.on('pageerror', error => pageErrors.push(error.message));
  for (const entry of cases) {
    console.log(`Testing real ${report.model}: ${entry.id}`);
    const started = Date.now();
    try {
      const result = await page.evaluate(async entry => {
        const sdk = await import('/chemical-editor.js');
        const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key)+':'+canonical(value[key])).join(',') + '}' : JSON.stringify(value);
        const equal = (left,right) => canonical(left) === canonical(right);
        window.integrationEditor?.destroy();
        const document = sdk.exampleDocument('ethanol'); document.title = 'Qwen SDK validation';
        const secret = 'PRIVATE_SOURCE_NOT_FOR_MODEL';
        document.source = { format: 'mrv', raw: secret, fingerprint: '', issues: [] };
        const atomIds = Object.keys(document.graph.atoms), oxygen = atomIds.find(id => document.graph.atoms[id].element === 'O'), carbon = atomIds.find(id => document.graph.atoms[id].element === 'C');
        if (entry.id === 'query-review-approved') document.graph.atoms[carbon].queryConstraints = { ringBondCount: 'NoRingBonds' };
        const editor = sdk.createChemicalEditor({ container: window.document.querySelector('#editor'), document, locale: entry.locale });
        window.integrationEditor = editor;
        const target = entry.id === 'oxygen18-direct' ? oxygen : carbon;
        editor.setSelection({ atomIds: [target] });
        const before = editor.getSnapshot(), client = sdk.createAiClient('/api/ai');
        const requests = [], events = [], proposals = [];
        const transport = { complete: async (request, signal) => {
          if (JSON.stringify(request).includes(secret)) throw Error('Original source leaked into a model request');
          const turn = await client.transport.complete(request, signal);
          requests.push({ round: requests.length + 1, messageCount: request.messages.length, text: turn.text, toolCalls: turn.toolCalls });
          return turn;
        } };
        const reviewEdits = entry.review ? async proposal => {
          const unchangedBeforeApproval = editor.getSnapshot().revision === before.revision && equal(editor.getDocument(),before.document);
          const sourceFree = !JSON.stringify(proposal).includes(secret) && !Object.hasOwn(proposal.before, 'source') && !Object.hasOwn(proposal.after, 'source');
          proposals.push({ id: proposal.id, expectedRevision: proposal.expectedRevision, title: proposal.title, tool: proposal.tool,
            summary: proposal.summary, totalChanges: proposal.totalChanges, changes: proposal.changes,
            targetAfter: proposal.after.graph.atoms[target], unchangedBeforeApproval, sourceFree, approved: entry.review === 'approve' });
          if (!unchangedBeforeApproval) throw Error('The editor changed before preview approval');
          if (!sourceFree) throw Error('Preview contains original source records');
          return entry.review === 'approve';
        } : undefined;
        const result = await sdk.runAiAssistant(editor, transport, { message: entry.instruction, locale: entry.locale,
          allowEdits: !entry.readonly, reviewEdits, signal: AbortSignal.timeout(240000), onEvent: event => {
            if (event.type !== 'artifact') events.push(event);
          } });
        const after = editor.getSnapshot();
        const expected = structuredClone(before.document);
        if (entry.id === 'oxygen18-direct') expected.graph.atoms[target].isotope = 18;
        if (entry.id === 'query-review-approved') expected.graph.atoms[target].queryConstraints = { ...expected.graph.atoms[target].queryConstraints, substituentsUpTo: 3 };
        const checks = { exactExpectedDocument: equal(after.document,expected),
          sourcePreserved: after.document.source?.raw === secret,
          expectedRevision: entry.readonly || entry.review === 'reject' ? after.revision === before.revision : after.revision === before.revision + 1,
          reviewInvoked: !entry.review || proposals.length > 0,
          previewsSourceFree: proposals.every(proposal => proposal.sourceFree),
          unchangedUntilReview: proposals.every(proposal => proposal.unchangedBeforeApproval),
          rejectedFlag: entry.review !== 'reject' || result.rejected === true,
          rejectedPreviewMatchesRequest: entry.review !== 'reject' || proposals.some(proposal => proposal.targetAfter.element === 'N' && proposal.changes.length === 1 && proposal.changes[0].kind === 'atom' && proposal.changes[0].id === target && proposal.changes[0].fields.every(field => field === 'element')),
          readonlyUsedActualTool: !entry.readonly || events.some(event => event.type === 'tool-end' && event.ok && ['read_structure','check_structure','read_selection'].includes(event.name)),
          oneStepUndo: true };
        if (!entry.readonly && entry.review !== 'reject') {
          editor.undo(); checks.oneStepUndo = equal(editor.getDocument(),before.document);
        }
        return { id: entry.id, locale: entry.locale, instruction: entry.instruction, target,
          beforeRevision: before.revision, afterRevision: after.revision, completed: result.completed, rejected: result.rejected ?? false,
          text: result.text, toolCount: result.toolCount, rounds: requests.length, requests, events, proposals,
          toolResults: result.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content)), checks };
      }, entry);
      result.durationMs = Date.now() - started;
      report.results.push(result);
      await page.screenshot({ path: `${output}/${entry.id}.png` });
      for (const [check, passed] of Object.entries(result.checks)) assert.equal(passed, true, `${entry.id}: ${check} failed`);
      if (entry.review !== 'reject') assert.equal(result.completed, true, `${entry.id}: model hit the execution limit`);
      assert.ok(result.toolCount > 0, 'A model text claim is not evidence of an editor action');
      console.log(`Verified ${entry.id}: ${result.rounds} model rounds / ${result.toolCount} real tool calls`);
    } catch (error) {
      report.failures.push({ id: entry.id, error: error.message, stack: error.stack, durationMs: Date.now() - started });
      await page.screenshot({ path: `${output}/${entry.id}-failure.png` }).catch(() => {});
      console.error(`Failed ${entry.id}: ${error.message}`);
    }
    await writeFile(`${output}/model-integration-results.json`, JSON.stringify({ ...report, pageErrors }, null, 2) + '\n');
  }
  assert.deepEqual(pageErrors, [], 'Browser errors occurred during real model validation');
} finally {
  await browser?.close(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  report.finishedAt = new Date().toISOString();
  await writeFile(`${output}/model-integration-results.json`, JSON.stringify(report, null, 2) + '\n');
}
assert.deepEqual(report.failures, [], `${report.failures.length} real-model SDK scenario(s) failed`);
