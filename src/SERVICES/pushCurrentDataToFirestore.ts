import { doc, writeBatch } from "firebase/firestore";
import { db } from "../firebase";

const CURRENT_DATA_FIELDS = [
    "temp",
    "plato",
    "pH",
    "pressure",
    "carbonation",
    "volume",
    "notes",
    "isEmpty",
    "kegs",
    "crates",
    "totalLiters",
    "shrinkagePercent",
] as const;

type ReadingLike = { tankId: string; [key: string]: unknown };

export async function pushCurrentDataToFirestore(readings: ReadingLike[]) {
    const relevant = readings.filter((r) =>
        CURRENT_DATA_FIELDS.some((f) => r[f] !== undefined)
    );
    if (relevant.length === 0) return;

    const batch = writeBatch(db);

    relevant.forEach((reading) => {
        const currentData: Record<string, unknown> = {};
        CURRENT_DATA_FIELDS.forEach((field) => {
            if (reading[field] !== undefined) {
                currentData[field] = reading[field];
            }
        });

        const tankRef = doc(db, "fermentors", reading.tankId);
        // merge:true על שדה מקונן מבצע מיזוג per-field, לא דורס את כל currentData
        batch.set(tankRef, { currentData }, { merge: true });
    });

    await batch.commit();
}