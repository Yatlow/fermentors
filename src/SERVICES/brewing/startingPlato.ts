export type StartingPlatoBlockInput = {
    endBoilPlato: number | null | undefined;
    endBoilVolumeLiters: number | null | undefined;
};

export type StartingPlatoResult = {
    value: number | null;
    completedBlocks: number;
    isPartial: boolean;
};

/**
 * Calculates the rolling, volume-weighted starting Plato for the batch.
 *
 * Each brew block contributes its own end-of-boil sample:
 *   correctedPlato = endBoilPlato + 0.05
 *   weight = endBoilVolumeLiters
 *
 * Neither the "תחילת תסיסה" Plato nor the cumulative fermentor volume are used
 * here: the former is already mixed in the FV, while the latter is optional
 * after brew A and can include transfer losses.
 */
export function calculateWeightedStartingPlato(
    blocks: StartingPlatoBlockInput[],
): StartingPlatoResult {
    let weightedTotal = 0;
    let includedVolume = 0;
    let completedBlocks = 0;
    let isPartial = false;

    for (const block of blocks) {
        const hasRawPlato =
            block.endBoilPlato !== null &&
            block.endBoilPlato !== undefined;
        const hasRawVolume =
            block.endBoilVolumeLiters !== null &&
            block.endBoilVolumeLiters !== undefined;

        const plato = hasRawPlato ? Number(block.endBoilPlato) : NaN;
        const endBoilVolume = hasRawVolume
            ? Number(block.endBoilVolumeLiters)
            : NaN;

        const hasPlato = Number.isFinite(plato);
        const hasVolume = Number.isFinite(endBoilVolume) && endBoilVolume > 0;

        if (!hasPlato && !hasVolume) {
            isPartial = true;
            break;
        }

        if (!hasPlato || !hasVolume) {
            isPartial = true;
            break;
        }

        weightedTotal += (plato + 0.05) * endBoilVolume;
        includedVolume += endBoilVolume;
        completedBlocks += 1;
    }

    return {
        value: includedVolume > 0 ? weightedTotal / includedVolume : null,
        completedBlocks,
        isPartial: isPartial || completedBlocks < blocks.length,
    };
}
