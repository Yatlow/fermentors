import { doc, getDoc, collection, addDoc, Timestamp, updateDoc } from "firebase/firestore";
import { db } from "../firebase";
import {
    createPalletsFromCustomSplit,
    getDefaultPalletSplit,
    type CustomPalletSplitEntry,
} from "./Palletservice";
import type { PalletItemType } from "./Pallettypes ";

const GOOGLE_SCRIPT_URL =
    "https://script.google.com/macros/s/AKfycbzSq8vnL_P9DOkiXluKReSUNFILqlRkK-WxnPC_Q0BNt23rFHbLpRlkvPudbqElqw5h/exec";

export type PackagingType = "kegs" | "bottles";

const BOTTLES_PER_CRATE = 24;

/** שם הקולקציה בפיירסטור שאליה נכתבים אירועי אריזה בפועל (לצורך דוחות) */
const PACKAGING_LOG_COLLECTION = "packagingLog";

/**
 * ⚠️ חדש - חישוב סינכרוני בלבד (לא נוגע ברשת) של כמות המשטחים (חביות/ארגזים)
 * מתוך הכמות שדווחה. חשוב שזה יהיה פונקציה נפרדת וטהורה כדי ש-usePackagingPalletsFlow
 * יוכל להציג את מסך עריכת המשטחים מייד, בלי לחכות ל-submitPackagingRecord.
 */
export function computePalletQuantity(packagingType: PackagingType, amount: number): number {
    return packagingType === "kegs" ? amount : Math.floor(amount / BOTTLES_PER_CRATE);
}

function mapBeerStyleToExpiryKey(beerStyle: string | undefined | null): string | null {
    if (!beerStyle) return null;
    const s = String(beerStyle).trim();

    if (s.includes("הופי") && s.includes("לאגר")) return "הופי לאגר";
    if (s.includes("לאגר")) return "לאגר"; // כולל "ניו לאגר", "לאגר ג'ון ביר" וכו'
    if (s.includes("חיטה")) return "חיטה";
    if (s.includes("סטאוט")) return "סטאוט";
    if (s.includes("פייל")) return "פייל";
    if (/ipa/i.test(s)) return "ipa";

    return null;
}

/** שם השדה הקבוע לתוקף חביות בדוקומנט specs/bottleExpDat - לא תלוי בסגנון */
const KEG_BBE_FIELD = "kegBBE";

/**
 * שולף את מספר חודשי התוקף מ-specs/bottleExpDat.
 * לחביות: תמיד לפי השדה הקבוע kegBBE.
 * לבקבוקים: לפי מפתח הסגנון (mapBeerStyleToExpiryKey).
 */
export async function getExpiryMonths(
    packagingType: PackagingType,
    beerStyle: string | undefined | null
): Promise<number | null> {
    const fieldKey = packagingType === "kegs" ? KEG_BBE_FIELD : mapBeerStyleToExpiryKey(beerStyle);

    if (!fieldKey) {
        console.warn("packagingMasterSheetLogger: לא נמצא מפתח תוקף מתאים לסגנון:", beerStyle);
        return null;
    }
    const ref = doc(db, "specs", "bottleExpDat");
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    const data = snap.data() as Record<string, number>;
    const months = data[fieldKey];
    return typeof months === "number" ? months : null;
}

export function formatDDMMYYYY(d: Date): string {
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
}

export function addMonths(d: Date, months: number): Date {
    const result = new Date(d);
    result.setMonth(result.getMonth() + months);
    return result;
}

export async function getDefaultExpiryDateStr(
    packagingType: PackagingType,
    beerStyle: string | undefined | null,
    baseDate: Date = new Date()
): Promise<string> {
    const months = await getExpiryMonths(packagingType, beerStyle);
    return months === null ? "" : formatDDMMYYYY(addMonths(baseDate, months));
}

export type MasterSheetLogParams = {
    beerStyle: string | undefined | null;
    packagingType: PackagingType;
    /** כמות בקבוקים (לבקבוקים) או כמות חביות (לחביות) - כמו שהוזן ע"י המשתמש בטופס */
    amount: number;
    batchNumber: string | number | undefined | null;
    tankNumber: string | number | null;
    tankStatus: boolean;
};

export type MasterSheetLogResult = {
    success: boolean;
    warnings?: string[];
    error?: string;
};

/**
 * ⚠️ חדש - "תוכנית משטחים": כל המידע הדרוש כדי להציע חלוקת משטחי ברירת מחדל
 * ולאפשר למשתמש לערוך אותה, בלי שום תלות ברשת. מוחזר מ-submitPackagingRecord.
 */
export type PackagingPalletPlan = {
    itemType: PalletItemType;
    /** הכמות הכוללת בפועל (מספר חביות, או מספר ארגזים שלמים לבקבוקים) */
    quantity: number;
    beerStyle: string;
    batchNumber: string | number | null;
    expiryDateStr: string;
    sourceTankNumber: string | number | null;
    tankNumber: string | number | null;
};

export type SubmitPackagingRecordResult = {
    success: boolean;
    warnings?: string[];
    error?: string;
    /** null אם הכמות לא תקינה / אין צורך במשטחים בכלל */
    palletPlan: PackagingPalletPlan | null;
};

/**
 * כותבת אירוע אריזה בפועל לפיירסטור, לקולקציית packagingLog.
 * מבנה הדוקומנט תואם בכוונה למבנה של calendar_events (title/itemType/quantity/unit/timestamp)
 * כדי שיהיה קל לאחד בין השניים בקומפוננטת הדוחות.
 */
async function logPackagingToFirestore(params: {
    packagingType: PackagingType;
    beerStyle: string | undefined | null;
    quantity: number;
    batchNumber: string | number | undefined | null;
    productionDateStr: string;
    expiryDateStr: string;
    productDate: Date;
    tankNumber: string | number | null;
    tankStatus: boolean;
}): Promise<void> {
    const { packagingType, beerStyle, quantity, batchNumber, tankNumber, productionDateStr, expiryDateStr, productDate, tankStatus } = params;

    const unit = packagingType === "kegs" ? "חביות" : "ארגזים";
    const itemLabel = String(beerStyle ?? "").trim();
    const title =
        packagingType === "kegs"
            ? `אריזת חביות ${itemLabel} - ${quantity} חביות`
            : `אריזת ${itemLabel} - ${quantity} ארגזים`;

    await addDoc(collection(db, PACKAGING_LOG_COLLECTION), {
        source: "actual",
        packagingType,
        beerStyle: itemLabel,
        quantity,
        unit,
        batchNumber: batchNumber ?? "",
        tankNumber: tankNumber ?? null,
        productionDateStr,
        expiryDateStr,
        date: productionDateStr,
        timestamp: productDate.getTime(),
        title,
        createdAt: Timestamp.now(),
    });
    const docRef = doc(db, "fermentors", tankNumber?.toString() ?? "");
    try {
        await updateDoc(docRef, {
            tankStatus: tankStatus,
            action: 3,
        });
    } catch (err) {
        console.error("Failed to update tankStatus in Firestore:", err);
    }
}

/**
 * ⚠️ חדש - השלב ה"מהיר" בלבד: כתיבה לגיליון המאסטר + רישום בפיירסטור.
 * במכוון *לא* יוצרת משטחים - זה קורה בנפרד, אחרי שהמשתמש מאשר/עורך את
 * חלוקת המשטחים (ר' getDefaultPalletSplit + createPalletsFromCustomSplit).
 * יש לקרוא לפונקציה הזו מיד עם אישור הדיווח, בלי לחכות למסך עריכת המשטחים.
 */
export async function submitPackagingRecord(
    params: MasterSheetLogParams
): Promise<SubmitPackagingRecordResult> {
    const { beerStyle, packagingType, amount, batchNumber, tankNumber, tankStatus } = params;

    if (!amount || amount <= 0) {
        return { success: false, error: "כמות לא תקינה", palletPlan: null };
    }

    let expiryMonths: number | null = null;
    try {
        expiryMonths = await getExpiryMonths(packagingType, beerStyle);
    } catch (err) {
        console.error("Failed to fetch bottleExpDat from Firestore:", err);
    }

    const today = new Date();
    const productionDateStr = formatDDMMYYYY(today);
    const expiryDateStr =
        expiryMonths !== null ? formatDDMMYYYY(addMonths(today, expiryMonths)) : "";

    // עמודה B: לחביות - הכמות כפי שהוזנה. לבקבוקים - מספר ארגזים (24 בקבוק לארגז).
    const quantity = computePalletQuantity(packagingType, amount);

    if (packagingType === "bottles" && quantity <= 0) {
        // פחות מארגז שלם אחד - לא נכתב לטבלת המאסטר (נרשם ידנית במקום אחר)
        return { success: false, error: "פחות מארגז שלם - לא נכתב לטבלת המאסטר", palletPlan: null };
    }

    const productLabel =
        packagingType === "kegs"
            ? `חביות ${beerStyle ?? ""}`.trim()
            : `ארגזי ${beerStyle ?? ""}`.trim();

    const payload = {
        action: "logPackagingToMasterSheet",
        productLabel,
        quantity,
        batchNumber: batchNumber ?? "",
        expiryDateStr,
        productionDateStr,
    };

    // כותבים לגיליון ולפיירסטור במקביל. כשל באחד לא ימנע את השני.
    const [sheetResult, firestoreResult] = await Promise.allSettled([
        fetch(GOOGLE_SCRIPT_URL, {
            method: "POST",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify(payload),
        }),
        logPackagingToFirestore({
            packagingType,
            beerStyle,
            quantity,
            batchNumber,
            productionDateStr,
            expiryDateStr,
            productDate: today,
            tankNumber,
            tankStatus,
        }),
    ]);

    const warnings: string[] = [];

    if (firestoreResult.status === "rejected") {
        console.error("Failed to log packaging to Firestore:", firestoreResult.reason);
        warnings.push("הרישום לגיליון הצליח אך הרישום לפיירבייס נכשל");
    }

    // תוכנית המשטחים לא תלויה בהצלחת הכתיבה לגיליון - מחזירים אותה תמיד
    // (אלא אם הכמות עצמה לא תקינה, שנבדק כבר למעלה).
    const palletPlan: PackagingPalletPlan = {
        itemType: packagingType === "kegs" ? "kegs" : "crates",
        quantity,
        beerStyle: String(beerStyle ?? "").trim(),
        batchNumber: batchNumber ?? null,
        expiryDateStr,
        sourceTankNumber: tankNumber,
        tankNumber,
    };

    if (sheetResult.status === "rejected") {
        console.error("Failed to log packaging to master sheet:", sheetResult.reason);
        return {
            success: false,
            error: sheetResult.reason?.message ?? "שגיאה בכתיבה לטבלת המאסטר",
            warnings,
            palletPlan,
        };
    }

    try {
        const text = await sheetResult.value.text();
        let parsed: { success: boolean; error?: string; message?: string; warnings?: string[] };

        try {
            parsed = JSON.parse(text);
        } catch {
            throw new Error("Google Apps Script returned invalid JSON: " + text);
        }

        if (!parsed.success) {
            throw new Error(parsed.error || parsed.message || "Master sheet log failed");
        }

        if (parsed.warnings && parsed.warnings.length > 0) {
            warnings.push(...parsed.warnings);
        }

        return { success: true, warnings: warnings.length > 0 ? warnings : undefined, palletPlan };
    } catch (err: any) {
        console.error("Failed to log packaging to master sheet:", err);
        return { success: false, error: err?.message ?? "שגיאה בכתיבה לטבלת המאסטר", warnings, palletPlan };
    }
}

/**
 * ⚠️ חדש - יוצרת בפועל את המשטחים במפת המקרר, לפי תוכנית + חלוקה (שהמשתמש אישר/ערך).
 * נקראת בנפרד מ-submitPackagingRecord, אחרי מסך אישור חלוקת המשטחים.
 * זורקת שגיאה אם סכום החלוקה לא תואם בדיוק לכמות שדווחה בתוכנית (ר' Palletservice).
 */
export async function createPalletsForPlan(
    plan: PackagingPalletPlan,
    splits: CustomPalletSplitEntry[]
): Promise<string[]> {
    return createPalletsFromCustomSplit({
        itemType: plan.itemType,
        expectedTotalQuantity: plan.quantity,
        beerStyle: plan.beerStyle,
        batchNumber: plan.batchNumber,
        expiryDateStr: plan.expiryDateStr,
        sourceTankNumber: plan.sourceTankNumber,
        splits,
    });
}

/** נוחות: חלוקת ברירת המחדל להצגה ראשונית במסך העריכה, לפי תוכנית נתונה */
export function getDefaultSplitForPlan(plan: PackagingPalletPlan): CustomPalletSplitEntry[] {
    return getDefaultPalletSplit(plan.itemType, plan.quantity);
}

/**
 * @deprecated שמור לתאימות לאחור בלבד (עדיין חוסם עד ליצירת המשטחים, עם חלוקה אוטומטית).
 * לזרימה החדשה עם מסך עריכת משטחים - יש להשתמש ב-submitPackagingRecord,
 * ואז (אחרי אישור המשתמש) ב-createPalletsForPlan / createPalletsFromCustomSplit.
 */
export async function logPackagingToMasterSheet(
    params: MasterSheetLogParams
): Promise<MasterSheetLogResult> {
    const record = await submitPackagingRecord(params);
    const warnings = [...(record.warnings ?? [])];

    if (record.palletPlan) {
        try {
            const splits = getDefaultSplitForPlan(record.palletPlan);
            await createPalletsForPlan(record.palletPlan, splits);
        } catch (err) {
            console.error("Failed to create pallets for cooler map:", err);
            warnings.push("הרישום הצליח אך יצירת המשטחים במפת המקרר נכשלה - יש להוסיף ידנית");
        }
    }

    return {
        success: record.success,
        error: record.error,
        warnings: warnings.length > 0 ? warnings : undefined,
    };
}