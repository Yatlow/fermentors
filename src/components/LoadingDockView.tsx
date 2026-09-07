import { useMemo, useState } from "react";
import type { Pallet } from "../SERVICES/Pallettypes ";
import ShipmentDocumentModal from "./ShipmentDocumentModal";
import {
    createShipment,
    moveToZone,
    calcTruckSlots,
    MAX_TRUCK_SLOTS,
} from "../SERVICES/Palletservice";
import BeerLoader from "./Loading";

function useTotals(pallets: Pallet[]) {
    return useMemo(() => {
        const map = new Map<
            string,
            {
                itemType: string;
                beerStyle: string;
                totalQuantity: number;
            }
        >();

        pallets.forEach((p) => {
            const key = `${p.itemType}__${p.beerStyle}`;
            const cur = map.get(key);

            if (cur) {
                cur.totalQuantity += p.quantity;
            } else {
                map.set(key, {
                    itemType: p.itemType,
                    beerStyle: p.beerStyle,
                    totalQuantity: p.quantity,
                });
            }
        });

        return Array.from(map.values());
    }, [pallets]);
}

export default function LoadingDockView({
    pallets,
}: {
    pallets: Pallet[];
}) {
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState(false);
    const [busyAction, setBusyAction] = useState<"return" | "ship" | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [lastShipmentId, setLastShipmentId] =
        useState<string | null>(null);

    const [shipmentPallets, setShipmentPallets] =
        useState<Pallet[]>([]);

    const [showShipmentDocument, setShowShipmentDocument] =
        useState(false);

    /*
     * =========================================================
     * כל המשטחים שנבחרו
     * =========================================================
     */
    const selectedPallets = useMemo(
        () => pallets.filter((p) => selected.has(p.id)),
        [pallets, selected]
    );

    /*
     * =========================================================
     * קיבולת המשאית — תמיד לפי כל המשטחים במשטח ההעמסה
     * =========================================================
     */
    const totalTruckSlots = useMemo(
        () => calcTruckSlots(pallets),
        [pallets]
    );

    const totalTruckOverCapacity =
        totalTruckSlots > MAX_TRUCK_SLOTS;

    /*
     * =========================================================
     * קיבולת לפי הבחירה הנוכחית
     * =========================================================
     */
    const selectedTruckSlots = useMemo(
        () => calcTruckSlots(selectedPallets),
        [selectedPallets]
    );

    const selectedTruckOverCapacity =
        selectedTruckSlots > MAX_TRUCK_SLOTS;

    /*
     * =========================================================
     * האם הכל נבחר
     * =========================================================
     */
    const allSelected =
        pallets.length > 0 &&
        pallets.every((p) => selected.has(p.id));

    /*
     * =========================================================
     * סיכום כמויות
     *
     * הסיכום מציג את כל המשטחים במשטח ההעמסה,
     * ולא רק את אלה שנבחרו.
     * =========================================================
     */
    const totals = useTotals(pallets);

    /*
     * =========================================================
     * בחירה / ביטול בחירה
     * =========================================================
     */
    function togglePallet(id: string) {
        setSelected((current) => {
            const next = new Set(current);

            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }

            return next;
        });
    }

    function toggleSelectAll() {
        setSelected(() => {
            if (allSelected) {
                return new Set();
            }

            return new Set(pallets.map((p) => p.id));
        });
    }

    /*
     * =========================================================
     * החזרת משטח ל"ממתינים לשיבוץ"
     * =========================================================
     */
    async function returnToPending(id: string) {
        setBusy(true);
        setBusyAction("return");
        setError(null);

        try {
            await moveToZone(id, "pending");

            setSelected((current) => {
                const next = new Set(current);
                next.delete(id);
                return next;
            });
        } catch (e: any) {
            setError(e?.message ?? "שגיאה בהעברת המשטח");
        } finally {
            setBusy(false);
            setBusyAction(null);
        }
    }

    /*
     * =========================================================
     * יצירת משלוח
     * =========================================================
     */
    async function handleShip() {
        if (selected.size === 0) {
            return;
        }

        setBusy(true);
        setBusyAction("ship");
        setError(null);

        try {
            const palletsForShipment = pallets.filter((p) =>
                selected.has(p.id)
            );

            const shipmentId = await createShipment(
                palletsForShipment.map((p) => p.id)
            );

            setLastShipmentId(shipmentId);
            setShipmentPallets(palletsForShipment);
            setShowShipmentDocument(true);
            setSelected(new Set());
        } catch (e: any) {
            setError(e?.message ?? "שגיאה בשילוח");
        } finally {
            setBusy(false);
            setBusyAction(null);
        }
    }

    /*
     * =========================================================
     * אין משטחים
     * =========================================================
     */
    if (pallets.length === 0 && !showShipmentDocument) {
        return (
            <div className="zone-tray-empty">
                אין משטחים במשטח הטעינה כרגע.
            </div>
        );
    }

    return (
        <div className="loading-dock-view" dir="rtl">
            {/* =====================================================
                HEADER
            ====================================================== */}
            <div className="zone-tray-header">
                <div>
                    <h3>משטח טעינה</h3>
                    <p>
                        בחר משטחים שנשלחו. לחץ שלח לניפוק תעודת
                        משלוח.
                    </p>
                </div>

                {pallets.length > 0 && (
                    <button
                        type="button"
                        className="bulk-mode-btn"
                        onClick={toggleSelectAll}
                        disabled={busy}
                    >
                        {allSelected
                            ? "בטל בחירת הכל"
                            : "בחר הכל"}
                    </button>
                )}
            </div>

            {/* =====================================================
                קיבולת המשאית — מצב כללי
            ====================================================== */}
            <div
                className={`truck-capacity-indicator ${
                    totalTruckOverCapacity
                        ? "over-capacity"
                        : ""
                }`}
                dir="rtl"
            >
                <div className="truck-capacity-icon">
                    🚚
                </div>

                <div className="truck-capacity-info">
                    <strong>תפוסת המשאית</strong>

                    <span>
                        {totalTruckSlots} / {MAX_TRUCK_SLOTS}{" "}
                        מקומות
                    </span>
                </div>

                <div className="truck-capacity-bar">
                    <div
                        className="truck-capacity-bar-fill"
                        style={{
                            width: `${Math.min(
                                100,
                                (totalTruckSlots /
                                    MAX_TRUCK_SLOTS) *
                                    100
                            )}%`,
                        }}
                    />
                </div>

                {totalTruckOverCapacity && (
                    <div className="truck-capacity-warning">
                        ⚠️ חרגת מקיבולת המשאית ב־
                        {totalTruckSlots - MAX_TRUCK_SLOTS}{" "}
                        מקומות
                    </div>
                )}
            </div>

            {/* =====================================================
                קיבולת הבחירה הנוכחית
            ====================================================== */}
            {selected.size > 0 && (
                <div
                    className={`truck-capacity-indicator ${
                        selectedTruckOverCapacity
                            ? "over-capacity"
                            : ""
                    }`}
                    dir="rtl"
                >
                    <div className="truck-capacity-icon">
                        📦
                    </div>

                    <div className="truck-capacity-info">
                        <strong>הבחירה למשלוח</strong>

                        <span>
                            {selectedTruckSlots} /{" "}
                            {MAX_TRUCK_SLOTS} מקומות
                        </span>
                    </div>

                    <div className="truck-capacity-bar">
                        <div
                            className="truck-capacity-bar-fill"
                            style={{
                                width: `${Math.min(
                                    100,
                                    (selectedTruckSlots /
                                        MAX_TRUCK_SLOTS) *
                                        100
                                )}%`,
                            }}
                        />
                    </div>

                    {selectedTruckOverCapacity && (
                        <div className="truck-capacity-warning">
                            ⚠️ הבחירה חורגת מקיבולת המשאית ב־
                            {selectedTruckSlots -
                                MAX_TRUCK_SLOTS}{" "}
                            מקומות
                        </div>
                    )}
                </div>
            )}

            {/* =====================================================
                רשימת המשטחים
            ====================================================== */}
            <div className="dock-list">
                {pallets.map((pallet) => {
                    const isSelected = selected.has(
                        pallet.id
                    );

                    return (
                        <article
                            key={pallet.id}
                            className={`dock-card ${
                                isSelected ? "selected" : ""
                            }`}
                        >
                            <label className="dock-select">
                                <input
                                    type="checkbox"
                                    checked={isSelected}
                                    disabled={busy}
                                    onChange={() =>
                                        togglePallet(
                                            pallet.id
                                        )
                                    }
                                />

                                <span>
                                    בחר למשלוח
                                </span>
                            </label>

                            <div className="dock-card-info">
                                <strong>
                                    {pallet.beerStyle}

                                    {pallet.subLabel
                                        ? ` · ${pallet.subLabel}`
                                        : ""}
                                </strong>

                                <span>
                                    {pallet.quantity}{" "}
                                    {pallet.itemType ===
                                    "kegs"
                                        ? "חביות"
                                        : "ארגזים"}

                                    {pallet.batchNumber
                                        ? ` · אצווה ${pallet.batchNumber}`
                                        : ""}
                                </span>
                            </div>

                            <button
                                type="button"
                                className="zone-secondary-action"
                                onClick={() =>
                                    returnToPending(
                                        pallet.id
                                    )
                                }
                                disabled={busy}
                            >
                                {busyAction === "return" ? <BeerLoader message="מעביר..." size="spinner" /> : 'החזר ל"ממתינים לשיבוץ"'}
                            </button>
                        </article>
                    );
                })}
            </div>

            {/* =====================================================
                סיכום כמויות
            ====================================================== */}
            {totals.length > 0 && (
                <table className="dock-summary">
                    <thead>
                        <tr>
                            <th>סגנון</th>
                            <th>סוג</th>
                            <th>סה״כ</th>
                        </tr>
                    </thead>

                    <tbody>
                        {totals.map((total) => (
                            <tr
                                key={`${total.beerStyle}-${total.itemType}`}
                            >
                                <td>
                                    {total.beerStyle}
                                </td>

                                <td>
                                    {total.itemType ===
                                    "kegs"
                                        ? "חביות"
                                        : "ארגזים"}
                                </td>

                                <td>
                                    {total.totalQuantity}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}

            {/* =====================================================
                הודעות
            ====================================================== */}
            {error && (
                <div className="edit-specs-message error">
                    {error}
                </div>
            )}

            {lastShipmentId && (
                <div className="edit-specs-message success">
                    תעודת משלוח נוצרה ({lastShipmentId})
                </div>
            )}

            {/* =====================================================
                כפתור שליחה — אחד בלבד
            ====================================================== */}
            <button
                type="button"
                className={`shipment-btn ${
                    selectedTruckOverCapacity
                        ? "shipment-btn-over-capacity"
                        : ""
                }`}
                disabled={
                    busy || selected.size === 0
                }
                onClick={handleShip}
            >
                {busyAction === "ship" ? (
                    <BeerLoader
                        message="יוצר תעודה"
                        overlay={false}
                        size="spinner"
                    />
                ) : (
                    `שלח${
                        selected.size
                            ? ` (${selected.size})`
                            : ""
                    }`
                )}
            </button>

            {/* =====================================================
                תעודת משלוח
            ====================================================== */}
            {showShipmentDocument && (
                <ShipmentDocumentModal
                    shipmentId={lastShipmentId!}
                    pallets={shipmentPallets}
                    onClose={() =>
                        setShowShipmentDocument(false)
                    }
                />
            )}
        </div>
    );
}