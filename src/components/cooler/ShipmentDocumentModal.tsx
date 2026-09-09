import BeerLoader from "../general/Loading";
import { useMemo, useRef, useState } from "react";
import emailjs from "@emailjs/browser";
import type { Pallet, Shipment } from "../../SERVICES/cooler/Pallettypes ";
import shpiro from "../../assets/shpiro.jpeg";
import { getCatalogEntry } from "../../SERVICES/cooler/PalletCatalog";

// Isolated print document: no dashboard styles, React tree or network services.
const SHIPMENT_PRINT_CSS = `
@page { size: A4 portrait; margin: 12mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: white; color: #111;
  font-family: Arial, sans-serif; -webkit-text-size-adjust: 100%; }
.print-toolbar { padding: 12px; font-size: 14px; }
.print-toolbar button { font: inherit; padding: 10px 20px; cursor: pointer; }
.print-sheet { position: relative; width: 186mm; height: 270mm;
  margin: 0 auto; break-inside: avoid; page-break-inside: avoid; }
.print-sheet + .print-sheet { break-before: page; page-break-before: always; }
.print-content { position: absolute; top: 0; right: 0; width: 186mm;
  padding: 2mm; transform-origin: top right; font-size: 10pt; line-height: 1.25; }
.shipment-document-header { display: flex; justify-content: space-between;
  align-items: flex-start; gap: 6mm; margin-bottom: 5mm; }
.shipment-company-details { min-width: 0; overflow-wrap: anywhere; }
h1 { font-size: 20pt; margin: 0 0 3mm; }
.shipment-company-details div { margin-bottom: 1mm; }
.shipment-logo { width: 28mm; height: 24mm; object-fit: contain; flex-shrink: 0; }
.shipment-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th, td { border: 1px solid #aaa; padding: 1.3mm 2mm; text-align: right;
  vertical-align: top; overflow-wrap: anywhere; }
th { background: #f1f5f9; }
th:first-child { width: 24%; } th:last-child { width: 15%; }
.shipment-signatures { display: flex; gap: 12mm; margin-top: 7mm; }
.shipment-signature-block { flex: 1; }
.shipment-signature-line { border-bottom: 1px solid #555; height: 9mm; }
.shipment-document-footer { border-top: 1px solid #ccc; margin-top: 5mm;
  padding-top: 2mm; text-align: center; font-size: 8pt; }
.print-page-number { text-align: center; font-size: 8pt; margin-top: 2mm; }
@media print { .print-toolbar { display: none !important; } }
`;

function fitShipmentPages(printDocument: Document) {
    printDocument.querySelectorAll<HTMLElement>(".print-sheet").forEach((sheet) => {
        const content = sheet.querySelector<HTMLElement>(".print-content");
        if (!content) return;
        // Absolute positioning prevents the unscaled height creating extra pages.
        content.style.transform = "none";
        const scale = Math.min(1,
            (sheet.clientHeight - 4) / content.scrollHeight,
            (sheet.clientWidth - 4) / content.scrollWidth);
        content.style.transform = `scale(${scale})`;
    });
}

async function prepareShipmentPrint(printWindow: Window) {
    const printDocument = printWindow.document;
    const button = printDocument.querySelector<HTMLButtonElement>(".print-toolbar button");
    if (!button) return;
    const images = Array.from(printDocument.images);
    // Failed/slow logo must not leave printing disabled forever.
    await Promise.all(images.map((img) => new Promise<void>((resolve) => {
        if (img.complete) { resolve(); return; }
        const finish = () => {
            window.clearTimeout(timer);
            img.removeEventListener("load", finish);
            img.removeEventListener("error", finish);
            resolve();
        };
        const timer = window.setTimeout(() => {
            img.removeAttribute("src");
            img.style.visibility = "hidden";
            finish();
        }, 4000);
        img.addEventListener("load", finish, { once: true });
        img.addEventListener("error", finish, { once: true });
    })));
    if (printWindow.closed) return;
    fitShipmentPages(printDocument);
    printWindow.addEventListener("beforeprint", () => fitShipmentPages(printDocument));
    button.disabled = false;
    button.textContent = "הדפס / שמור PDF";
    button.onclick = () => {
        fitShipmentPages(printDocument);
        printWindow.focus();
        printWindow.print();
    };
    // Keep the tab and manual button available if iOS suppresses automatic print.
    try { printWindow.focus(); printWindow.print(); } catch { /* Manual button remains available. */ }
}

type Props = {
    shipmentId: string;
    pallets: Pallet[];
    onClose?: () => void;
    shipment?: Shipment | null;
    inline?: boolean;
};


export default function ShipmentDocumentModal({ shipmentId, pallets, onClose, shipment, inline = false, }: Props) {
    const [emails, setEmails] = useState<string[]>([
        "yochai@shapirobeer.co.il",
    ]);

    const documentRef = useRef<HTMLDivElement>(null);
    const printWindowRef = useRef<Window | null>(null);

    const [newEmail, setNewEmail] = useState("");
    const [sending, setSending] = useState(false);
    const [message, setMessage] = useState("");
    const [logoLoaded, setLogoLoaded] = useState(false);

   const date = useMemo(() => 
    { if (!shipment?.createdAt) return "";
         return new Intl.DateTimeFormat("he-IL", { dateStyle: "full", timeStyle: "short", })
         .format(shipment.createdAt.toDate()); }, [shipment?.createdAt]);

    const totals = useMemo(() => {
        const map = new Map<string, { beerStyle: string; itemType: Pallet["itemType"]; quantity: number }>();
        pallets.forEach((p) => {
            const key = `${p.itemType}__${p.beerStyle}`;
            const cur = map.get(key);
            if (cur) cur.quantity += p.quantity;
            else map.set(key, { beerStyle: p.beerStyle, itemType: p.itemType, quantity: p.quantity });
        });
        return Array.from(map.values());
    }, [pallets]);

    const totalsTableHtml = useMemo(() => {
    const rows = totals
        .map((t) => {
            const entry = getCatalogEntry(t.beerStyle, t.itemType);
            return `
                <tr>
                    <td style="border:1px solid #ccc;padding:8px;text-align:right;">${entry?.sku ?? "—"}</td>
                    <td style="border:1px solid #ccc;padding:8px;text-align:right;">${entry?.displayText ?? `${t.beerStyle} (לא נמצא בקטלוג)`}</td>
                    <td style="border:1px solid #ccc;padding:8px;text-align:right;">${t.quantity}</td>
                </tr>`;
        })
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
}, [totals]);

    function addEmail() {
        const email = newEmail.trim();

        if (
            !email ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
        ) {
            return;
        }

        if (!emails.includes(email)) {
            setEmails((prev) => [...prev, email]);
        }

        setNewEmail("");
    }

    function removeEmail(email: string) {
        setEmails((prev) =>
            prev.filter((x) => x !== email)
        );
    }



    async function sendEmails() {
        if (emails.length === 0) {
            setMessage("יש להוסיף לפחות כתובת אימייל אחת");
            return;
        }

        try {
            setSending(true);
            setMessage("");

            for (const email of emails) {
                await emailjs.send(
                    "service_bxs22rp",
                    "template_nzaxe18",
                    {
                        email,
                        shipmentId,
                        shipmentDate: date,
                        shipmentTableHtml: totalsTableHtml,
                        logoUrl: "https://fermenter-dashboard-bada3.web.app/assets/favicon-DCEmML13.ico",
                    },
                    "xcE_CHJqkvlh2b_S3"
                );
            }

            setMessage("תעודת המשלוח נשלחה בהצלחה ✓");
        } catch (err) {
            console.error("Shipment email error:", err);
            setMessage("תעודת המשלוח נוצרה, אך שליחת המייל נכשלה.");
        } finally {
            setSending(false);
        }
    }
    function printShipment() {
        const source = documentRef.current;
        if (!source) return;
        if (printWindowRef.current && !printWindowRef.current.closed) {
            printWindowRef.current.close();
        }
        // Open synchronously inside the click handler to avoid popup blocking.
        const printWindow = window.open("", "_blank");
        if (!printWindow) {
            setMessage("פתיחת תעודת ההדפסה נחסמה. יש לאפשר חלונות קופצים לאתר ולנסות שוב.");
            return;
        }
        printWindowRef.current = printWindow;
        const printDocument = printWindow.document;
        printDocument.open();
        printDocument.write('<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>');
        printDocument.close();
        printDocument.title = `תעודת משלוח ${shipmentId}`;
        const style = printDocument.createElement("style");
        style.textContent = SHIPMENT_PRINT_CSS;
        printDocument.head.appendChild(style);
        const toolbar = printDocument.createElement("div");
        toolbar.className = "print-toolbar";
        const button = printDocument.createElement("button");
        button.type = "button";
        button.disabled = true;
        button.textContent = "מכין להדפסה…";
        toolbar.appendChild(button);
        printDocument.body.appendChild(toolbar);

        // Count displayed item rows AFTER aggregation, not source pallets.
        const rows = Array.from(source.querySelectorAll(".shipment-table tbody tr"));
        const pageCount = Math.max(1, Math.ceil(rows.length / 25));
        for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
            const sheet = printDocument.createElement("section");
            sheet.className = "print-sheet";
            const content = source.cloneNode(true) as HTMLDivElement;
            content.className = "print-content";
            const tbody = content.querySelector("tbody");
            tbody?.replaceChildren(...rows.slice(pageIndex * 25, (pageIndex + 1) * 25)
                .map((row) => row.cloneNode(true)));
            // Resolve the Vite asset before moving the copy to about:blank.
            const logo = content.querySelector<HTMLImageElement>(".shipment-logo");
            if (logo) logo.src = new URL(shpiro, window.location.href).href;
            const pageNumber = printDocument.createElement("div");
            pageNumber.className = "print-page-number";
            pageNumber.textContent = `עמוד ${pageIndex + 1} מתוך ${pageCount}`;
            content.appendChild(pageNumber);
            sheet.appendChild(content);
            printDocument.body.appendChild(sheet);
        }
        void prepareShipmentPrint(printWindow).catch((error) => {
            console.error("Shipment print error:", error);
            setMessage("לא ניתן להכין את ההדפסה. יש לסגור את לשונית ההדפסה ולנסות שוב.");
        });
    }

    return (
        <div
           className={ inline ? "shipment-document-inline" : "modal-overlay shipment-document-overlay" }
            onClick={inline ? undefined : onClose} >
        
            <div
                className={ inline ? "shipment-document-container" : "shipment-document-modal" } 
                onClick={(e) => { if (!inline) e.stopPropagation(); }} dir="rtl"
            >
                <div className="shipment-document-actions no-print">
                    <button className="shipment-print-btn" onClick={printShipment}>
                        🖨️ הדפס
                    </button>
                    <button className="shipment-email-btn" onClick={sendEmails} disabled={sending || !logoLoaded}>
                        {sending ? <BeerLoader message="שולח..." size="spinner" /> : "✉️ שלח במייל"}
                    </button>
                   {!inline && ( <button className="modal-x" onClick={onClose}> × </button> )}
                </div>
                <div className="shipment-email-editor no-print">
                    <h3>שליחה במייל</h3>

                    <div className="shipment-email-list">
                        {emails.map((email) => (
                            <div
                                key={email}
                                className="shipment-email-row"
                            >
                                <span>{email}</span>

                                <button
                                    onClick={() =>
                                        removeEmail(email)
                                    }
                                >
                                    ×
                                </button>
                            </div>
                        ))}
                    </div>

                    <div className="shipment-add-email">
                        <input
                            type="email"
                            value={newEmail}
                            placeholder="כתובת אימייל"
                            onChange={(e) =>
                                setNewEmail(
                                    e.target.value
                                )
                            }
                            onKeyDown={(e) => {
                                if (
                                    e.key === "Enter"
                                ) {
                                    addEmail();
                                }
                            }}
                        />

                        <button onClick={addEmail} className="shipment-email-btn">
                            הוסף
                        </button>
                    </div>

                    {message && (
                        <div className="edit-specs-message success">
                            {message}
                        </div>
                    )}
                </div>

                <div className="shipment-document" ref={documentRef}>
                    <header className="shipment-document-header">
                        <div className="shipment-company-details">
                            <h1>תעודת משלוח</h1>
                            <div>מבשלת שפירא א.ת. שורק (נחם), בית שמש</div>
                            <div>טל: 02-5612622 &nbsp;|&nbsp; ח.פ: 514378678</div>
                            <div>מספר: <strong>{shipmentId}</strong></div>
                            <div>תאריך: {date}</div>
                        </div>
                        <img src={shpiro} alt="Shpiro" className="shipment-logo" onLoad={() => setLogoLoaded(true)} />
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
                            {totals.map((t) => {
                                const entry = getCatalogEntry(t.beerStyle, t.itemType);
                                return (
                                    <tr key={`${t.beerStyle}-${t.itemType}`}>
                                        <td>{entry?.sku ?? "—"}</td>
                                        <td>{entry?.displayText ?? `${t.beerStyle} (לא נמצא בקטלוג)`}</td>
                                        <td>{t.quantity}</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                    <div className="shipment-signatures">
                        <div className="shipment-signature-block">
                            <span>שם מפיק התעודה:</span>
                            <div className="shipment-signature-line"></div>
                        </div>
                        <div className="shipment-signature-block">
                            <span>חתימת הלקוח:</span>
                            <div className="shipment-signature-line"></div>
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