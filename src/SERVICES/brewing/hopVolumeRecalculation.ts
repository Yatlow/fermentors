/** Decide which hop amounts to write when kettle volume is committed.
 * Initial entry calculates all hops, including copied Master placeholders.
 * Existing quantities are preserved on later edits until the brewer confirms
 * recalculation. Missing/zero quantities are safe to fill at any time.
 */
export function shouldRecalculateHopAmount(
    previousVolume: number | null,
    existingGrams: number | null,
    forceRecalculate: boolean,
): boolean {
    return forceRecalculate ||
        previousVolume === null ||
        existingGrams === null ||
        existingGrams <= 0;
}
