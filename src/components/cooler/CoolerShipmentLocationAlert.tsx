import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { Truck } from "lucide-react";
import { db } from "../../firebase";
import type { Pallet } from "../../SERVICES/cooler/Pallettypes ";
import "./CoolerShipmentLocationAlert.css";

type AlertZone = "pending" | "bottleRoom";

type ZoneSummary = {
    zone: AlertZone;
    label: string;
    kegs: number;
    crates: number;
};

const ZONES: Array<{ zone: AlertZone; label: string }> = [
    { zone: "pending", label: "ממתינים לשיבוץ" },
    { zone: "bottleRoom", label: "חדר בקבוקים" },
];

function summarize(zone: AlertZone, label: string, pallets: Pallet[]): ZoneSummary {
    return pallets
        .filter((pallet) => pallet.zone === zone)
        .reduce<ZoneSummary>((result, pallet) => {
            if (pallet.itemType === "kegs") result.kegs += pallet.quantity;
            else result.crates += pallet.quantity;
            return result;
        }, { zone, label, kegs: 0, crates: 0 });
}

export default function CoolerShipmentLocationAlert() {
    const [target, setTarget] = useState<HTMLElement | null>(null);
    const [markedPallets, setMarkedPallets] = useState<Pallet[]>([]);

    useEffect(() => {
        const resolveTarget = () => {
            setTarget(document.querySelector<HTMLElement>(".cooler-map-header"));
        };

        resolveTarget();
        const observer = new MutationObserver(resolveTarget);
        observer.observe(document.body, { childList: true, subtree: true });
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (!target) {
            setMarkedPallets([]);
            return;
        }

        // One narrow listener replaces two full-zone listeners. The alert only
        // needs pallets that are already marked for shipment; filtering the two
        // relevant zones locally avoids duplicating CoolerMap/planning reads.
        const markedQuery = query(
            collection(db, "pallets"),
            where("markedForShipment", "==", true),
        );

        return onSnapshot(
            markedQuery,
            (snapshot) => {
                setMarkedPallets(
                    snapshot.docs
                        .map((item) => ({ id: item.id, ...item.data() } as Pallet))
                        .filter((pallet) => pallet.zone === "pending" || pallet.zone === "bottleRoom"),
                );
            },
            (error) => {
                console.error("Cooler shipment-location alert subscription failed", error);
                setMarkedPallets([]);
            },
        );
    }, [target]);

    const summaries = useMemo(
        () => ZONES
            .map(({ zone, label }) => summarize(zone, label, markedPallets))
            .filter((summary) => summary.kegs > 0 || summary.crates > 0),
        [markedPallets],
    );

    if (!target || summaries.length === 0) return null;

    return createPortal(
        <div className="cooler-shipment-location-alert" role="alert">
            <Truck size={17} aria-hidden="true" />
            <div>
                {summaries.flatMap((summary) => {
                    const lines: string[] = [];
                    if (summary.kegs > 0) {
                        lines.push(`${summary.kegs} חביות מסומנות למשלוח נמצאות ב${summary.label}.`);
                    }
                    if (summary.crates > 0) {
                        lines.push(`${summary.crates} ארגזים מסומנים למשלוח נמצאים ב${summary.label}.`);
                    }
                    return lines.map((line) => <div key={`${summary.zone}:${line}`}>{line}</div>);
                })}
            </div>
        </div>,
        target,
    );
}
