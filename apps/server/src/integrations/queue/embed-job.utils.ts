/**
 * Coalesce rapid successive embed triggers for the same page (typing bursts
 * fire PAGE_UPDATED + PAGE_CONTENT_UPDATED together) into one delayed job.
 * Used by both page.listener.ts and persistence.extension.ts — the identical
 * jobId is what makes BullMQ collapse the burst, so it must come from here.
 *
 * Only for single-page upsert jobs — delete jobs must never be dropped.
 */
export function embedJobOptions(pageIds: string[]) {
  if (pageIds?.length !== 1) return undefined;
  return { jobId: `embed-${pageIds[0]}`, delay: 3000 };
}
