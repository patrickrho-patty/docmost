/**
 * Typed accessor for workspace.settings.ai — avoids ad-hoc anonymous casts
 * at every AI gate (controllers, services, repos).
 */
export interface WorkspaceAiSettings {
  search?: boolean;
  chat?: boolean;
  chatReadOnly?: boolean;
  chatWorkspaceKnowledgeOnly?: boolean;
  generative?: boolean;
  [key: string]: unknown;
}

export function getAiSettings(workspace: {
  settings?: unknown;
}): WorkspaceAiSettings {
  const settings = (workspace?.settings ?? {}) as { ai?: WorkspaceAiSettings };
  return settings?.ai ?? {};
}
