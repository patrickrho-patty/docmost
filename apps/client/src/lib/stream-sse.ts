/**
 * Shared client-side SSE consumer for the AI endpoints:
 * fetch POST → line-buffered `data:` frames → parsed JSON per frame.
 *
 * - `[DONE]` ends the stream (and calls onDone)
 * - malformed JSON frames are skipped; everything else throws
 * - pass an AbortSignal to cancel (AbortError propagates)
 */
export async function streamSseFrames<T = any>(opts: {
  url: string;
  body: unknown;
  signal?: AbortSignal;
  onFrame: (data: T) => void;
  onDone?: () => void;
}): Promise<void> {
  const { url, body, signal, onFrame, onDone } = opts;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    let message = `HTTP error ${response.status}`;
    try {
      message = JSON.parse(errorBody).message || message;
    } catch {
      // keep default
    }
    throw new Error(message);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response body is not readable");

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") {
          onDone?.();
          return;
        }
        try {
          onFrame(JSON.parse(data));
        } catch (e) {
          if (e instanceof SyntaxError) continue; // malformed frame
          throw e;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  onDone?.();
}
