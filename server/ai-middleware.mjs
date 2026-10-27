/** Local, single-user AI gateway. Secrets remain in this server process. */
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_UPSTREAM_BYTES = 6 * 1024 * 1024;

class GatewayError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
function check(condition, message = '请求参数无效。') {
  if (!condition) throw new GatewayError(400, message);
}
function string(value, limit, allowEmpty = false) {
  return typeof value === 'string' && value.length <= limit && (allowEmpty || value.trim().length > 0);
}
function validName(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value); }
function normalizeBaseUrl(value) {
  check(string(value, 2048), '请输入有效的模型服务地址。');
  let url;
  try { url = new URL(value); } catch { throw new GatewayError(400, '请输入有效的模型服务地址。'); }
  check(['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password && !url.search && !url.hash,
    '模型服务地址只支持 HTTP/HTTPS，不能包含凭据、查询参数或片段。');
  return url.href.replace(/\/+$/, '');
}
function validateConfig(input, previous) {
  check(isObject(input));
  check(input.protocol === 'responses' || input.protocol === 'chat-completions', '请选择支持的 API 协议。');
  check(string(input.model, 150) && !/[\r\n\x00-\x1f]/.test(input.model), '模型名称不能为空且不能超过 150 个字符。');
  check(input.apiKey === undefined || (string(input.apiKey, 8192, true) && !/[\r\n\x00-\x1f]/.test(input.apiKey)), 'API 密钥格式无效。');
  check(input.clearKey === undefined || typeof input.clearKey === 'boolean');
  check(input.enableThinking === undefined || (typeof input.enableThinking === 'boolean' && input.protocol === 'chat-completions'), '思考模式开关仅支持兼容 Chat Completions 服务。');
  check(!(input.clearKey && input.apiKey?.trim()), '清除密钥时请不要同时提供新密钥。');
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  // Retain a blank secret only within the same origin; never forward it to a new service.
  const sameOrigin = new URL(baseUrl).origin === new URL(previous.baseUrl).origin;
  return {
    protocol: input.protocol,
    baseUrl,
    model: input.model.trim(),
    apiKey: input.clearKey ? '' : (input.apiKey?.trim() || (sameOrigin ? previous.apiKey : '')),
    ...(input.enableThinking === undefined ? {} : { enableThinking: input.enableThinking }),
  };
}
function validateToolCall(call) {
  check(isObject(call) && string(call.id, 256) && validName(call.name) && string(call.arguments, 300000, true), '工具调用格式无效。');
}
function validateRequest(input) {
  check(isObject(input));
  check(string(input.systemPrompt, 64000), '系统提示词不能为空且不能超过 64000 个字符。');
  check(Array.isArray(input.messages) && input.messages.length > 0 && input.messages.length <= 160, '对话消息需要为 1–160 条。');
  for (const message of input.messages) {
    check(isObject(message) && string(message.content, 800000, true), '对话内容格式无效或过长。');
    check(['user', 'assistant', 'tool'].includes(message.role), '对话角色无效。');
    if (message.role === 'tool') check(string(message.toolCallId, 256), '缺少工具调用编号。');
    if (message.role === 'assistant') {
      check(message.toolCalls === undefined || (Array.isArray(message.toolCalls) && message.toolCalls.length <= 20), '单轮工具调用不能超过 20 个。');
      message.toolCalls?.forEach(validateToolCall);
      check(message.providerItems === undefined || (Array.isArray(message.providerItems) && message.providerItems.length <= 160 && message.providerItems.every(isObject)), '模型历史内容格式无效。');
    }
  }
  check(Array.isArray(input.tools) && input.tools.length <= 20, '工具数量不能超过 20 个。');
  const names = new Set();
  for (const tool of input.tools) {
    check(isObject(tool) && validName(tool.name) && string(tool.description, 8000, true) && isObject(tool.parameters), '工具定义格式无效。');
    check(!names.has(tool.name), '工具名称不能重复。');
    names.add(tool.name);
  }
  return input;
}
function responseInput(messages) {
  const items = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      items.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content });
    } else if (message.role === 'assistant') {
      if (message.providerItems?.length) items.push(...message.providerItems);
      else {
        if (message.content) items.push({ role: 'assistant', content: message.content });
        for (const call of message.toolCalls ?? []) items.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments });
      }
    } else items.push({ role: 'user', content: message.content });
  }
  return items;
}
function buildPayload(config, request, connectionTest) {
  if (config.protocol === 'responses') {
    return {
      model: config.model, instructions: request.systemPrompt, store: false,
      input: responseInput(request.messages), max_output_tokens: connectionTest ? 2048 : 8192,
      ...(request.tools.length ? { tools: request.tools.map((tool) => ({ type: 'function', ...tool, strict: false })) } : {}),
      ...(connectionTest ? { tool_choice: { type: 'function', name: 'ping' } } : {}),
    };
  }
  const messages = [{ role: 'system', content: request.systemPrompt }, ...request.messages.map((message) => {
    if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    if (message.role === 'assistant') return {
      role: 'assistant', content: message.content || null,
      ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {}),
    };
    return { role: 'user', content: message.content };
  })];
  return {
    model: config.model, messages,
    ...(config.enableThinking === undefined ? {} : { chat_template_kwargs: { enable_thinking: config.enableThinking } }),
    ...(request.tools.length ? { tools: request.tools.map((tool) => ({ type: 'function', function: { ...tool, strict: false } })) } : {}),
    ...(connectionTest ? { tool_choice: { type: 'function', function: { name: 'ping' } } } : {}),
  };
}
function parseTurn(protocol, data) {
  const bad = () => { throw new GatewayError(502, '模型返回的内容格式不兼容。请检查协议、模型和工具调用支持。'); };
  if (!isObject(data)) return bad();
  if (protocol === 'responses') {
    if (!Array.isArray(data.output)) return bad();
    if (data.status === 'failed' || data.status === 'incomplete') throw new GatewayError(502, '模型未完成本轮响应。请重试或更换模型。');
    const text = [], toolCalls = [];
    for (const item of data.output) {
      if (!isObject(item)) return bad();
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const content of item.content) {
          if (content.type === 'output_text' && typeof content.text === 'string') text.push(content.text);
          if (content.type === 'refusal' && typeof content.refusal === 'string') text.push(content.refusal);
        }
      } else if (item.type === 'function_call') {
        if (!string(item.call_id, 256) || !validName(item.name) || !string(item.arguments, 300000, true)) return bad();
        toolCalls.push({ id: item.call_id, name: item.name, arguments: item.arguments });
      }
    }
    if (toolCalls.length > 20) return bad();
    return { text: text.join('\n'), toolCalls, providerItems: data.output };
  }
  const choice = data.choices?.[0], message = choice?.message;
  if (!isObject(message)) return bad();
  if (choice.finish_reason === 'length') throw new GatewayError(502, '模型响应被截断。请缩小任务或提高服务端输出限制。');
  const content = message.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n') : '';
  if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) return bad();
  const toolCalls = (message.tool_calls ?? []).map((call) => {
    if (!isObject(call) || !string(call.id, 256) || !validName(call.function?.name) || !string(call.function?.arguments, 300000, true)) return bad();
    return { id: call.id, name: call.function.name, arguments: call.function.arguments };
  });
  if (toolCalls.length > 20) return bad();
  return { text: text || (typeof message.refusal === 'string' ? message.refusal : ''), toolCalls };
}

function localHost(host) {
  if (typeof host !== 'string' || !/^(localhost|127\.0\.0\.1)(:\d{1,5})?$/i.test(host)) return false;
  try { return new URL(`http://${host}`).host.toLowerCase() === host.toLowerCase().replace(/:80$/, ''); } catch { return false; }
}
function checkRequestOrigin(req) {
  const host = req.headers.host;
  if (!localHost(host)) throw new GatewayError(403, 'AI 网关只接受本机 localhost 或 127.0.0.1 请求。');
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let url;
    try { url = new URL(origin); } catch { throw new GatewayError(403, '请求来源无效。'); }
    const expected = `${req.socket.encrypted ? 'https' : 'http'}://${host}`;
    if (url.origin !== new URL(expected).origin || origin !== url.origin) throw new GatewayError(403, 'AI 网关拒绝跨站请求。');
  }
  if (req.method !== 'GET' && req.headers['x-molecule-ai'] !== '1') throw new GatewayError(403, '缺少 AI 网关请求标记。');
}
function json(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}
function readJson(req, maxBytes) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new GatewayError(415, '请求内容必须使用 application/json。');
  if (Number(req.headers['content-length']) > maxBytes) {
    req.resume();
    throw new GatewayError(413, '请求内容超过 2 MB 限制。');
  }
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    const clean = () => { req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onAbort); };
    const onError = () => { clean(); reject(new GatewayError(400, '无法读取请求内容。')); };
    const onAbort = () => { clean(); reject(new GatewayError(400, '请求已取消。')); };
    const onData = (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) { clean(); req.resume(); reject(new GatewayError(413, '请求内容超过 2 MB 限制。')); }
      else chunks.push(chunk);
    };
    const onEnd = () => {
      clean();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new GatewayError(400, '请求内容不是有效 JSON。')); }
    };
    req.on('data', onData); req.once('end', onEnd); req.once('error', onError); req.once('aborted', onAbort);
  });
}
async function upstreamJson(response, controller) {
  if (!response.body) throw new GatewayError(502, '模型服务返回了空响应。');
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_UPSTREAM_BYTES) { controller.abort(); throw new GatewayError(502, '模型响应过大，请缩小任务。'); }
    chunks.push(Buffer.from(value));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new GatewayError(502, '模型服务未返回有效 JSON。请检查 API 协议和服务地址。'); }
}

/** @param {{env?: Record<string, string | undefined>, fetch?: typeof globalThis.fetch, timeoutMs?: number, maxBodyBytes?: number}} [options] */
export function createAiMiddleware(options = {}) {
  const env = options.env ?? process.env;
  const fetchUpstream = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 90000;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  let config = {
    protocol: env.AI_PROTOCOL || 'responses', baseUrl: normalizeBaseUrl(env.AI_BASE_URL || DEFAULT_BASE_URL),
    model: (env.AI_MODEL || '').trim(), apiKey: (env.AI_API_KEY || '').trim(),
  };
  if (!['responses', 'chat-completions'].includes(config.protocol) || config.model.length > 150 || /[\x00-\x1f]/.test(config.model) || /[\x00-\x1f]/.test(config.apiKey)) {
    throw new Error('AI 环境配置无效。请检查 AI_PROTOCOL、AI_MODEL 和 AI_API_KEY。');
  }
  const publicConfig = () => ({ protocol: config.protocol, baseUrl: config.baseUrl, model: config.model, hasApiKey: !!config.apiKey, ...(config.enableThinking === undefined ? {} : { enableThinking: config.enableThinking }) });
  return async function aiMiddleware(req, res, next) {
    const pathname = (req.url ?? '').split('?')[0];
    if (pathname !== '/api/ai' && !pathname.startsWith('/api/ai/')) { next(); return; }
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', cancel); res.once('close', cancel);
    let timer;
    try {
      checkRequestOrigin(req);
      if (!['/api/ai/config', '/api/ai/test', '/api/ai/turn'].includes(pathname)) throw new GatewayError(404, 'AI 接口不存在。');
      if (pathname === '/api/ai/config' && req.method === 'GET') { json(res, 200, publicConfig()); return; }
      if (req.method !== 'POST') throw new GatewayError(405, '该接口仅支持 POST 请求。');
      const input = await readJson(req, maxBodyBytes);
      if (pathname === '/api/ai/config') {
        config = validateConfig(input, config);
        json(res, 200, publicConfig()); return;
      }
      const current = { ...config };
      if (!current.model) throw new GatewayError(400, '请先在模型设置中填写模型名称并保存。');
      const connectionTest = pathname === '/api/ai/test';
      if (connectionTest) check(isObject(input));
      const request = connectionTest ? {
        systemPrompt: 'Connection test only. Call ping with message ok. Do not access chemical data.',
        messages: [{ role: 'user', content: 'Call ping now.' }],
        tools: [{ name: 'ping', description: 'Check tool calling connectivity.', parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false } }],
      } : validateRequest(input);
      timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetchUpstream(`${current.baseUrl}/${current.protocol === 'responses' ? 'responses' : 'chat/completions'}`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(current.apiKey ? { Authorization: `Bearer ${current.apiKey}` } : {}) },
        body: JSON.stringify(buildPayload(current, request, connectionTest)),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const status = response.status;
        if (status === 401 || status === 403) throw new GatewayError(502, '模型服务认证失败，请检查 API 密钥及模型访问权限。');
        if (status === 429) throw new GatewayError(502, '模型服务限流或额度不足，请稍后重试并检查额度。');
        throw new GatewayError(502, `模型服务请求失败（HTTP ${status}）。请检查服务地址、协议和模型；该模型需要支持工具调用。`);
      }
      const turn = parseTurn(current.protocol, await upstreamJson(response, controller));
      if (connectionTest) {
        const ping = turn.toolCalls.find((call) => call.name === 'ping');
        let args;
        try { args = ping && JSON.parse(ping.arguments); } catch { /* Report only a safe compatibility error below. */ }
        if (!isObject(args) || args.message !== 'ok') throw new GatewayError(502, '连接成功，但模型未返回有效的 ping 工具调用。请选择支持工具调用的模型并检查 API 协议。');
        json(res, 200, { ok: true, message: '连接成功，模型支持工具调用。' });
      } else json(res, 200, turn);
    } catch (error) {
      const message = error instanceof GatewayError ? error.message : controller.signal.aborted ? '模型请求已取消或超时，请重试。' : '无法连接模型服务。请检查服务地址、协议及网络连接。';
      json(res, error instanceof GatewayError ? error.status : controller.signal.aborted ? 504 : 502, { error: message });
    } finally {
      clearTimeout(timer); req.off('aborted', cancel); res.off('close', cancel);
    }
  };
}
