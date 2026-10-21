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
  if (/L\\.T|לאוטר|סחרור|שטיפה|הוצאה לבישול|סוף העברה|העברה ל/.test(name)) return 2;
  if (/לתת|מאש|השריה|חימום/.test(name)) return 1;
  return 0;
}

export function recordedBrewPosition(
  progress: RecordedBrewProgress | null | undefined,
  blocks: Readonly<Record<string, RecordedBrewBlock>>,
  totalBlocks: number,
): ValidationPosition {
  const count = Math.max(1, Math.min(3, Math.trunc(totalBlocks) || 1));
  const liveBlock = Number(progress?.blockIndex);
  const liveName = String(progress?.stageName ?? "").trim();
  // A valid time is present on real progress reports. Do not use unstarted
  // stage labels left behind on a recycled fermenter.
  if (
    liveName &&
    Number.isInteger(liveBlock) && liveBlock >= 1 && liveBlock <= count &&
    (String(progress?.stageStartTimeText ?? "").trim() ||
      String(progress?.stageEndTimeText ?? "").trim())
  ) {
    return { blockIndex: liveBlock, stepIndex: brewStepFromStageName(liveName) };
  }

  const stages: ReadonlyArray<{ stepIndex: number; keys: readonly string[] }> = [
    { stepIndex: 4, keys: ["outToFermentor.start", "wp.start"] },
    { stepIndex: 3, keys: ["boil.start"] },
    { stepIndex: 2, keys: ["transferLt.start", "restLt.start", "circulation.start", "outToBoil.start"] },
    { stepIndex: 1, keys: ["mashIn.start", "rest1.start"] },
    { stepIndex: 0, keys: ["brewDate", "hltWaterAmount", "lauterWaterAmount", "materialsConfirmed"] },
  ];
  // The latest block with *recorded* work is authoritative if the tank's live
  // progress is absent (legacy or archived batches).
  for (let block = count; block >= 1; block--) {
    const fields = blocks[String(block)]?.fields || {};
    for (const stage of stages) {
      if (stage.keys.some(key => String(fields[key] ?? "").trim())) {
        return { blockIndex: block, stepIndex: stage.stepIndex };
      }
    }
  }
  return { blockIndex: 1, stepIndex: 0 };
}
