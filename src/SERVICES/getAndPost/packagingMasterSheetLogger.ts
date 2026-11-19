import { doc, getDoc, getDocFromServer, getDocs, getDocsFromServer, collection, setDoc, Timestamp, updateDoc, serverTimestamp, runTransaction, query, where, deleteDoc, writeBatch } from "firebase/firestore";
import { auth, db } from "../../firebase";
import {
    createPalletsFromCustomSplit,
    replacePackagingOperationPallets,
    getDefaultPalletSplit,
    type CustomPalletSplitEntry,
} from "../cooler/Palletservice";
import type { PalletItemType } from "../cooler/Pallettypes ";
import { matchPreReportedShippedPallets, matchPreReportedActivePallets } from "../cooler/preReportedPackagingCoverage";
import { dateKey } from "../planning/planningEngine";
import { reserveNewPalletsForNearestShipment } from "../planning/planningShipmentReservations";
import {
    callAppsScriptPost,
    createAppsScriptRequestId,
    type AppsScriptEnvelope,
} from "./appsScriptClient";

export type PackagingType = "kegs" | "bottles";

const BOTTLES_PER_CRATE = 24;

/** שם הקולקציה בפיירסטור שאליה נכתבים אירועי אריזה בפועל (לצורך דוחות) */
const PACKAGING_LOG_COLLECTION = "packagingLog";

const PACKAGING_OPERATIONS_COLLECTION = "packagingOperations";

// One indexed read covers the plain and #prefixed lot forms used in manual entry.
const batchVariants = (raw: string): string[] => {
    const batch = String(raw).trim().replace(/^#/, "");
    return [...new Set([batch, `#${batch}`])];
};

async function persistPackagingOperation(params: {
    operationId: string;
    packagingType: PackagingType;
    beerStyle: string | undefined | null;
    quantity: number;
    batchNumber: string | number | undefined | null;
    tankNumber: string | number | null;
    expiryDateStr: string;
}): Promise<void> {
    const ref = doc(db, PACKAGING_OPERATIONS_COLLECTION, params.operationId);
    const immutable = {
        operationId: params.operationId,
        packagingType: params.packagingType,
        itemType: params.packagingType === "kegs" ? "kegs" : "crates",
        beerStyle: String(params.beerStyle ?? "").trim(),
        quantity: params.quantity,
        batchNumber: params.batchNumber == null ? null : String(params.batchNumber),
        tankNumber: params.tankNumber ?? null,
        expiryDateStr: params.expiryDateStr,
    };

    await runTransaction(db, async (tx) => {
        const existing = await tx.get(ref);
        if (existing.exists()) {
            const data = existing.data();
            const mismatch = Object.entries(immutable).some(([key, value]) => data[key] !== value);
            if (mismatch) {
                throw new Error("מזהה פעולת האריזה כבר קיים עם נתונים אחרים. הפעולה נעצרה כדי למנוע כפילות.");
            }
            // Retry of the same logical operation: preserve createdAt and,
            // critically, never reopen an operation that is already completed.
            return;
        }

        tx.set(ref, {
            ...immutable,
            state: "awaiting_pallets",
            updatedAt: serverTimestamp(),
            createdAt: serverTimestamp(),
        });
    });
}

/**
 * Link an already-dispatched same-day manual pallet to its later packaging
 * report WITHOUT rewriting the immutable shipped pallet or shipment document.
 * A competing packaging operation for the same batch/SKU/day is ambiguous.
 * The quantity is durably claimed on this operation before any auto creation.
 */
async function ensurePreReportedShippedCoverage(operationId: string): Promise<number> {
    const operationRef = doc(db, PACKAGING_OPERATIONS_COLLECTION, operationId);
    const opSnap = await getDoc(operationRef);
    if (!opSnap.exists()) throw new Error("פעולת אריזה לא נמצאה");
    const operation = opSnap.data();
    if (Number(operation.preShippedQuantity ?? 0) > 0) return Number(operation.preShippedQuantity);
    const batch = String(operation.batchNumber ?? "").replace("#", "").trim();
    if (!batch) return 0;
    const storageBatch = String(operation.batchNumber ?? "").trim();
    const opDate = operation.createdAt?.toDate?.();
    if (!(opDate instanceof Date) || !Number.isFinite(opDate.getTime())) return 0;
    // One targeted batch read for a typical report. The second query is only
    // needed if we actually found same-day pallets shipped before reporting.
    const pallets = await getDocsFromServer(query(collection(db, "pallets"), where("batchNumber", "in", batchVariants(storageBatch))));
    const candidates = pallets.docs.map((entry) => {
        const data = entry.data();
        return {
            id: entry.id,
            zone: data.zone,
            itemType: data.itemType,
            beerStyle: data.beerStyle,
            batchNumber: data.batchNumber,
            expiryDateStr: data.expiryDateStr,
            sourceTankNumber: data.sourceTankNumber,
            packagingOperationId: data.packagingOperationId,
            quantity: data.quantity,
            createdAtMs: data.createdAt?.toMillis?.(),
            shippedAtMs: data.shippedAt?.toMillis?.(),
        };
    });
    const preview = matchPreReportedShippedPallets({
        operationCreatedMs: opDate.getTime(),
        operationBatch: batch,
        itemType: String(operation.itemType),
        beerStyle: String(operation.beerStyle ?? ""),
        expiryDateStr: String(operation.expiryDateStr ?? ""),
        tankNumber: operation.tankNumber ?? null,
        expectedQuantity: Number(operation.quantity ?? 0),
        candidates,
    });
    if (!preview.quantity) return 0;

    const sameDay = dateKey(opDate);
    const otherOperations = await getDocsFromServer(query(
        collection(db, PACKAGING_OPERATIONS_COLLECTION), where("batchNumber", "in", batchVariants(storageBatch))));
    const competitors = otherOperations.docs.filter((entry) => {
        if (entry.id === operationId) return false;
        const data = entry.data();
        const created = data.createdAt?.toDate?.();
        return created instanceof Date && dateKey(created) === sameDay &&
            data.itemType === operation.itemType && data.beerStyle === operation.beerStyle;
    });
    if (competitors.length) {
        throw new Error("קיימים כמה דיווחי אריזה לאותה אצווה ומוצר היום, ומשטח כבר נשלח. אי אפשר לייחס אותו אוטומטית ללא בדיקת עקיבות.");
    }

    return runTransaction(db, async (tx) => {
        const liveOperation = await tx.get(operationRef);
        if (!liveOperation.exists() || liveOperation.data().state !== "awaiting_pallets") {
            throw new Error("פעולת האריזה אינה זמינה להתאמת משלוח שכבר יצא.");
        }
        if (Number(liveOperation.data().preShippedQuantity ?? 0) > 0) {
            return Number(liveOperation.data().preShippedQuantity);
        }
        const palletRefs = preview.palletIds.map((id) => doc(db, "pallets", id));
        const actual = await Promise.all(palletRefs.map((ref) => tx.get(ref)));
        const verified = matchPreReportedShippedPallets({
            operationCreatedMs: opDate.getTime(), operationBatch: batch,
            itemType: String(operation.itemType), beerStyle: String(operation.beerStyle ?? ""),
            expiryDateStr: String(operation.expiryDateStr ?? ""), tankNumber: operation.tankNumber ?? null,
            expectedQuantity: Number(operation.quantity ?? 0),
            candidates: actual.map((snap, index) => {
                const data = snap.data();
                return {
                    id: preview.palletIds[index], zone: data?.zone, itemType: data?.itemType,
                    beerStyle: data?.beerStyle, batchNumber: data?.batchNumber, expiryDateStr: data?.expiryDateStr,
                    sourceTankNumber: data?.sourceTankNumber, packagingOperationId: data?.packagingOperationId,
                    quantity: data?.quantity, createdAtMs: data?.createdAt?.toMillis?.(),
                    shippedAtMs: data?.shippedAt?.toMillis?.(),
                };
            }),
        });
        if (verified.quantity !== preview.quantity || verified.palletIds.length !== preview.palletIds.length) {
            throw new Error("המשטחים שנשלחו השתנו בזמן התאמת האריזה. יש לרענן ולבדוק.");
        }
        tx.update(operationRef, {
            preShippedPalletIds: verified.palletIds,
            preShippedQuantity: verified.quantity,
            preShippedMatchedAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
        });
        return verified.quantity;
    });
}


type ExistingManualCoverage = {
    quantity: number;
    count: number;
    locked: boolean;
};
const NO_EXISTING_MANUAL_COVERAGE: ExistingManualCoverage = { quantity: 0, count: 0, locked: false };

/**
 * Claim only same-day unlinked MANUAL pallets that existed before this report.
 * A placed pallet remains in place. A previously adopted manual pallet remains
 * linked to this operation on retry. The transaction reads each selected
 * physical pallet before changing its attribution, so two reports cannot
 * silently claim the same pallet.
 */
async function ensurePreReportedActiveCoverage(operationId: string): Promise<ExistingManualCoverage> {
    const operationRef = doc(db, PACKAGING_OPERATIONS_COLLECTION, operationId);
    const operationSnap = await getDocFromServer(operationRef);
    if (!operationSnap.exists()) throw new Error("דיווח האריזה לא נמצא");
    const operation = operationSnap.data();
    const batch = String(operation.batchNumber ?? "").trim();
    if (!batch) return NO_EXISTING_MANUAL_COVERAGE;
    const createdAt = operation.createdAt?.toMillis?.();
    if (!Number.isFinite(createdAt) || createdAt <= 0) {
        throw new Error("חסר תאריך יצירת דיווח האריזה. לא ניתן לבדוק משטחים ידניים ללא סכנת כפילות.");
    }
    const palletDocs = await getDocsFromServer(query(collection(db, "pallets"),
        where("batchNumber", "in", batchVariants(batch))));
    const toCandidate = (id: string, data: Record<string, any>) => ({
        id,
        zone: data.zone,
        itemType: data.itemType,
        beerStyle: data.beerStyle,
        batchNumber: data.batchNumber,
        expiryDateStr: data.expiryDateStr,
        sourceTankNumber: data.sourceTankNumber,
        packagingOperationId: data.packagingOperationId,
        packagingSource: data.packagingSource,
        quantity: data.quantity,
        createdAtMs: data.createdAt?.toMillis?.(),
        shippedAtMs: data.shippedAt?.toMillis?.(),
    });
    const candidates = palletDocs.docs.map((p) => toCandidate(p.id, p.data()));
    const parameters = {
        operationId,
        operationCreatedMs: createdAt,
        operationBatch: batch,
        itemType: String(operation.itemType ?? ""),
        beerStyle: String(operation.beerStyle ?? ""),
        expiryDateStr: String(operation.expiryDateStr ?? ""),
        tankNumber: operation.tankNumber ?? null,
        expectedQuantity: Math.max(0, Number(operation.quantity ?? 0)),
        preShippedQuantity: Math.max(0, Number(operation.preShippedQuantity ?? 0)),
    };
    const preview = matchPreReportedActivePallets({ ...parameters, candidates });
    if (preview.palletIds.length === 0) return NO_EXISTING_MANUAL_COVERAGE;
    const matching = candidates.filter((p) => preview.palletIds.includes(p.id));
    const hasUnlinked = matching.some((p) => !p.packagingOperationId);
    const locked = matching.some((p) => p.zone !== "pending");
    if (!hasUnlinked) {
        return { quantity: preview.quantity, count: preview.palletIds.length, locked };
    }
    if (operation.state !== "awaiting_pallets") {
        throw new Error("דיווח האריזה כבר הושלם. לא ניתן לקשר אליו משטח ידני חדש.");
    }
    const createdDay = dateKey(new Date(createdAt));
    const competing = await getDocsFromServer(query(collection(db, PACKAGING_OPERATIONS_COLLECTION),
        where("batchNumber", "in", batchVariants(batch))));
    if (competing.docs.some((other) => {
        if (other.id === operationId) return false;
        const entry = other.data();
        const at = entry.createdAt?.toDate?.();
        return at instanceof Date && dateKey(at) === createdDay &&
            entry.itemType === operation.itemType && entry.beerStyle === operation.beerStyle;
    })) {
        throw new Error("קיימים כמה דיווחי אריזה של אותה אצווה ומוצר היום. משטח ידני לא ישויך אוטומטית לפני בדיקת עקיבות.");
    }

    const palletRefs = preview.palletIds.map((id) => doc(db, "pallets", id));
    return runTransaction(db, async (tx) => {
        const liveOperation = await tx.get(operationRef);
        if (!liveOperation.exists() || liveOperation.data().state !== "awaiting_pallets") {
            throw new Error("סטטוס דיווח האריזה השתנה. לא נוצר מלאי נוסף.");
        }
        const livePallets = await Promise.all(palletRefs.map((ref) => tx.get(ref)));
        const actualCandidates = livePallets.map((docSnap, i) =>
            toCandidate(preview.palletIds[i], docSnap.data() ?? {}));
        const verified = matchPreReportedActivePallets({
            ...parameters,
            preShippedQuantity: Math.max(0, Number(liveOperation.data().preShippedQuantity ?? 0)),
            candidates: actualCandidates,
        });
        if (verified.quantity !== preview.quantity ||
            verified.palletIds.length !== preview.palletIds.length) {
            throw new Error("הכמות או השיוך של משטח ידני השתנו. יש לרענן ולבדוק לפני דיווח נוסף.");
        }
        livePallets.forEach((snap, index) => {
            if (snap.data()?.packagingOperationId === operationId) return;
            tx.update(palletRefs[index], {
                packagingOperationId: operationId,
                packagingSource: "manual",
                packagingAppliedQuantity: Number(snap.data()?.quantity),
                updatedAt: serverTimestamp(),
            });
        });
        // Fences concurrent automatic pallet creation for the same operation.
        tx.update(operationRef, { updatedAt: serverTimestamp() });
        return {
            quantity: verified.quantity,
            count: verified.palletIds.length,
            locked: actualCandidates.some((p) => p.zone !== "pending"),
        };
    });
}

export async function savePackagingPalletSplits(operationId: string, splits: CustomPalletSplitEntry[]): Promise<void> {
    await updateDoc(doc(db, PACKAGING_OPERATIONS_COLLECTION, operationId), {
        palletSplits: splits.map((split) => ({ quantity: Math.round(split.quantity), subLabel: split.subLabel ?? null })),
        updatedAt: serverTimestamp(),
    });
}

export async function recoverPackagingOperation(operationId: string): Promise<string[]> {
    const operationRef = doc(db, PACKAGING_OPERATIONS_COLLECTION, operationId);
    const snapshot = await getDoc(operationRef);
    if (!snapshot.exists()) throw new Error("פעולת האריזה לא נמצאה");
    const operation = snapshot.data();
    if (operation.state === "completed") return [];
    if (operation.state !== "awaiting_pallets") {
        throw new Error("פעולת האריזה אינה במצב שמאפשר השלמה");
    }

    const expectedQuantity = Math.max(0, Math.round(Number(operation.quantity ?? 0)));
    const batchNumber = String(operation.batchNumber ?? "").trim();
    if (!batchNumber) throw new Error("לפעולת האריזה חסר מספר אצווה ולכן לא ניתן לבצע התאמה אוטומטית.");
    const beerStyle = String(operation.beerStyle ?? "").trim();
    const itemType = operation.itemType as PalletItemType;
    const expiryDateStr = String(operation.expiryDateStr ?? "").trim();

    // The packaging log is the durable business report. Never repair inventory
    // from an operation document alone: the two records must agree first.
    const reportSnap = await getDoc(doc(db, PACKAGING_LOG_COLLECTION, operationId));
    if (!reportSnap.exists()) {
        throw new Error("לא נמצא דוח האריזה התואם. לא בוצע שינוי במשטחים.");
    }
    const report = reportSnap.data();
    const reportItemType = report.packagingType === "kegs" ? "kegs" : "crates";
    const reportMatches =
        Math.round(Number(report.quantity ?? 0)) === expectedQuantity &&
        String(report.batchNumber ?? "").trim() === batchNumber &&
        String(report.beerStyle ?? "").trim() === beerStyle &&
        reportItemType === itemType;
    if (!reportMatches) {
        throw new Error("דוח האריזה ופעולת האריזה אינם תואמים. לא בוצע שינוי במשטחים.");
    }

    // Link safe pre-report manual stock before taking the recovery snapshot.
    // Otherwise the older manual pallet would be excluded by the timestamp filter.
    const preShippedQuantity = await ensurePreReportedShippedCoverage(operationId);
    await ensurePreReportedActiveCoverage(operationId);

    // Reconcile against the physical active inventory for the exact batch,
    // item type, style and expiry. This deliberately includes pallets already
    // placed in the cooler as well as pallets still waiting for placement.
    const batchPallets = batchNumber
        ? await getDocs(query(collection(db, "pallets"), where("batchNumber", "in", batchVariants(batchNumber))))
        : null;
    const operationCreatedMs =
        typeof operation.createdAt?.toMillis === "function" ? operation.createdAt.toMillis() : 0;
    const exactPhysicalPallets = (batchPallets?.docs ?? []).filter((palletDoc) => {
        const pallet = palletDoc.data();
        if (pallet.zone === "shipped") return false;
        if (pallet.itemType !== itemType) return false;
        if (String(pallet.beerStyle ?? "").trim() !== beerStyle) return false;
        if (expiryDateStr && String(pallet.expiryDateStr ?? "").trim() !== expiryDateStr) return false;

        const linkedOperation = String(pallet.packagingOperationId ?? "").trim();
        if (linkedOperation === operationId) return true;
        if (linkedOperation) return false;

        // An unlinked manual pallet is eligible only if it was created as part
        // of this packaging window. This prevents an older pallet from the same
        // batch/style/expiry from silently satisfying a new packaging report.
        const palletCreatedMs =
            typeof pallet.createdAt?.toMillis === "function" ? pallet.createdAt.toMillis() : 0;
        return operationCreatedMs > 0 && palletCreatedMs >= operationCreatedMs;
    });

    const inventoryQuantity = preShippedQuantity + exactPhysicalPallets.reduce(
        (sum, palletDoc) => sum + Math.max(0, Number(palletDoc.data().quantity ?? 0) || 0),
        0
    );
    if (inventoryQuantity > expectedQuantity) {
        throw new Error(
            `נמצאו ${inventoryQuantity} פריטים חדשים שמתאימים לדוח של ${expectedQuantity}. קיימת עמימות ולכן לא בוצע שינוי אוטומטי.`
        );
    }

    // Adopt matching manual pallets first. Automatic creation is always based
    // on the uncovered remainder, never on the original report quantity.
    const unlinked = exactPhysicalPallets.filter(
        (palletDoc) => !String(palletDoc.data().packagingOperationId ?? "").trim()
    );
    if (unlinked.length > 0) {
        const batch = writeBatch(db);
        unlinked.forEach((palletDoc) => {
            batch.update(palletDoc.ref, {
                packagingOperationId: operationId,
                packagingSource: "manual",
                packagingAppliedQuantity: Math.max(0, Number(palletDoc.data().quantity ?? 0) || 0),
                updatedAt: serverTimestamp(),
            });
        });
        await batch.commit();
    }

    const missingQuantity = expectedQuantity - inventoryQuantity;
    let createdIds: string[] = [];
    if (missingQuantity > 0) {
        const missingSplits = getDefaultPalletSplit(itemType, missingQuantity)
            .map((split, index) => ({ ...split, operationSplitIndex: 1000 + index }));
        createdIds = await createPalletsFromCustomSplit({
            itemType,
            expectedTotalQuantity: missingQuantity,
            beerStyle,
            batchNumber,
            expiryDateStr,
            sourceTankNumber: operation.tankNumber ?? null,
            operationId,
            splits: missingSplits,
        });
    }

    const reconciledIds = [...exactPhysicalPallets.map((palletDoc) => palletDoc.id), ...createdIds];
    await reserveNewPalletsForNearestShipment(reconciledIds);
    await markPackagingPalletsCompleted(operationId);
    return createdIds;
}

export async function markPackagingPalletsCompleted(operationId: string): Promise<void> {
    const operationRef = doc(db, PACKAGING_OPERATIONS_COLLECTION, operationId);
    const operationSnap = await getDoc(operationRef);
    if (!operationSnap.exists()) throw new Error("פעולת האריזה לא נמצאה");
    const operation = operationSnap.data();
    if (operation.state === "completed") return;
    if (operation.state !== "awaiting_pallets") throw new Error("פעולת האריזה אינה במצב שמאפשר השלמה");

    const expectedQuantity = Math.max(0, Math.round(Number(operation.quantity ?? 0)));
    const linkedSnapshot = await getDocs(query(
        collection(db, "pallets"),
        where("packagingOperationId", "==", operationId),
    ));
    const linkedQuantity = linkedSnapshot.docs.reduce((sum, palletDoc) => {
        const pallet = palletDoc.data();
        const applied = pallet.packagingAppliedQuantity;
        return sum + Math.max(0, Number(applied == null ? pallet.quantity : applied) || 0);
    }, 0);

    const coveredQuantity = linkedQuantity + Math.max(0, Number(operation.preShippedQuantity ?? 0));
    if (coveredQuantity < expectedQuantity) {
        throw new Error(
            `לא ניתן להשלים את פעולת האריזה: נוצרו/קושרו ${coveredQuantity} מתוך ${expectedQuantity} פריטים`
        );
    }

    const completionUpdate: Record<string, unknown> = {
        state: "completed",
        updatedAt: serverTimestamp(),
    };

    // Preview channels still use the production Firestore rules until merge.
    // cleanupAfter is a new PR #27 field, so omit it there to let the full
    // pallet/recovery flow complete under the currently deployed rules.
    if (!isPullRequestPreview()) {
        const cleanupAfter = new Date();
        cleanupAfter.setDate(cleanupAfter.getDate() + 30);
        completionUpdate.cleanupAfter = Timestamp.fromDate(cleanupAfter);
    }

    await updateDoc(operationRef, completionUpdate);
}


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
    /** Stable id supplied by the packaging UI; retries must reuse it. */
    operationId?: string;
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
    /** Stable identity shared by Sheet log, Firestore log and pallet creation. */
    operationId: string;
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
    preShippedQuantity?: number;
    preExistingQuantity?: number;
    preExistingPalletCount?: number;
    preExistingLocked?: boolean;
};

type MasterSheetServerResult = {
    row?: number;
    warnings?: string[];
    requestId?: string | null;
    duplicate?: boolean;
};

function isPullRequestPreview(): boolean {
    return typeof window !== "undefined" && window.location.hostname.includes("--pr");
}

function isFirestorePermissionDenied(error: unknown): boolean {
    return typeof error === "object" &&
        error !== null &&
        "code" in error &&
        String((error as { code?: unknown }).code) === "permission-denied";
}

async function persistPackagingSheetSyncJob(
    operationId: string,
    payload: Record<string, unknown>,
    tankNumber: string | number | null
): Promise<void> {
    const user = auth.currentUser;
    if (!user?.email) throw new Error("אין משתמש מחובר. יש להתחבר מחדש.");

    await setDoc(doc(db, "sheetSyncJobs", operationId), {
        requestId: operationId,
        action: "logPackagingToMasterSheet",
        operationType: "רישום אריזה בגיליון",
        tankNumber: tankNumber ?? null,
        batchNumber: payload.batchNumber ?? null,
        ownerUid: user.uid,
        ownerEmail: user.email,
        state: "pending",
        attempts: 0,
        payloadJson: JSON.stringify(payload),
        createdAt: serverTimestamp(),
    });
}

async function clearPackagingSheetSyncJob(operationId: string): Promise<void> {
    try {
        await deleteDoc(doc(db, "sheetSyncJobs", operationId));
    } catch (error) {
        // The maintenance worker will observe the same idempotency receipt and
        // clean the pending job. A cleanup miss must not reopen the modal.
        console.warn("Could not clear completed packaging Sheet sync job", {
            operationId,
            error,
        });
    }
}

function syncPackagingSheetInBackground(
    operationId: string,
    payload: Record<string, unknown>
): void {
    void callAppsScriptPost<AppsScriptEnvelope<MasterSheetServerResult>>(
        payload,
        { retries: 2, retryDelayMs: 600 }
    )
        .then(async (result) => {
            if (!result.success) {
                console.error(
                    "Background packaging Sheet sync returned failure:",
                    result.error || result.message
                );
                return;
            }
            await clearPackagingSheetSyncJob(operationId);
        })
        .catch((error) => {
            // Keep the durable outbox job pending. Apps Script maintenance will
            // safely retry with this operationId/requestId.
            console.error("Background packaging Sheet sync failed:", error);
        });
}

/**
 * כותבת אירוע אריזה בפועל לפיירסטור, לקולקציית packagingLog.
 * מבנה הדוקומנט תואם בכוונה למבנה של calendar_events (title/itemType/quantity/unit/timestamp)
 * כדי שיהיה קל לאחד בין השניים בקומפוננטת הדוחות.
 */
async function logPackagingToFirestore(params: {
    operationId: string;
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
    const { operationId, packagingType, beerStyle, quantity, batchNumber, tankNumber, productionDateStr, expiryDateStr, productDate, tankStatus } = params;

    const unit = packagingType === "kegs" ? "חביות" : "ארגזים";
    const itemLabel = String(beerStyle ?? "").trim();
    const title =
        packagingType === "kegs"
            ? `אריזת חביות ${itemLabel} - ${quantity} חביות`
            : `אריזת ${itemLabel} - ${quantity} ארגזים`;

    // Deterministic id: retrying the same logical packaging operation overwrites
    // the same log document instead of creating a duplicate actual-packaging row.
    await setDoc(doc(db, PACKAGING_LOG_COLLECTION, operationId), {
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
        operationId,
        createdAt: Timestamp.fromDate(productDate),
    }, { merge: true });
    const docRef = doc(db, "fermentors", tankNumber?.toString() ?? "");
    try {
        await updateDoc(docRef, {
            tankStatus: tankStatus,
            action: tankStatus ? 3 : 1,
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

    const quantity = computePalletQuantity(packagingType, amount);
    if (packagingType === "bottles" && quantity <= 0) {
        return { success: false, error: "פחות מארגז שלם - לא נכתב לטבלת המאסטר", palletPlan: null };
    }

    const productLabel =
        packagingType === "kegs"
            ? `חביות ${beerStyle ?? ""}`.trim()
            : `ארגזי ${beerStyle ?? ""}`.trim();

    const operationId = params.operationId?.trim() || createAppsScriptRequestId("packaging");
    await persistPackagingOperation({
        operationId,
        packagingType,
        beerStyle,
        quantity,
        batchNumber,
        tankNumber,
        expiryDateStr,
    });

    const payload = {
        action: "logPackagingToMasterSheet",
        requestId: operationId,
        productLabel,
        quantity,
        batchNumber: batchNumber ?? "",
        expiryDateStr,
        productionDateStr,
    };

    // Durable first: the business log and Sheet outbox are persisted before the
    // external Apps Script request starts. From this point the modal can close
    // after pallet confirmation without waiting for Google.
    let outboxPersisted = true;
    const outboxPromise = persistPackagingSheetSyncJob(operationId, payload, tankNumber)
        .catch((error) => {
            // Hosting preview channels use the production Firestore rules until
            // merge. Let the preview exercise the rest of the packaging flow
            // without weakening the production durability contract.
            if (isPullRequestPreview() && isFirestorePermissionDenied(error)) {
                console.warn("Preview rules do not allow packaging Sheet outbox yet; using synchronous preview fallback.");
                outboxPersisted = false;
                return;
            }
            throw error;
        });

    await Promise.all([
        outboxPromise,
        logPackagingToFirestore({
            operationId,
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

    const palletPlan: PackagingPalletPlan = {
        operationId,
        itemType: packagingType === "kegs" ? "kegs" : "crates",
        quantity,
        beerStyle: String(beerStyle ?? "").trim(),
        batchNumber: batchNumber ?? null,
        expiryDateStr,
        sourceTankNumber: tankNumber,
        tankNumber,
    };

    const preShippedQuantity = await ensurePreReportedShippedCoverage(operationId);
    const preExisting = await ensurePreReportedActiveCoverage(operationId);

    // Safe-by-default: create the standard pallet split as soon as the
    // packaging record exists. If the browser closes or the user abandons the
    // editor, physical inventory is still represented in Firestore.
    const defaultSplits = getDefaultPalletSplit(palletPlan.itemType, palletPlan.quantity);
    await savePackagingPalletSplits(operationId, defaultSplits);
    await createPalletsForPlan(palletPlan, defaultSplits);

    if (outboxPersisted) {
        syncPackagingSheetInBackground(operationId, payload);
    } else {
        // Preview-only compatibility: without the new rules there is no durable
        // job to recover a lost response, so wait for the current production
        // Apps Script to confirm the write before treating the send as done.
        const previewResult = await callAppsScriptPost<AppsScriptEnvelope<MasterSheetServerResult>>(
            payload,
            { retries: 2, retryDelayMs: 600 }
        );
        if (!previewResult.success) {
            return {
                success: false,
                error: previewResult.error || previewResult.message || "Master sheet log failed",
                palletPlan,
            };
        }
    }

    return {
        success: true,
        palletPlan,
        preShippedQuantity,
        preExistingQuantity: preExisting.quantity,
        preExistingPalletCount: preExisting.count,
        preExistingLocked: preExisting.locked,
        ...(preShippedQuantity > 0 || preExisting.quantity > 0 ? { warnings: [
            ...(preExisting.quantity > 0 ? [
                "זוהו " + preExisting.count + " משטחים ידניים קיימים (" + preExisting.quantity + " " +
                (palletPlan.itemType === "kegs" ? "חביות" : "ארגזים") +
                "). הם שויכו לדיווח ללא יצירת עותק נוסף. נותרה כמות " +
                Math.max(0, palletPlan.quantity - preShippedQuantity - preExisting.quantity) +
                " ליצירה או לאישור בחלוקת המשטחים."
            ] : []),
            ...(preShippedQuantity > 0 ? [`זוהו ${preShippedQuantity} ${palletPlan.itemType === "kegs" ? "חביות" : "ארגזים"} שנשלחו לפני דיווח האריזה. הן קושרו לדיווח ללא יצירת מלאי כפול וללא שינוי תעודת המשלוח. החלוקה שנשלחה כבר נעולה.`] : []),
        ] } : {}),
    };
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
    const operationDoc = await getDoc(doc(db, PACKAGING_OPERATIONS_COLLECTION, plan.operationId));
    const preShippedCoverage = Math.max(0, Number(operationDoc.data()?.preShippedQuantity ?? 0));
    const linked = await getDocs(query(
        collection(db, "pallets"),
        where("packagingOperationId", "==", plan.operationId),
    ));

    // Recovery pallets retain the approved split index. Manual pallets do not
    // replace a particular split; their applied quantity is consumed from the
    // first still-uncreated approved splits.
    const createdSplitIndexes = new Set<number>();
    let manualCoverage = preShippedCoverage;
    linked.docs.forEach((palletDoc) => {
        const data = palletDoc.data();
        if (data.packagingSource === "manual") {
            manualCoverage += Math.max(0, Number(data.packagingAppliedQuantity ?? 0) || 0);
            return;
        }
        const splitIndex = Number(data.packagingSplitIndex);
        if (Number.isInteger(splitIndex) && splitIndex >= 0) createdSplitIndexes.add(splitIndex);
    });

    const remainingSplits: CustomPalletSplitEntry[] = [];
    splits.forEach((split, index) => {
        if (createdSplitIndexes.has(index)) return;
        let quantity = Math.max(0, Math.round(split.quantity));
        if (manualCoverage > 0) {
            const consumed = Math.min(quantity, manualCoverage);
            quantity -= consumed;
            manualCoverage -= consumed;
        }
        if (quantity > 0) {
            remainingSplits.push({
                quantity,
                subLabel: split.subLabel ?? null,
                operationSplitIndex: index,
            });
        }
    });

    const remaining = remainingSplits.reduce((sum, split) => sum + split.quantity, 0);
    if (remaining === 0) return [];

    return createPalletsFromCustomSplit({
        itemType: plan.itemType,
        expectedTotalQuantity: remaining,
        beerStyle: plan.beerStyle,
        batchNumber: plan.batchNumber,
        expiryDateStr: plan.expiryDateStr,
        sourceTankNumber: plan.sourceTankNumber,
        operationId: plan.operationId,
        splits: remainingSplits,
    });
}

/** Replace the already-created safe default with a user-approved valid split. */
export async function replacePalletsForPlan(
    plan: PackagingPalletPlan,
    splits: CustomPalletSplitEntry[]
): Promise<string[]> {
    return replacePackagingOperationPallets({
        itemType: plan.itemType,
        expectedTotalQuantity: plan.quantity,
        beerStyle: plan.beerStyle,
        batchNumber: plan.batchNumber,
        expiryDateStr: plan.expiryDateStr,
        sourceTankNumber: plan.sourceTankNumber,
        operationId: plan.operationId,
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
            await markPackagingPalletsCompleted(record.palletPlan.operationId);
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
