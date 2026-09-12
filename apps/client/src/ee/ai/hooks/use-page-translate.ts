/**
 * PAT-2723: view-only AI translation of the page into Korean.
 *
 * Works entirely against the DOM the reader is already rendering:
 *  - detects the page language via Unicode-script ratio (show the toggle
 *    only when the page is NOT Korean — English, Chinese, German, …)
 *  - on translate: sends the top-level HTML blocks to POST /api/ai/translate
 *    and swaps each block in place as translations stream back
 *  - on restore: puts the original innerHTML back — nothing is persisted,
 *    nothing is sent to the collaborative editor
 *  - auto-restores if the page switches to edit mode while translated
 */
import { useCallback, useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { streamSseFrames } from "@/lib/stream-sse.ts";

type TranslateState =
  | "hidden" // page is Korean (or unreadable) — no toggle
  | "idle" // foreign-language page, not translated
  | "translating"
  | "translated"
  | "error";

const HANGUL = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/g;
const HAN = /[\u4E00-\u9FFF]/g;
const KANA = /[\u3040-\u30FF]/g;
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
  // The title editor and empty comment editors are also .ProseMirror roots;
  // the page body is the non-title root with the most text.
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
  const [state, setState] = useState<TranslateState>("hidden");
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  const abortRef = useRef<AbortController | null>(null);
  const originalsRef = useRef(new Map<HTMLElement, string>());
  const blocksRef = useRef<{ id: number; el: HTMLElement }[]>([]);

  const restore = useCallback(() => {
    for (const [el, html] of originalsRef.current) {
      el.innerHTML = html;
    }
    originalsRef.current = new Map();
    blocksRef.current = [];
  }, []);

  const detect = useCallback(() => {
    const root = findContentRoot();
    if (!root) {
      setState("hidden");
      return;
    }
    const text = (root.textContent ?? "").trim();
    setState(isMostlyKorean(text) ? "hidden" : "idle");
  }, []);

  // language detection once the reader content has actually rendered
  useEffect(() => {
    setState("hidden");
    let tries = 0;
    const timer = setInterval(() => {
      const root = findContentRoot();
      tries += 1;
      if (root && (root.textContent ?? "").trim().length > 0) {
        detect();
        clearInterval(timer);
      } else if (tries > 40) {
        clearInterval(timer);
      }
    }, 250);
    return () => clearInterval(timer);
  }, [pageId, detect]);

  // leaving the page / unmount: stop the stream and restore the view
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      restore();
    };
  }, [pageId, restore]);

  // edit mode must never see (or persist) translated DOM: watch the editor
  // root's contenteditable flag and restore as soon as editing starts.
  // `state` is a dep because the content root usually doesn't exist yet on
  // first mount — detection flips the state once it renders, and this effect
  // re-runs to attach the observer to the now-available root.
  useEffect(() => {
    const root = findContentRoot();
    if (!root || typeof MutationObserver === "undefined") return;
    const hideIfEditable = () => {
      if (root.getAttribute("contenteditable") === "true") {
        abortRef.current?.abort();
        restore();
        setState("hidden");
      }
    };
    hideIfEditable(); // page may LOAD directly into edit mode — hide at attach
    const observer = new MutationObserver(hideIfEditable);
    observer.observe(root, { attributes: true, attributeFilter: ["contenteditable"] });
    return () => observer.disconnect();
  }, [pageId, restore, state]);

  const translate = useCallback(() => {
    if (!pageId) return;
    const root = findContentRoot();
    if (!root) return;
    // never translate the live collaborative editor — DOM swaps there would
    // be picked up by yjs as local edits and persisted for everyone
    if (root.getAttribute("contenteditable") === "true") {
      setState("hidden");
      return;
    }

    const blocks = collectBlocks(root);
    if (blocks.length === 0) return;

    abortRef.current?.abort();
    restore();

    originalsRef.current = new Map(blocks.map((b) => [b.el, b.el.innerHTML]));
    blocksRef.current = blocks.map((b, i) => ({ id: i, el: b.el }));
    setState("translating");
    setProgress({ done: 0, total: blocks.length });

    const byId = new Map(blocksRef.current.map((b) => [b.id, b.el]));
    const payload = blocksRef.current.map((b) => ({
      id: b.id,
      html: originalsRef.current.get(b.el) ?? "",
    }));

    const abort = new AbortController();
    abortRef.current = abort;

    streamSseFrames<{ block?: { id: number; html: string }; done?: boolean; error?: string }>({
      url: "/api/ai/translate",
      body: { pageId, blocks: payload },
      signal: abort.signal,
      onFrame: (frame) => {
        if (frame.error) {
          // eslint-disable-next-line no-console
          console.error("[page-translate] server error frame:", frame.error);
          setState("error");
          abort.abort();
          return;
        }
        if (frame.block) {
          const el = byId.get(frame.block.id);
          if (el) {
            el.innerHTML = sanitizer.sanitize(frame.block.html);
            setProgress((p) => ({ ...p, done: p.done + 1 }));
          }
        }
      },
      onDone: () => {
        setState((s) => (s === "error" ? s : "translated"));
      },
    }).catch((err) => {
      if (err?.name !== "AbortError") {
        // eslint-disable-next-line no-console
        console.error("[page-translate] stream failed:", err);
        setState("error");
      }
    });
  }, [pageId, restore]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    restore();
    setState("idle");
    setProgress({ done: 0, total: 0 });
  }, [restore]);

  return { state, progress, translate, reset };
}
