export type BrewProgressLike = {
  blockIndex?: number | null;
  stageCode?: number | null;
  stageName?: string | null;
  stageStartTime?: unknown;
  stageEndTime?: unknown;
  stageStartTimeText?: string | null;
  stageEndTimeText?: string | null;
} | null | undefined;

function hasTimestamp(value: unknown): boolean {
  if (!value) return false;
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return record.seconds != null || record._seconds != null || typeof record.toDate === "function";
  }
  return false;
}

/**
 * The dashboard must not treat a stale label left on a reused fermentor as
 * evidence that the newly assigned brew has started. A real live stage always
 * carries either a clock value/timestamp or a canonical stage code. The
 * historical bug we are guarding against is specifically the impossible
 * "out to fermentor" label on a brand-new ACTION-0 batch with no timing data.
 */
export function hasCredibleLiveBrewProgress(progress: BrewProgressLike): boolean {
  if (!progress?.stageName) return false;

  const hasTime = Boolean(
    String(progress.stageStartTimeText ?? "").trim() ||
    String(progress.stageEndTimeText ?? "").trim() ||
    hasTimestamp(progress.stageStartTime) ||
    hasTimestamp(progress.stageEndTime),
  );
  if (hasTime) return true;

  const stageCode = Number(progress.stageCode);
  if (Number.isFinite(stageCode) && stageCode > 0 && stageCode !== 120) return true;

  return false;
}
