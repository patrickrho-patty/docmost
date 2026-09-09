import api from "@/lib/api-client.ts";
import { streamSseFrames } from "@/lib/stream-sse.ts";
import { IPageSearchParams } from "@/features/search/types/search.types.ts";

export interface IAiSearchResponse {
  answer: string;
  sources?: Array<{
    pageId: string;
    title: string;
    slugId: string;
    spaceSlug: string;
    similarity: number;
    distance: number;
    chunkIndex: number;
    excerpt: string;
    citation?: number;
  }>;
}

export async function hintVectorCache(): Promise<void> {
  try {
    await api.post("/ai/vector-cache-hint");
  } catch {
    // best-effort cache hint
  }
}

export async function aiAnswers(
  params: IPageSearchParams,
  onChunk?: (chunk: { content?: string; sources?: any[] }) => void,
  signal?: AbortSignal,
): Promise<IAiSearchResponse> {
  let answer = "";
  let sources: any[] = [];

  await streamSseFrames<{ content?: string; sources?: any[]; error?: string }>(
    {
      url: "/api/ai/answers",
      body: params,
      signal,
      onFrame: (parsed) => {
        if (parsed.error) throw new Error(parsed.error);
        if (parsed.content) {
          answer += parsed.content;
          onChunk?.({ content: parsed.content });
        }
        if (parsed.sources) {
          sources = parsed.sources;
          onChunk?.({ sources: parsed.sources });
        }
      },
    },
  );

  return { answer, sources };
}
