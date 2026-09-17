import { collection, doc, getDoc, getDocs } from "firebase/firestore";
import { db } from "../../firebase";

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

const STYLE_AVERAGE_TTL_MS = 5 * 60 * 1000;
const averageCache = new Map<string, { value: StyleAverages | null; loadedAt: number }>();
let stylesCache: { value: string[]; loadedAt: number } | null = null;
let stylesPending: Promise<string[]> | null = null;

export async function getStyleAverages(
    style: string
): Promise<StyleAverages | null> {
    if (!style) return null;

    const cached = averageCache.get(style);
    if (cached && Date.now() - cached.loadedAt < STYLE_AVERAGE_TTL_MS) {
        return cached.value;
    }

    const ref = doc(db, "styleAverages", style);
    const snapshot = await getDoc(ref);

    if (!snapshot.exists()) {
        console.warn("No style averages found for:", style);
        averageCache.set(style, { value: null, loadedAt: Date.now() });
        return null;
    }

    const value = {
        ...snapshot.data(),
        days: snapshot.data().days ?? {},
    } as StyleAverages;
    averageCache.set(style, { value, loadedAt: Date.now() });
    return value;
}

export async function getAllStyleAverageStyles(): Promise<string[]> {
    if (stylesCache && Date.now() - stylesCache.loadedAt < STYLE_AVERAGE_TTL_MS) {
        return [...stylesCache.value];
    }
    if (stylesPending) return [...await stylesPending];

    stylesPending = (async () => {
        const snapshot = await getDocs(collection(db, "styleAverages"));
        const styles = snapshot.docs
            .map((docSnap) => docSnap.id)
            .filter((id): id is string => !!id)
            .sort((a, b) => a.localeCompare(b, "he"));
        stylesCache = { value: styles, loadedAt: Date.now() };
        return styles;
    })();

    try {
        return [...await stylesPending];
    } finally {
        stylesPending = null;
    }
}
