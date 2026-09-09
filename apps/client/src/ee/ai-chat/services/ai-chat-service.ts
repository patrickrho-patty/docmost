import api from "@/lib/api-client.ts";
import { streamSseFrames } from "@/lib/stream-sse.ts";
import type {
  AiChat,
  AiChatMessage,
  AiChatStreamEvent,
  ChatAttachment,
} from "../types/ai-chat.types";
import { IPagination } from "@/lib/types.ts";

export async function createChat(): Promise<AiChat> {
  const req = await api.post<AiChat>("/ai/chats/create");
  return req.data;
}

export async function listChats(params?: {
  limit?: number;
  cursor?: string;
}): Promise<IPagination<AiChat>> {
  const req = await api.post("/ai/chats", params);
  return req.data;
}

export async function getChatInfo(
  chatId: string,
): Promise<{ chat: AiChat; messages: AiChatMessage[] }> {
  const req = await api.post("/ai/chats/info", { chatId });
  return req.data;
}

export async function deleteChat(chatId: string): Promise<void> {
  await api.post("/ai/chats/delete", { chatId });
}

export async function updateChatTitle(
  chatId: string,
  title: string,
): Promise<void> {
  await api.post("/ai/chats/update", { chatId, title });
}

export async function searchChats(query: string): Promise<AiChat[]> {
  const req = await api.post("/ai/chats/search", { query });
  return req.data;
}

export async function uploadChatFile(
  file: File,
  chatId?: string,
): Promise<ChatAttachment> {
  const formData = new FormData();
  // fields must be appended BEFORE the file part: @fastify/multipart only
  // surfaces fields parsed before the file on `file.fields`
  if (chatId) {
    formData.append("chatId", chatId);
  }
  formData.append("file", file);
  return await api.post("/ai/chats/upload", formData, {
    headers: { "Content-Type": "multipart/form-data" },
  });
}

export function sendChatMessage(
  params: {
    chatId?: string;
    content: string;
    mentionedPageIds?: string[];
    contextPageId?: string;
    attachmentIds?: string[];
  },
  onEvent: (event: AiChatStreamEvent) => void,
  onError?: (error: string) => void,
  onComplete?: () => void,
): AbortController {
  const abortController = new AbortController();

  streamSseFrames<AiChatStreamEvent & { message?: string }>({
    url: "/api/ai/chats/send",
    body: params,
    signal: abortController.signal,
    onFrame: (parsed) => {
      if (parsed.type === "error") {
        onError?.(parsed.message || "Unknown error");
        return;
      }
      onEvent(parsed);
    },
    onDone: onComplete,
  }).catch((error) => {
    if (error.name !== "AbortError") {
      onError?.(error.message);
    }
  });

  return abortController;
}
