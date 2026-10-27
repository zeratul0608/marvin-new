import type { IncomingMessage, ServerResponse } from 'node:http';

export interface AiMiddlewareOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxBodyBytes?: number;
}
/** One local, single-user configuration per middleware; never exposes API keys. */
export declare function createAiMiddleware(options?: AiMiddlewareOptions): (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) => Promise<void>;
