import { useEffect, useMemo, useState, type ComponentProps } from "react";
import { ArrowRightLeft, Pencil, ClipboardClock, BottleWine, Truck, Check } from "lucide-react";
import { beerStyleClass } from "../SERVICES/Pallettypes ";
import type { Pallet, PalletZone } from "../SERVICES/Pallettypes ";

const ZONE_OPTIONS: { value: PalletZone; label: string; icon: React.ReactNode }[] = [
    { value: "pending", label: "ממתינים לשיבוץ", icon: <ClipboardClock size={18} /> },
    { value: "bottleRoom", label: "חדר בקבוקים", icon: <BottleWine size={18} /> },
    { value: "loadingDock", label: "בהעמסה למשלוח", icon: <Truck size={18} /> },
];

function sortPendingPallets(pallets: Pallet[]) {
    return [...pallets].sort((a, b) => {
        // הגדולים ראשונים, הקטנים בסוף
        return b.quantity - a.quantity;
    });
}

function ZoneMoveModal({
    pallet,
    onMove,
    onClose,
}: {
    pallet: Pallet;
    onMove: (id: string, zone: PalletZone) => Promise<void>;
    onClose: () => void;
}) {
    const options = ZONE_OPTIONS.filter(
        (z) => z.value !== pallet.zone
    );

    const [targetZone, setTargetZone] = useState<PalletZone>(
        options[0]?.value ?? "pending"
    );
    const [moving, setMoving] = useState(false);

    async function handleMove() {
        try {
            setMoving(true);
            await onMove(pallet.id, targetZone);
            onClose();
        } finally {
            setMoving(false);
        }
    }

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div
                className="modal-box zone-move-modal"
                onClick={(e) => e.stopPropagation()}
                dir="rtl"
            >
                <div className="modal-header-row">
                    <div>
                        <span className="modal-kicker">העברת משטח</span>
                        <h3>לאן להעביר?</h3>
                    </div>

                    <button
                        className="modal-x"
                        onClick={onClose}
                        disabled={moving}
                    >
                        ×
                    </button>
                </div>

                <p className="zone-move-modal-subtitle">
                    <span>
                        {pallet.quantity}{" "}
                        {pallet.itemType === "kegs"
                            ? "חביות"
                            : "ארגזים"}
                    </span>

                    <span> · {beerStyleClass(pallet.beerStyle).displayLabel}</span>

                    {pallet.batchNumber && (
                        <span> · אצווה {pallet.batchNumber}</span>
                    )}
                </p>

                <div className="zone-move-modal-options">
                    {options.map((z) => (
                        <button key={z.value} type="button"
                            className={`zone-move-modal-option ${targetZone === z.value ? "active" : ""}`}
                            onClick={() => setTargetZone(z.value)}
                            disabled={moving}>
                            {z.icon}
                            <span className="zone-move-modal-option-label">{z.label}</span>
                            {targetZone === z.value && <Check size={16} className="zone-move-modal-option-check" />}
                        </button>
                    ))}
                </div>

                <div className="zone-move-modal-footer">
                    <button
                        className="modal-cancel-btn"
                        onClick={onClose}
                        disabled={moving}
                    >
                        ביטול
                    </button>

                    <button
                        className="modal-save-btn"
                        onClick={handleMove}
                        disabled={moving}
                    >
                        {moving ? "מעביר..." : "אשר העברה"}
                    </button>
                </div>
            </div>
        </div>
    );
}

function ZoneListItem({
    pallet,
    selected,
    bulkMode,
    onSelectForPlacement,
    onToggleBulk,
    onEditPallet,
    onOpenMoveModal,
}: {
    pallet: Pallet;
    selected: boolean;
    bulkMode: boolean;
    onSelectForPlacement: (pallet: Pallet) => void;
    onToggleBulk: (id: string) => void;
    onEditPallet: (pallet: Pallet) => void;
    onOpenMoveModal: (pallet: Pallet) => void;
}) {
    const itemLabel =
        pallet.itemType === "kegs" ? "חביות" : "ארגזים";

    return (
        <article
            className={`zone-tray-item ${beerStyleClass(pallet.beerStyle).className
                } ${selected ? "selected" : ""}`}
        >
            {bulkMode && (
                <label
                    className="zone-bulk-check"
                    onClick={(e) => e.stopPropagation()}
                >
                    <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => onToggleBulk(pallet.id)}
                    />
                </label>
            )}

            <div className="zone-tray-item-main">
                <div className="zone-tray-item-title">
                    <span className="zone-item-icon">
                        {pallet.itemType === "kegs" ? "🛢️" : "📦"}
                    </span>

                    {beerStyleClass(pallet.beerStyle).displayLabel}

                    {pallet.subLabel
                        ? ` · ${pallet.subLabel}`
                        : ""}
                </div>

                <div className="zone-tray-item-meta">
                    <strong>
                        {pallet.quantity} {itemLabel}
                    </strong>

                    {pallet.batchNumber
                        ? ` · אצווה ${pallet.batchNumber}`
                        : ""}
                </div>
            </div>

            <div
                className="zone-tray-item-actions"
                onClick={(e) => e.stopPropagation()}
            >
                {/* שיבוץ במפה = תמיד יחיד */}
                {!bulkMode && (
                    <button
                        className="zone-primary-action"
                        onClick={() => onSelectForPlacement(pallet)}
                    >
                        שבץ במפה
                    </button>
                )}

                <button
                    className="zone-secondary-action"
                    onClick={() => onEditPallet(pallet)}
                >
                    <Pencil size={14} />
                    עריכה
                </button>

                {/* במצב Bulk אין העברה יחידנית */}
                {!bulkMode && (
                    <button
                        className="zone-secondary-action"
                        onClick={() => onOpenMoveModal(pallet)}
                    >
                        <ArrowRightLeft size={14} />
                        העבר
                    </button>
                )}
            </div>
        </article>
    );
}

export function ZoneTray({
    title,
    hint,
    pallets,
    selectedPalletIds,
    bulkMode,
    onStartBulk,
    onCancelBulk,
    onSelectForPlacement,
    onToggleBulk,
    onBulkMove,
    onEditPallet,
    onMoveZone,
}: {
    title: string;
    hint: string;
    pallets: Pallet[];
    selectedPalletIds: Set<string>;
    bulkMode: boolean;
    onStartBulk: () => void;
    onCancelBulk: () => void;
    onSelectForPlacement: (pallet: Pallet) => void;
    onToggleBulk: (id: string) => void;
    onBulkMove: (zone: PalletZone) => Promise<void>;
    onEditPallet: (pallet: Pallet) => void;
    onMoveZone: (id: string, zone: PalletZone) => Promise<void>;
}) {
    const [bulkTarget, setBulkTarget] =
        useState<PalletZone>("bottleRoom");

    const [movingPallet, setMovingPallet] =
        useState<Pallet | null>(null);
    const [showBulkMoveModal, setShowBulkMoveModal] = useState(false);

    const displayPallets = useMemo(() => {
        // רק Pending מקבל את המיון הזה
        if (pallets.every((p) => p.zone === "pending")) {
            return sortPendingPallets(pallets);
        }

        return pallets;
    }, [pallets]);

    const allSelected =
        pallets.length > 0 &&
        pallets.every((p) => selectedPalletIds.has(p.id));

    // const someSelected =
    //     selectedPalletIds.size > 0;

    useEffect(() => {
        const allowedTargets = ZONE_OPTIONS
            .filter((z) => z.value !== pallets[0]?.zone);

        if (
            !allowedTargets.some(
                (z) => z.value === bulkTarget
            )
        ) {
            setBulkTarget(
                allowedTargets[0]?.value ?? "bottleRoom"
            );
        }
    }, [pallets, bulkTarget]);

    function selectAll() {
        pallets.forEach((p) => {
            if (!selectedPalletIds.has(p.id)) {
                onToggleBulk(p.id);
            }
        });
    }

    function clearAll() {
        pallets.forEach((p) => {
            if (selectedPalletIds.has(p.id)) {
                onToggleBulk(p.id);
            }
        });
    }

    return (
        <div className="zone-tray">
            <div className="zone-tray-header">
                <div>
                    <h3>{title}</h3>
                    <p>{hint}</p>
                </div>

                {!bulkMode ? (
                    <button
                        className="bulk-mode-btn"
                        onClick={onStartBulk}
                        disabled={pallets.length === 0}
                    >
                        בחר כמה להעברה
                    </button>
                ) : (
                    <button
                        className="bulk-mode-cancel"
                        onClick={onCancelBulk}
                    >
                        יציאה מבחירה
                    </button>
                )}
            </div>

            {/* {pallets.length > 0 && !bulkMode && (
                <div className="zone-select-all-row">
                    <button
                        type="button"
                        className="zone-select-all-btn"
                        onClick={()=>selectAll}
                    >
                        בחר הכל להעברה
                    </button>
                </div>
            )} */}

            {bulkMode && (
                <div className="bulk-action-bar">
                    <div className="bulk-selection-info">
                        <strong>
                            {selectedPalletIds.size}{"  "} נבחרו
                        </strong>

                        <button
                            type="button"
                            onClick={
                                allSelected
                                    ? clearAll
                                    : selectAll
                            }
                            className="bulk-select-all-btn"
                        >
                            {allSelected
                                ? "בטל בחירת הכל"
                                : "בחר הכל"}
                                
                        </button>
                    </div>

                    <button
                        disabled={selectedPalletIds.size === 0}
                        onClick={() => setShowBulkMoveModal(true)}
                    >
                        העבר נבחרים
                    </button>

                </div>
            )}

            {pallets.length === 0 ? (
                <div className="zone-tray-empty">
                    אין משטחים באזור הזה כרגע.
                </div>
            ) : (
                <div className="zone-tray-list">
                    {displayPallets.map((p) => (
                        <ZoneListItem
                            key={p.id}
                            pallet={p}
                            selected={selectedPalletIds.has(
                                p.id
                            )}
                            bulkMode={bulkMode}
                            onSelectForPlacement={
                                onSelectForPlacement
                            }
                            onToggleBulk={onToggleBulk}
                            onEditPallet={onEditPallet}
                            onOpenMoveModal={
                                setMovingPallet
                            }
                        />
                    ))}
                </div>
            )}

            {movingPallet && (
                <ZoneMoveModal
                    pallet={movingPallet}
                    onMove={onMoveZone}
                    onClose={() =>
                        setMovingPallet(null)
                    }
                />
            )}
            {showBulkMoveModal && (
                <ZoneMoveModal
                    pallet={{ ...pallets[0], quantity: selectedPalletIds.size } as Pallet} // just for the subtitle count
                    onMove={async (_id, zone) => { await onBulkMove(zone); }}
                    onClose={() => setShowBulkMoveModal(false)}
                />
            )}
        </div>
    );
}

export function PendingTray(
    props: Omit<
        ComponentProps<typeof ZoneTray>,
        "title" | "hint"
    >
) {
    return (
        <ZoneTray
            {...props}
            title="ממתינים לשיבוץ"
            hint="בחר משטח כדי לשבץ אותו במקרר, או הפעל בחירה מרובה להעברת מספר משטחים."
        />
    );
}

export function StashTray(
    props: Omit<
        ComponentProps<typeof ZoneTray>,
        "title" | "hint"
    >
) {
    return (
        <ZoneTray
            {...props}
            title="בסידור"
            hint="כאן נמצאים משטחים שהוצאו זמנית מהמקרר."
        />
    );
}

export function BottleRoomTray(
    props: Omit<
        ComponentProps<typeof ZoneTray>,
        "title" | "hint"
    >
) {
    return (
        <ZoneTray
            {...props}
            title="חדר בקבוקים"
            hint="משטחים שנמצאים פיזית בחדר הבקבוקים. ניתן להעביר משטח בודד או לבחור כמה להעברה."
        />
    );
}