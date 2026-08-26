import { collection, doc, getDoc, getDocs } from "firebase/firestore";
import { db } from "../firebase";

export type StyleAverageDay = {
    temp: number | null;
    plato: number | null;
    pH: number | null;
    pressure: number | null;
    carbonation: number | null;
    sampleCount: number;
    batchCount: number;
};

export type StyleAverages = {
    style: string;
    batchCount: number;
    sampleCount: number;
    updatedAt: string;
    days: Record<string, StyleAverageDay>;
};

export async function getStyleAverages(
    style: string
): Promise<StyleAverages | null> {

    if (!style) {
        return null;
    }

    const ref = doc(
        db,
        "styleAverages",
        style
    );

    const snapshot = await getDoc(ref);

    if (!snapshot.exists()) {
        console.warn(
            "No style averages found for:",
            style
        );

        return null;
    }

    return {
        ...snapshot.data(),
        days: snapshot.data().days ?? {},
    } as StyleAverages;
}

export async function getAllStyleAverageStyles(): Promise<string[]> {
  const snapshot = await getDocs(collection(db, "styleAverages"));

  const styles = snapshot.docs
    // אם אצלכם שם הסגנון הוא מזהה המסמך - doc.id מספיק.
    // אם יש שדה style/name בתוך המסמך במקום, תחליפו כאן ל-doc.data().style
    .map((docSnap) => docSnap.id)
    .filter((id): id is string => !!id);

  return styles.sort((a, b) => a.localeCompare(b, "he"));
}
