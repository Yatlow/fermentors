import { useState, type ComponentProps } from "react";
import { beerStyleClass } from "../SERVICES/Pallettypes ";
import type { Pallet, PalletZone } from "../SERVICES/Pallettypes ";

const ZONE_OPTIONS: { value: PalletZone; label: string }[] = [
    { value: "pending", label: "ממתינים לשיבוץ" },
    { value: "bottleRoom", label: "חדר בקבוקים" },
    { value: "loadingDock", label: "משטח טעינה" },
];

function ZoneListItem({
    pallet,
    selected,
    bulkMode,
    onSelectForPlacement,
    onToggleBulk,
    onEditPallet,
    onMoveZone,
}: {
    pallet: Pallet;
    selected: boolean;
    bulkMode: boolean;
    onSelectForPlacement: (pallet: Pallet) => void;
    onToggleBulk: (id: string) => void;
    onEditPallet: (pallet: Pallet) => void;
    onMoveZone: (id: string, zone: PalletZone) => Promise<void>;
}) {
    const [targetZone, setTargetZone] = useState<PalletZone>("bottleRoom");

    const itemLabel =
        pallet.itemType === "kegs" ? "חביות" : "ארגזים";

    const zoneOptions = ZONE_OPTIONS.filter(
        (z) => z.value !== pallet.zone
    );

    const actualTarget =
        zoneOptions.some((z) => z.value === targetZone)
            ? targetZone
            : zoneOptions[0]?.value;

    return (
        <article
            className={`zone-tray-item ${beerStyleClass(pallet.beerStyle).className
                } ${selected ? "selected" : ""}`}
        >
            {/* בחירה מרובה — רק כאשר הופעל מצב בחירה מרובה */}
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
                    {pallet.quantity} {itemLabel}

                    {pallet.batchNumber
                        ? ` · אצווה ${pallet.batchNumber}`
                        : ""}
                </div>
            </div>

            <div
                className="zone-tray-item-actions"
                onClick={(e) => e.stopPropagation()}
            >
                {/* שיבוץ = תמיד משטח אחד */}
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
                    עריכה
                </button>

                {/* העברה לאזור אחר */}
                {actualTarget && (
                    <div className="zone-move-inline">
                        <select
                            value={actualTarget}
                            onChange={(e) =>
                                setTargetZone(
                                    e.target.value as PalletZone
                                )
                            }
                        >
                            {zoneOptions.map((z) => (
                                <option
                                    key={z.value}
                                    value={z.value}
                                >
                                    {z.label}
                                </option>
                            ))}
                        </select>

                        <button
                            className="zone-move-action"
                            onClick={() =>
                                onMoveZone(
                                    pallet.id,
                                    actualTarget
                                )
                            }
                        >
                            העבר
                        </button>
                    </div>
                )}
            </div>
        </article>
    );
}

export function ZoneTray({
    title, hint, pallets, selectedPalletIds, bulkMode, onStartBulk, onCancelBulk, onSelectForPlacement,
    onToggleBulk, onBulkMove, onEditPallet, onMoveZone,
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
    const [bulkTarget, setBulkTarget] = useState<PalletZone>("bottleRoom");

    return (
        <div className="zone-tray">
            <div className="zone-tray-header">
                <div>
                    <h3>{title}</h3>
                    <p>{hint}</p>
                </div>
                {!bulkMode ? (
                    <button className="bulk-mode-btn" onClick={onStartBulk}>בחר כמה להעברה</button>
                ) : (
                    <button className="bulk-mode-cancel" onClick={onCancelBulk}>יציאה מבחירה</button>
                )}
            </div>

            {bulkMode && (
                <div className="bulk-action-bar">
                    <strong>{selectedPalletIds.size} נבחרו</strong>
                    <select value={bulkTarget} onChange={(e) => setBulkTarget(e.target.value as PalletZone)}>
                        {ZONE_OPTIONS
                            .filter((z) => z.value !== pallets[0]?.zone)
                            .map((z) => (
                                <option key={z.value} value={z.value}>
                                    {z.label}
                                </option>
                            ))}
                    </select>
                    <button disabled={selectedPalletIds.size === 0} onClick={() => onBulkMove(bulkTarget)}>העבר נבחרים</button>
                </div>
            )}

            {pallets.length === 0 ? <div className="zone-tray-empty">אין משטחים באזור הזה כרגע.</div> : (
                <div className="zone-tray-list">
                    {pallets.map((p) => (
                        <ZoneListItem
                            key={p.id}
                            pallet={p}
                            selected={selectedPalletIds.has(p.id)}
                            bulkMode={bulkMode}
                            onSelectForPlacement={onSelectForPlacement}
                            onToggleBulk={onToggleBulk}
                            onEditPallet={onEditPallet}
                            onMoveZone={onMoveZone}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

export function PendingTray(props: Omit<ComponentProps<typeof ZoneTray>, "title" | "hint">) {
    return <ZoneTray {...props} title="ממתינים לשיבוץ" hint="לחצי על 'שבץ במפה' כדי לבחור משטח אחד. הבחירה הזו מיועדת רק לשיבוץ בתא — לא לבחירה מרובה." />;
}

export function StashTray(props: Omit<ComponentProps<typeof ZoneTray>, "title" | "hint">) {
    return <ZoneTray {...props} title="בסידור" hint="כאן נמצאים משטחים שהוצאו זמנית מהמקרר. אפשר לשבץ משטח אחד במפה או לבצע העברה מרובה בין אזורים." />;
}

export function BottleRoomTray(props: Omit<ComponentProps<typeof ZoneTray>, "title" | "hint">) {
    return <ZoneTray {...props} title="חדר בקבוקים" hint="משטחים שנמצאים פיזית בחדר הבקבוקים. אפשר להחזיר אותם למקרר או להעביר לאזור אחר." />;
}
