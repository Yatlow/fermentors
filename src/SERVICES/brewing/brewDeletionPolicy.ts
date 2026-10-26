/**
 * Batch correction policy: delete + recreate is permitted only before the
 * brew starts. Keep this independent of Firestore so it can be regression-tested.
 */
export type BatchDeletionTank = {
    id: string;
    batchNumber?: unknown;
    action?: unknown;
    brewProgress?: { stageName?: unknown } | null;
};

export function batchDeletionBlockReason(
    batchNumber: string,
    tanks: BatchDeletionTank[],
    hasMeasurements: boolean,
    expectedTankId?: string,
): string | null {
    const batch = String(batchNumber || "").replace("#", "").trim();
    if (!batch) return "מספר אצווה חסר.";
    if (hasMeasurements) return `אי אפשר למחוק אצווה ${batch}: כבר קיימות עבורה מדידות.`;

    const active = tanks.filter((tank) => {
        const assigned = String(tank.batchNumber || "").replace("#", "").trim();
        return assigned === batch && (Number(tank.action) === 0 || Number(tank.action) === 1);
    });
    if (!expectedTankId) {
        return active.length
            ? `אי אפשר למחוק אצווה ${batch}: היא כבר משובצת למיכל. יש לרענן את הדף.`
            : null;
    }
    if (active.length !== 1 || active[0].id !== expectedTankId) {
        return "שיוך האצווה למיכל השתנה. יש לרענן את הדף לפני מחיקה.";
    }
    if (Number(active[0].action) !== 0 || active[0].brewProgress?.stageName) {
        return `אי אפשר למחוק אצווה ${batch}: הבישול כבר התחיל.`;
    }
    return null;
}
