import type { AiCompletionRequest, AiConfigInput, AiModelConfig, AiTransport, AiTurn } from './types';

/** Same-origin gateway client. Keys are sent only when explicitly saving settings. */
export function createAiClient(endpoint = '/api/ai') {
  const base = endpoint.replace(/\/$/, '');
  async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${base}/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'x-molecule-ai': '1' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
      credentials: 'same-origin',
      cache: 'no-store',
    });
    let data: unknown;
    try { data = await response.json(); }
    catch { throw new Error('AI 本地服务未返回有效数据。请使用 npm run dev，或构建后运行 npm start。'); }
    if (!response.ok) {
      const error = data as { error?: unknown; message?: unknown };
      throw new Error(typeof error.error === 'string' ? error.error : typeof error.message === 'string' ? error.message : `AI 服务请求失败（${response.status}）`);
    }
    return data as T;
  }
  const transport: AiTransport = {
    complete: (input: AiCompletionRequest, signal?: AbortSignal) => request<AiTurn>('turn', input, signal),
  };
  return {
    getConfig: (signal?: AbortSignal) => request<AiModelConfig>('config', undefined, signal),
    saveConfig: (config: AiConfigInput, signal?: AbortSignal) => request<AiModelConfig>('config', config, signal),
    test: (signal?: AbortSignal) => request<{ ok: boolean; message: string }>('test', {}, signal),
    transport,
  };
}
