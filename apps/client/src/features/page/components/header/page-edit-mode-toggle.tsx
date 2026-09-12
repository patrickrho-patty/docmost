/**
 * Page-header edit-mode toggle (PAT-2723 follow-up: the per-user default
 * preference was removed — the workspace setting is the single source of
 * truth). This toggle only flips the CURRENT page's mode for the session;
 * nothing is persisted.
 */
import { SegmentedControl, MantineSize } from "@mantine/core";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { currentPageEditModeAtom } from "@/features/editor/atoms/editor-atoms.ts";
import { PageEditMode } from "@/features/user/types/user.types.ts";

export function PageEditModeToggle({ size }: { size?: MantineSize }) {
  const { t } = useTranslation();
  const [currentPageEditMode, setCurrentPageEditMode] = useAtom(
    currentPageEditModeAtom,
  );

  return (
    <SegmentedControl
      size={size}
      value={currentPageEditMode}
      onChange={(v) => setCurrentPageEditMode(v as PageEditMode)}
      data={[
        { label: t("Edit"), value: PageEditMode.Edit },
        { label: t("Read"), value: PageEditMode.Read },
      ]}
    />
  );
}
