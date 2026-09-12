/**
 * PAT-2723: "AI 한국어 번역" toggle in the page header.
 *
 * Reflects the shared translation job for this page version (started by
 * anyone) and the user's own view state — see use-page-translate.ts:
 *  - idle            → start a translation
 *  - busy + viewing  → a job is running and the translation is showing
 *  - busy + !viewing → a job is running (someone started it); click to watch
 *                      the stream live — a new job cannot be started
 *  - done + viewing  → showing a finished translation ("저장됨" = served from
 *                      cache); the (i) menu offers reprocessing
 *  - done + !viewing → a finished translation exists; click to apply it
 * Explicit AI indicator (✦) so users know the translated view is AI-generated.
 */
import { ActionIcon, Button, Group, Menu, Tooltip } from "@mantine/core";
import {
  IconInfoCircle,
  IconLanguage,
  IconLoader2,
  IconSparkles,
} from "@tabler/icons-react";
import { usePageTranslate } from "@/ee/ai/hooks/use-page-translate.ts";
import { usePageQuery } from "@/features/page/queries/page-query.ts";
import { extractPageSlugId } from "@/lib";
import { useParams } from "react-router-dom";

export default function PageTranslateToggle() {
  const { pageSlug } = useParams();
  const { data: page } = usePageQuery({ pageId: extractPageSlugId(pageSlug) });
  const { phase, viewing, cached, progress, toggleView, reprocess } =
    usePageTranslate(page?.id);

  if (phase === "hidden") return null;

  const progressLabel = `${progress.done}/${progress.total}`;

  if (phase === "busy") {
    if (viewing) {
      return (
        <Tooltip label="AI 번역이 진행 중입니다. 클릭하면 원문으로 돌아갑니다." openDelay={250} withArrow>
          <Button
            size="compact-xs"
            variant="light"
            color="indigo"
            leftSection={<IconLoader2 size={13} className="spin" />}
            style={{ flexShrink: 0 }}
            onClick={toggleView}
          >
            AI 번역 중 {progressLabel}
          </Button>
        </Tooltip>
      );
    }
    return (
      <Tooltip label="이 페이지의 번역이 진행 중입니다. 클릭하면 실시간으로 함께 봅니다." openDelay={250} withArrow>
        <Button
          size="compact-xs"
          variant="light"
          color="indigo"
          leftSection={<IconLoader2 size={13} className="spin" />}
          style={{ flexShrink: 0 }}
          onClick={toggleView}
        >
          AI 번역 진행 중 {progressLabel}
        </Button>
      </Tooltip>
    );
  }

  if (phase === "done") {
    if (viewing) {
      return (
        <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
          <Tooltip
            label="AI 번역본을 표시 중입니다. 클릭하면 원문으로 돌아갑니다."
            openDelay={250}
            withArrow
          >
            <Button
              size="compact-xs"
              variant="light"
              color="indigo"
              leftSection={<IconSparkles size={13} />}
              onClick={toggleView}
            >
              AI 번역본 표시 중{cached ? " (저장됨)" : ""} · 원문 보기
            </Button>
          </Tooltip>
          {cached && (
            <Menu position="bottom-end" shadow="md" width={220} withArrow>
              <Menu.Target>
                <Tooltip label="번역이 이상하게 보이나요?" openDelay={250} withArrow>
                  <ActionIcon
                    size="compact-xs"
                    variant="subtle"
                    color="gray"
                    aria-label="번역 옵션"
                  >
                    <IconInfoCircle size={14} />
                  </ActionIcon>
                </Tooltip>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item onClick={reprocess}>
                  번역 다시 처리하기
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          )}
        </Group>
      );
    }
    return (
      <Tooltip label="완료된 AI 번역본을 표시합니다." openDelay={250} withArrow>
        <Button
          size="compact-xs"
          variant="subtle"
          color="indigo"
          leftSection={<IconSparkles size={13} />}
          rightSection={<IconLanguage size={11} style={{ opacity: 0.7 }} />}
          style={{ flexShrink: 0 }}
          onClick={toggleView}
        >
          AI 번역본 보기
        </Button>
      </Tooltip>
    );
  }

  const errored = phase === "error";
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
        onClick={toggleView}
      >
        {errored ? "번역 재시도" : "AI 한국어 번역"}
      </Button>
    </Tooltip>
  );
}
