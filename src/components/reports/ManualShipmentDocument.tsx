import BeerLoader from "../general/Loading";
import { useMemo, useState } from "react";
import emailjs from "@emailjs/browser";
import {
    doc,
    runTransaction,
    serverTimestamp,
    Timestamp,
} from "firebase/firestore";
import type { Shipment } from "../../SERVICES/cooler/Pallettypes ";
import shpiro from "../../assets/shpiro.jpeg";
import { auth, db } from "../../firebase";
import "./manualShipmentPrint.css";

type PrintMark = "מקור" | "העתק" | "מקור משוחזר";

function escapeHtml(value: unknown): string {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

export default function ManualShipmentDocument({ shipment }: { shipment: Shipment }) {
    const lines = shipment.manualLines ?? [];
    const [shipmentState, setShipmentState] = useState(shipment);
    const [originalIssued, setOriginalIssued] = useState(Boolean(shipment.originalIssuedAt));
    const [emails, setEmails] = useState<string[]>(["yochai@shapirobeer.co.il"]);
    const [newEmail, setNewEmail] = useState("");
    const [sending, setSending] = useState(false);
    const [printing, setPrinting] = useState(false);
    const [message, setMessage] = useState("");

    const date = useMemo(() => {
        const source = shipmentState.createdAt?.toDate?.() ?? new Date();
        return new Intl.DateTimeFormat("he-IL", {
            dateStyle: "full",
            timeStyle: "short",
        }).format(source);
    }, [shipmentState.createdAt]);

    const totalsTableHtml = useMemo(() => {
        const rows = lines
            .map((line) => `
                <tr>
                    <td style="border:1px solid #ccc;padding:8px;text-align:right;">${escapeHtml(line.sku || "—")}</td>
                    <td style="border:1px solid #ccc;padding:8px;text-align:right;">${escapeHtml(line.description)}</td>
                    <td style="border:1px solid #ccc;padding:8px;text-align:right;">${escapeHtml(line.quantity)}</td>
                </tr>`)
            .join("");

        return `
            <table dir="rtl" style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;">
                <thead>
                    <tr>
                        <th style="border:1px solid #ccc;padding:8px;text-align:right;background:#f8fafc;">מק"ט</th>
                        <th style="border:1px solid #ccc;padding:8px;text-align:right;background:#f8fafc;">תאור פריט</th>
                        <th style="border:1px solid #ccc;padding:8px;text-align:right;background:#f8fafc;">כמות</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>`;
    }, [lines]);

    function addEmail() {
        const email = newEmail.trim();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
        if (!emails.includes(email)) setEmails((current) => [...current, email]);
        setNewEmail("");
    }

    function removeEmail(email: string) {
        setEmails((current) => current.filter((item) => item !== email));
    }

    async function sendEmails() {
        if (!emails.length) {
            setMessage("יש להוסיף לפחות כתובת אימייל אחת");
            return;
        }

        setSending(true);
        setMessage("");
        try {
            for (const email of emails) {
                await emailjs.send(
                    "service_bxs22rp",
                    "template_nzaxe18",
                    {
                        email,
                        shipmentId: shipment.id,
                        customerName: shipmentState.customerName ?? "",
                        shipmentDate: date,
                        shipmentTableHtml: totalsTableHtml,
                        logoUrl: "https://fermenter-dashboard-bada3.web.app/assets/favicon-DCEmML13.ico",
                    },
                    "xcE_CHJqkvlh2b_S3"
                );
            }
            setMessage("תעודת המשלוח נשלחה בהצלחה ✓");
        } catch (error) {
            console.error("Manual shipment email error:", error);
            setMessage("תעודת המשלוח נוצרה, אך שליחת המייל נכשלה.");
        } finally {
            setSending(false);
        }
    }

    async function claimOriginal(): Promise<boolean> {
        const shipmentRef = doc(db, "shipments", shipment.id);
        const userEmail = auth.currentUser?.email ?? null;

        const claimed = await runTransaction(db, async (tx) => {
            const snap = await tx.get(shipmentRef);
            if (!snap.exists()) throw new Error("Shipment document was not found");
            const data = snap.data() as Shipment;
            if (data.originalIssuedAt) return false;
            tx.update(shipmentRef, {
                originalIssuedAt: serverTimestamp(),
                originalIssuedBy: userEmail,
            });
            return true;
        });

        if (claimed) {
            setOriginalIssued(true);
            setShipmentState((current) => ({
                ...current,
                originalIssuedAt: Timestamp.now(),
                originalIssuedBy: userEmail,
            }));
        }
        return claimed;
    }

    async function recordOriginalRestore() {
        const shipmentRef = doc(db, "shipments", shipment.id);
        const userEmail = auth.currentUser?.email ?? null;

        await runTransaction(db, async (tx) => {
            const snap = await tx.get(shipmentRef);
            if (!snap.exists()) throw new Error("Shipment document was not found");
            const data = snap.data() as Shipment;
            if (!data.originalIssuedAt) {
                throw new Error("לא ניתן לשחזר מקור לפני שהופק המקור הראשון");
            }
            tx.update(shipmentRef, {
                originalRestoreCount: Number(data.originalRestoreCount ?? 0) + 1,
                originalLastRestoredAt: serverTimestamp(),
                originalLastRestoredBy: userEmail,
            });
        });
    }

    function documentHtml(mark: PrintMark): string {
        const logoUrl = new URL(shpiro, window.location.href).href;
        return `
            <section class="print-sheet">
                <div class="shipment-copy-mark">${mark}</div>
                <header class="shipment-document-header">
                    <div class="shipment-company-details">
                        <h1>תעודת משלוח</h1>
                        ${shipmentState.customerName ? `<div class="shipment-customer-name">לכבוד: <strong>${escapeHtml(shipmentState.customerName)}</strong></div>` : ""}
                        <div>מבשלת שפירא א.ת. שורק (נחם), בית שמש</div>
                        <div>טל: 02-5612622 &nbsp;|&nbsp; ח.פ: 514378678</div>
                        <div>מספר: <strong>${escapeHtml(shipment.id)}</strong></div>
                        <div>${escapeHtml(date)}</div>
                    </div>
                    <img src="${escapeHtml(logoUrl)}" class="shipment-logo" alt="Shpiro" />
                </header>
                ${totalsTableHtml}
                <div class="shipment-signatures">
                    <div class="shipment-signature-block"><span>שם מפיק התעודה:</span><div class="shipment-signature-line"></div></div>
                    <div class="shipment-signature-block"><span>חתימת הלקוח:</span><div class="shipment-signature-line"></div></div>
                </div>
                <footer class="shipment-document-footer">הופק ממערכת ניהול המלאי</footer>
            </section>`;
    }

    function openPrint(marks: PrintMark[]) {
        const printWindow = window.open("", "_blank");
        if (!printWindow) {
            setMessage("פתיחת תעודת ההדפסה נחסמה. יש לאפשר חלונות קופצים לאתר ולנסות שוב.");
            return;
        }

        const css = `
            @page { size: A4 portrait; margin: 12mm; }
            * { box-sizing: border-box; }
            body { margin:0; color:#111; font-family:Arial,sans-serif; direction:rtl; }
            .print-sheet { width:186mm; min-height:270mm; margin:0 auto; padding:2mm; page-break-after:always; }
            .print-sheet:last-child { page-break-after:auto; }
            .shipment-copy-mark { display:inline-block; border:2px solid #111; padding:1.5mm 5mm; margin-bottom:4mm; font-size:14pt; font-weight:700; }
            .shipment-document-header { display:flex; justify-content:space-between; align-items:flex-start; gap:6mm; margin-bottom:5mm; }
            .shipment-company-details div { margin-bottom:1mm; }
            h1 { font-size:20pt; margin:0 0 3mm; }
            .shipment-customer-name { font-size:12pt; margin-bottom:2mm; }
            .shipment-logo { width:28mm; height:24mm; object-fit:contain; }
            table { width:100%; border-collapse:collapse; table-layout:fixed; }
            th, td { border:1px solid #aaa; padding:1.3mm 2mm; text-align:right; vertical-align:top; }
            th { background:#f1f5f9; }
            th:first-child { width:24%; } th:last-child { width:15%; }
            .shipment-signatures { display:flex; gap:12mm; margin-top:7mm; }
            .shipment-signature-block { flex:1; }
            .shipment-signature-line { border-bottom:1px solid #555; height:9mm; }
            .shipment-document-footer { border-top:1px solid #ccc; margin-top:5mm; padding-top:2mm; text-align:center; font-size:8pt; }
        `;

        printWindow.document.open();
        printWindow.document.write(`<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>תעודת משלוח ${escapeHtml(shipment.id)}</title><style>${css}</style></head><body>${marks.map(documentHtml).join("")}</body></html>`);
        printWindow.document.close();
        window.setTimeout(() => {
            try {
                printWindow.focus();
                printWindow.print();
            } catch {
                setMessage("לא ניתן לפתוח את חלון ההדפסה.");
            }
        }, 350);
    }

    async function printShipment() {
        setPrinting(true);
        setMessage("");
        try {
            const claimed = await claimOriginal();
            openPrint(claimed ? ["מקור", "העתק"] : ["העתק"]);
        } catch (error) {
            console.error("Manual shipment print error:", error);
            setMessage("לא ניתן להכין את ההדפסה. יש לנסות שוב.");
        } finally {
            setPrinting(false);
        }
    }

    async function restoreOriginal() {
        setPrinting(true);
        setMessage("");
        try {
            await recordOriginalRestore();
            openPrint(["מקור משוחזר"]);
        } catch (error) {
            console.error("Manual shipment restore original error:", error);
            setMessage(error instanceof Error ? error.message : "שחזור המקור נכשל");
        } finally {
            setPrinting(false);
        }
    }

    return (
        <div className="shipment-document-inline" dir="rtl">
            <div className="shipment-document-container">
                <div className="shipment-document-actions no-print">
                    <button className="shipment-print-btn" onClick={() => void printShipment()} disabled={printing}>
                        {printing ? "מכין הדפסה…" : originalIssued ? "🖨️ הדפס העתק" : "🖨️ הדפס מקור + העתק"}
                    </button>

                    {originalIssued && (
                        <button className="shipment-print-btn" onClick={() => void restoreOriginal()} disabled={printing}>
                            ↻ שחזור מקור
                        </button>
                    )}

                    <button className="shipment-email-btn" onClick={() => void sendEmails()} disabled={sending}>
                        {sending ? <BeerLoader message="שולח..." size="spinner" /> : "✉️ שלח במייל"}
                    </button>
                </div>

                <div className="shipment-email-editor no-print">
                    <h3>שליחה במייל</h3>
                    <div className="shipment-email-list">
                        {emails.map((email) => (
                            <div key={email} className="shipment-email-row">
                                <span>{email}</span>
                                <button type="button" onClick={() => removeEmail(email)}>×</button>
                            </div>
                        ))}
                    </div>
                    <div className="shipment-add-email">
                        <input
                            type="email"
                            value={newEmail}
                            placeholder="כתובת אימייל"
                            onChange={(event) => setNewEmail(event.target.value)}
                            onKeyDown={(event) => { if (event.key === "Enter") addEmail(); }}
                        />
                        <button type="button" onClick={addEmail} className="shipment-email-btn">הוסף</button>
                    </div>
                    {message && <div className="edit-specs-message success">{message}</div>}
                </div>

                <div className="shipment-document">
                    <header className="shipment-document-header">
                        <div className="shipment-company-details">
                            <h1>תעודת משלוח</h1>
                            {shipmentState.customerName && (
                                <div className="shipment-customer-name">
                                    לכבוד: <span>{shipmentState.customerName}</span>
                                </div>
                            )}
                            <div>מבשלת שפירא א.ת. שורק (נחם), בית שמש</div>
                            <div>טל: 02-5612622 &nbsp;|&nbsp; ח.פ: 514378678</div>
                            <div>מספר: <strong>{shipment.id}</strong></div>
                            <div>{date}</div>
                        </div>
                        <img src={shpiro} alt="Shpiro" className="shipment-logo" />
                    </header>

                    <table className="shipment-table">
                        <thead>
                            <tr>
                                <th>מק"ט</th>
                                <th>תאור פריט</th>
                                <th>כמות</th>
                            </tr>
                        </thead>
                        <tbody>
                            {lines.map((line) => (
                                <tr key={line.id}>
                                    <td>{line.sku || "—"}</td>
                                    <td>{line.description}</td>
                                    <td>{line.quantity}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>

                    <div className="shipment-signatures">
                        <div className="shipment-signature-block">
                            <span>שם מפיק התעודה:</span>
                            <div className="shipment-signature-line" />
                        </div>
                        <div className="shipment-signature-block">
                            <span>חתימת הלקוח:</span>
                            <div className="shipment-signature-line" />
                        </div>
                    </div>

                    <footer className="shipment-document-footer">
                        הופק ממערכת ניהול המלאי
                    </footer>
                </div>
            </div>
        </div>
    );
}
