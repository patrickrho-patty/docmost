import { Injectable, Logger } from '@nestjs/common';
import { EnvironmentService } from '../../integrations/environment/environment.service';

/**
 * PAT-2329/PAT-2330: embedding provider driver.
 *
 * Driver resolution (patty fork semantics — replaces the private EE module):
 *  - OLLAMA_API_URL set          → Ollama `/api/embed` (local CPU, bge-m3)
 *  - else AI_DRIVER=gemini      → Gemini embedContent API
 *  - else AI_DRIVER=openai[-compatible] + OPENAI_API_KEY → `${OPENAI_API_URL}/embeddings`
 *    (works for MiniMax-style endpoints and any OpenAI-compatible server)
 *
 * NOTE: AI_DRIVER primarily selects the chat/completions provider; embeddings
 * prefer Ollama whenever OLLAMA_API_URL is explicitly configured.
 */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private static readonly BATCH_SIZE = 16;
  private static readonly MAX_RETRIES = 3;

  constructor(private readonly environmentService: EnvironmentService) {}

  isAvailable(): boolean {
    return this.resolveProvider() !== null;
  }

  private resolveProvider(): 'ollama' | 'gemini' | 'openai-compatible' | null {
    const env = this.environmentService;
    if (!env.getAiEmbeddingModel()) return null;
    if (env.getOllamaApiUrl()) return 'ollama';
    const driver = env.getAiDriver()?.toLowerCase();
    if (driver === 'gemini' && env.getGeminiApiKey()) return 'gemini';
    if (
      (driver === 'openai' || driver === 'openai-compatible') &&
      env.getOpenAiApiKey()
    ) {
      return 'openai-compatible';
    }
    return null;
  }

  getDimension(): number {
    return this.environmentService.getAiEmbeddingDimension() || 1024;
  }

  getModelName(): string {
    return this.environmentService.getAiEmbeddingModel();
  }

  /** Embed a batch of texts. Returns one vector per input, in order. */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += EmbeddingService.BATCH_SIZE) {
      const batch = texts.slice(i, i + EmbeddingService.BATCH_SIZE);
      results.push(...(await this.embedWithRetry(batch)));
    }
    return results;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vec] = await this.embedBatch([text]);
    return vec;
  }

  private async embedWithRetry(texts: string[]): Promise<number[][]> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= EmbeddingService.MAX_RETRIES; attempt++) {
      try {
        return await this.embedInternal(texts);
      } catch (err) {
        lastErr = err;
        this.logger.warn(
          `Embedding attempt ${attempt}/${EmbeddingService.MAX_RETRIES} failed: ${err?.['message'] ?? err}`,
        );
        if (attempt < EmbeddingService.MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, attempt * 2000));
        }
      }
    }
    throw lastErr;
  }

  private async embedInternal(texts: string[]): Promise<number[][]> {
    const env = this.environmentService;
    const model = env.getAiEmbeddingModel();
    const provider = this.resolveProvider();

    if (provider === 'ollama') {
      return this.embedOllama(
        env.getOllamaApiUrl().replace(/\/$/, ''),
        model,
        texts,
      );
    }
    if (provider === 'gemini') {
      return this.embedGemini(env.getGeminiApiKey(), model, texts);
    }
    if (provider === 'openai-compatible') {
      const base = (
        env.getOpenAiApiUrl() || 'https://api.openai.com/v1'
      ).replace(/\/$/, '');
      return this.embedOpenAiCompatible(
        base,
        env.getOpenAiApiKey(),
        model,
        texts,
      );
    }
    throw new Error(
      'No embedding provider configured (set OLLAMA_API_URL or AI_DRIVER + keys)',
    );
  }

  private async embedOllama(
    baseUrl: string,
    model: string,
    texts: string[],
  ): Promise<number[][]> {
    const res = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
    });
    if (!res.ok) {
      throw new Error(`Ollama embed failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    return data.embeddings as number[][];
  }

  private async embedOpenAiCompatible(
    baseUrl: string,
    apiKey: string,
    model: string,
    texts: string[],
  ): Promise<number[][]> {
    const res = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: texts }),
    });
    if (!res.ok) {
      throw new Error(
        `OpenAI-compatible embed failed: ${res.status} ${await res.text()}`,
      );
    }
    const data = await res.json();
    const sorted = (data.data as { index: number; embedding: number[] }[])
      .slice()
      .sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding);
  }

  private async embedGemini(
    apiKey: string,
    model: string,
    texts: string[],
  ): Promise<number[][]> {
    // Gemini batchEmbedContents
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: texts.map((text) => ({
            model: `models/${model}`,
            content: { parts: [{ text }] },
          })),
        }),
      },
    );
    if (!res.ok) {
      throw new Error(`Gemini embed failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    return (data.embeddings as { values: number[] }[]).map((e) => e.values);
  }
}
