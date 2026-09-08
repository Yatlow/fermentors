import BeerLoader from "./Loading";
import { useMemo, useState } from "react";
import emailjs from "@emailjs/browser";
import type { Pallet, Shipment } from "../SERVICES/Pallettypes ";
import shpiro from "../assets/shpiro.jpeg";
import { getCatalogEntry } from "../SERVICES/PalletCatalog";

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

    return (
        <div
           className={ inline ? "shipment-document-inline" : "modal-overlay shipment-document-overlay" }
            onClick={inline ? undefined : onClose} >
        
            <div
                className={ inline ? "shipment-document-container" : "shipment-document-modal" } 
                onClick={(e) => { if (!inline) e.stopPropagation(); }} dir="rtl"
            >
                <div className="shipment-document-actions no-print">
                    <button className="shipment-print-btn" onClick={() => window.print()}>
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

                <div className="shipment-document">
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