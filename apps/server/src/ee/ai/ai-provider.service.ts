import { Injectable, Logger } from '@nestjs/common';
import { EnvironmentService } from '../../integrations/environment/environment.service';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Which configured model slot to use. */
export type ChatModelKind = 'chat' | 'completion';

/**
 * Shared request side of the LLM provider (MiniMax / OpenAI-compatible):
 * endpoint, auth, model resolution, streaming POST, and error classification.
 * Consumption of the SSE stream lives in ai-stream.util (streamCompletionDeltas).
 */
@Injectable()
export class AiProviderService {
  private readonly logger = new Logger(AiProviderService.name);

  constructor(private readonly environmentService: EnvironmentService) {}

  private resolveModel(kind: ChatModelKind): string {
    const env = this.environmentService;
    return (
      (kind === 'chat' ? env.getAiChatModel() : env.getAiCompletionModel()) ||
      'MiniMax-M3'
    );
  }

  /**
   * POST /chat/completions with stream: true. Returns the raw Response for
   * the caller to consume (see streamCompletionDeltas). Throws
   * AiProviderError with the provider's HTTP status on failure.
   */
  async streamChatCompletion(opts: {
    messages: ChatMessage[];
    model: ChatModelKind;
    temperature?: number;
    signal?: AbortSignal;
    /** e.g. 'none' — skips the reasoning phase for latency-critical calls
     *  (translation). Only sent when explicitly set. */
    reasoningEffort?: string;
  }): Promise<Response> {
    const env = this.environmentService;
    const apiKey = env.getOpenAiApiKey();
    const endpoint = env.getOpenAiApiUrl().replace(/\/$/, '');
    const model = this.resolveModel(opts.model);

    let response: Response;
    try {
      response = await fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        signal: opts.signal,
        body: JSON.stringify({
          model,
          stream: true,
          temperature: opts.temperature ?? 0.2,
          messages: opts.messages,
          ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
        }),
      });
    } catch (err) {
      if (opts.signal?.aborted) throw err; // client disconnect — not a provider error
      this.logger.error(`AI provider unreachable: ${err?.['message'] ?? err}`);
      throw new AiProviderError('AI provider unreachable', 502);
    }

    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => '');
      this.logger.error(
        `AI provider error ${response.status}: ${body.slice(0, 300)}`,
      );
      throw new AiProviderError(
        `AI provider error (HTTP ${response.status})`,
        response.status,
      );
    }

    return response;
  }
}

export class AiProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}
