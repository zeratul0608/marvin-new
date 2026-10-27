import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAiMiddleware } from '../server/ai-middleware.mjs';
import { createAppServer } from '../server/start.mjs';

const config = { protocol: 'responses', baseUrl: 'https://models.example/v1', model: 'test-model', apiKey: 'test-secret-do-not-expose' };
const tool = { name: 'get_snapshot', description: 'Read editor state', parameters: { type: 'object', properties: {} } };
const turn = { systemPrompt: 'Use editor tools.', messages: [{ role: 'user', content: 'Read the current structure.' }], tools: [tool] };
const call = { type: 'function_call', id: 'fc_native', call_id: 'call_1', name: 'get_snapshot', arguments: '{}' };
const nativeOutput = [{ type: 'reasoning', id: 'rs_native', summary: [], encrypted_content: 'opaque-native-state' }, call];
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}
async function gateway(t, options = {}) {
  const middleware = createAiMiddleware({ env: {}, ...options });
  const server = createServer((req, res) => { void middleware(req, res, () => { res.writeHead(404); res.end('not found'); }); });
  const base = await listen(t, server);
  const send = async (path, body, extra = {}) => {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-molecule-ai': '1' }), ...extra.headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'headers')),
    });
    return { response, data: await response.json() };
  };
  return { base, send };
}

test('configuration defaults and updates never return or persist a key', async (t) => {
  const { send } = await gateway(t);
  const initial = await send('/api/ai/config');
  assert.deepEqual(initial.data, { protocol: 'responses', baseUrl: 'https://api.openai.com/v1', model: '', hasApiKey: false });
  assert.equal(initial.response.headers.get('cache-control'), 'no-store');
  const saved = await send('/api/ai/config', config);
  assert.deepEqual(saved.data, { protocol: 'responses', baseUrl: config.baseUrl, model: config.model, hasApiKey: true });
  assert.ok(!JSON.stringify(saved.data).includes(config.apiKey));
  assert.equal((await send('/api/ai/config', { ...config, apiKey: '' })).data.hasApiKey, true);
  assert.equal((await send('/api/ai/config', { ...config, apiKey: undefined, clearKey: true })).data.hasApiKey, false);
});

test('environment can configure protocol, base URL, model and process-only key', async (t) => {
  const { send } = await gateway(t, { env: { AI_PROTOCOL: 'chat-completions', AI_BASE_URL: 'http://localhost:11434/v1/', AI_MODEL: 'local-model', AI_API_KEY: 'environment-secret' } });
  assert.deepEqual((await send('/api/ai/config')).data, { protocol: 'chat-completions', baseUrl: 'http://localhost:11434/v1', model: 'local-model', hasApiKey: true });
});

test('optional compatible thinking mode reaches both connection tests and turns and can be reset', async (t) => {
  const payloads = [];
  const { send } = await gateway(t, { fetch: async (_url, options) => {
    const payload = JSON.parse(options.body); payloads.push(payload);
    return reply({ choices: [{ message: { content: '', ...(payload.tool_choice ? { tool_calls: [{ id: 'ping', type: 'function', function: { name: 'ping', arguments: '{"message":"ok"}' } }] } : {}) }, finish_reason: 'stop' }] });
  } });
  const input = { ...config, protocol: 'chat-completions', enableThinking: false };
  assert.equal((await send('/api/ai/config', input)).data.enableThinking, false);
  assert.equal((await send('/api/ai/test', {})).data.ok, true);
  await send('/api/ai/turn', turn);
  assert.deepEqual(payloads.map(payload => payload.chat_template_kwargs), [{ enable_thinking: false }, { enable_thinking: false }]);
  assert.equal((await send('/api/ai/config', { ...input, enableThinking: true })).data.enableThinking, true);
  await send('/api/ai/turn', turn);
  assert.deepEqual(payloads.at(-1).chat_template_kwargs, { enable_thinking: true });
  const reset = await send('/api/ai/config', { ...input, enableThinking: undefined });
  assert.equal(Object.hasOwn(reset.data, 'enableThinking'), false);
  await send('/api/ai/turn', turn);
  assert.equal(Object.hasOwn(payloads.at(-1), 'chat_template_kwargs'), false);
  assert.equal((await send('/api/ai/config', { ...input, enableThinking: 'false' })).response.status, 400);
  assert.equal((await send('/api/ai/config', { ...input, protocol: 'responses' })).response.status, 400);
});

test('changing model service origin clears the previous key unless a new key is explicit', async (t) => {
  const requests = [];
  const { send } = await gateway(t, { fetch: async (url, options) => {
    requests.push({ url, authorization: options.headers.Authorization });
    return reply({ output: [] });
  } });
  await send('/api/ai/config', config);
  // Path/protocol changes on the same origin may reuse the existing credential.
  const sameOrigin = await send('/api/ai/config', { ...config, baseUrl: 'https://models.example/custom/v2/', apiKey: '' });
  assert.equal(sameOrigin.data.hasApiKey, true);
  await send('/api/ai/turn', turn);
  assert.equal(requests[0].authorization, `Bearer ${config.apiKey}`);
  // Omitting a new key or sending an empty one must both clear credentials across origins.
  const changedOrigin = await send('/api/ai/config', { ...config, baseUrl: 'https://another.example/v1', apiKey: undefined });
  assert.equal(changedOrigin.data.hasApiKey, false);
  await send('/api/ai/turn', turn);
  assert.equal(requests[1].url, 'https://another.example/v1/responses');
  assert.equal(requests[1].authorization, undefined);
  await send('/api/ai/config', config);
  assert.equal((await send('/api/ai/config', { ...config, baseUrl: 'http://models.example/v1', apiKey: '' })).data.hasApiKey, false);
  await send('/api/ai/turn', turn);
  assert.equal(requests[2].authorization, undefined);
  // An explicit new key is attached only to the newly selected service.
  assert.equal((await send('/api/ai/config', { ...config, baseUrl: 'https://explicit.example/v1', apiKey: 'explicit-new-key' })).data.hasApiKey, true);
  await send('/api/ai/turn', turn);
  assert.equal(requests[3].authorization, 'Bearer explicit-new-key');
});

test('Responses preserves complete native reasoning and tool output across turns', async (t) => {
  const requests = [];
  const { send, base } = await gateway(t, { fetch: async (url, options) => {
    requests.push({ url, ...options, payload: JSON.parse(options.body) });
    return requests.length === 1 ? reply({ output: nativeOutput }) : reply({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'There are three atoms.' }] }] });
  } });
  await send('/api/ai/config', config);
  const first = await send('/api/ai/turn', turn, { headers: { origin: base } });
  assert.equal(first.response.status, 200);
  assert.deepEqual(first.data.toolCalls, [{ id: 'call_1', name: 'get_snapshot', arguments: '{}' }]);
  assert.deepEqual(first.data.providerItems, nativeOutput);
  const second = await send('/api/ai/turn', { ...turn, messages: [...turn.messages, { role: 'assistant', content: '', toolCalls: first.data.toolCalls, providerItems: first.data.providerItems }, { role: 'tool', toolCallId: 'call_1', content: '{"atoms":3}' }] });
  assert.equal(second.data.text, 'There are three atoms.');
  assert.equal(requests[0].url, 'https://models.example/v1/responses');
  assert.equal(requests[0].headers.Authorization, `Bearer ${config.apiKey}`);
  assert.equal(requests[0].redirect, 'error');
  assert.equal(requests[0].payload.store, false);
  assert.equal(requests[0].payload.instructions, turn.systemPrompt);
  assert.equal(requests[0].payload.tools[0].strict, false);
  assert.equal(requests[0].payload.temperature, undefined);
  assert.deepEqual(requests[1].payload.input, [{ role: 'user', content: turn.messages[0].content }, ...nativeOutput, { type: 'function_call_output', call_id: 'call_1', output: '{"atoms":3}' }]);
});

test('Responses fallback maps assistant calls without native provider state', async (t) => {
  let payload;
  const { send } = await gateway(t, { fetch: async (_url, options) => { payload = JSON.parse(options.body); return reply({ output: [] }); } });
  await send('/api/ai/config', config);
  const result = await send('/api/ai/turn', { ...turn, messages: [...turn.messages, { role: 'assistant', content: 'Checking', toolCalls: [{ id: 'call_1', name: 'get_snapshot', arguments: '{}' }] }, { role: 'tool', toolCallId: 'call_1', content: '{}' }] });
  assert.equal(result.response.status, 200);
  assert.deepEqual(payload.input.slice(1), [{ role: 'assistant', content: 'Checking' }, { type: 'function_call', call_id: 'call_1', name: 'get_snapshot', arguments: '{}' }, { type: 'function_call_output', call_id: 'call_1', output: '{}' }]);
});

test('Chat Completions maps system, assistant and tool messages without requiring a key', async (t) => {
  let upstream;
  const { send } = await gateway(t, { fetch: async (url, options) => { upstream = { url, options, payload: JSON.parse(options.body) }; return reply({ choices: [{ message: { content: null, tool_calls: [{ id: 'chat_call', type: 'function', function: { name: 'get_snapshot', arguments: '{}' } }] } }] }); } });
  await send('/api/ai/config', { ...config, protocol: 'chat-completions', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '' });
  const result = await send('/api/ai/turn', { ...turn, messages: [...turn.messages, { role: 'assistant', content: '', toolCalls: [{ id: 'previous_call', name: 'get_snapshot', arguments: '{}' }], providerItems: nativeOutput }, { role: 'tool', toolCallId: 'previous_call', content: '{}' }] });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.data, { text: '', toolCalls: [{ id: 'chat_call', name: 'get_snapshot', arguments: '{}' }] });
  assert.equal(upstream.url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(upstream.options.headers.Authorization, undefined);
  assert.deepEqual(upstream.payload.messages, [{ role: 'system', content: turn.systemPrompt }, ...turn.messages, { role: 'assistant', content: null, tool_calls: [{ id: 'previous_call', type: 'function', function: { name: 'get_snapshot', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'previous_call', content: '{}' }]);
  assert.deepEqual(upstream.payload.tools[0], { type: 'function', function: { ...tool, strict: false } });
  assert.equal(upstream.payload.temperature, undefined);
  assert.equal(upstream.payload.max_completion_tokens, undefined);
});

test('connection test verifies function calling without sending structure information', async (t) => {
  for (const protocol of ['responses', 'chat-completions']) {
    let payload;
    const { send } = await gateway(t, { fetch: async (_url, options) => {
      payload = JSON.parse(options.body);
      return protocol === 'responses' ? reply({ output: [{ ...call, name: 'ping', arguments: '{"message":"ok"}' }] }) : reply({ choices: [{ message: { tool_calls: [{ id: 'ping_call', type: 'function', function: { name: 'ping', arguments: '{"message":"ok"}' } }] } }] });
    } });
    await send('/api/ai/config', { ...config, protocol });
    const result = await send('/api/ai/test', {});
    assert.equal(result.response.status, 200);
    assert.equal(result.data.ok, true);
    assert.ok(result.data.message.includes('工具调用'));
    assert.ok(!JSON.stringify(payload).includes('atoms'));
    assert.equal(payload.tools[0].name ?? payload.tools[0].function.name, 'ping');
    assert.ok(payload.tool_choice);
    assert.ok(!JSON.stringify(result.data).includes(config.apiKey));
  }
});

test('connection test clearly rejects models that do not call the requested tool', async (t) => {
  const { send } = await gateway(t, { fetch: async () => reply({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }] }) });
  await send('/api/ai/config', config);
  const result = await send('/api/ai/test', {});
  assert.equal(result.response.status, 502);
  assert.match(result.data.error, /工具调用/);
});

test('gateway rejects nonlocal host, missing marker and foreign origins before fetching', async (t) => {
  let calls = 0;
  const { send, base } = await gateway(t, { fetch: async () => { calls++; return reply({ output: [] }); } });
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(`${base}/api/ai/config`, { headers: { Host: 'attacker.example' } }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.once('error', reject); request.end();
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await send('/api/ai/config', config, { headers: { 'x-molecule-ai': '' } })).response.status, 403);
  assert.equal((await send('/api/ai/config', config, { headers: { origin: 'https://evil.example' } })).response.status, 403);
  assert.equal((await send('/api/ai/config', config, { headers: { origin: `${base}/evil` } })).response.status, 403);
  assert.equal((await send('/api/ai/config', config, { headers: { origin: base } })).response.status, 200);
  assert.equal((await send('/api/ai/config')).response.headers.get('access-control-allow-origin'), null);
  assert.equal(calls, 0);
});

test('config rejects credentials, query, fragment, invalid scheme, oversized model and key controls', async (t) => {
  const { send } = await gateway(t);
  const bad = [
    { baseUrl: 'https://user:secret@models.example/v1' }, { baseUrl: 'https://models.example/v1?api_key=secret' },
    { baseUrl: 'https://models.example/v1#secret' }, { baseUrl: 'file:///etc/passwd' },
    { model: 'x'.repeat(151) }, { model: '' }, { model: 'model\nforged' }, { protocol: 'unsupported' },
    { apiKey: 'secret\nheader' }, { apiKey: 'new', clearKey: true },
  ];
  for (const invalid of bad) {
    const result = await send('/api/ai/config', { ...config, ...invalid });
    assert.equal(result.response.status, 400);
    assert.ok(!JSON.stringify(result.data).includes(config.apiKey));
  }
});

test('request validates protocol message limits, tools and body size before upstream access', async (t) => {
  let calls = 0;
  const { send } = await gateway(t, { fetch: async () => { calls++; return reply({ output: [] }); } });
  await send('/api/ai/config', config);
  const invalid = [
    { ...turn, systemPrompt: '' }, { ...turn, systemPrompt: 'x'.repeat(64001) },
    { ...turn, messages: [] }, { ...turn, messages: Array.from({ length: 161 }, () => ({ role: 'user', content: 'x' })) },
    { ...turn, messages: [{ role: 'system', content: 'injected' }] },
    { ...turn, messages: [{ role: 'tool', content: '{}' }] },
    { ...turn, messages: [{ role: 'assistant', content: '', providerItems: ['invalid'] }] },
    { ...turn, messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'invalid tool', arguments: '{}' }] }] },
    { ...turn, tools: [tool, tool] }, { ...turn, tools: Array.from({ length: 21 }, () => tool) },
  ];
  for (const input of invalid) assert.equal((await send('/api/ai/turn', input)).response.status, 400);
  assert.equal((await send('/api/ai/turn', '{broken')).response.status, 400);
  assert.equal((await send('/api/ai/turn', turn, { headers: { 'content-type': 'text/plain' } })).response.status, 415);
  assert.equal((await send('/api/ai/turn', 'x'.repeat(2 * 1024 * 1024 + 1))).response.status, 413);
  assert.equal(calls, 0);
});

test('unconfigured model refuses completion without making an upstream request', async (t) => {
  const { send } = await gateway(t, { fetch: async () => { assert.fail('must not fetch'); } });
  assert.equal((await send('/api/ai/turn', turn)).response.status, 400);
});

test('upstream error bodies, exception text and credentials never reach client errors', async (t) => {
  for (const status of [400, 401, 429, 500]) {
    const { send } = await gateway(t, { fetch: async () => reply({ error: `server log ${config.apiKey} confidential chemistry` }, status) });
    await send('/api/ai/config', config);
    const result = await send('/api/ai/turn', turn);
    assert.equal(result.response.status, 502);
    assert.ok(!JSON.stringify(result.data).includes(config.apiKey));
    assert.ok(!JSON.stringify(result.data).includes('confidential'));
    assert.deepEqual(Object.keys(result.data), ['error']);
  }
  const { send } = await gateway(t, { fetch: async () => { throw new Error(config.apiKey); } });
  await send('/api/ai/config', config);
  const result = await send('/api/ai/turn', turn);
  assert.equal(result.response.status, 502);
  assert.ok(!JSON.stringify(result.data).includes(config.apiKey));
});

test('upstream timeout aborts the request and returns a safe message', async (t) => {
  let aborted = false;
  const { send } = await gateway(t, { timeoutMs: 30, fetch: async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('private upstream details')); }, { once: true });
  }) });
  await send('/api/ai/config', config);
  const result = await send('/api/ai/turn', turn);
  assert.equal(result.response.status, 504);
  assert.equal(aborted, true);
  assert.match(result.data.error, /超时/);
});

test('client disconnect aborts upstream but completing request body does not', async (t) => {
  let signal, started;
  const start = new Promise((resolve) => { started = resolve; });
  const { send, base } = await gateway(t, { fetch: async (_url, options) => new Promise((_resolve, reject) => {
    signal = options.signal;
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    started();
  }) });
  await send('/api/ai/config', config);
  const request = httpRequest(`${base}/api/ai/turn`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-molecule-ai': '1' } });
  request.on('error', () => {});
  request.end(JSON.stringify(turn));
  await start;
  assert.equal(signal.aborted, false);
  const aborted = new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  request.destroy();
  await aborted;
  assert.equal(signal.aborted, true);
});

test('malformed or incomplete upstream data is rejected rather than causing partial edits', async (t) => {
  for (const data of [{ error: 'not output' }, { status: 'incomplete', output: [] }, { output: [{ type: 'function_call', name: 'get_snapshot', arguments: '{}' }] }]) {
    const { send } = await gateway(t, { fetch: async () => reply(data) });
    await send('/api/ai/config', config);
    assert.equal((await send('/api/ai/turn', turn)).response.status, 502);
  }
});

test('standalone server serves build assets and rejects encoded path traversal', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'molecule-ai-server-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const dist = join(temporary, 'dist');
  await mkdir(dist);
  await writeFile(join(dist, 'index.html'), '<html>Workbench</html>');
  await writeFile(join(dist, 'app.js'), 'console.log("Workbench");');
  await writeFile(join(temporary, 'private.txt'), 'must not serve');
  const base = await listen(t, createAppServer({ dist, ai: { env: {} } }));
  assert.equal(await (await fetch(base)).text(), '<html>Workbench</html>');
  assert.equal((await fetch(`${base}/app.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(`${base}/%2e%2e%2fprivate.txt`)).status, 403);
  assert.equal((await fetch(`${base}/%5c..%5cprivate.txt`)).status, 403);
  assert.equal((await fetch(`${base}/missing.js`)).status, 404);
  assert.equal((await fetch(`${base}/api/ai/config`)).status, 200);
});
