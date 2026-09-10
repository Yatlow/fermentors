import { calcHeightCm, type Pallet } from "./Pallettypes ";

export const MAX_TRUCK_SLOTS = 12;
export const MAX_TRUCK_HEIGHT_CM = 190;

export function calcTruckSlots(
    pallets: Pallet[]
): number {
    const heights = pallets
        .map((pallet) =>
            calcHeightCm(
                pallet.itemType,
                pallet.quantity
            )
        )
        .sort((a, b) => b - a);

    // כל מקום במשאית מתחיל כ"מקום" ריק.
    // בכל מקום אפשר לשים משטח אחד או לערום
    // משטח נוסף, כל עוד הגובה הכולל <= 190.
    const slots: number[] = [];

    for (const height of heights) {
        // אם המשטח עצמו גבוה מדי למשאית
        if (height > MAX_TRUCK_HEIGHT_CM) {
            throw new Error(
                `משטח בגובה ${height} ס"מ לא יכול להיכנס למשאית (מקסימום ${MAX_TRUCK_HEIGHT_CM} ס"מ)`
            );
        }

        // מחפשים מקום קיים שבו אפשר לערום אותו.
        // Best fit: נבחר את המקום שהכי קרוב ל-190
        // אחרי הכנסת המשטח.
        let bestSlotIndex = -1;
        let bestRemainingHeight =
            Infinity;

        for (
            let i = 0;
            i < slots.length;
            i++
        ) {
            const newHeight =
                slots[i] + height;

            if (
                newHeight <=
                MAX_TRUCK_HEIGHT_CM
            ) {
                const remaining =
                    MAX_TRUCK_HEIGHT_CM -
                    newHeight;

                if (
                    remaining <
                    bestRemainingHeight
                ) {
                    bestRemainingHeight =
                        remaining;

                    bestSlotIndex = i;
                }
            }
        }

        if (bestSlotIndex >= 0) {
            slots[bestSlotIndex] += height;
        } else {
            slots.push(height);
        }
    }

    return slots.length;
}
