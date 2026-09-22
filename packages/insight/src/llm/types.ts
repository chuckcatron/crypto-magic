export interface LlmRequest {
  readonly system: string;
  readonly user: string;
  /** Ask the runtime to constrain output to JSON. Not all models honour it. */
  readonly json?: boolean;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly timeoutMs?: number;
}

export interface LlmResponse {
  readonly text: string;
  readonly model: string;
  readonly durationMs: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
}

/**
 * A local language model.
 *
 * Deliberately tiny. Nothing on this interface can place an order, read a
 * balance or change a position — it takes text and returns text. Whatever the
 * model says, the worst it can do is write a bad paragraph into the trade log.
 */
export interface LlmClient {
  readonly name: string;
  readonly model: string;
  /** Cheap liveness probe. Must never throw; returns false when unreachable. */
  isAvailable(): Promise<boolean>;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
