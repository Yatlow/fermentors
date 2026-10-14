import { auth, db } from "../../firebase";
import { collection, doc, serverTimestamp, writeBatch } from "firebase/firestore";
import type { ReadingToSend } from "../../App";

export type ActivityKind = "לחץ" | "חם" | "פעולות" | "אריזה";

/** Best-effort supplementary journal; never changes the outcome of the original report. */
export async function recordCellarReportActivity(kind: ActivityKind, readings: ReadingToSend[]): Promise<void> {
    const user = auth.currentUser;
    if (!user?.email || !readings.length) return;
    const batch = writeBatch(db);
    const operationId = crypto.randomUUID();
    for (const [index, reading] of readings.entries()) {
        const ref = doc(collection(db, "activityEvents"), `${operationId}-${index}`);
        const details = kind === "אריזה"
            ? [reading.kegs != null ? `${reading.kegs} חביות` : "", reading.crates != null ? `${reading.crates} ארגזים` : "", reading.isEmpty ? "מיכל התרוקן" : ""].filter(Boolean).join(" · ")
            : kind === "פעולות" ? String(reading.notes ?? "").slice(0, 500)
            : kind === "לחץ" ? `טמפ׳ ${reading.temp ?? "—"} · לחץ ${reading.pressure ?? "—"}`
            : `פלאטו ${reading.plato ?? "—"} · pH ${reading.pH ?? "—"}`;
        batch.set(ref, {
            eventId: ref.id,
            operationId,
            kind,
            tankNumber: String(reading.tankNumber ?? reading.tankId),
            batchNumber: String(reading.batchNumber ?? ""),
            details: details.slice(0, 600),
            actorUid: user.uid,
            actorEmail: user.email.toLowerCase(),
            occurredAt: serverTimestamp(),
            source: "cellar-report",
        });
    }
    await batch.commit();
}
