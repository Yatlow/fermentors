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
    // pressureAdjustment is a legacy shared key for TWO different natural
    // recommendations. Use the explicit kind to match vent reports to vent
    // recommendations, instead of treating all of them as pressure changes.
    const actionIdentity = rawKey === "pressureAdjustment" &&
        (record.scheduledActionType === "ventAdjust" || record.scheduledActionType === "other")
        ? "vent-adjust"
        : rawKey + " " + (record.title || "");
    return `${batch}:${scheduledId ? `scheduled:${scheduledId}` : normalizeType(actionIdentity)}`;
};

export function calculateActionKpis(alerts: ActionRecord[], completedActions: ActionRecord[]): Record<"pressure" | "other", ActionCount> {
    const required = { pressure: new Set<string>(), other: new Set<string>() };
    const completed = { pressure: new Set<string>(), other: new Set<string>() };
    for (const alert of alerts) {
        const key = alert.recommendationKey;
        if (!key || key === "measurementRound" || !alert.tankNumber) continue;
        // Classify by structured action type, never by explanatory prose. A carbonation
        // follow-up can mention yesterday\'s pressure change without being a pressure action.
        // An untyped pressureAdjustment is ambiguous: the old key may mean
        // adjusting the regulator (other) or raising/lowering pressure. The
        // recommendation engine now always supplies its actual action kind.
        const category = key === "pressureAdjustment" && !alert.scheduledActionType
            ? null
            : classify(alert.scheduledActionType || key);
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

/** Pressure operations are physical raising/lowering only, not tuning a vent,
 * closing a breather, or carbonating from below. Shared with scheduled evidence. */
export function hasExplicitPressureChangeAction(notes: string): boolean {
    return /העלאת\s+לחץ|הורדת\s+לחץ|להעלות\s+לחץ|להוריד\s+לחץ/.test(notes);
}
