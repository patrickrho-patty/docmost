/**
 * PAT-2723: "AI 한국어 번역" toggle in the page header.
 *
 * Appears only when the page is written in a non-Korean language. While
 * translating, shows live progress; the translation itself streams into the
 * page view (see use-page-translate.ts). Explicit AI indicator (✦) so users
 * know the translated view is AI-generated.
 */
import { Button, Tooltip } from "@mantine/core";
import { IconLanguage, IconLoader2, IconSparkles } from "@tabler/icons-react";
import { usePageTranslate } from "@/ee/ai/hooks/use-page-translate.ts";
import { usePageQuery } from "@/features/page/queries/page-query.ts";
import { extractPageSlugId } from "@/lib";
import { useParams } from "react-router-dom";

export default function PageTranslateToggle() {
  const { pageSlug } = useParams();
  const { data: page } = usePageQuery({ pageId: extractPageSlugId(pageSlug) });
  const { state, progress, translate, reset } = usePageTranslate(page?.id);

  if (state === "hidden") return null;

  if (state === "translating") {
    return (
      <Tooltip label="AI가 페이지를 한국어로 번역하는 중입니다" openDelay={250} withArrow>
        <Button
          size="compact-xs"
          variant="light"
          color="indigo"
          leftSection={<IconLoader2 size={13} className="spin" />}
          style={{ flexShrink: 0 }}
          onClick={reset}
        >
          AI 번역 중 {progress.done}/{progress.total}
        </Button>
      </Tooltip>
    );
  }

  if (state === "translated") {
    return (
      <Tooltip label="AI 번역본을 표시 중입니다. 클릭하면 원문으로 돌아갑니다." openDelay={250} withArrow>
        <Button
          size="compact-xs"
          variant="light"
          color="indigo"
          leftSection={<IconSparkles size={13} />}
          style={{ flexShrink: 0 }}
          onClick={reset}
        >
          AI 번역본 표시 중 · 원문 보기
        </Button>
      </Tooltip>
    );
  }

  const errored = state === "error";
  return (
    <Tooltip
      label={errored ? "번역에 실패했습니다. 다시 시도해 주세요." : "AI로 이 페이지를 한국어로 번역합니다"}
      openDelay={250}
      withArrow
    >
      <Button
        size="compact-xs"
        variant="subtle"
        color={errored ? "red" : "indigo"}
        leftSection={<IconLanguage size={13} />}
        rightSection={<IconSparkles size={11} style={{ opacity: 0.7 }} />}
        style={{ flexShrink: 0 }}
        onClick={translate}
      >
        {errored ? "번역 재시도" : "AI 한국어 번역"}
      </Button>
    </Tooltip>
  );
}
