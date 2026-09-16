import BeerLoader from "../general/Loading";

import { useEffect, useState } from "react";
import { Plus } from "lucide-react";

import type { Pallet, Shipment } from "../../SERVICES/cooler/Pallettypes ";

import {
    collection,
    doc,
    getDoc,
    onSnapshot,
    Timestamp,
} from "firebase/firestore";

import { db } from "../../firebase";

import ShipmentDocumentModal from "../cooler/ShipmentDocumentModal";
import ManualShipmentCreator from "./ManualShipmentCreator";
import ManualShipmentDocument from "./ManualShipmentDocument";

function formatDate(timestamp?: Timestamp | null): string {
    if (!timestamp) return "";

    const date = timestamp.toDate();

    return date.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "2-digit",
        year: "2-digit",
    });
}

export default function ShipmentReportsView() {
    const [shipments, setShipments] = useState<Shipment[]>([]);
    const [pallets, setPallets] = useState<Pallet[]>([]);

    const [loadingShipments, setLoadingShipments] = useState(true);
    const [loadingPallets, setLoadingPallets] = useState(false);

    const [selectedShipment, setSelectedShipment] = useState<Shipment | null>(null);
    const [selectedShipmentId, setSelectedShipmentId] = useState<string | null>(null);
    const [showManualCreator, setShowManualCreator] = useState(false);

    useEffect(() => {
        const shipmentsRef = collection(db, "shipments");

        const unsubscribe = onSnapshot(
            shipmentsRef,
            (snapshot) => {
                const data: Shipment[] = snapshot.docs.map(
                    (firebaseDoc) =>
                    ({
                        id: firebaseDoc.id,
                        ...firebaseDoc.data(),
                    } as Shipment)
                );

                data.sort((a, b) => Number(b.shipmentNumber) - Number(a.shipmentNumber));
                setShipments(data);
                setLoadingShipments(false);
            },
            (error) => {
                console.error("Firestore listener error:", error);
                setLoadingShipments(false);
            }
        );

        return () => unsubscribe();
    }, []);

    async function handleShipmentChange(shipmentId: string) {
        if (!shipmentId) {
            setSelectedShipmentId(null);
            setSelectedShipment(null);
            setPallets([]);
            return;
        }

        const shipmentL = shipments.find(
            (shipment) => shipment.id === shipmentId
        );

        if (!shipmentL) {
            console.error("Shipment not found:", shipmentId);
            setSelectedShipmentId(null);
            setSelectedShipment(null);
            setPallets([]);
            return;
        }

        setSelectedShipmentId(shipmentId);
        setSelectedShipment(shipmentL);

        if (shipmentL.sourceType === "manual" || (shipmentL.manualLines?.length ?? 0) > 0) {
            setPallets([]);
            setLoadingPallets(false);
            return;
        }

        setLoadingPallets(true);
        try {
            const palletSnapshots = await Promise.all(
                shipmentL.palletIds.map((palletId) =>
                    getDoc(doc(db, "pallets", palletId))
                )
            );

            const shipmentPallets: Pallet[] = palletSnapshots
                .filter((snapshot) => snapshot.exists())
                .map(
                    (snapshot) =>
                    ({
                        id: snapshot.id,
                        ...snapshot.data(),
                    } as Pallet)
                );

            setPallets(shipmentPallets);
        } catch (error) {
            console.error("Error loading shipment pallets:", error);
            setPallets([]);
            setSelectedShipmentId(null);
            setSelectedShipment(null);
        } finally {
            setLoadingPallets(false);
        }
    }

    function handleCloseModal() {
        setSelectedShipmentId(null);
        setSelectedShipment(null);
        setPallets([]);
    }

    function handleManualCreated(shipmentId: string) {
        setShowManualCreator(false);
        window.setTimeout(() => {
            const created = shipments.find((shipment) => shipment.id === shipmentId);
            if (created) {
                void handleShipmentChange(shipmentId);
                return;
            }
            setSelectedShipmentId(shipmentId);
        }, 100);
    }

    useEffect(() => {
        if (!selectedShipmentId || selectedShipment) return;
        const created = shipments.find((shipment) => shipment.id === selectedShipmentId);
        if (created) void handleShipmentChange(created.id);
        // selectedShipment is intentionally omitted: this effect only resolves a just-created id.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shipments, selectedShipmentId]);

    const isManualSelected = selectedShipment?.sourceType === "manual" || (selectedShipment?.manualLines?.length ?? 0) > 0;

    return (
        <div className="write-messurmant">
            <div
                className="status-filter"
                style={{ marginBottom: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}
            >
                <button
                    type="button"
                    className="status-filter-button"
                    onClick={() => setShowManualCreator(true)}
                    style={{ display: "inline-flex", gap: 6, alignItems: "center" }}
                >
                    <Plus size={18} />
                    <span>תעודת משלוח חדשה</span>
                </button>

                {loadingShipments && (
                    <BeerLoader
                        message="טוען תעודות משלוח..."
                        size="small"
                    />
                )}

                {!loadingShipments && (
                    <select
                        value={selectedShipmentId ?? ""}
                        onChange={(e) => void handleShipmentChange(e.target.value)}
                        style={{
                            minWidth: 220,
                            padding: "8px 12px",
                            borderRadius: 8,
                            border: "1px solid #cbd5e1",
                            background: "#fff",
                            fontSize: 14,
                        }}
                    >
                        <option value="">
                            בחר תעודת משלוח
                        </option>

                        {shipments.map((s) => (
                            <option key={s.id} value={s.id}>
                                {s.shipmentNumber} - {formatDate(s.createdAt)}
                                {(s.sourceType === "manual" || (s.manualLines?.length ?? 0) > 0) ? " · ידנית" : ""}
                            </option>
                        ))}
                    </select>
                )}

                {!loadingShipments && shipments.length === 0 && (
                    <span className="measurement-batch">
                        אין תעודות משלוח להצגה בתצוגה זו
                    </span>
                )}
            </div>

            {loadingPallets && (
                <div className="measurementLoading">
                    <BeerLoader
                        message="טוען את המשטחים..."
                        size="small"
                    />
                </div>
            )}

            {selectedShipmentId && selectedShipment && !loadingPallets && isManualSelected && (
                <ManualShipmentDocument shipment={selectedShipment} />
            )}

            {selectedShipmentId && selectedShipment && !loadingPallets && !isManualSelected && (
                <ShipmentDocumentModal
                    onClose={handleCloseModal}
                    shipmentId={selectedShipmentId}
                    pallets={pallets}
                    inline
                    customerName={selectedShipment.customerName ?? ""}
                    shipment={selectedShipment}
                />
            )}

            {showManualCreator && (
                <ManualShipmentCreator
                    onClose={() => setShowManualCreator(false)}
                    onCreated={handleManualCreated}
                />
            )}
        </div>
    );
}
