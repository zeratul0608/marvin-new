import type { EditorPlugin } from '../editor/api-types';

export type AiProtocol = 'responses' | 'chat-completions';
export interface AiModelConfig {
  protocol: AiProtocol;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  /** Optional extension for compatible services such as vLLM. */
  enableThinking?: boolean;
}
export interface AiConfigInput {
  protocol: AiProtocol;
  baseUrl: string;
  model: string;
  apiKey?: string;
  clearKey?: boolean;
  enableThinking?: boolean;
}
export interface AiToolCall { id: string; name: string; arguments: string }
export type AiMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: AiToolCall[]; providerItems?: unknown[] }
  | { role: 'tool'; toolCallId: string; content: string };
export interface AiToolDefinition { name: string; description: string; parameters: Record<string, unknown> }
export interface AiTurn { text: string; toolCalls: AiToolCall[]; providerItems?: unknown[] }
export interface AiCompletionRequest { systemPrompt: string; messages: AiMessage[]; tools: AiToolDefinition[] }
export interface AiTransport { complete(request: AiCompletionRequest, signal?: AbortSignal): Promise<AiTurn> }
export interface AiArtifact { name: string; mimeType: string; data: string }
export type AiRunEvent =
  | { type: 'status'; message: string }
  | { type: 'tool-start'; id: string; name: string; arguments: string }
  | { type: 'tool-end'; id: string; name: string; ok: boolean; summary: string }
  | { type: 'assistant'; text: string }
  | { type: 'artifact'; artifact: AiArtifact };
export interface AiRunOptions {
  message: string;
  history?: AiMessage[];
  instructions?: string;
  allowEdits?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: AiRunEvent) => void;
}
export interface AiRunResult { messages: AiMessage[]; text: string; toolCount: number; completed?: boolean }
export interface AiAssistantOptions { endpoint?: string; transport?: AiTransport }
/** Creates a trusted plugin with chat, model settings and tool-based editing. */
export type AiPluginFactory = (options?: AiAssistantOptions) => EditorPlugin;
