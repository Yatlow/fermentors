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
