import SettingsTitle from "@/components/settings/settings-title.tsx";
import React from "react";
import useUserRole from "@/hooks/use-user-role.tsx";
import { useTranslation } from "react-i18next";
import EnableAiSearch from "@/ee/ai/components/enable-ai-search.tsx";
import EnableAiChat from "@/ee/ai-chat/components/enable-ai-chat.tsx";
import AiChatReadOnly from "@/ee/ai-chat/components/ai-chat-read-only.tsx";
import AiChatWorkspaceKnowledgeOnly from "@/ee/ai-chat/components/ai-chat-workspace-knowledge-only.tsx";
import { Alert, Collapse, Stack } from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";
import { useHasFeature } from "@/ee/hooks/use-feature";
import { Feature } from "@/ee/features";
import { useUpgradeLabel } from "@/ee/hooks/use-upgrade-label";
import { isCloud } from "@/lib/config.ts";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import { useAtomValue } from "jotai";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";

export default function AiSettings() {
  const { t } = useTranslation();
  const { isAdmin } = useUserRole();
  const hasAccess = useHasFeature(Feature.AI);
  const upgradeLabel = useUpgradeLabel();
  const workspace = useAtomValue(workspaceAtom);
  const aiChatEnabled = workspace?.settings?.ai?.chat === true;

  if (!isAdmin) {
    return null;
  }

  // patty fork (PAT-2332): the Generative AI toggle (broken /api/ai/generate)
  // and the MCP tab (no MCP server in this fork) are intentionally hidden.
  return (
    <>
      <DocumentTitle title="AI settings" />
      <SettingsTitle title={t("AI settings")} />

      {!hasAccess && (
        <Alert
          icon={<IconInfoCircle />}
          title={upgradeLabel}
          color="blue"
          mb="lg"
        >
          {t(
            "AI is available in the Docmost paid editions. Contact sales@docmost.com.",
          )}
        </Alert>
      )}

      <Stack gap="md">
        {!isCloud() && <EnableAiSearch />}
        <EnableAiChat />
        <Collapse expanded={aiChatEnabled}>
          <Stack
            gap="md"
            pl="md"
            ml="xs"
            style={{
              borderLeft:
                "2px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
            }}
          >
            <AiChatReadOnly />
            <AiChatWorkspaceKnowledgeOnly />
          </Stack>
        </Collapse>
      </Stack>
    </>
  );
}

