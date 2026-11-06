/**
 * Human-readable, action-specific titles for Cellaring dashboard alerts.
 * Only presentation is affected: recommendation keys, scoring and completion
 * rules stay untouched. Variants are set by the engine from actual evidence,
 * never inferred from a localized reason string.
 */
export type CellarTitleVariant =
    | "afterDryHop"
    | "warmFermentation"
    | "afterCooling"
    | "additionalAfterSunday"
    | "firstAfterCooling"
    | "firstAfterCoolingOverdue"
    | "retest"
    | "retestAfterPressureChange"
    | "retestAfterBottomCarbonation"
    | "prePackaging"
    | "firstInRange"
    | "outOfSpec"
    | "ventAdjust";

export type CellarRecommendationTitleInput = {
    tankNumber: string | number;
    recommendationKey: string;
    titleVariant?: CellarTitleVariant;
    actionType?: string;
    userDecision?: boolean;
    pressureDirection?: "raise" | "lower";
    pressureSuggestion?: "raise" | "lower";
    carbonationTestOutOfSpec?: boolean;
    reviewOnly?: boolean;
    scheduledNote?: string;
};

/**
 * Persisted scheduled cellar rows are brewer decisions. Unlike the forecast's
 * calculated/conditional recommendations, they were manually created in the
 * scheduling panel. Older records may lack source: "user", so never infer
 * their origin from that optional legacy field.
 */
function scheduledTitle(input: CellarRecommendationTitleInput): string {
    switch (input.actionType) {
        case "carbTest": return "החלטת סלרינג – בדיקת גיזוז";
        case "yeastDrop": return "החלטת סלרינג – הורדת שמרים";
        case "coolDown": return "החלטת סלרינג – קירור";
        case "bottomCarbonation": return "החלטת סלרינג – גיזוז מלמטה";
        case "pressureChange":
            return input.pressureDirection === "raise" ? "החלטת סלרינג – העלאת לחץ"
                : input.pressureDirection === "lower" ? "החלטת סלרינג – הורדת לחץ"
                : "החלטת סלרינג – שינוי לחץ";
        case "other": return `החלטת סלרינג – ${input.scheduledNote?.trim() || "פעולה אחרת"}`;
        default: return "החלטת סלרינג";
    }
}

/** Build the complete title, including the tank number, for all alert views. */
export function cellarRecommendationTitle(input: CellarRecommendationTitleInput): string {
    const key = input.recommendationKey;
    const variant = input.titleVariant;
    let description: string;

    if (input.reviewOnly) {
        description = "סייג לפני קירור";
    } else if (key.startsWith("scheduled-")) {
        description = scheduledTitle(input);
    } else {
        switch (key) {
            case "dryHop":
                description = "המלצה לביצוע דרייהופ"; break;
            case "pressureClose":
                description = "המלצה לסגירת מיכל"; break;
            case "warmYeastDrop":
                description = variant === "afterDryHop"
                    ? "המלצה להורדת שמרים אחרי דרייהופ"
                    : "המלצה להורדת שמרים במהלך תסיסה";
                break;
            case "warmYeastDropCompletion":
                description = "המלצה להשלמת הורדת שמרים חמה"; break;
            case "yeastDropAfterCooling":
                description = variant === "additionalAfterSunday"
                    ? "המלצה להורדת שמרים נוספת"
                    : "המלצה להורדת שמרים אחרי קירור";
                break;
            case "coldYeastDropCompletion":
                description = "המלצה להשלמת הורדת שמרים קרה"; break;
            case "wedYeastDropOnThu":
                description = "המלצה להורדת שמרים לפני אריזה"; break;
            case "carbTest":
                switch (variant) {
                    case "firstAfterCooling":
                        description = "המלצה לבדיקת גיזוז ראשונה אחרי קירור"; break;
                    case "firstAfterCoolingOverdue":
                        description = "המלצה לבדיקת גיזוז ראשונה באיחור"; break;
                    case "retestAfterPressureChange":
                        description = "המלצה לבדיקת גיזוז חוזרת אחרי שינוי לחץ"; break;
                    case "retestAfterBottomCarbonation":
                        description = "המלצה לבדיקת גיזוז חוזרת אחרי גיזוז מלמטה"; break;
                    case "retest":
                        description = "המלצה לבדיקת גיזוז חוזרת"; break;
                    case "prePackaging":
                        description = "המלצה לבדיקת גיזוז לפני אריזה"; break;
                    default:
                        description = "המלצה לבדיקת גיזוז";
                }
                break;
            case "bottomCarbonation":
                description = "המלצה להתחלת גיזוז מלמטה"; break;
            case "bottomCarbonationFollowUp":
                description = "המלצה לסגירת גיזוז מלמטה"; break;
            case "diacetylRest":
                description = "המלצה לביצוע מנוחת דיאצטיל"; break;
            case "neglectedStatus":
                description = "המלצה לבדיקת מצב המיכל"; break;
            case "coolDown":
                description = "המלצה להתחלת קירור"; break;
            case "pressureAdjustment":
                if (variant === "firstInRange") {
                    description = "המלצה לבחינת הלחץ לאחר גיזוז תקין ראשון";
                } else if (variant === "ventAdjust" || input.actionType === "ventAdjust") {
                    description = "המלצה לכיוון פורק";
                } else if (input.carbonationTestOutOfSpec && input.pressureSuggestion === "raise") {
                    description = "המלצה להעלאת לחץ";
                } else if (input.carbonationTestOutOfSpec && input.pressureSuggestion === "lower") {
                    description = "המלצה להורדת לחץ";
                } else if (input.carbonationTestOutOfSpec) {
                    description = "המלצה לשינוי לחץ לאחר בדיקת גיזוז לא תקינה";
                } else {
                    description = "המלצה לשינוי לחץ";
                }
                break;
            default:
                description = "המלצה כללית לסלרינג";
        }
    }
    return `מיכל ${input.tankNumber}: ${description}`;
}


/**
 * "Ignored today" is a log of the underlying action, not another recommendation.
 * Preserve the source title (for newly ignored alerts), removing only its tank
 * prefix and the word "המלצה". Legacy records stored truncated titles, so the
 * canonical recommendation title is used only when the saved title is generic.
 *
 * This is presentation-only: it does not touch Firestore identities, the
 * importance level, restoration, the recommendation engine or cellar KPIs.
 */
export type IgnoredCellarActionTitleInput = CellarRecommendationTitleInput & {
    title?: string | null;
    detail?: string | null;
    importance?: number | null;
    autoReason?: string | null;
};

function ignoredTitleText(title: string | null | undefined): string {
    return String(title ?? "")
        .trim()
        .replace(/^מיכל\s+\S+\s*[:·]\s*/u, "")
        .replace(/^המלצה\s+ל/u, "")
        .replace(/^המלצה\s+/u, "")
        .trim();
}

// Titles written by older versions were broad, sometimes losing the *entire*
// recommendation subtype (e.g. a yeast-drop completion became "הורדת שמרים").
const legacyShortTitles = new Set([
    "סבב מדידות", "דרייהופ", "סגירת לחץ", "הורדת שמרים",
    "בדיקת גיזוז", "גיזוז מלמטה", "מנוחת דיאצטיל",
    "טיפול במיכל", "קירור", "שינוי לחץ", "מתוזמנת",
]);

export function cellarIgnoredActionTitle(input: IgnoredCellarActionTitleInput): string {
    const key = input.recommendationKey;

    // An auto-ignored moderate retest always originates from the Friday
    // carbonation-retest gate. A first-after-cooling test is never auto-ignored
    // by that gate. Never infer this subtype from importance alone.
    if (key === "carbTest" && input.autoReason && input.importance === 2) {
        return "בדיקת גיזוז חוזרת (סטייה נמוכה בגיזוז)";
    }
    if (key === "neglectedStatus") return "טיפול במיכל מוזנח";
    if (key === "measurementRound") return "השלמת סבב מדידות";

    const saved = ignoredTitleText(input.title);
    if (saved && !legacyShortTitles.has(saved)) {
        return saved;
    }

    // Legacy generic text has no subtype. Derive from canonical keys and
    // available structured metadata, never fabricate a missing event type.
    if (key.startsWith("scheduled-") && !input.actionType) {
        return "החלטת סלרינג";
    }
    if (key === "carbTest" && !input.titleVariant && saved === "בדיקת גיזוז") {
        // Old records may explicitly name a repeat or first test in the
        // persisted description. This fallback affects display only.
        const detail = String(input.detail ?? "");
        if (/בדיקת\s+ה?גיזוז\s+חוזרת/u.test(detail)) return "בדיקת גיזוז חוזרת";
        if (/בדיקת\s+ה?גיזוז\s+(?:הראשונה|ראשונה)/u.test(detail)) return "בדיקת גיזוז ראשונה אחרי קירור";
    }

    return ignoredTitleText(cellarRecommendationTitle(input));
}
