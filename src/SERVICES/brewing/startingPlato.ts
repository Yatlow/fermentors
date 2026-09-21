export type StartingPlatoBlockInput = {
    endBoilPlato: number | null | undefined;
    cumulativeTankVolumeLiters: number | null | undefined;
};

export type StartingPlatoResult = {
    value: number | null;
    completedBlocks: number;
    isPartial: boolean;
};

/**
 * Calculates the rolling, volume-weighted starting Plato for the batch.
 *
 * Each brew block contributes:
 *   correctedPlato = endBoilPlato + 0.05
 *   addedVolume = current cumulative tank volume - previous cumulative volume
 *
 * The "תחילת תסיסה" Plato cell is deliberately not used here because it is a
 * sample from the already-mixed fermentor, not a sample of the individual brew.
 */
export function calculateWeightedStartingPlato(
    blocks: StartingPlatoBlockInput[],
): StartingPlatoResult {
    let previousCumulativeVolume = 0;
    let weightedTotal = 0;
    let includedVolume = 0;
    let completedBlocks = 0;
    let isPartial = false;

    for (const block of blocks) {
        const plato = Number(block.endBoilPlato);
        const cumulativeVolume = Number(block.cumulativeTankVolumeLiters);

        const hasPlato = Number.isFinite(plato);
        const hasVolume = Number.isFinite(cumulativeVolume) && cumulativeVolume > 0;

        if (!hasPlato && !hasVolume) {
            isPartial = true;
            break;
        }

        if (!hasPlato || !hasVolume || cumulativeVolume <= previousCumulativeVolume) {
            isPartial = true;
            break;
        }

        const addedVolume = cumulativeVolume - previousCumulativeVolume;
        weightedTotal += (plato + 0.05) * addedVolume;
        includedVolume += addedVolume;
        previousCumulativeVolume = cumulativeVolume;
        completedBlocks += 1;
    }

    return {
        value: includedVolume > 0 ? weightedTotal / includedVolume : null,
        completedBlocks,
        isPartial: isPartial || completedBlocks < blocks.length,
    };
}
