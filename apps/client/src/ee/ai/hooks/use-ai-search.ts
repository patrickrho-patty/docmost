import { useMutation, UseMutationResult } from "@tanstack/react-query";
import { useState, useCallback, useRef } from "react";
import { aiAnswers, IAiSearchResponse } from "@/ee/ai/services/ai-search-service.ts";
import { IPageSearchParams } from "@/features/search/types/search.types.ts";

type UseAiSearchResult = UseMutationResult<
  IAiSearchResponse,
  Error,
  IPageSearchParams,
  unknown
> & {
  streamingAnswer: string;
  streamingSources: any[];
  clearStreaming: () => void;
};

export function useAiSearch(): UseAiSearchResult {
  const [streamingAnswer, setStreamingAnswer] = useState("");
  const [streamingSources, setStreamingSources] = useState<any[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const mutationResetRef = useRef<(() => void) | null>(null);
  // The server streams per-token; buffer chunks and flush to React state at
  // ~20fps instead of re-rendering on every SSE frame.
  const bufferRef = useRef("");
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushBuffer = useCallback(() => {
    flushTimerRef.current = null;
    if (bufferRef.current) {
      const pending = bufferRef.current;
      bufferRef.current = "";
      setStreamingAnswer((prev) => prev + pending);
    }
  }, []);

  const clearStreaming = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    bufferRef.current = "";
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = null;
    setStreamingAnswer("");
    setStreamingSources([]);
    mutationResetRef.current?.();
  }, []);

  const mutation = useMutation({
    mutationFn: async (params: IPageSearchParams & { contentType?: string }) => {
      // abort any in-flight stream (rapid re-submits would interleave)
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      bufferRef.current = "";
      setStreamingAnswer("");
      setStreamingSources([]);

      const { contentType, ...apiParams } = params;

      try {
        return await aiAnswers(
          apiParams,
          (chunk) => {
            if (chunk.content) {
              bufferRef.current += chunk.content;
              if (!flushTimerRef.current) {
                flushTimerRef.current = setTimeout(flushBuffer, 50);
              }
            }
            if (chunk.sources) {
              setStreamingSources(chunk.sources);
            }
          },
          controller.signal,
        );
      } finally {
        if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
        flushBuffer();
      }
    },
  });

  mutationResetRef.current = mutation.reset;

  return {
    ...mutation,
    streamingAnswer,
    streamingSources,
    clearStreaming,
  };
}
