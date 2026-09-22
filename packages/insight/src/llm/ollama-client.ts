import { LlmError, type LlmClient, type LlmRequest, type LlmResponse } from './types';

export interface OllamaOptions {
  /** Ollama's HTTP endpoint. Default is its standard local port. */
  readonly baseUrl?: string;
  readonly model: string;
  readonly defaultTimeoutMs?: number;
  /**
   * How long Ollama keeps the model resident after a call.
   *
   * Post-mortems run minutes apart, and reloading an 8B model from disk each
   * time costs several seconds. Keeping it warm trades idle RAM for latency;
   * set '0' to unload immediately if the Mac needs the memory back.
   */
  readonly keepAlive?: string;
}

interface OllamaChatResponse {
  model?: string;
  message?: { role?: string; content?: string };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Ollama adapter, written against its /api/chat endpoint.
 *
 * Also works unchanged against anything else exposing Ollama's API. For an
 * OpenAI-compatible runtime (LM Studio and friends) write a sibling client
 * rather than bending this one — the two response shapes have nothing in
 * common beyond both containing text.
 */
export class OllamaClient implements LlmClient {
  readonly name = 'ollama';
  readonly model: string;

  private readonly baseUrl: string;
  private readonly defaultTimeoutMs: number;
  private readonly keepAlive: string;

  constructor(options: OllamaOptions) {
    if (!options.model) throw new LlmError('OllamaClient requires a model name');
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
    this.keepAlive = options.keepAlive ?? '5m';
  }

  /**
   * True only when Ollama is up AND has the configured model pulled.
   *
   * Checking the tag list rather than just the port matters: a running Ollama
   * without the model will happily accept a chat request and then spend
   * minutes pulling gigabytes, which from the engine's side looks like a hang.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await this.fetchJson<{ models?: { name?: string; model?: string }[] }>(
        '/api/tags',
        undefined,
        5_000,
      );
      const names = (response.models ?? []).flatMap((m) => [m.name, m.model].filter(Boolean));
      // Ollama reports "llama3.1:8b"; a config of "llama3.1" should still match.
      return names.some((name) => name === this.model || name === `${this.model}:latest`);
    } catch {
      return false;
    }
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const startedAt = Date.now();
    const body = {
      model: this.model,
      stream: false,
      keep_alive: this.keepAlive,
      ...(request.json ? { format: 'json' } : {}),
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      options: {
        // Low but not zero: at exactly 0 some local models loop on a phrase.
        temperature: request.temperature ?? 0.2,
        num_predict: request.maxTokens ?? 800,
      },
    };

    const response = await this.fetchJson<OllamaChatResponse>(
      '/api/chat',
      body,
      request.timeoutMs ?? this.defaultTimeoutMs,
    );

    const text = response.message?.content?.trim() ?? '';
    if (!text) throw new LlmError(`${this.model} returned an empty response`);

    return {
      text,
      model: response.model ?? this.model,
      durationMs: Date.now() - startedAt,
      ...(response.prompt_eval_count !== undefined
        ? { promptTokens: response.prompt_eval_count }
        : {}),
      ...(response.eval_count !== undefined ? { completionTokens: response.eval_count } : {}),
    };
  }

  private async fetchJson<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
    // A local model that has wedged will hold the socket open indefinitely.
    // Every call is bounded so a stuck generation cannot pin the worker.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new LlmError(
          `Ollama ${path} returned ${response.status}: ${(await response.text()).slice(0, 200)}`,
        );
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if ((error as Error)?.name === 'AbortError') {
        throw new LlmError(`Ollama ${path} timed out after ${timeoutMs}ms`);
      }
      throw new LlmError(`Ollama ${path} failed: ${describe(error)}`, error);
    } finally {
      clearTimeout(timer);
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error).slice(0, 200);
}
