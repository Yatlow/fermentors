/** A fermenting tank with no valid temperature is UNKNOWN, not cold.
 * Treat unknown temperatures as warm for required Plato/pH measurements.
 * A verified temperature <=9°C keeps the existing cold-reading exemption.
 * Grace eligibility is calculated separately and must not be changed here.
 */
export type CellarTemperatureTank = {
    stage?: { name?: string } | null;
    currentData?: { temp?: string | number | null } | null;
};
export function requiresFermentationPlatoPh(tank: CellarTemperatureTank): boolean {
    if (tank.stage?.name !== "בתסיסה") return false;
    const temp = tank.currentData?.temp;
    if (temp === undefined || temp === null || String(temp).trim() === "") return true;
    const numeric = Number(temp);
    return !Number.isFinite(numeric) || numeric > 9;
}
