import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Truck } from "lucide-react";
import { subscribeToZone } from "../../SERVICES/cooler/Palletservice";
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
        .filter((pallet) => pallet.markedForShipment)
        .reduce<ZoneSummary>((result, pallet) => {
            if (pallet.itemType === "kegs") result.kegs += pallet.quantity;
            else result.crates += pallet.quantity;
            return result;
        }, { zone, label, kegs: 0, crates: 0 });
}

export default function CoolerShipmentLocationAlert() {
    const [target, setTarget] = useState<HTMLElement | null>(null);
    const [zonePallets, setZonePallets] = useState<Record<AlertZone, Pallet[]>>({
        pending: [],
        bottleRoom: [],
    });

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
            setZonePallets({ pending: [], bottleRoom: [] });
            return;
        }

        const unsubscribers = ZONES.map(({ zone }) =>
            subscribeToZone(zone, (pallets) => {
                setZonePallets((current) => ({ ...current, [zone]: pallets }));
            }),
        );

        return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
    }, [target]);

    const summaries = useMemo(
        () => ZONES
            .map(({ zone, label }) => summarize(zone, label, zonePallets[zone]))
            .filter((summary) => summary.kegs > 0 || summary.crates > 0),
        [zonePallets],
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
