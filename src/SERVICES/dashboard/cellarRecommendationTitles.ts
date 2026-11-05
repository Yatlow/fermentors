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

function scheduledTitle(input: CellarRecommendationTitleInput): string {
    const note = input.scheduledNote?.trim();

    // A brewer's explicit decision is a decision, not advice. Keep its source
    // visible rather than misrepresenting it as a system recommendation.
    if (input.userDecision) {
        switch (input.actionType) {
            case "carbTest": return "החלטת סלרינג – בדיקת גיזוז";
            case "yeastDrop": return "החלטת סלרינג – הורדת שמרים";
            case "coolDown": return "החלטת סלרינג – קירור";
            case "bottomCarbonation": return "החלטת סלרינג – גיזוז מלמטה";
            case "pressureChange":
                return input.pressureDirection === "raise" ? "החלטת סלרינג – העלאת לחץ"
                    : input.pressureDirection === "lower" ? "החלטת סלרינג – הורדת לחץ"
                    : "החלטת סלרינג – שינוי לחץ";
            case "other": return `החלטת סלרינג – ${note || "פעולה אחרת"}`;
            default: return "החלטת סלרינג";
        }
    }

    // "Recommendation" must lead every actionable system-generated title,
    // including scheduled recommendations. The operator retains discretion.
    switch (input.actionType) {
        case "carbTest": return "המלצה מתוזמנת לבדיקת גיזוז";
        case "yeastDrop": return "המלצה מתוזמנת להורדת שמרים";
        case "coolDown": return "המלצה מתוזמנת לקירור";
        case "bottomCarbonation": return "המלצה מתוזמנת לגיזוז מלמטה";
        case "pressureChange":
            return input.pressureDirection === "raise" ? "המלצה מתוזמנת להעלאת לחץ"
                : input.pressureDirection === "lower" ? "המלצה מתוזמנת להורדת לחץ"
                : "המלצה מתוזמנת לשינוי לחץ";
        case "other": return `המלצה מתוזמנת – ${note || "פעולה אחרת"}`;
        default: return "המלצה מתוזמנת";
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
