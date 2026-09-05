import { useEffect, useMemo, useState } from "react";
import { Pencil, Truck, ArrowRightLeft, LayersPlus, ClipboardClock, BottleWine, MapPlus, LayerArrowUp, LayerArrowDown } from "lucide-react";
import {
    subscribeToZone,
    movePalletToCell,
    moveToZone,
    movePalletsToZone,
    reorderPalletsInCell,
    setMarkedForShipment,
} from "../SERVICES/Palletservice";
import {
    beerStyleClass,
    calcHeightUnits,
    MAX_HEIGHT_UNITS_PER_CELL,
    type Pallet,
    type CoolerCell,
    type CoolerSide,
    type PalletZone,
} from "../SERVICES/Pallettypes ";
import { RIGHT_SIDE_COLUMNS, LEFT_SIDE_COLUMNS, CORRIDOR_COLUMNS } from "../SERVICES/Coolergridconfig";
import type { Fermentor } from "../App";
import PalletEditModal from "./PalletEditModal";
import AddPalletModal from "./AddPalletModal";
import LoadingDockView from "./LoadingDockView";
// import ConfirmModal from "./ConfirmModal";
import { PendingTray, BottleRoomTray } from "./Zonetrays";
import "../Coolermap.css";

function cellKey(cell: CoolerCell) { return `${cell.side}_${cell.col}_${cell.row}`; }
function getHeight(p: Pallet) { return typeof p.heightUnits === "number" ? p.heightUnits : calcHeightUnits(p.itemType, p.quantity); }

function parseExpiryDate(dateStr: string): Date | null {
    const parts = dateStr.split(/[./]/).map(Number);
    if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;
    let [dd, mm, yyyy] = parts;
    if (yyyy < 100) yyyy += 2000;
    const d = new Date(yyyy, mm - 1, dd);
    d.setHours(0, 0, 0, 0);
    return d;
}
function isWithinDays(dateStr: string, days: number) {
    const expiry = parseExpiryDate(dateStr);
    if (!expiry) return false;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diffDays = (expiry.getTime() - today.getTime()) / 86400000;
    return diffDays >= 0 && diffDays <= days;
}
function isExpired(dateStr: string) {
    const expiry = parseExpiryDate(dateStr);
    if (!expiry) return false;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return expiry.getTime() < today.getTime();
}
function sortPalletsInCell(pallets: Pallet[]) {
    const manuallyOrdered = pallets.length > 0 && pallets.every((p) => typeof p.orderInCell === "number" || typeof p.slotIndex === "number");
    if (manuallyOrdered) return [...pallets].sort((a, b) => (a.orderInCell ?? a.slotIndex ?? 0) - (b.orderInCell ?? b.slotIndex ?? 0));
    return [...pallets].sort((a, b) => a.quantity - b.quantity);
}

const ZONE_META: Record<PalletZone, { label: string; icon: any }> = {
    cooler: { label: "מפת מקרר", icon: <MapPlus /> },
    pending: { label: "ממתינים לשיבוץ", icon: <ClipboardClock /> },
    bottleRoom: { label: "חדר בקבוקים", icon: <BottleWine /> },
    loadingDock: { label: "בהעמסה למשלוח", icon: <Truck /> },
};

function ZoneMoveModal({ pallet, onMove, onClose }: { pallet: Pallet; onMove: (id: string, zone: PalletZone) => void; onClose: () => void }) {
    const options = (Object.keys(ZONE_META) as PalletZone[]).filter((z) => z !== pallet.zone && z !== "cooler");
    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-box zone-move-modal" onClick={(e) => e.stopPropagation()} dir="rtl">
                <div className="modal-header-row">
                    <div><span className="modal-kicker">העברת משטח</span><h3>לאן להעביר?</h3></div>
                    <button className="modal-x" onClick={onClose}>×</button>
                </div>
                <p className="zone-move-modal-subtitle">
                    <span> {pallet.quantity} {pallet.itemType === "kegs" ? "חביות" : "ארגזים"}</span>
                    <span> · {pallet.beerStyle}</span>
                </p>
                <div className="zone-move-modal-options">
                    {options.map((z) => (
                        <button key={z} className="zone-move-modal-option" onClick={() => { onMove(pallet.id, z); onClose(); }}>
                            <span>{ZONE_META[z].icon}</span>{ZONE_META[z].label}
                        </button>
                    ))}
                </div>
                <button className="modal-cancel-btn" onClick={onClose}>ביטול</button>
            </div>
        </div>
    );
}

function CompactPalletCard({
    pallet, isSelectedForMove, placementActive, organizeMode, onPlace, onEdit, onSelectForMove, onOpenMoveZone, onMarkShipment, onReorder,
}: {
    pallet: Pallet;
    isSelectedForMove: boolean;
    placementActive: boolean;
    organizeMode: boolean;
    onPlace: () => void;
    onEdit: () => void;
    onSelectForMove: () => void;
    onOpenMoveZone: () => void;
    onMarkShipment: () => void;
    onReorder?: (direction: "up" | "down") => void;
}) {
    const style = beerStyleClass(pallet.beerStyle);
    const expiring = !!pallet.expiryDateStr && isWithinDays(pallet.expiryDateStr, 14);
    const expired = !!pallet.expiryDateStr && isExpired(pallet.expiryDateStr);

    function handleRowClick() {
        if (placementActive) { if (!isSelectedForMove) onPlace(); return; }
        if (organizeMode) onSelectForMove();
    }

    return (
        <div
            className={`pallet-row ${style.className} ${isSelectedForMove ? "placement-card" : ""} ${pallet.markedForShipment ? "marked-for-shipment" : ""}`}
            onClick={(e) => { e.stopPropagation(); handleRowClick(); }}
        >
            <span className="pallet-row-icon">{pallet.itemType === "kegs" ? "🛢️" : "📦"}</span>
            <strong className="pallet-row-qty">{pallet.quantity} {"  "} {pallet.itemType === "crates" ? "ארגזים" : "חביות"}</strong>
            <span className="pallet-row-style">
                <span>{style.displayLabel}</span>
                <span> {pallet.subLabel ? ` · ${pallet.subLabel}` : ""}</span>
                <span>  #{pallet.batchNumber}</span>
            </span>
            {pallet.expiryDateStr && (
                <span className={`pallet-row-expiry ${expired ? "expiry-expired" : expiring ? "expiry-warning" : ""}`}>{pallet.expiryDateStr}</span>
            )}

            {isSelectedForMove ? (
                <span className="pallet-row-selected"> בחר תא יעד</span>
            ) : !placementActive && (
                <div className="pallet-row-actions" onClick={(e) => e.stopPropagation()}>
                    {organizeMode && onReorder && (
                        <>
                            <button className="row-icon-btn" onClick={() => onReorder("up")} title="הזז למעלה">{<LayerArrowUp size={12}/>}</button>
                            <button className="row-icon-btn" onClick={() => onReorder("down")} title="הזז למטה">{<LayerArrowDown size={12}/>}</button>
                        </>
                    )}
                    <button className="row-icon-btn" onClick={onEdit} title="עריכה"><Pencil size={13} /></button>
                    <button className={`row-icon-btn ${pallet.markedForShipment ? "on" : ""}`} onClick={onMarkShipment} title="סמן למשלוח"><Truck size={13} /></button>
                    <button className="row-icon-btn" onClick={onOpenMoveZone} title="העבר אזור"><ArrowRightLeft size={13} /></button>
                </div>
            )}
        </div>
    );
}

function CoolerCellBox({
    cell, pallets, caution, placementPallet, organizeMode, onDropHere, onEdit, onSelectForMove, onOpenMoveZone, onMarkShipment, onReorder,
}: {
    cell: CoolerCell;
    pallets: Pallet[];
    caution?: boolean;
    placementPallet: Pallet | null;
    organizeMode: boolean;
    onDropHere: (cell: CoolerCell) => void;
    onEdit: (pallet: Pallet) => void;
    onSelectForMove: (pallet: Pallet) => void;
    onOpenMoveZone: (pallet: Pallet) => void;
    onMarkShipment: (pallet: Pallet) => void;
    onReorder: (cell: CoolerCell, ids: string[]) => void;
}) {
    const sorted = sortPalletsInCell(pallets);
    const heightUsed = pallets.reduce((sum, p) => sum + getHeight(p), 0);
    const movingHeight = placementPallet ? getHeight(placementPallet) : 0;
    const wouldOverflow = !!placementPallet && heightUsed + movingHeight > MAX_HEIGHT_UNITS_PER_CELL;
    const isSourceCell = !!placementPallet && pallets.some((p) => p.id === placementPallet.id);

    function swap(index: number, direction: "up" | "down") {
        const other = direction === "up" ? index - 1 : index + 1;
        if (other < 0 || other >= sorted.length) return;
        const next = [...sorted];[next[index], next[other]] = [next[other], next[index]];
        onReorder(cell, next.map((p) => p.id));
    }

    return (
        <div
            className={`cooler-cell ${caution ? "caution" : ""} ${placementPallet && !wouldOverflow && !isSourceCell ? "move-target" : ""} ${wouldOverflow ? "no-room" : ""}`}
            onClick={() => placementPallet && !wouldOverflow && !isSourceCell && onDropHere(cell)}
        >
            <div className="cooler-cell-header"><strong>{cell.col}.{cell.row}</strong><span>{pallets.length ? `${pallets.length} משטחים`: "פנוי"}</span></div>
            <div className="cooler-cell-capacity"><span style={{ width: `${Math.min(100, heightUsed / MAX_HEIGHT_UNITS_PER_CELL * 100)}%` }} /></div>
            <div className="cooler-cell-pallets">
                {sorted.map((p, i) => (
                    <CompactPalletCard
                        key={p.id}
                        pallet={p}
                        isSelectedForMove={placementPallet?.id === p.id}
                        placementActive={!!placementPallet}
                        organizeMode={organizeMode}
                        onPlace={() => placementPallet && !wouldOverflow && !isSourceCell && onDropHere(cell)}
                        onEdit={() => onEdit(p)}
                        onSelectForMove={() => onSelectForMove(p)}
                        onOpenMoveZone={() => onOpenMoveZone(p)}
                        onMarkShipment={() => onMarkShipment(p)}
                        onReorder={organizeMode ? (dir) => swap(i, dir) : undefined}
                    />
                ))}
            </div>
            {placementPallet && !isSourceCell && (wouldOverflow ? <div className="cell-move-status danger">אין מקום — {heightUsed.toFixed(1)}/{MAX_HEIGHT_UNITS_PER_CELL}</div> : <div className="cell-move-status">לחצי כאן לשיבוץ</div>)}
            {caution && <div className="cautionBox"><div className="cell-caution">⚠ עשוי לחסום את הדלת</div></div>}
        </div>
    );
}

function CoolerColumn({ side, col, rows, cautionRows, palletsByCell, placementPallet, organizeMode, onDropHere, onEdit, onSelectForMove, onOpenMoveZone, onMarkShipment, onReorder }: {
    side: CoolerSide; col: number; label: string; rows: number; cautionRows?: number[]; palletsByCell: Map<string, Pallet[]>; placementPallet: Pallet | null; organizeMode: boolean;
    onDropHere: (cell: CoolerCell) => void; onEdit: (p: Pallet) => void; onSelectForMove: (p: Pallet) => void; onOpenMoveZone: (p: Pallet) => void; onMarkShipment: (p: Pallet) => void; onReorder: (cell: CoolerCell, ids: string[]) => void;
}) {
    return (
        <div className="cooler-column">
            {Array.from({ length: rows }, (_, i) => i + 1).map((row) => {
                const cell: CoolerCell = { side, col, row };
                return <CoolerCellBox
                    key={cellKey(cell)} cell={cell} pallets={palletsByCell.get(cellKey(cell)) ?? []}
                    caution={cautionRows?.includes(row)} placementPallet={placementPallet} organizeMode={organizeMode}
                    onDropHere={onDropHere} onEdit={onEdit} onSelectForMove={onSelectForMove} onOpenMoveZone={onOpenMoveZone}
                    onMarkShipment={onMarkShipment} onReorder={onReorder} />;
            })}
        </div>
    );
}

function Corridor({ palletsByCell, placementPallet, organizeMode, onDropHere, onEdit, onSelectForMove, onOpenMoveZone, onMarkShipment, onReorder }: {
    palletsByCell: Map<string, Pallet[]>; placementPallet: Pallet | null; organizeMode: boolean; onDropHere: (cell: CoolerCell) => void; onEdit: (p: Pallet) => void; onSelectForMove: (p: Pallet) => void; onOpenMoveZone: (p: Pallet) => void; onMarkShipment: (p: Pallet) => void; onReorder: (cell: CoolerCell, ids: string[]) => void;
}) {
    return (
        <div className="cooler-corridor-row">
            <div className="door-marker"><span>דלת</span><small>כניסה</small></div>
            <div className="cooler-corridor-cells">
                {CORRIDOR_COLUMNS.map((c) => {
                    const cell: CoolerCell = { side: "corridor", col: c.col, row: 1 };
                    return <CoolerCellBox key={cellKey(cell)} cell={cell} pallets={palletsByCell.get(cellKey(cell)) ?? []} placementPallet={placementPallet} organizeMode={organizeMode} onDropHere={onDropHere} onEdit={onEdit} onSelectForMove={onSelectForMove} onOpenMoveZone={onOpenMoveZone} onMarkShipment={onMarkShipment} onReorder={onReorder} />;
                })}
            </div>
            <div className="door-marker"><span>דלת</span><small>יציאה</small></div>
        </div>
    );
}

type Tab = "map" | "pending" | "bottleRoom" | "stash" | "dock";

export default function CoolerMap({ brews }: { brews?: Fermentor[] }) {
    const [zones, setZones] = useState<Record<PalletZone, Pallet[]>>({ cooler: [], pending: [], bottleRoom: [], loadingDock: [] });
    const [loading, setLoading] = useState(true);
    const [placementPalletId, setPlacementPalletId] = useState<string | null>(null);
    const [bulkSelectedIds, setBulkSelectedIds] = useState<Set<string>>(new Set());
    const [bulkMode, setBulkMode] = useState(false);
    const [editingPallet, setEditingPallet] = useState<Pallet | null>(null);
    const [movingZonePallet, setMovingZonePallet] = useState<Pallet | null>(null);
    const [showAddModal, setShowAddModal] = useState(false);
    const [tab, setTab] = useState<Tab>("map");
    const [organizeMode, setOrganizeMode] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const unsubs = (Object.keys(ZONE_META) as PalletZone[]).map((zone) => subscribeToZone(zone, (data) => {
            setZones((prev) => ({ ...prev, [zone]: data }));
            if (zone === "cooler") setLoading(false);
        }));
        return () => unsubs.forEach((u) => u());
    }, []);

    const allPallets = useMemo(() => Object.values(zones).flat(), [zones]);
    const counts = useMemo(() => ({ cooler: zones.cooler.length, pending: zones.pending.length, bottleRoom: zones.bottleRoom.length, loadingDock: zones.loadingDock.length }), [zones]);
    const placementPallet = placementPalletId ? allPallets.find((p) => p.id === placementPalletId) ?? null : null;

    const palletsByCell = useMemo(() => {
        const map = new Map<string, Pallet[]>();
        zones.cooler.forEach((p) => { if (p.cell) { const key = cellKey(p.cell); map.set(key, [...(map.get(key) ?? []), p]); } });
        return map;
    }, [zones.cooler]);

    function chooseForPlacement(pallet: Pallet) {
        setBulkMode(false); setBulkSelectedIds(new Set()); setPlacementPalletId(pallet.id); setTab("map"); setError(null);
    }
    function clearPlacement() { setPlacementPalletId(null); }
    function toggleBulk(id: string) { setBulkSelectedIds((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; }); }

    async function moveSelectedToCell(cell: CoolerCell) {
        if (!placementPallet) return;
        const target = palletsByCell.get(cellKey(cell)) ?? [];
        const used = target.reduce((sum, p) => sum + getHeight(p), 0);
        if (used + getHeight(placementPallet) > MAX_HEIGHT_UNITS_PER_CELL) { setError("אין מספיק מקום בתא הזה"); return; }
        try {
            setError(null);
            await movePalletToCell(placementPallet.id, cell, target.length);
            clearPlacement();
        } catch (e: any) { setError(e?.message ?? "שגיאה בשיבוץ"); }
    }

    async function moveZone(id: string, zone: PalletZone) {
        try { setError(null); await moveToZone(id, zone); setBulkSelectedIds((s) => { const n = new Set(s); n.delete(id); return n; }); if (placementPalletId === id) clearPlacement(); }
        catch (e: any) { setError(e?.message ?? "שגיאה בהעברה"); }
    }

    async function bulkMove(zone: PalletZone) {
        try { setError(null); await movePalletsToZone(Array.from(bulkSelectedIds), zone); setBulkSelectedIds(new Set()); setBulkMode(false); }
        catch (e: any) { setError(e?.message ?? "שגיאה בהעברה מרובה"); }
    }

    async function reorder(cell: CoolerCell, ids: string[]) {
        if (!organizeMode) return;
        try { await reorderPalletsInCell(ids); } catch (e: any) { setError(e?.message ?? "שגיאה בסידור" + cell); }
    }

    async function markShipment(pallet: Pallet) {
        try { await setMarkedForShipment(pallet.id, !pallet.markedForShipment); } catch (e: any) { setError(e?.message ?? "שגיאה"); }
    }

    function selectZone(z: PalletZone) {
        if (z === "cooler") setTab("map");
        if (z === "pending" || z === "bottleRoom") setTab(z);
        else if (z === "loadingDock") setTab("dock");
    }

    const trayProps = {
        selectedPalletIds: bulkSelectedIds,
        bulkMode,
        onStartBulk: () => { setPlacementPalletId(null); setBulkMode(true); },
        onCancelBulk: () => { setBulkMode(false); setBulkSelectedIds(new Set()); },
        onSelectForPlacement: chooseForPlacement,
        onToggleBulk: toggleBulk,
        onBulkMove: bulkMove,
        onEditPallet: setEditingPallet,
        onMoveZone: moveZone,
    };

    function ZoneBadges({ counts, onSelect }: { counts: Record<PalletZone, number>; onSelect: (z: PalletZone) => void }) {
        const zones: PalletZone[] = ["cooler", "pending", "bottleRoom", "loadingDock"];
        return <div className="cooler-zone-badges">{zones.map((z) => <button key={z} className={`cooler-zone-badge zone-${z}`} onClick={() => onSelect(z)}><span>{ZONE_META[z].icon}</span><span>{ZONE_META[z].label}</span><strong>{counts[z]}</strong></button>)}</div>;
    }

    if (loading) return <div className="cooler-loading"><span><MapPlus /></span><strong>טוען את מפת המקרר…</strong></div>;

    return (
        <div className={`cooler-map-page ${placementPallet ? "has-floating-banner" : ""}`} dir="rtl">
            <div className="cooler-map-header">
                <div className="cooler-header-actions"><button className={`organize-toggle ${organizeMode ? "active" : ""}`} onClick={() => setOrganizeMode((v) => !v)}>{organizeMode ? "✓ מצב סידור פעיל" : `"מצב סידור מקרר"`}</button>
                    <button className="cooler-add-pallet-btn" onClick={() => setShowAddModal(true)}>הוסף משטחים {<LayersPlus size={14} />}</button></div>
            </div>
            <ZoneBadges counts={counts} onSelect={selectZone} />
            {/* <div className="cooler-tabs">
                <button className={tab === "map" ? "active" : ""} onClick={() => setTab("map")}> מפת מקרר<span>{counts.cooler}</span></button>
                <button className={tab === "pending" ? "active" : ""} onClick={() => setTab("pending")}> ממתינים לשיבוץ<span>{counts.pending}</span></button>
                <button className={tab === "bottleRoom" ? "active" : ""} onClick={() => setTab("bottleRoom")}>חדר בקבוקים <span>{counts.bottleRoom}</span></button>
                <button className={tab === "dock" ? "active" : ""} onClick={() => setTab("dock")}>בהעמסה למשלוח<span>{counts.loadingDock}</span></button>
            </div> */}

            {placementPallet && <div className="placement-banner"><div><strong>שיבוץ משטח במקרר</strong><span>
                <small>{placementPallet.quantity} {placementPallet.itemType === "kegs" ? "חביות" : "ארגזים"}</small>
                <small> · {placementPallet.beerStyle}</small></span>
            </div><button onClick={clearPlacement}>ביטול</button></div>}
            {error && <div className="cooler-error">{error}</div>}

            {tab === "pending" && <PendingTray {...trayProps} pallets={zones.pending} />}
            {tab === "bottleRoom" && <BottleRoomTray {...trayProps} pallets={zones.bottleRoom} />}
            {/* {tab === "stash" && <StashTray {...trayProps} pallets={zones.stash} />} */}
            {tab === "dock" && <LoadingDockView />}

            {tab === "map" && (
                <div className="cooler-map-wrap">
                    <div className="cooler-map-explainer">
                        {organizeMode
                            ? <span>מצב סידור מקרר: לחץ על משטח כדי לבחור אותו, ואז על התא היעד כדי להעביר.</span>
                            : <> <span>כדי לשבץ משטח ממתין: בחר אותו במסך ממתין ובחר את התא הרצוי. </span><span>כדי להזיז משטח בתוך המקרר: הפעל מצב סידור מקרר.</span></>}
                    </div>
                    <div className="cooler-map-scroll">
                        <div className="cooler-physical-map">

                            <div className="cooler-side-block right-side">
                                {RIGHT_SIDE_COLUMNS.map((c) => <CoolerColumn key={c.col} side="right" col={c.col} label={c.label}
                                    rows={c.rows} cautionRows={c.cautionRows} palletsByCell={palletsByCell} placementPallet={placementPallet}
                                    organizeMode={organizeMode} onDropHere={moveSelectedToCell} onEdit={setEditingPallet}
                                    onSelectForMove={chooseForPlacement} onOpenMoveZone={setMovingZonePallet} onMarkShipment={markShipment}
                                    onReorder={reorder} />)}
                                <div className="door-marker"><span>מקרר כשות</span></div>
                            </div>
                            <Corridor palletsByCell={palletsByCell} placementPallet={placementPallet} organizeMode={organizeMode} onDropHere={moveSelectedToCell} onEdit={setEditingPallet} onSelectForMove={chooseForPlacement} onOpenMoveZone={setMovingZonePallet} onMarkShipment={markShipment} onReorder={reorder} />
                            <div className="cooler-side-block left-side">{LEFT_SIDE_COLUMNS.map((c) => <CoolerColumn key={c.col} side="left" col={c.col} label={c.label} rows={c.rows} palletsByCell={palletsByCell} placementPallet={placementPallet} organizeMode={organizeMode} onDropHere={moveSelectedToCell} onEdit={setEditingPallet} onSelectForMove={chooseForPlacement} onOpenMoveZone={setMovingZonePallet} onMarkShipment={markShipment} onReorder={reorder} />)}</div>
                        </div>
                    </div>
                </div>
            )}

            {movingZonePallet && (
                <ZoneMoveModal
                    pallet={movingZonePallet}
                    onMove={moveZone}
                    onClose={() => setMovingZonePallet(null)}
                />
            )}

            {editingPallet && <PalletEditModal pallet={editingPallet} onClose={() => setEditingPallet(null)} onDone={() => setEditingPallet(null)} />}
            {showAddModal && <AddPalletModal brews={brews} onClose={() => setShowAddModal(false)} onDone={() => setShowAddModal(false)} />}
        </div>
    );
}