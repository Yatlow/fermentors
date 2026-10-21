/** Only the recorded progression and explicit checks in this form session
 * decide whether missing-field hints are visible. Old persisted reviewedSteps
 * are intentionally ignored: they are not evidence of current progress.
 */
export type ValidationPosition = { blockIndex: number; stepIndex: number };
export function reviewedStepsForPosition(
  position: ValidationPosition,
  stepIds: readonly string[],
  explicitlyReviewed: Readonly<Record<string, boolean>> = {},
): Record<string, boolean> {
  const reviewed: Record<string, boolean> = { ...explicitlyReviewed };
  for (let block = 1; block <= position.blockIndex; block++) {
    const limit = block < position.blockIndex ? stepIds.length : Math.max(0, position.stepIndex);
    for (let index = 0; index < limit && index < stepIds.length; index++) {
      if (stepIds[index] !== "summary") reviewed[`${block}:${stepIds[index]}`] = true;
    }
  }
  return reviewed;
}

export function laterValidationPosition(a: ValidationPosition, b: ValidationPosition): ValidationPosition {
  return a.blockIndex > b.blockIndex || (a.blockIndex === b.blockIndex && a.stepIndex >= b.stepIndex) ? a : b;
}

/** Navigation tabs are not proof that a brew has progressed.
 * Resume and initial validation must derive from recorded brewing activity,
 * never from activeBlockIndex/activeStepIndex (the last visited screen).
 */
export type RecordedBrewProgress = {
  blockIndex?: number | null;
  stageName?: string | null;
  stageStartTimeText?: string | null;
  stageEndTimeText?: string | null;
};
export type RecordedBrewBlock = { fields?: Record<string, string> };

export function brewStepFromStageName(stageName: string): number {
  const name = stageName.trim();
  if (/WP|ווירפול|תסיסה/i.test(name)) return 4;
  if (/רתיחה|כשות/.test(name)) return 3;
  if (/L\.T|לאוטר|סחרור|שטיפה|הוצאה לבישול|סוף העברה|העברה ל/.test(name)) return 2;
  if (/לתת|מאש|השריה|חימום/.test(name)) return 1;
  return 0;
}

function liveRecordedPosition(
  progress: RecordedBrewProgress | null | undefined,
  totalBlocks: number,
): ValidationPosition | null {
  const liveBlock = Number(progress?.blockIndex);
  const liveName = String(progress?.stageName ?? "").trim();
  // The last *visited* tab is not a progress report. Require a real timestamp.
  if (!liveName || !Number.isInteger(liveBlock) || liveBlock < 1 ||
    liveBlock > totalBlocks || !(
      String(progress?.stageStartTimeText ?? "").trim() ||
      String(progress?.stageEndTimeText ?? "").trim()
    )) return null;
  return { blockIndex: liveBlock, stepIndex: brewStepFromStageName(liveName) };
}

const RECORDED_STAGES: ReadonlyArray<{ stepIndex: number; keys: readonly string[] }> = [
  { stepIndex: 4, keys: ["outToFermentor.start", "wp.start"] },
  { stepIndex: 3, keys: ["boil.start"] },
  { stepIndex: 2, keys: ["transferLt.start", "restLt.start", "circulation.start", "outToBoil.start"] },
  { stepIndex: 1, keys: ["mashIn.start", "rest1.start"] },
  { stepIndex: 0, keys: ["brewDate", "hltWaterAmount", "lauterWaterAmount", "materialsConfirmed"] },
];

export function recordedBrewPosition(
  progress: RecordedBrewProgress | null | undefined,
  blocks: Readonly<Record<string, RecordedBrewBlock>>,
  totalBlocks: number,
): ValidationPosition {
  const count = Math.max(1, Math.min(3, Math.trunc(totalBlocks) || 1));
  const live = liveRecordedPosition(progress, count);
  if (live) return live;

  // In overlapping A/B/C brews, B can have water/mash data while A is still
  // transferring. A later block number alone is NOT later process progress.
  // When live timing is absent, prefer the deepest actually recorded stage.
  for (const stage of RECORDED_STAGES) {
    for (let block = count; block >= 1; block--) {
      const fields = blocks[String(block)]?.fields || {};
      if (stage.keys.some(key => String(fields[key] ?? "").trim())) {
        return { blockIndex: block, stepIndex: stage.stepIndex };
      }
    }
  }
  return { blockIndex: 1, stepIndex: 0 };
}

/** Initial checks follow each block's own recorded process, not a fictional
 * sequence in which all of A must be finished before B can start.
 * Explicit Next presses still count as a review of that specific step only.
 */
export function reviewedStepsFromRecordedWork(
  progress: RecordedBrewProgress | null | undefined,
  blocks: Readonly<Record<string, RecordedBrewBlock>>,
  totalBlocks: number,
  stepIds: readonly string[],
  explicitlyReviewed: Readonly<Record<string, boolean>> = {},
): Record<string, boolean> {
  const count = Math.max(1, Math.min(3, Math.trunc(totalBlocks) || 1));
  const live = liveRecordedPosition(progress, count);
  const reviewed: Record<string, boolean> = { ...explicitlyReviewed };
  for (let block = 1; block <= count; block++) {
    const blockRecorded = recordedBrewPosition(null, { "1": blocks[String(block)] || {} }, 1);
    const stepIndex = live?.blockIndex === block
      ? Math.max(blockRecorded.stepIndex, live.stepIndex)
      : blockRecorded.stepIndex;
    for (let step = 0; step < Math.min(stepIndex, stepIds.length); step++) {
      if (stepIds[step] !== "summary") reviewed[`${block}:${stepIds[step]}`] = true;
    }
  }
  return reviewed;
}
