import { doc, getDoc } from "firebase/firestore";
import { db } from "../firebase";

export type StyleAverageDay = {
    temp: number | null;
    plato: number | null;
    pH: number | null;
    pressure: number | null;
    carbonation: number | null;
    sampleCount: number;
};

export type StyleAverages = {
    style: string;
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
