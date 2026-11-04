import type { BrewRecipe } from "./brewRecipe";

/**
 * Old in-progress brew snapshots can lack rest-duration metadata despite
 * retaining their materials. Recover only ABSENT rest durations from the
 * current recipe for the exact same style; never override a non-empty
 * snapshot duration (including an explicit zero).
 */
export function restoreMissingMashRestDurations(
    snapshot: BrewRecipe,
    currentRecipe: BrewRecipe | null | undefined,
): BrewRecipe {
    if (!currentRecipe ||
        snapshot.style.trim().toLowerCase() !== currentRecipe.style.trim().toLowerCase()) {
        return snapshot;
    }

    const configured = new Map(currentRecipe.mash.steps.map(step => [step.id, step.minutes]));
    let changed = false;
    const steps = snapshot.mash.steps.map(step => {
        if (!/^rest[1-3]$/.test(step.id) || step.minutes != null) return step;
        const minutes = Number(configured.get(step.id));
        if (!Number.isFinite(minutes) || minutes <= 0) return step;
        changed = true;
        return { ...step, minutes };
    });

    return changed ? {
        ...snapshot,
        mash: { ...snapshot.mash, steps },
    } : snapshot;
}
