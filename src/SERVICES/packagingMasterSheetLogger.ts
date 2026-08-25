import { doc, getDoc } from "firebase/firestore";
import { db } from "../firebase"; 
 
const GOOGLE_SCRIPT_URL =
    "https://script.google.com/macros/s/AKfycbzSq8vnL_P9DOkiXluKReSUNFILqlRkK-WxnPC_Q0BNt23rFHbLpRlkvPudbqElqw5h/exec";
 
export type PackagingType = "kegs" | "bottles";
 
const BOTTLES_PER_CRATE = 24;
 

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
async function getExpiryMonths(
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
 
function formatDDMMYYYY(d: Date): string {
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
}
 
function addMonths(d: Date, months: number): Date {
    const result = new Date(d);
    result.setMonth(result.getMonth() + months);
    return result;
}
 
export type MasterSheetLogParams = {
    beerStyle: string | undefined | null;
    packagingType: PackagingType;
    /** כמות בקבוקים (לבקבוקים) או כמות חביות (לחביות) - כמו שהוזן ע"י המשתמש בטופס */
    amount: number;
    batchNumber: string | number | undefined | null;
};
 
export type MasterSheetLogResult = {
    success: boolean;
    warnings?: string[];
    error?: string;
};
 
export async function logPackagingToMasterSheet(
    params: MasterSheetLogParams
): Promise<MasterSheetLogResult> {
    const { beerStyle, packagingType, amount, batchNumber } = params;
 
    if (!amount || amount <= 0) {
        return { success: false, error: "כמות לא תקינה" };
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
 
    // עמודה B: לחביות - הכמות כפי שהוזנה. לבקבוקים - מספר ארגזים (24 בקבוק לארגז), עם 2 ספרות אחרי הנקודה.
    const quantity =
        packagingType === "kegs"
            ? amount
            : Math.floor(amount / BOTTLES_PER_CRATE);
 
    if (packagingType === "bottles" && quantity <= 0) {
        // פחות מארגז שלם אחד - לא נכתב לטבלת המאסטר (נרשם ידנית במקום אחר)
        return { success: false, error: "פחות מארגז שלם - לא נכתב לטבלת המאסטר" };
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
 
    try {
        const response = await fetch(GOOGLE_SCRIPT_URL, {
            method: "POST",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify(payload),
        });
 
        const text = await response.text();
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
            console.warn("Master sheet log warnings:", parsed.warnings);
        }
 
        return { success: true, warnings: parsed.warnings };
    } catch (err: any) {
        console.error("Failed to log packaging to master sheet:", err);
        return { success: false, error: err?.message ?? "שגיאה בכתיבה לטבלת המאסטר" };
    }
}
 