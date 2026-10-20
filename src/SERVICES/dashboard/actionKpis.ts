export type ActionCategory = "pressure" | "other" | "carb" | "yeast";
export type ActionRecord = {
    id: string;
    tankNumber?: string;
    batchNumber?: string;
    title?: string;
    detail?: string;
    recommendationKey?: string;
    scheduledActionType?: string;
};
export type ActionCount = { done: number; total: number };

const classify = (value: string): ActionCategory | null => {
    if (/pressureAdjustment|pressureChange|pressure-adjust|pressure-change|שינוי לחץ|העלאת לחץ|הורדת לחץ/i.test(value)) return "pressure";
    if (/carb|carbonation|גיזוז/i.test(value)) return "carb";
    if (/yeast|שמרים/i.test(value)) return "yeast";
    if (/^(?:other|ventAdjust)$/i.test(value)) return "other";
    if (/pressureClose|pressure-close|vent-adjust|dryHop|coolDown|cooling|diacetyl|neglectedStatus|סגירת נשם|סגירת מיכל|כיוון פורק|דרייהופ|כשות|קירור|דיאצטיל|פעולה אחרת|reported-other|scheduled-other/i.test(value)) return "other";
    return null;
};

const normalizeType = (value: string): string => {
    if (/pressureAdjustment|pressureChange|pressure-adjust|pressure-change|שינוי לחץ|העלאת לחץ|הורדת לחץ/i.test(value)) return "pressureAdjustment";
    if (/pressureClose|pressure-close|סגירת נשם|סגירת מיכל/i.test(value)) return "pressureClose";
    if (/vent-adjust|כיוון פורק/i.test(value)) return "ventAdjust";
    if (/dryHop|דרייהופ|כשות/i.test(value)) return "dryHop";
    if (/coolDown|cooling|קירור/i.test(value)) return "coolDown";
    if (/diacetyl|דיאצטיל/i.test(value)) return "diacetylRest";
    if (/neglectedStatus/i.test(value)) return "neglectedStatus";
    if (/reported-other|scheduled-other|פעולה אחרת/i.test(value)) return "other";
    return value;
};

const identity = (record: ActionRecord, rawKey: string): string => {
    const batch = String(record.batchNumber || record.tankNumber).replace(/^#/, "");
    const scheduledId = rawKey.startsWith("scheduled-") ? rawKey.slice("scheduled-".length) : null;
    return `${batch}:${scheduledId ? `scheduled:${scheduledId}` : normalizeType(record.scheduledActionType === "other" && rawKey === "pressureAdjustment"
        ? "vent-adjust" : rawKey + " " + (record.title || ""))}`;
};

export function calculateActionKpis(alerts: ActionRecord[], completedActions: ActionRecord[]): Record<"pressure" | "other", ActionCount> {
    const required = { pressure: new Set<string>(), other: new Set<string>() };
    const completed = { pressure: new Set<string>(), other: new Set<string>() };
    for (const alert of alerts) {
        const key = alert.recommendationKey;
        if (!key || key === "measurementRound" || !alert.tankNumber) continue;
        // Classify by structured action type, never by explanatory prose. A carbonation
        // follow-up can mention yesterday\'s pressure change without being a pressure action.
        const category = classify(alert.scheduledActionType || key);
        if (category === "pressure" || category === "other") required[category].add(identity(alert, key));
    }
    for (const action of completedActions) {
        const category = classify(`${action.id} ${action.title || ""}`);
        if (category === "pressure" || category === "other") completed[category].add(identity(action, action.id));
    }
    const count = (category: "pressure" | "other"): ActionCount => ({
        done: completed[category].size,
        total: new Set([...required[category], ...completed[category]]).size,
    });
    return { pressure: count("pressure"), other: count("other") };
}
