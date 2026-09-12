import React from "react";
import { Badge, Center, Group, Text } from "@mantine/core";
import DOMPurify from "dompurify";
import { useTranslation } from "react-i18next";
import { getPageIcon } from "@/lib";
import { timeAgo } from "@/lib/time.ts";
import { IPageSearch } from "@/features/search/types/search.types";

/** Shared sanitize policy for server-built highlight HTML. */
export const HIGHLIGHT_SANITIZE_CONFIG = {
  ALLOWED_TAGS: ["mark", "em", "strong", "b"],
  ALLOWED_ATTR: [] as string[],
};

interface PageSearchResultBodyProps {
  page: IPageSearch;
  showSpace?: boolean;
  showTime?: boolean;
}

/**
 * Presentational body of a page search result (icon, title, space, sanitized
 * highlight). Used inside Spotlight.Action (search-result-item) and plain
 * links (home hero).
 */
export function PageSearchResultBody({
  page,
  showSpace,
  showTime,
}: PageSearchResultBodyProps) {
  const { t } = useTranslation();

  return (
    <Group wrap="nowrap" w="100%">
      <Center>{getPageIcon(page?.icon)}</Center>

      <div style={{ flex: 1, minWidth: 0 }}>
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Text truncate>{page.title || t("Untitled")}</Text>
          {showTime && (
            <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
              {timeAgo(page.updatedAt)}
            </Text>
          )}
        </Group>

        {showSpace && page.space && (
          <Badge variant="light" size="xs" color="gray">
            {page.space.name}
          </Badge>
        )}

        {page?.highlight && (
          <Text
            opacity={0.6}
            size="xs"
            lineClamp={2}
            dangerouslySetInnerHTML={{
              __html: DOMPurify.sanitize(page.highlight, HIGHLIGHT_SANITIZE_CONFIG),
            }}
          />
        )}
      </div>
    </Group>
  );
}
