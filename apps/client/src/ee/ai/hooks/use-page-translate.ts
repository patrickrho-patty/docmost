/**
 * PAT-2723: view-only AI translation of the page into Korean.
 *
 * Two concerns are kept separate:
 *  - job state (none / in_progress / complete) is SERVER truth, shared by
 *    everyone viewing the page — the client learns it either from its own
 *    SSE stream or by polling POST /api/ai/translate/status (every viewer
 *    can watch a job someone else started; nobody can start a duplicate)
 *  - view state (viewing / not viewing) is per-user — the translated DOM is
 *    swapped in and out of the reader locally, never persisted, and the
 *    original HTML is always kept in memory for restore
 *
 * Works against the DOM the reader is already rendering:
 *  - detects the page language via Unicode-script ratio (toggle only on
 *    non-Korean pages)
 *  - POST /api/ai/translate streams each translated block as an SSE frame;
 *    pending blocks are dimmed until their translation lands
 *  - entering edit mode restores the originals immediately (translated DOM
 *    must never reach the collaborative editor)
 *
 * The shared job/cache key ("page version") is a hash of the blocks'
 * NORMALIZED TEXT, not their HTML: every viewer must derive the same key
 * from the same synced document, and HTML serialization is browser- and
 * renderer-dependent (static preview vs live collab editor, style/entity
 * encoding) while text content is not. A text edit changes the key and
 * therefore misses the cache; a formatting-only edit keeps it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { useAtomValue } from "jotai";
import { useEditorState } from "@tiptap/react";
import { streamSseFrames } from "@/lib/stream-sse.ts";
import api from "@/lib/api-client.ts";
import { pageEditorAtom } from "@/features/editor/atoms/editor-atoms.ts";

export type TranslatePhase =
  | "hidden" // page is Korean (or edit mode) — no toggle
  | "idle" // foreign page, no job, nothing applied
  | "busy" // a translation job is running (mine or someone else's)
  | "done" // a complete translation exists (applied only if `viewing`)
  | "error";


interface StatusResponse {
  state: "none" | "in_progress" | "cached";
  done?: number;
  total?: number;
}

const POLL_INTERVAL_MS = 4000;

/**
 * sha256 of the block version payload: `[{id, text}]` where text is the
 * block's normalized text content. Every viewer derives the identical key
 * from the same document (textContent is spec-stable across browsers, unlike
 * innerHTML), so a job started by one person is found by everyone else.
 * The server trusts this value as a cache key only — it is never executed.
 */
async function computeSourceHash(
  blocks: { id: number; text: string }[],
): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(blocks));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Collapse whitespace and unify nbsp so extraction differences between
 *  renderers can never change the version key. */
function normalizeBlockText(text: string): string {
  return text.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

const HANGUL = /[가-힯ᄀ-ᅟᅠ-ᆯ]/g;
const HAN = /[一-鿿]/g;
const KANA = /[぀-ヿ]/g;
const LATIN = /[A-Za-zÀ-ÖØ-öø-ÿĀ-žĂ-șĂ-ś]/g;

function countMatches(text: string, re: RegExp): number {
  const m = text.match(re);
  return m ? m.length : 0;
}

/** Korean when Hangul dominates the letter mix; a little Han/Hiragana noise
 *  (mixed KR docs) is tolerated. Non-Korean when Hangul is a small minority. */
export function isMostlyKorean(text: string): boolean {
  const hangul = countMatches(text, HANGUL);
  const han = countMatches(text, HAN);
  const kana = countMatches(text, KANA);
  const latin = countMatches(text, LATIN);
  const total = hangul + han + kana + latin;
  if (total < 60) return true; // too little text to translate meaningfully
  return hangul / total >= 0.3;
}

function findContentRoot(): HTMLElement | null {
  // The page body is the .ProseMirror inside .editor-container — stable
  // across the static preview and the live collab editor (page-editor.tsx
  // wraps both). Picking deterministically matters: every viewer must
  // collect the same blocks to derive the same version key.
  const body = document.querySelector<HTMLElement>(
    ".editor-container .ProseMirror",
  );
  if (body) return body;
  // Fallback for layouts without the marker: the non-title root with the
  // most text (title and empty comment editors are also .ProseMirror roots).
  const roots = Array.from(
    document.querySelectorAll<HTMLElement>(".ProseMirror"),
  ).filter(
    (el) =>
      !el.closest(".page-title") && (el.textContent ?? "").trim().length > 0,
  );
  roots.sort(
    (a, b) =>
      (b.textContent ?? "").length - (a.textContent ?? "").length,
  );
  return roots[0] ?? null;
}

/** Top-level blocks worth translating. Skips code blocks, image-only rows,
 *  embeds and empty spacing nodes. */
function collectBlocks(
  root: HTMLElement,
): { el: HTMLElement; html: string }[] {
  const out: { el: HTMLElement; html: string }[] = [];
  const children = Array.from(root.children) as HTMLElement[];
  for (const el of children) {
    const tag = el.tagName;
    if (tag === "PRE") continue;
    if (tag === "IMG" || tag === "HR" || tag === "TABLE") continue;
    const text = (el.textContent ?? "").trim();
    if (text.length < 2) continue;
    if (el.querySelector("pre")) continue;
    out.push({ el, html: el.innerHTML });
  }
  return out;
}

const sanitizer = DOMPurify();
sanitizer.setConfig({
  ALLOW_DATA_ATTR: true,
  ADD_ATTR: ["class", "style", "colspan", "rowspan", "target", "rel"],
});

export function usePageTranslate(pageId: string | undefined) {
  const [phase, setPhase] = useState<TranslatePhase>("hidden");
  const [viewing, setViewing] = useState(false);
  const [cached, setCached] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  // edit-mode truth comes from editor state, not DOM observation: the page
  // editor folds page permission and the header mode toggle into
  // editor.setEditable, and isEditable is connection-independent — so it is
  // correct during the static preview (editor already editable before the
  // collab root mounts) and during transient yjs disconnects alike.
  const editor = useAtomValue(pageEditorAtom);
  const editorIsEditable = useEditorState({
    editor,
    selector: (ctx) => ctx.editor?.isEditable ?? false,
  });
  const editorIsEditableRef = useRef(editorIsEditable);
  editorIsEditableRef.current = editorIsEditable;

  // ref mirrors so timers and stream callbacks see current values without
  // re-binding (the poller interval must not restart on every state change)
  const phaseRef = useRef<TranslatePhase>("hidden");
  const viewingRef = useRef(false);
  const pageIdRef = useRef(pageId);
  pageIdRef.current = pageId;

  const abortRef = useRef<AbortController | null>(null);
  const streamOpenRef = useRef(false);
  const originalsRef = useRef(new Map<HTMLElement, string>());
  const receivedRef = useRef(new Map<number, string>());
  const blocksRef = useRef<{ id: number; el: HTMLElement }[]>([]);

  const setPhaseAll = useCallback((p: TranslatePhase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  const setViewingAll = useCallback((v: boolean) => {
    viewingRef.current = v;
    setViewing(v);
  }, []);

  /** Swap one block's translated HTML in and light it up. */
  const swapBlock = useCallback((id: number) => {
    const el = blocksRef.current.find((b) => b.id === id)?.el;
    const html = receivedRef.current.get(id);
    if (!el || html === undefined) return;
    el.innerHTML = sanitizer.sanitize(html);
    el.style.opacity = "1";
  }, []);

  /** Show the translated view: translated blocks swapped in, still-pending
   *  blocks show their original dimmed. */
  const applyView = useCallback(() => {
    setViewingAll(true);
    for (const b of blocksRef.current) {
      const received = receivedRef.current.get(b.id);
      if (received !== undefined) {
        b.el.innerHTML = sanitizer.sanitize(received);
        b.el.style.opacity = "1";
      } else {
        const original = originalsRef.current.get(b.el);
        if (original !== undefined) b.el.innerHTML = original;
        b.el.style.opacity = "0.45";
        b.el.style.transition = "opacity 0.35s ease";
      }
    }
  }, [setViewingAll]);

  /** Put every original back and strip the dimming styles we added. */
  const restoreDom = useCallback(() => {
    for (const [el, html] of originalsRef.current) {
      el.innerHTML = html;
      el.style.opacity = "";
      el.style.transition = "";
    }
  }, []);

  const clearLocal = useCallback(() => {
    abortRef.current?.abort();
    streamOpenRef.current = false;
    restoreDom();
    originalsRef.current = new Map();
    receivedRef.current.clear();
    blocksRef.current = [];
    setViewingAll(false);
    setCached(false);
    setProgress((p) => (p.done === 0 && p.total === 0 ? p : { done: 0, total: 0 }));
  }, [restoreDom, setViewingAll]);

  const detect = useCallback(() => {
    const root = findContentRoot();
    if (!root) {
      setPhaseAll("hidden");
      return;
    }
    const text = (root.textContent ?? "").trim();
    setPhaseAll(isMostlyKorean(text) ? "hidden" : "idle");
  }, [setPhaseAll]);

  /** Hide and reset: the page entered edit mode, where translated DOM must
   *  never exist (yjs would persist it). Guarded so repeated calls with
   *  nothing to clear don't trigger re-renders. */
  const hideForEditMode = useCallback(() => {
    if (phaseRef.current === "hidden" && !viewingRef.current) return;
    clearLocal();
    setPhaseAll("hidden");
  }, [clearLocal, setPhaseAll]);

  /** Apply the editor's edit state: hide in edit mode, otherwise reveal/
   *  re-detect. Never re-detect while the translated view is applied: the
   *  DOM reads as Korean then, and hiding would strand the user with no
   *  toggle to switch back. */
  const applyModeState = useCallback(() => {
    if (editorIsEditableRef.current) {
      hideForEditMode();
    } else if (!viewingRef.current) {
      detect();
    }
  }, [detect, hideForEditMode]);

  // language detection once the reader content has actually rendered
  useEffect(() => {
    clearLocal();
    setPhaseAll("hidden");
    let tries = 0;
    const timer = setInterval(() => {
      const root = findContentRoot();
      tries += 1;
      if (root && (root.textContent ?? "").trim().length > 0) {
        applyModeState();
        clearInterval(timer);
      } else if (tries > 40) {
        clearInterval(timer);
      }
    }, 250);
    return () => clearInterval(timer);
  }, [pageId, clearLocal, setPhaseAll, applyModeState]);

  // leaving the page / unmount: stop the stream and restore the view
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      restoreDom();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  // react to edit-mode transitions (header toggle, permission changes) —
  // editor.setEditable emits an update, so useEditorState re-runs the
  // selector and this effect applies the new state
  useEffect(() => {
    applyModeState();
  }, [editorIsEditable, applyModeState]);

  /**
   * Turn the translated view on. Idempotent: re-applies what we already
   * have; opens POST /api/ai/translate otherwise. With `force`, discards
   * locally held results and starts a fresh translation server-side
   * (reprocess). Never starts a duplicate job — the server joins the live
   * job for this page version or replays the cache when one exists.
   */
  const translate = useCallback(
    async (force = false) => {
      const pid = pageIdRef.current;
      if (!pid) return;
      const root = findContentRoot();
      if (!root) return;
      // never translate the live collaborative editor — DOM swaps there
      // would be picked up by yjs as local edits and persisted for everyone
      if (root.getAttribute("contenteditable") === "true") {
        setPhaseAll("hidden");
        return;
      }

      if (force) {
        // reprocess: kill any running stream first — its frames would
        // otherwise interleave with the fresh job's (same refs/maps)
        abortRef.current?.abort();
        streamOpenRef.current = false;
        restoreDom();
        receivedRef.current.clear();
        setCached(false);
      } else if (streamOpenRef.current || receivedRef.current.size > 0) {
        // stream already running (or everything already received):
        // (re)apply the view — instant
        applyView();
        return;
      }

      const blocks = collectBlocks(root);
      if (blocks.length === 0) return;

      originalsRef.current = new Map(
        blocks.map((b) => [b.el, b.el.innerHTML]),
      );
      blocksRef.current = blocks.map((b, i) => ({ id: i, el: b.el }));
      applyView(); // dim pending blocks, show what arrives
      setProgress({ done: 0, total: blocks.length });
      setPhaseAll("busy");

      const payload = blocksRef.current.map((b) => ({
        id: b.id,
        html: originalsRef.current.get(b.el) ?? "",
      }));

      // the shared job/cache key: normalized text of the exact blocks we
      // are about to send — identical for every viewer of this page version
      const sourceHash = await computeSourceHash(
        blocksRef.current.map((b) => ({
          id: b.id,
          text: normalizeBlockText(b.el.textContent ?? ""),
        })),
      );

      const abort = new AbortController();
      abortRef.current = abort;
      streamOpenRef.current = true;

      streamSseFrames<{
        block?: { id: number; html: string };
        done?: boolean;
        error?: string;
        cached?: boolean;
      }>({
        url: "/api/ai/translate",
        body: { pageId: pid, blocks: payload, force, sourceHash },
        signal: abort.signal,
        onFrame: (frame) => {
          if (frame.cached) {
            setCached(true);
            return;
          }
          if (frame.error) {
            // eslint-disable-next-line no-console
            console.error("[page-translate] server error frame:", frame.error);
            streamOpenRef.current = false;
            if (receivedRef.current.size === 0) {
              restoreDom();
              setViewingAll(false);
              setPhaseAll("error");
            } else {
              // keep the partial translation viewable
              setPhaseAll("done");
            }
            abort.abort();
            return;
          }
          if (frame.block) {
            receivedRef.current.set(frame.block.id, frame.block.html);
            setProgress((p) => ({ ...p, done: receivedRef.current.size }));
            if (viewingRef.current) swapBlock(frame.block.id);
          }
        },
        onDone: () => {
          streamOpenRef.current = false;
          if (phaseRef.current === "busy") setPhaseAll("done");
        },
      }).catch((err) => {
        streamOpenRef.current = false;
        if (err?.name !== "AbortError") {
          // eslint-disable-next-line no-console
          console.error("[page-translate] stream failed:", err);
          if (receivedRef.current.size === 0) {
            restoreDom();
            setViewingAll(false);
            setPhaseAll("error");
          } else {
            setPhaseAll("done");
          }
        }
      });
    },
    [
      applyView,
      restoreDom,
      setPhaseAll,
      setViewingAll,
      swapBlock,
    ],
  );

  /** Button click: flip the view. Jobs are shared and persistent — this
   *  never cancels server-side work, it only shows originals locally. */
  const toggleView = useCallback(() => {
    if (viewingRef.current) {
      restoreDom();
      setViewingAll(false);
    } else {
      void translate(false);
    }
  }, [restoreDom, setViewingAll, translate]);

  /** Reprocess: discard the cached translation and translate again. */
  const reprocess = useCallback(() => {
    void translate(true);
  }, [translate]);

  // Status poller: while the toggle is visible and we are neither viewing
  // nor streaming, ask the server whether a job is running (started by
  // anyone) or a cached translation exists for this page version. This is
  // how a second viewer sees "번역 진행 중" without pressing anything, and
  // how a returning user learns a job survived their navigation.
  useEffect(() => {
    if (phase === "hidden" || viewing) return;
    let cancelled = false;

    const poll = async () => {
      if (
        cancelled ||
        streamOpenRef.current ||
        viewingRef.current ||
        document.hidden
      ) {
        return;
      }
      const pid = pageIdRef.current;
      if (!pid) return;
      const root = findContentRoot();
      if (!root) return;
      if (root.getAttribute("contenteditable") === "true") {
        // DOM-level safety net: the live root is the click-time authority
        // for whether swapping is safe, so never leave the toggle up when
        // it says editable — even if editor state disagreed momentarily
        // (e.g. before the editor instance existed)
        hideForEditMode();
        return;
      }
      const blocks = collectBlocks(root);
      if (blocks.length === 0) return;

      try {
        // send only the digest: the poller fires every few seconds per
        // viewer and the full page HTML can be ~200KB
        const sourceHash = await computeSourceHash(
          blocks.map((b, i) => ({
            id: i,
            text: normalizeBlockText(b.el.textContent ?? ""),
          })),
        );
        if (cancelled || streamOpenRef.current || viewingRef.current) return;
        // the axios client carries auth + unwraps the API envelope
        const envelope = await api.post("/ai/translate/status", {
          pageId: pid,
          sourceHash,
        });
        const st: StatusResponse | undefined = envelope?.data;
        if (!st || cancelled || streamOpenRef.current || viewingRef.current) {
          return;
        }

        if (st.state === "in_progress") {
          const done = st.done ?? 0;
          const total = st.total ?? blocks.length;
          setProgress((p) =>
            p.done === done && p.total === total ? p : { done, total },
          );
          if (["idle", "error", "done"].includes(phaseRef.current)) {
            setPhaseAll("busy");
          }
        } else if (st.state === "cached") {
          if (["idle", "error", "busy"].includes(phaseRef.current)) {
            setPhaseAll("done");
          }
        } else {
          if (["busy", "done", "error"].includes(phaseRef.current)) {
            setPhaseAll("idle");
          }
        }
      } catch {
        // network hiccup — the next tick retries
      }
    };

    void poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [phase, viewing, pageId, setPhaseAll, clearLocal, hideForEditMode]);

  return { phase, viewing, cached, progress, translate, toggleView, reprocess };
}
