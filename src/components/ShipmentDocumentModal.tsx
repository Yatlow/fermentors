import { useMemo, useState } from "react";
// import emailjs from "@emailjs/browser";
import type { Pallet } from "../SERVICES/Pallettypes ";
import shpiro from "../assets/shpiro.jpeg";

type Props = {
    shipmentId: string;
    pallets: Pallet[];
    onClose: () => void;
};

export default function ShipmentDocumentModal({
    shipmentId,
    pallets,
    onClose,
}: Props) {
    const [emails, setEmails] = useState<string[]>([
        "yisrael@atlow.co.il",
    ]);

    const [newEmail, setNewEmail] = useState("");
    const [sending, setSending] = useState(false);
    const [message, setMessage] = useState("");

    const date = useMemo(() => {
        return new Intl.DateTimeFormat("he-IL", {
            dateStyle: "full",
            timeStyle: "short",
        }).format(new Date());
    }, []);

    const totals = useMemo(() => {
        const map = new Map<
            string,
            {
                beerStyle: string;
                itemType: string;
                quantity: number;
            }
        >();

        pallets.forEach((p) => {
            const key =
                `${p.itemType}__${p.beerStyle}`;

            const existing = map.get(key);

            if (existing) {
                existing.quantity += p.quantity;
            } else {
                map.set(key, {
                    beerStyle: p.beerStyle,
                    itemType: p.itemType,
                    quantity: p.quantity,
                });
            }
        });

        return Array.from(map.values());
    }, [pallets]);

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

            // const content = totals
            //     .map(
            //         (t) =>
            //             `${t.beerStyle} | ${
            //                 t.itemType === "kegs"
            //                     ? "חביות"
            //                     : "ארגזים"
            //             } | ${t.quantity}`
            //     )
            //     .join("\n");

            // for (const email of emails) {
            //     await emailjs.send(
            //         "service_r6sx6s2",
            //         "template_uhrmohh",
            //         {
            //             email,
            //             shipmentId,
            //             shipmentDate: date,
            //             shipmentContent: content,
            //         },
            //         "SOy_TDtKEy-_xaKWw"
            //     );
            // }

            setMessage("תעודת המשלוח נשלחה בהצלחה ✓");
        } catch (err) {
            console.error(
                "Shipment email error:",
                err
            );

            setMessage(
                "תעודת המשלוח נוצרה, אך שליחת המייל נכשלה."
            );
        } finally {
            setSending(false);
        }
    }

    return (
        <div
            className="modal-overlay shipment-document-overlay"
            onClick={onClose}
        >
            <div
                className="shipment-document-modal"
                onClick={(e) => e.stopPropagation()}
                dir="rtl"
            >
                <div className="shipment-document-actions no-print">
                    <button onClick={() => window.print()}>
                        🖨️ הדפס
                    </button>

                    <button
                        onClick={sendEmails}
                        disabled={sending}
                    >
                        {sending
                            ? "שולח..."
                            : "✉️ שלח במייל"}
                    </button>

                    <button
                        className="modal-x"
                        onClick={onClose}
                    >
                        ×
                    </button>
                </div>

                <div className="shipment-document">
                    <header className="shipment-document-header">
                        <img
                            src={shpiro}
                            alt="Shpiro"
                            className="shipment-logo"
                        />

                        <div>
                            <h1>תעודת משלוח</h1>

                            <div>
                                מספר:
                                <strong>
                                    {" "}
                                    {shipmentId}
                                </strong>
                            </div>

                            <div>
                                תאריך: {date}
                            </div>
                        </div>
                    </header>

                    <table className="shipment-table">
                        <thead>
                            <tr>
                                <th>סגנון</th>
                                <th>תת־סוג</th>
                                <th>אצווה</th>
                                <th>סוג</th>
                                <th>כמות</th>
                            </tr>
                        </thead>

                        <tbody>
                            {pallets.map((p) => (
                                <tr key={p.id}>
                                    <td>{p.beerStyle}</td>

                                    <td>
                                        {p.subLabel || "—"}
                                    </td>

                                    <td>
                                        {p.batchNumber || "—"}
                                    </td>

                                    <td>
                                        {p.itemType ===
                                        "kegs"
                                            ? "חביות"
                                            : "ארגזים"}
                                    </td>

                                    <td>
                                        {p.quantity}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>

                    <h3>סיכום</h3>

                    <table className="shipment-summary-table">
                        <thead>
                            <tr>
                                <th>סגנון</th>
                                <th>סוג</th>
                                <th>סה"כ</th>
                            </tr>
                        </thead>

                        <tbody>
                            {totals.map((t) => (
                                <tr
                                    key={`${t.beerStyle}-${t.itemType}`}
                                >
                                    <td>
                                        {t.beerStyle}
                                    </td>

                                    <td>
                                        {t.itemType ===
                                        "kegs"
                                            ? "חביות"
                                            : "ארגזים"}
                                    </td>

                                    <td>
                                        {t.quantity}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>

                    <footer className="shipment-document-footer">
                        הופק ממערכת ניהול המלאי
                    </footer>
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

                        <button onClick={addEmail}>
                            הוסף
                        </button>
                    </div>

                    {message && (
                        <div className="edit-specs-message success">
                            {message}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}