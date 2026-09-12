import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Anchor,
  Center,
  Loader,
  SegmentedControl,
  Text,
  TextInput,
} from "@mantine/core";
import { useDebouncedValue, useMediaQuery } from "@mantine/hooks";
import { IconSparkles } from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { useUnifiedSearch } from "@/features/search/hooks/use-unified-search.ts";
import { useAiSearch } from "@/ee/ai/hooks/use-ai-search.ts";
import { AiSearchResult } from "@/ee/ai/components/ai-search-result.tsx";
import { PageSearchResultBody } from "@/features/search/components/page-search-result-body";
import { buildPageUrl } from "@/features/page/page.utils";
import { IPageSearch } from "@/features/search/types/search.types";
import classes from "./home-hero.module.css";

/**
 * PAT-2335: Google-style hero omnibox for the Patty KB landing page.
 * Search mode hits the existing search API with live results; Ask mode
 * (visible only when workspace AI search is enabled) streams an AI answer
 * with cited sources via /api/ai/answers.
 */
export default function HomeHero() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const workspace = useAtomValue(workspaceAtom);

  const aiSearchEnabled = workspace?.settings?.ai?.search === true;
  const aiChatEnabled = workspace?.settings?.ai?.chat === true;

  const [mode, setMode] = useState<"search" | "ask">("search");
  const [query, setQuery] = useState("");
  const [debouncedQuery] = useDebouncedValue(query, 300);

  const inputRef = useRef<HTMLInputElement>(null);
  const isDesktop = useMediaQuery("(min-width: 48em)");

  // autofocus on desktop
  useEffect(() => {
    if (isDesktop) inputRef.current?.focus();
  }, [isDesktop]);

  // Ask mode is unavailable when AI search is off — never leave dead UI
  useEffect(() => {
    if (!aiSearchEnabled && mode === "ask") setMode("search");
  }, [aiSearchEnabled, mode]);

  const searchParams = useMemo(
    () => ({ query: debouncedQuery, contentType: "page" }),
    [debouncedQuery],
  );
  const { data: results, isFetching } = useUnifiedSearch(
    searchParams,
    mode === "search" && debouncedQuery.trim().length > 0,
  );

  const aiSearch = useAiSearch();

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Enter while an IME composition is in progress confirms the candidate —
    // it must not submit the query (Korean/Japanese input)
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && mode === "ask" && query.trim()) {
      aiSearch.mutate({ query: query.trim() });
    }
    if (e.key === "Escape") {
      setQuery("");
      aiSearch.clearStreaming();
    }
  };

  // answer visibility derives from the mutation lifecycle — a submitted ask
  // is either pending, streaming, has data, or failed
  const showAnswer =
    mode === "ask" &&
    (aiSearch.isPending ||
      aiSearch.streamingAnswer.length > 0 ||
      Boolean(aiSearch.data) ||
      aiSearch.isError);

  const pageResults = (results ?? []).filter(
    (r): r is IPageSearch => (r as IPageSearch).space !== undefined,
  );

  return (
    <div className={classes.hero}>
      <div className={classes.wordmark}>{workspace?.name ?? "Patty KB"}</div>
      <div className={classes.tagline}>
        {aiSearchEnabled
          ? t("Ask anything or search the KB")
          : t("Search the KB")}
      </div>

      <div className={classes.omnibox}>
        {aiSearchEnabled && (
          <Center>
            <SegmentedControl
              size="xs"
              value={mode}
              onChange={(v) => setMode(v as "search" | "ask")}
              data={[
                { label: t("Search"), value: "search" },
                {
                  label: (
                    <Center style={{ gap: 4 }}>
                      <IconSparkles size={14} />
                      <span>{t("Ask AI")}</span>
                    </Center>
                  ),
                  value: "ask",
                },
              ]}
            />
          </Center>
        )}

        <div className={classes.input}>
          <TextInput
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.currentTarget.value);
              if (mode === "ask") {
                aiSearch.clearStreaming();
              }
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              mode === "ask"
                ? t("Ask a question — answers cite workspace pages")
                : t("Search pages…")
            }
            aria-label={t("Search or ask")}
          />
        </div>
      </div>

      {mode === "search" && debouncedQuery.trim().length > 0 && (
        <div className={classes.results}>
          {isFetching && pageResults.length === 0 && (
            <Center p="md">
              <Loader size="sm" />
            </Center>
          )}
          {!isFetching && pageResults.length === 0 && (
            <Center p="md">
              <Text size="sm" c="dimmed">
                {t("No results")}
              </Text>
            </Center>
          )}
          {pageResults.map((page) => (
            <Link
              key={page.id}
              className={classes.resultItem}
              to={buildPageUrl(page.space?.slug, page.slugId, page.title)}
            >
              <PageSearchResultBody page={page} showSpace />
            </Link>
          ))}
        </div>
      )}

      {showAnswer && (
        <div className={classes.answer}>
          {aiSearch.isError && !aiSearch.streamingAnswer && !aiSearch.data ? (
            <Text size="sm" c="red" role="alert">
              {t("Failed to get an answer. Please try again.")}
            </Text>
          ) : (
            <AiSearchResult
              result={aiSearch.data}
              isLoading={aiSearch.isPending}
              streamingAnswer={aiSearch.streamingAnswer}
              streamingSources={aiSearch.streamingSources}
            />
          )}
          {aiChatEnabled && !aiSearch.isPending && aiSearch.streamingAnswer && (
            <div className={classes.continueChat}>
              <Anchor
                component="button"
                size="sm"
                onClick={() =>
                  navigate("/ai", {
                    state: {
                      initialContent: aiSearch.variables?.query ?? "",
                      initialMentions: [],
                      initialAttachments: [],
                    },
                  })
                }
              >
                {t("Continue in full chat →")}
              </Anchor>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
