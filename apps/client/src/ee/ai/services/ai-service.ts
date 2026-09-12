import api from "@/lib/api-client.ts";
import { streamSseFrames } from "@/lib/stream-sse.ts";
import {
  AiGenerateDto,
  AiContentResponse,
  AiStreamChunk,
  AiStreamError,
} from "@/ee/ai/types/ai.types.ts";

export async function generateAiContent(
  data: AiGenerateDto,
): Promise<AiContentResponse> {
  const req = await api.post<AiContentResponse>("/ai/generate", data);
  return req.data;
}

export async function generateAiContentStream(
  data: AiGenerateDto,
  onChunk: (chunk: AiStreamChunk) => void,
  onError?: (error: AiStreamError) => void,
  onComplete?: () => void,
): Promise<AbortController> {
  const abortController = new AbortController();

  streamSseFrames<AiStreamChunk & { error?: any }>({
    url: "/api/ai/generate/stream",
    body: data,
    signal: abortController.signal,
    onFrame: (parsed) => {
      if (parsed.error) {
        onError?.({ error: parsed.error });
      } else {
        onChunk(parsed);
      }
    },
    onDone: onComplete,
  }).catch((error) => {
    if (error.name !== "AbortError") {
      onError?.({ error: error.message });
    }
  });

  return abortController;
}
