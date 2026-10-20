/** Mirrors the brewery's correction worksheet: volume * (1 - salinity / 11) * 0.01. */
export function calculateSalinityCorrection(volume: number, salinity: number): number | null {
    if (!Number.isFinite(volume) || !Number.isFinite(salinity) ||
        volume < 0 || salinity < 0 || salinity > 11) return null;
    return volume * (1 - salinity / 11) * 0.01;
}
