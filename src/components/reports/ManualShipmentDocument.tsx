import type { Shipment } from "../../SERVICES/cooler/Pallettypes ";
import shpiro from "../../assets/shpiro.jpeg";
import "./manualShipmentPrint.css";

export default function ManualShipmentDocument({ shipment }: { shipment: Shipment }) {
    const lines = shipment.manualLines ?? [];
    const createdAt = shipment.createdAt?.toDate?.() ?? new Date();
    const date = createdAt.toLocaleDateString("he-IL", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
    });

    function print() {
        window.print();
    }

    return (
        <section className="shipment-document" dir="rtl" style={{ background: "white", padding: 18, borderRadius: 14 }}>
            <div className="shipment-document-header" style={{ display: "flex", justifyContent: "space-between", gap: 18, alignItems: "flex-start" }}>
                <div>
                    <h2 style={{ margin: 0 }}>תעודת משלוח #{shipment.shipmentNumber}</h2>
                    <div style={{ marginTop: 6 }}>תאריך: {date}</div>
                    <div style={{ marginTop: 6 }}><strong>לכבוד:</strong> {shipment.customerName || "—"}</div>
                </div>
                <img src={shpiro} alt="שפירא" style={{ width: 90, height: 70, objectFit: "contain" }} />
            </div>

            <table className="shipment-table" style={{ width: "100%", borderCollapse: "collapse", marginTop: 18 }}>
                <thead>
                    <tr>
                        <th style={{ border: "1px solid #cbd5e1", padding: 8 }}>מק״ט</th>
                        <th style={{ border: "1px solid #cbd5e1", padding: 8 }}>תיאור פריט</th>
                        <th style={{ border: "1px solid #cbd5e1", padding: 8 }}>כמות</th>
                    </tr>
                </thead>
                <tbody>
                    {lines.map((line) => (
                        <tr key={line.id}>
                            <td style={{ border: "1px solid #cbd5e1", padding: 8 }}>{line.sku || "—"}</td>
                            <td style={{ border: "1px solid #cbd5e1", padding: 8 }}>{line.description}</td>
                            <td style={{ border: "1px solid #cbd5e1", padding: 8 }}>{line.quantity}</td>
                        </tr>
                    ))}
                </tbody>
            </table>

            <div style={{ display: "flex", gap: 24, marginTop: 30 }}>
                <div style={{ flex: 1 }}>שם וחתימת מקבל: ____________________</div>
                <div style={{ flex: 1 }}>חתימת נהג: ____________________</div>
            </div>

            <button type="button" className="btn-primary" style={{ marginTop: 20 }} onClick={print}>
                הדפס / שמור PDF
            </button>
        </section>
    );
}
