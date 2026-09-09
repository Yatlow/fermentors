import BeerLoader from "../general/Loading";

import { useEffect, useState } from "react";

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

    const [selectedShipment, setSelectedShipment] = useState<Shipment | null>(null)
    const [selectedShipmentId, setSelectedShipmentId] = useState<string | null>(
        null
    );

    // ========================================================
    // LOAD SHIPMENTS
    // ========================================================

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

    // ========================================================
    // LOAD PALLETS OF SELECTED SHIPMENT
    // ========================================================

    async function handleShipmentChange(shipmentId: string) {
        if (!shipmentId) {
            setSelectedShipmentId(null);
            setSelectedShipment(null)
            setPallets([]);
            return;
        }

        const shipmentL = shipments.find(
            (shipment) => shipment.id === shipmentId
        );

        if (!shipmentL) {
            console.error("Shipment not found:", shipmentId);
            setSelectedShipmentId(null);
            setSelectedShipment(null)
            setPallets([]);
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
            setSelectedShipmentId(shipmentId);
            setSelectedShipment(shipmentL)


        } catch (error) {
            console.error("Error loading shipment pallets:", error);
            setPallets([]);
            setSelectedShipmentId(null);
            setSelectedShipment(null)

        } finally {
            setLoadingPallets(false);
        }
    }

    // ========================================================
    // CLOSE MODAL
    // ========================================================

    function handleCloseModal() {
        setSelectedShipmentId(null);
        setSelectedShipment(null)
        setPallets([]);
    }

    // ========================================================
    // RENDER
    // ========================================================

    return (
        <div className="write-messurmant">
            {/* SHIPMENT PICKER */}

            <div
                className="status-filter"
                style={{ marginBottom: 10 }}
            >
                {loadingShipments && (
                    <BeerLoader
                        message="טוען תעודות משלוח..."
                        size="small"
                    />
                )}

                {!loadingShipments && (
                    <select
                        value={selectedShipmentId ?? ""}
                        onChange={(e) =>
                            handleShipmentChange(e.target.value)
                        }
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
                                {s.shipmentNumber} -{" "}
                                {formatDate(s.createdAt)}
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

            {/* LOADING PALLETS */}

            {loadingPallets && (
                <div className="measurementLoading">
                    <BeerLoader
                        message="טוען את המשטחים..."
                        size="small"
                    />
                </div>
            )}

            {/* SHIPMENT DOCUMENT */}

            {selectedShipmentId && !loadingPallets && (
                <ShipmentDocumentModal
                    onClose={handleCloseModal}
                    shipmentId={selectedShipmentId}
                    pallets={pallets}
                    inline
                    customerName={selectedShipment?.customerName ?? ""}
                    shipment={selectedShipment}
                />
            )}
        </div>
    );
}
