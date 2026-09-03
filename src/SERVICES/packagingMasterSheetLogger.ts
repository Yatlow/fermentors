import { doc, getDoc, collection, addDoc, Timestamp ,updateDoc } from "firebase/firestore";
import { db } from "../firebase";

const GOOGLE_SCRIPT_URL =
    "https://script.google.com/macros/s/AKfycbzSq8vnL_P9DOkiXluKReSUNFILqlRkK-WxnPC_Q0BNt23rFHbLpRlkvPudbqElqw5h/exec";

export type PackagingType = "kegs" | "bottles";

const BOTTLES_PER_CRATE = 24;

/** שם הקולקציה בפיירסטור שאליה נכתבים אירועי אריזה בפועל (לצורך דוחות) */
const PACKAGING_LOG_COLLECTION = "packagingLog";


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
    tankNumber?: string | number | null;
    tankStatus: boolean;
};

export type MasterSheetLogResult = {
    success: boolean;
    warnings?: string[];
    error?: string;
};

/**
 * כותב אירוע אריזה בפועל לפיירסטור, לקולקציית packagingLog.
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
    tankNumber?: string | number | null;
    tankStatus:boolean;
}): Promise<void> {
    const { packagingType, beerStyle, quantity, batchNumber,tankNumber, productionDateStr, expiryDateStr, productDate,tankStatus } = params;

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
    console.log("tankStatus",tankStatus)
    const docRef = doc(db, "fermentors", tankNumber?.toString() ?? "");
    console.log("tankStatus",tankStatus,docRef,tankNumber?.toString())
    try{
        await updateDoc(docRef, {
              tankStatus: tankStatus,
              action:3,
            });;
    }catch(err){
        console.error("Failed to update tankStatus in Firestore:", err);
    }
}

export async function logPackagingToMasterSheet(
    params: MasterSheetLogParams
): Promise<MasterSheetLogResult> {
    const { beerStyle, packagingType, amount, batchNumber,tankNumber,tankStatus } = params;

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

    // כותבים לגיליון ולפיירסטור במקביל - כשל באחד לא ימנע את השני
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

    if (sheetResult.status === "rejected") {
        console.error("Failed to log packaging to master sheet:", sheetResult.reason);
        return {
            success: false,
            error: sheetResult.reason?.message ?? "שגיאה בכתיבה לטבלת המאסטר",
            warnings,
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

        return { success: true, warnings: warnings.length > 0 ? warnings : undefined };
    } catch (err: any) {
        console.error("Failed to log packaging to master sheet:", err);
        return { success: false, error: err?.message ?? "שגיאה בכתיבה לטבלת המאסטר", warnings };
    }
}