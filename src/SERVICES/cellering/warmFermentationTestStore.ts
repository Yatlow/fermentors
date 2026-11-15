import { collection, deleteDoc, doc, getDocs, limit, query, runTransaction, serverTimestamp, where } from "firebase/firestore";
import { auth, db } from "../../firebase";
import { callAppsScriptPost, createAppsScriptRequestId, type AppsScriptEnvelope } from "../getAndPost/appsScriptClient";
import { recordReadAudit } from "../readAudit";
import { normalizeWarmBatch, type WarmFermentationTest } from "./warmFermentationTest";

export async function batchWasPackaged(batchNumber: string): Promise<boolean> {
    const id = normalizeWarmBatch(batchNumber);
    if (!/^\d+$/.test(id)) throw new Error("מספר אצווה לא תקין");
    const numeric = Number(id);
    const ids: Array<string | number> = Number.isSafeInteger(numeric) ? [id, numeric] : [id];
    const snapshot = await getDocs(query(collection(db, "packagingLog"), where("batchNumber", "in", ids), limit(1)));
    recordReadAudit("Warm fermentation packaging lookup", snapshot.size);
    return !snapshot.empty;
}

export type SaveWarmTestInput = WarmFermentationTest & { tankId: string | null };

export async function saveWarmFermentationTest(input: SaveWarmTestInput): Promise<{ sheetSynced: boolean }> {
    const user = auth.currentUser;
    if (!user?.uid || !user.email) throw new Error("יש להתחבר מחדש כדי לשמור את הבדיקה");
    const batchNumber = normalizeWarmBatch(input.batchNumber);
    if (!/^\d+$/.test(batchNumber) || !input.sheetUrl.startsWith("https://")) {
        throw new Error("חסרים פרטי אצווה או קישור לגיליון המקור");
    }
    if (!Number.isFinite(input.plato) || input.plato < 0 || input.plato > 40) {
        throw new Error("יש להזין תוצאת פלאטו תקינה בין 0 ל־40");
    }
    const requestId = createAppsScriptRequestId("warm-fermentation");
    const payload: WarmFermentationTest = {
        batchNumber, plato: input.plato, coolingPlato: input.coolingPlato,
        recordedAt: input.recordedAt, packaged: input.packaged, inTank: Boolean(input.tankId),
        tankNumber: input.tankNumber, sheetUrl: input.sheetUrl,
    };
    // Save the isolated test and the durable Sheet outbox in ONE Firestore
    // transaction; unlike a daily measurement it never mutates currentData.plato
    // or creates a brews/{batch}/measurements sugar sample.
    await runTransaction(db, async tx => {
        if (input.tankId) {
            const activeRef = doc(db, "fermentors", input.tankId);
            const live = await tx.get(activeRef);
            if (!live.exists() || Number(live.data().action) !== 1 ||
                normalizeWarmBatch(live.data().batchNumber) !== batchNumber) {
                throw new Error("האצווה במיכל השתנתה. יש לרענן לפני שמירה");
            }
            tx.update(activeRef, {
                warmFermentationTest: payload,
                warmFermentationTestUpdatedAt: serverTimestamp(),
            });
        }
        tx.set(doc(db, "brews", batchNumber, "warmFermentationTests", requestId), {
            ...payload,
            requestId,
            createdAt: serverTimestamp(),
        });
        tx.set(doc(db, "sheetSyncJobs", requestId), {
            requestId, action: "addWarmFermentationTest",
            ownerUid: user.uid, ownerEmail: user.email,
            state: "pending", attempts: 0,
            batchNumber, operationType: "warm-fermentation-test",
            payloadJson: JSON.stringify(payload), createdAt: serverTimestamp(),
        });
    });

    // The existing five-minute Apps Script maintenance retries any interrupted
    // Sheet write. An immediate attempt is best-effort, NOT a reason to discard
    // an already durable test.
    try {
        const response = await callAppsScriptPost<AppsScriptEnvelope<{ success: boolean }>>({
            action: "addWarmFermentationTest", requestId, test: payload,
        }, { retries: 1, timeoutMs: 20000 });
        if (!response.success || response.result?.success === false || !response.result) return { sheetSynced: false };
        try {
            await deleteDoc(doc(db, "sheetSyncJobs", requestId));
        } catch (error) {
            console.warn("Sheet confirmed; maintenance will clear the warm-test job", error);
        }
        return { sheetSynced: true };
    } catch (error) {
        console.warn("Warm fermentation test saved; Sheet outbox will retry", error);
        return { sheetSynced: false };
    }
}
