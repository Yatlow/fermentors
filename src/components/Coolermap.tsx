import {
    useEffect,
    useMemo,
    useRef,
    useState,
    type JSX,
    type TouchEvent,
    type TouchList,
} from "react";

import {
    Pencil,
    Truck,
    ArrowRightLeft,
    LayersPlus,
    ClipboardClock,
    BottleWine,
    MapPlus,
    LayerArrowUp,
    LayerArrowDown,
} from "lucide-react";

import {
    subscribeToZone,
    movePalletToCell,
    moveToZone,
    movePalletsToZone,
    reorderPalletsInCell,
    setMarkedForShipment,
    calcTruckSlots,
    MAX_TRUCK_SLOTS,
    // reorderPalletsInZone,
    deletePallet,
} from "../SERVICES/Palletservice";

import {
    beerStyleClass,
    calcHeightCm,
    MAX_HEIGHT_CM,
    type Pallet,
    type CoolerCell,
    type CoolerSide,
    type PalletZone,
} from "../SERVICES/Pallettypes ";

import {
    RIGHT_SIDE_COLUMNS,
    LEFT_SIDE_COLUMNS,
    CORRIDOR_COLUMNS,
} from "../SERVICES/Coolergridconfig";

import type { Fermentor } from "../App";

import PalletEditModal from "./PalletEditModal";
import AddPalletModal from "./AddPalletModal";
import LoadingDockView from "./LoadingDockView";

import {
    PendingTray,
    BottleRoomTray,
    ZoneMoveModal,
} from "./Zonetrays";

import "../Coolermap.css";

import BeerLoader from "./Loading";
import ConfirmModal from "./ConfirmModal";


// ============================================================
// Map configuration
// ============================================================

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 1.5;


// ============================================================
// Helpers
// ============================================================

function cellKey(cell: CoolerCell) {
    return `${cell.side}_${cell.col}_${cell.row}`;
}


function getHeight(pallet: Pallet): number {
    return calcHeightCm(
        pallet.itemType,
        pallet.quantity
    );
}



function parseExpiryDate(
    dateStr: string
): Date | null {
    const parts = dateStr
        .split(/[./]/)
        .map(Number);

    if (
        parts.length !== 3 ||
        parts.some((n) =>
            Number.isNaN(n)
        )
    ) {
        return null;
    }

    let [
        day,
        month,
        year,
    ] = parts;

    if (year < 100) {
        year += 2000;
    }

    const date = new Date(
        year,
        month - 1,
        day
    );

    date.setHours(
        0,
        0,
        0,
        0
    );

    return date;
}


function isWithinDays(
    dateStr: string,
    days: number
) {
    const expiry =
        parseExpiryDate(dateStr);

    if (!expiry) {
        return false;
    }

    const today = new Date();

    today.setHours(
        0,
        0,
        0,
        0
    );

    const diffDays =
        (expiry.getTime() -
            today.getTime()) /
        86400000;

    return (
        diffDays >= 0 &&
        diffDays <= days
    );
}


function isExpired(
    dateStr: string
) {
    const expiry =
        parseExpiryDate(dateStr);

    if (!expiry) {
        return false;
    }

    const today = new Date();

    today.setHours(
        0,
        0,
        0,
        0
    );

    return (
        expiry.getTime() <
        today.getTime()
    );
}


function sortPalletsInCell(
    pallets: Pallet[]
) {
    const manuallyOrdered =
        pallets.length > 0 &&
        pallets.every(
            (p) =>
                typeof p.orderInCell ===
                "number" ||
                typeof p.slotIndex ===
                "number"
        );

    if (manuallyOrdered) {
        return [...pallets].sort(
            (a, b) =>
                (a.orderInCell ??
                    a.slotIndex ??
                    0) -
                (b.orderInCell ??
                    b.slotIndex ??
                    0)
        );
    }

    return [...pallets].sort(
        (a, b) =>
            a.quantity -
            b.quantity
    );
}


// ============================================================
// Zone metadata
// ============================================================

const ZONE_META = {
    cooler: {
        label: "מפת מקרר",
        icon: <MapPlus />,
    },

    pending: {
        label: "ממתינים לשיבוץ",
        icon: <ClipboardClock />,
    },

    bottleRoom: {
        label: "חדר בקבוקים",
        icon: <BottleWine />,
    },

    loadingDock: {
        label: "בהעמסה למשלוח",
        icon: <Truck />,
    },
} satisfies Record<
    Exclude<PalletZone, "shipped">,
    {
        label: string;
        icon: JSX.Element;
    }
>;


// ============================================================
// Compact pallet card
// ============================================================

function CompactPalletCard({
    pallet,
    isSelectedForMove,
    placementActive,
    organizeMode,
    onPlace,
    onEdit,
    onSelectForMove,
    onOpenMoveZone,
    onMarkShipment,
    onReorder,
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

    onReorder?: (
        direction:
            | "up"
            | "down"
    ) => void;
}) {
    const style =
        beerStyleClass(
            pallet.beerStyle
        );

    const expiring =
        !!pallet.expiryDateStr &&
        isWithinDays(
            pallet.expiryDateStr,
            14
        );

    const expired =
        !!pallet.expiryDateStr &&
        isExpired(
            pallet.expiryDateStr
        );

    function handleRowClick() {
        if (placementActive) {
            if (
                !isSelectedForMove
            ) {
                onPlace();
            }

            return;
        }

        if (organizeMode) {
            onSelectForMove();
        }
    }

    return (
        <div
            className={`pallet-row ${style.className
                } ${isSelectedForMove
                    ? "placement-card"
                    : ""
                } ${pallet.markedForShipment
                    ? "marked-for-shipment"
                    : ""
                }`}
            onClick={(e) => {
                e.stopPropagation();
                handleRowClick();
            }}
        >
            <span className="pallet-row-icon">
                {pallet.itemType ===
                    "kegs"
                    ? "🛢️"
                    : "📦"}
            </span>

            <strong className="pallet-row-qty">
                {pallet.quantity}{" "}
                {pallet.itemType ===
                    "crates"
                    ? "ארגזים"
                    : "חביות"}
            </strong>

            <span className="pallet-row-style">
                <span>
                    {style.displayLabel}
                </span>

                <span>
                    {pallet.subLabel
                        ? ` · ${pallet.subLabel}`
                        : ""}
                </span>

                {pallet.batchNumber && (
                    <span>
                        {" "}
                        #{pallet.batchNumber}
                    </span>
                )}
            </span>

            {pallet.expiryDateStr && (
                <span
                    className={`pallet-row-expiry ${expired
                        ? "expiry-expired"
                        : expiring
                            ? "expiry-warning"
                            : ""
                        }`}
                >
                    {
                        pallet.expiryDateStr
                    }
                </span>
            )}

            {isSelectedForMove ? (
                <span className="pallet-row-selected">
                    בחר תא יעד
                </span>
            ) : (
                !placementActive && (
                    <div
                        className="pallet-row-actions"
                        onClick={(e) =>
                            e.stopPropagation()
                        }
                    >
                        {organizeMode ? (
                            onReorder && (
                                <>
                                    <button
                                        type="button"
                                        className="row-icon-btn"
                                        onClick={() =>
                                            onReorder(
                                                "up"
                                            )
                                        }
                                        title="הזז למעלה"
                                    >
                                        <LayerArrowUp
                                            size={12}
                                        />
                                    </button>

                                    <button
                                        type="button"
                                        className="row-icon-btn"
                                        onClick={() =>
                                            onReorder(
                                                "down"
                                            )
                                        }
                                        title="הזז למטה"
                                    >
                                        <LayerArrowDown
                                            size={12}
                                        />
                                    </button>
                                </>
                            )
                        ) : (
                            <>
                                <button
                                    type="button"
                                    className="row-icon-btn"
                                    onClick={
                                        onEdit
                                    }
                                    title="עריכה"
                                >
                                    <Pencil
                                        size={13}
                                    />
                                </button>

                                <button
                                    type="button"
                                    className={`row-icon-btn ${pallet.markedForShipment
                                        ? "on"
                                        : ""
                                        }`}
                                    onClick={
                                        onMarkShipment
                                    }
                                    title="סמן למשלוח"
                                >
                                    <Truck
                                        size={13}
                                    />
                                </button>

                                <button
                                    type="button"
                                    className="row-icon-btn"
                                    onClick={
                                        onOpenMoveZone
                                    }
                                    title="העבר אזור"
                                >
                                    <ArrowRightLeft
                                        size={13}
                                    />
                                </button>
                            </>
                        )}
                    </div>
                )
            )}
        </div>
    );
}


// ============================================================
// Cooler cell
// ============================================================

function CoolerCellBox({
    cell,
    pallets,
    caution,
    placementPallet,
    organizeMode,
    onDropHere,
    onEdit,
    onSelectForMove,
    onOpenMoveZone,
    onMarkShipment,
    onReorder,
}: {
    cell: CoolerCell;

    pallets: Pallet[];

    caution?: boolean;

    placementPallet: Pallet | null;

    organizeMode: boolean;

    onDropHere: (
        cell: CoolerCell
    ) => void;

    onEdit: (
        pallet: Pallet
    ) => void;

    onSelectForMove: (
        pallet: Pallet
    ) => void;

    onOpenMoveZone: (
        pallet: Pallet
    ) => void;

    onMarkShipment: (
        pallet: Pallet
    ) => void;

    onReorder: (
        cell: CoolerCell,
        ids: string[]
    ) => void;
}) {
    const sorted =
        sortPalletsInCell(
            pallets
        );

    const heightUsed =
        pallets.reduce(
            (sum, pallet) =>
                sum +
                getHeight(pallet),
            0
        );

    const movingHeight =
        placementPallet
            ? getHeight(
                placementPallet
            )
            : 0;

    const isSourceCell =
        !!placementPallet &&
        pallets.some(
            (pallet) =>
                pallet.id ===
                placementPallet.id
        );

    const wouldOverflow =
        !!placementPallet &&
        !isSourceCell &&
        heightUsed +
        movingHeight >
        MAX_HEIGHT_CM;

    function swap(
        index: number,
        direction:
            | "up"
            | "down"
    ) {
        const other =
            direction === "up"
                ? index - 1
                : index + 1;

        if (
            other < 0 ||
            other >= sorted.length
        ) {
            return;
        }

        const next = [
            ...sorted,
        ];

        [
            next[index],
            next[other],
        ] = [
                next[other],
                next[index],
            ];

        onReorder(
            cell,
            next.map(
                (pallet) =>
                    pallet.id
            )
        );
    }

    const canMoveHere =
        !!placementPallet &&
        !wouldOverflow &&
        !isSourceCell;

    return (
        <div
            className={`cooler-cell ${caution
                ? "caution"
                : ""
                } ${canMoveHere
                    ? "move-target"
                    : ""
                } ${wouldOverflow
                    ? "no-room"
                    : ""
                }`}
            onClick={() => {
                if (canMoveHere) {
                    onDropHere(cell);
                }
            }}
        >
            <div className="cooler-cell-header">
                <span>
                    {pallets.length
                        ? `${pallets.length} משטחים`
                        : "פנוי"}
                </span>
            </div>

            <div className="cooler-cell-capacity">
                <span
                    style={{
                        width: `${Math.min(
                            100,
                            (heightUsed /
                                MAX_HEIGHT_CM) *
                            100
                        )}%`,
                    }}
                />
            </div>

            <div className="cooler-cell-pallets">
                {sorted.map(
                    (
                        pallet,
                        index
                    ) => (
                        <CompactPalletCard
                            key={
                                pallet.id
                            }
                            pallet={
                                pallet
                            }
                            isSelectedForMove={
                                placementPallet?.id ===
                                pallet.id
                            }
                            placementActive={
                                !!placementPallet
                            }
                            organizeMode={
                                organizeMode
                            }
                            onPlace={() => {
                                if (
                                    canMoveHere
                                ) {
                                    onDropHere(
                                        cell
                                    );
                                }
                            }}
                            onEdit={() =>
                                onEdit(
                                    pallet
                                )
                            }
                            onSelectForMove={() =>
                                onSelectForMove(
                                    pallet
                                )
                            }
                            onOpenMoveZone={() =>
                                onOpenMoveZone(
                                    pallet
                                )
                            }
                            onMarkShipment={() =>
                                onMarkShipment(
                                    pallet
                                )
                            }
                            onReorder={
                                organizeMode
                                    ? (
                                        direction
                                    ) =>
                                        swap(
                                            index,
                                            direction
                                        )
                                    : undefined
                            }
                        />
                    )
                )}
            </div>

            {placementPallet &&
                !isSourceCell &&
                (wouldOverflow ? (
                    <div className="cell-move-status danger">
                        אין מקום —{" "}
                        {heightUsed.toFixed(
                            1
                        )}
                        /
                        {
                            MAX_HEIGHT_CM
                        }
                    </div>
                ) : (
                    <div className="cell-move-status">
                        לחצי כאן לשיבוץ
                    </div>
                ))}

            {caution && (
                <div className="cautionBox">
                    <div className="cell-caution">
                        ⚠ עשוי לחסום את הדלת
                    </div>
                </div>
            )}
        </div>
    );
}


// ============================================================
// Cooler column
// ============================================================

function CoolerColumn({
    side,
    col,
    // label,
    rows,
    cautionRows,
    palletsByCell,
    placementPallet,
    organizeMode,
    onDropHere,
    onEdit,
    onSelectForMove,
    onOpenMoveZone,
    onMarkShipment,
    onReorder,
}: {
    side: CoolerSide;

    col: number;

    label: string;

    rows: number;

    cautionRows?: number[];

    palletsByCell: Map<
        string,
        Pallet[]
    >;

    placementPallet: Pallet | null;

    organizeMode: boolean;

    onDropHere: (
        cell: CoolerCell
    ) => void;

    onEdit: (
        pallet: Pallet
    ) => void;

    onSelectForMove: (
        pallet: Pallet
    ) => void;

    onOpenMoveZone: (
        pallet: Pallet
    ) => void;

    onMarkShipment: (
        pallet: Pallet
    ) => void;

    onReorder: (
        cell: CoolerCell,
        ids: string[]
    ) => void;
}) {
    return (
        <div className="cooler-column">
            {Array.from(
                {
                    length: rows,
                },
                (_, index) =>
                    index + 1
            ).map((row) => {
                const cell: CoolerCell =
                {
                    side,
                    col,
                    row,
                };

                return (
                    <CoolerCellBox
                        key={cellKey(
                            cell
                        )}
                        cell={cell}
                        pallets={
                            palletsByCell.get(
                                cellKey(
                                    cell
                                )
                            ) ?? []
                        }
                        caution={cautionRows?.includes(
                            row
                        )}
                        placementPallet={
                            placementPallet
                        }
                        organizeMode={
                            organizeMode
                        }
                        onDropHere={
                            onDropHere
                        }
                        onEdit={
                            onEdit
                        }
                        onSelectForMove={
                            onSelectForMove
                        }
                        onOpenMoveZone={
                            onOpenMoveZone
                        }
                        onMarkShipment={
                            onMarkShipment
                        }
                        onReorder={
                            onReorder
                        }
                    />
                );
            })}
        </div>
    );
}


// ============================================================
// Corridor
// ============================================================

function Corridor({
    palletsByCell,
    placementPallet,
    organizeMode,
    onDropHere,
    onEdit,
    onSelectForMove,
    onOpenMoveZone,
    onMarkShipment,
    onReorder,
}: {
    palletsByCell: Map<
        string,
        Pallet[]
    >;

    placementPallet: Pallet | null;

    organizeMode: boolean;

    onDropHere: (
        cell: CoolerCell
    ) => void;

    onEdit: (
        pallet: Pallet
    ) => void;

    onSelectForMove: (
        pallet: Pallet
    ) => void;

    onOpenMoveZone: (
        pallet: Pallet
    ) => void;

    onMarkShipment: (
        pallet: Pallet
    ) => void;

    onReorder: (
        cell: CoolerCell,
        ids: string[]
    ) => void;
}) {
    return (
        <div className="cooler-corridor-row">
            <div className="door-marker">
                <span>
                    דלת
                </span>
                <small>
                    כניסה
                </small>
            </div>

            <div className="cooler-corridor-cells">
                {CORRIDOR_COLUMNS.map(
                    (column) => {
                        const cell: CoolerCell =
                        {
                            side: "corridor",
                            col: column.col,
                            row: 1,
                        };

                        return (
                            <CoolerCellBox
                                key={cellKey(
                                    cell
                                )}
                                cell={
                                    cell
                                }
                                pallets={
                                    palletsByCell.get(
                                        cellKey(
                                            cell
                                        )
                                    ) ?? []
                                }
                                placementPallet={
                                    placementPallet
                                }
                                organizeMode={
                                    organizeMode
                                }
                                onDropHere={
                                    onDropHere
                                }
                                onEdit={
                                    onEdit
                                }
                                onSelectForMove={
                                    onSelectForMove
                                }
                                onOpenMoveZone={
                                    onOpenMoveZone
                                }
                                onMarkShipment={
                                    onMarkShipment
                                }
                                onReorder={
                                    onReorder
                                }
                            />
                        );
                    }
                )}
            </div>

            <div className="door-marker">
                <span>
                    דלת
                </span>
                <small>
                    יציאה
                </small>
            </div>
        </div>
    );
}


// ============================================================
// Zone badges
// ============================================================

function ZoneBadges({
    counts,
    onSelect,
}: {
    counts: {
        cooler: number;
        pending: number;
        bottleRoom: number;
        loadingDock: number;
    };

    onSelect: (
        zone:
            | "cooler"
            | "pending"
            | "bottleRoom"
            | "loadingDock"
    ) => void;
}) {
    const zones = [
        "cooler",
        "pending",
        "bottleRoom",
        "loadingDock",
    ] as const;

    return (
        <div className="cooler-zone-badges">
            {zones.map((zone) => (
                <button
                    key={zone}
                    type="button"
                    className={`cooler-zone-badge zone-${zone}`}
                    onClick={() =>
                        onSelect(
                            zone
                        )
                    }
                >
                    <span>
                        {
                            ZONE_META[
                                zone
                            ].icon
                        }
                    </span>

                    <span>
                        {
                            ZONE_META[
                                zone
                            ].label
                        }
                    </span>

                    <strong>
                        {
                            counts[
                            zone
                            ]
                        }
                    </strong>
                </button>
            ))}
        </div>
    );
}


// ============================================================
// Tabs
// ============================================================

type Tab =
    | "map"
    | "pending"
    | "bottleRoom"
    | "dock";


// ============================================================
// Main component
// ============================================================

export default function CoolerMap({
    brews,
}: {
    brews?: Fermentor[];
}) {
    const [zones, setZones] =
        useState<
            Record<
                Exclude<
                    PalletZone,
                    "shipped"
                >,
                Pallet[]
            >
        >({
            cooler: [],
            pending: [],
            bottleRoom: [],
            loadingDock: [],
        });

    const [loading, setLoading] =
        useState(true);

    const [
        placementPalletId,
        setPlacementPalletId,
    ] = useState<
        string | null
    >(null);

    const [
        bulkSelectedIds,
        setBulkSelectedIds,
    ] = useState<
        Set<string>
    >(new Set());

    const [
        bulkMode,
        setBulkMode,
    ] = useState(false);

    const [
        editingPallet,
        setEditingPallet,
    ] = useState<Pallet | null>(
        null
    );

    const [
        movingZonePallet,
        setMovingZonePallet,
    ] = useState<Pallet | null>(
        null
    );

    const [
        showAddModal,
        setShowAddModal,
    ] = useState(false);

    const [
        tab,
        setTab,
    ] = useState<Tab>("map");

    const [
        organizeMode,
        setOrganizeMode,
    ] = useState(false);

    const [
        error,
        setError,
    ] = useState<
        string | null
    >(null);

    const [
        zoomLevel,
        setZoomLevel,
    ] = useState(1);

    const [
        placementOriginTab,
        setPlacementOriginTab,
    ] = useState<
        Tab | null
    >(null);

    const [
        deletePalletTarget,
        setDeletePalletTarget,
    ] = useState<Pallet | null>(
        null
    );

    const [
        deletingPallet,
        setDeletingPallet,
    ] = useState(false);

    const [operationLoading, setOperationLoading] = useState<string | null>(null);

    // ========================================================
    // Pinch zoom refs
    // ========================================================

    const pinchStartDistance =
        useRef<number | null>(
            null
        );

    const pinchStartZoom =
        useRef(1);


    // ========================================================
    // Firebase subscriptions
    // ========================================================

    useEffect(() => {
        const activeZones = [
            "cooler",
            "pending",
            "bottleRoom",
            "loadingDock",
        ] as const;

        const unsubscribers =
            activeZones.map(
                (zone) =>
                    subscribeToZone(
                        zone,
                        (data) => {
                            setZones(
                                (
                                    previous
                                ) => ({
                                    ...previous,
                                    [zone]:
                                        data,
                                })
                            );

                            if (
                                zone ===
                                "cooler"
                            ) {
                                setLoading(
                                    false
                                );
                            }
                        }
                    )
            );

        return () =>
            unsubscribers.forEach(
                (unsubscribe) =>
                    unsubscribe()
            );
    }, []);


    // ========================================================
    // Derived state
    // ========================================================

    const allPallets =
        useMemo(
            () =>
                Object.values(
                    zones
                ).flat(),
            [zones]
        );

    const counts =
        useMemo(
            () => ({
                cooler:
                    zones.cooler
                        .length,

                pending:
                    zones.pending
                        .length,

                bottleRoom:
                    zones.bottleRoom
                        .length,

                loadingDock:
                    zones.loadingDock
                        .length,
            }),
            [zones]
        );

    const placementPallet =
        placementPalletId
            ? allPallets.find(
                (pallet) =>
                    pallet.id ===
                    placementPalletId
            ) ?? null
            : null;

    const palletsByCell =
        useMemo(() => {
            const map =
                new Map<
                    string,
                    Pallet[]
                >();

            zones.cooler.forEach(
                (pallet) => {
                    if (!pallet.cell) {
                        return;
                    }

                    const key =
                        cellKey(
                            pallet.cell
                        );

                    map.set(
                        key,
                        [
                            ...(map.get(
                                key
                            ) ?? []),
                            pallet,
                        ]
                    );
                }
            );

            return map;
        }, [zones.cooler]);

    const markedForShipmentPallets =
        useMemo(
            () =>
                allPallets.filter(
                    (pallet) =>
                        pallet.markedForShipment &&
                        pallet.zone !==
                        "loadingDock"
                ),
            [allPallets]
        );

    const markedTruckSlots =
        useMemo(
            () =>
                calcTruckSlots(
                    markedForShipmentPallets
                ),
            [
                markedForShipmentPallets,
            ]
        );

    const loadingTruckSlots =
        useMemo(
            () =>
                calcTruckSlots(
                    zones.loadingDock
                ),
            [zones.loadingDock]
        );

    const totalPlannedTruckSlots =
        markedTruckSlots +
        loadingTruckSlots;


    // ========================================================
    // Placement
    // ========================================================

    function chooseForPlacement(
        pallet: Pallet
    ) {
        setPlacementOriginTab(
            tab
        );

        setBulkMode(false);

        setBulkSelectedIds(
            new Set()
        );

        setPlacementPalletId(
            pallet.id
        );

        setTab("map");

        setError(null);
    }


    function clearPlacement() {
        setPlacementPalletId(
            null
        );

        setPlacementOriginTab(
            null
        );
    }


    async function moveSelectedToCell(
        cell: CoolerCell
    ) {
        if (!placementPallet) {
            return;
        }

        const target =
            palletsByCell.get(
                cellKey(cell)
            ) ?? [];

        const isSourceCell =
            target.some(
                (pallet) =>
                    pallet.id ===
                    placementPallet.id
            );

        if (isSourceCell) {
            return;
        }

        const used =
            target.reduce(
                (
                    sum,
                    pallet
                ) =>
                    sum +
                    getHeight(
                        pallet
                    ),
                0
            );

        const movingHeight =
            getHeight(
                placementPallet
            );

        if (
            used +
            movingHeight >
            MAX_HEIGHT_CM
        ) {
            setError(
                "אין מספיק מקום בתא הזה"
            );

            return;
        }

        try {
            setOperationLoading("משבץ משטח...");
            setError(null);

            await movePalletToCell(
                placementPallet.id,
                cell,
                target.length
            );

            const originTab =
                placementOriginTab;

            clearPlacement();

            if (
                originTab ===
                "pending" &&
                zones.pending.length >
                1
            ) {
                setTab(
                    "pending"
                );
            } else if (
                originTab ===
                "bottleRoom"
            ) {
                setTab(
                    "bottleRoom"
                );
            } else {
                setTab("map");
            }
        } catch (e: unknown) {
            const message =
                e instanceof Error
                    ? e.message
                    : "שגיאה בשיבוץ";

            setError(message);
        } finally {
            setOperationLoading(null);
        }

    }


    // ========================================================
    // Bulk selection
    // ========================================================

    function toggleBulk(
        id: string
    ) {
        setBulkSelectedIds(
            (previous) => {
                const next =
                    new Set(
                        previous
                    );

                if (
                    next.has(id)
                ) {
                    next.delete(
                        id
                    );
                } else {
                    next.add(id);
                }

                return next;
            }
        );
    }


    // ========================================================
    // Zone moves
    // ========================================================

    async function moveZone(
        id: string,
        zone: PalletZone
    ) {
        try {
            setOperationLoading("מעביר משטח...");
            setError(null);

            await moveToZone(
                id,
                zone
            );

            setBulkSelectedIds(
                (previous) => {
                    const next =
                        new Set(
                            previous
                        );

                    next.delete(
                        id
                    );

                    return next;
                }
            );

            if (
                placementPalletId ===
                id
            ) {
                clearPlacement();
            }

            setMovingZonePallet(
                null
            );
        } catch (e: unknown) {
            const message =
                e instanceof Error
                    ? e.message
                    : "שגיאה בהעברה";

            setError(message);
        } finally {
            setOperationLoading(null);
        }

    }


    async function bulkMove(
        zone: PalletZone
    ) {
        const ids =
            Array.from(
                bulkSelectedIds
            );

        if (ids.length === 0) {
            return;
        }

        try {
            setOperationLoading("מעביר משטחים...");
            setError(null);

            await movePalletsToZone(
                ids,
                zone
            );

            setBulkSelectedIds(
                new Set()
            );

            setBulkMode(false);
        } catch (e: unknown) {
            const message =
                e instanceof Error
                    ? e.message
                    : "שגיאה בהעברה מרובה";

            setError(message);
        } finally {
            setOperationLoading(null);
        }

    }


    // ========================================================
    // Shipment marking
    // ========================================================

    async function markShipment(
        pallet: Pallet
    ) {
        try {
            setOperationLoading("מעדכן סימון משלוח...");
            setError(null);

            await setMarkedForShipment(
                pallet.id,
                !pallet.markedForShipment
            );
        } catch (e: unknown) {
            const message =
                e instanceof Error
                    ? e.message
                    : "שגיאה בסימון למשלוח";

            setError(message);
        } finally {
            setOperationLoading(null);
        }

    }


    // ========================================================
    // Move marked pallets to loading dock
    // ========================================================

    async function shipAllMarked() {
        if (
            markedForShipmentPallets.length ===
            0
        ) {
            return;
        }

        try {
            setOperationLoading("מעביר למשלוח...");
            setError(null);

            await movePalletsToZone(
                markedForShipmentPallets.map(
                    (pallet) =>
                        pallet.id
                ),
                "loadingDock"
            );
        } catch (e: unknown) {
            const message =
                e instanceof Error
                    ? e.message
                    : "שגיאה בהעברה למשלוח";

            setError(message);
        } finally {
            setOperationLoading(null);
        }

    }


    // ========================================================
    // Reordering inside cooler
    // ========================================================

    async function reorder(
        cell: CoolerCell,
        ids: string[]
    ) {
        if (!organizeMode) {
            return cell;
        }

        try {
            setOperationLoading("שומר סדר משטחים...");
            setError(null);

            await reorderPalletsInCell(
                ids
            );
        } catch (e: unknown) {
            const message =
                e instanceof Error
                    ? e.message
                    : "שגיאה בסידור המשטחים";

            setError(message);
        } finally {
            setOperationLoading(null);
        }

    }


    // ========================================================
    // Reordering in flat zones
    // ========================================================

    // async function reorderZone(
    //     ids: string[]
    // ) {
    //     if (!organizeMode) {
    //         return ;
    //     }

    //     try {
    //         setError(null);

    //         await reorderPalletsInZone(
    //             ids
    //         );
    //     } catch (e: unknown) {
    //         const message =
    //             e instanceof Error
    //                 ? e.message
    //                 : "שגיאה בסידור המשטחים";

    //         setError(message);
    //     }
    // }


    // ========================================================
    // Delete
    // ========================================================

    async function confirmDeletePallet() {
        if (
            !deletePalletTarget
        ) {
            return;
        }

        try {
            setOperationLoading("מוחק משטח...");
            setDeletingPallet(
                true
            );

            setError(null);

            await deletePallet(
                deletePalletTarget.id
            );

            setDeletePalletTarget(
                null
            );
        } catch (e: unknown) {
            const message =
                e instanceof Error
                    ? e.message
                    : "שגיאה במחיקת המשטח";

            setError(message);
        } finally {
            setOperationLoading(null);
            setDeletingPallet(
                false
            );
        }
    }


    // ========================================================
    // Tabs
    // ========================================================

    function changeTab(
        nextTab: Tab
    ) {
        setPlacementPalletId(
            null
        );

        setPlacementOriginTab(
            null
        );

        setBulkSelectedIds(
            new Set()
        );

        setBulkMode(false);

        setMovingZonePallet(
            null
        );

        setError(null);

        setOrganizeMode(false);

        setTab(nextTab);
    }


    function selectZone(
        zone:
            | "cooler"
            | "pending"
            | "bottleRoom"
            | "loadingDock"
    ) {
        switch (zone) {
            case "cooler":
                changeTab("map");
                break;

            case "pending":
                changeTab(
                    "pending"
                );
                break;

            case "bottleRoom":
                changeTab(
                    "bottleRoom"
                );
                break;

            case "loadingDock":
                changeTab("dock");
                break;
        }
    }


    // ========================================================
    // Organize mode
    // ========================================================

    function toggleOrganizeMode() {
        setOrganizeMode(
            (previous) => {
                const next =
                    !previous;

                if (
                    previous &&
                    !next
                ) {
                    setPlacementPalletId(
                        null
                    );

                    setPlacementOriginTab(
                        null
                    );

                    setBulkSelectedIds(
                        new Set()
                    );

                    setBulkMode(
                        false
                    );

                    setMovingZonePallet(
                        null
                    );
                }

                return next;
            }
        );
    }


    // ========================================================
    // Zoom
    // ========================================================

    function zoomOut() {
        setZoomLevel(
            (current) =>
                Math.max(
                    MIN_ZOOM,
                    Number(
                        (
                            current -
                            0.15
                        ).toFixed(2)
                    )
                )
        );
    }


    function zoomIn() {
        setZoomLevel(
            (current) =>
                Math.min(
                    MAX_ZOOM,
                    Number(
                        (
                            current +
                            0.15
                        ).toFixed(2)
                    )
                )
        );
    }


    // ========================================================
    // Touch / pinch zoom
    // ========================================================

    function touchDistance(
        touches: TouchList
    ) {
        const first =
            touches[0];

        const second =
            touches[1];

        return Math.hypot(
            first.clientX -
            second.clientX,
            first.clientY -
            second.clientY
        );
    }


    function handleMapTouchStart(
        event: TouchEvent
    ) {
        if (
            event.touches.length ===
            2
        ) {
            pinchStartDistance.current =
                touchDistance(
                    event.touches
                );

            pinchStartZoom.current =
                zoomLevel;
        }
    }


    function handleMapTouchMove(
        event: TouchEvent
    ) {
        if (
            event.touches.length ===
            2 &&
            pinchStartDistance.current
        ) {
            event.preventDefault();

            const distance =
                touchDistance(
                    event.touches
                );

            const scale =
                distance /
                pinchStartDistance.current;

            const next =
                Math.min(
                    MAX_ZOOM,
                    Math.max(
                        MIN_ZOOM,
                        Number(
                            (
                                pinchStartZoom.current *
                                scale
                            ).toFixed(
                                2
                            )
                        )
                    )
                );

            setZoomLevel(
                next
            );
        }
    }


    function handleMapTouchEnd(
        event: TouchEvent
    ) {
        if (
            event.touches.length <
            2
        ) {
            pinchStartDistance.current =
                null;
        }
    }


    // ========================================================
    // Tray props
    // ========================================================

    const trayProps = {
        selectedPalletIds:
            bulkSelectedIds,

        bulkMode,

        onStartBulk: () => {
            setPlacementPalletId(
                null
            );

            setPlacementOriginTab(
                null
            );

            setBulkMode(true);
        },

        onCancelBulk: () => {
            setBulkMode(false);

            setBulkSelectedIds(
                new Set()
            );
        },

        onSelectForPlacement:
            chooseForPlacement,

        onToggleBulk:
            toggleBulk,

        onBulkMove:
            bulkMove,

        onEditPallet:
            setEditingPallet,

        onMoveZone:
            moveZone,

        onDeletePallet:
            setDeletePalletTarget,
    };


    // ========================================================
    // Loading
    // ========================================================

    if (loading) {
        return (
            <div className="cooler-loading">
                <span>
                    <BeerLoader
                        message="טוען את מפת המקרר"
                        overlay={true}
                        size="large"
                    />

                    <MapPlus />
                </span>

                <strong>
                    טוען את מפת המקרר…
                </strong>
            </div>
        );
    }


    // ========================================================
    // Render
    // ========================================================

    return (
        <div
            className={`cooler-map-page ${placementPallet
                ? "has-floating-banner"
                : ""
                }`}
            dir="rtl"
        >
            {/* ==================================================
                Header
            ================================================== */}

            <div className="cooler-map-header">
                <div className="cooler-header-actions">
                    {tab === "map" && (
                        <button
                            type="button"
                            className={`organize-toggle ${organizeMode ? "active" : ""
                                }`}
                            onClick={toggleOrganizeMode}
                        >
                            {organizeMode
                                ? "✓ מצב סידור פעיל"
                                : "סידור מקרר"}
                        </button>
                    )}

                    {!placementPallet && (
                        <button
                            type="button"
                            className="cooler-add-pallet-btn"
                            onClick={() => setShowAddModal(true)}
                        >
                            <LayersPlus size={14} />
                            הוסף משטחים
                        </button>
                    )}
                </div>

                {tab === "map" && (
                    <div className="cooler-map-toolbar">
                        <button
                            type="button"
                            className={`cooler-ship-marked-btn ${totalPlannedTruckSlots > MAX_TRUCK_SLOTS
                                    ? "truck-over-capacity"
                                    : ""
                                }`}
                            onClick={shipAllMarked}
                            disabled={
                                markedForShipmentPallets.length === 0
                            }
                        >
                            <Truck size={14} />

                            שלח מסומנים

                            <span>
                                (
                                {totalPlannedTruckSlots}/
                                {MAX_TRUCK_SLOTS} מקומות)
                            </span>
                        </button>

                        <div className="cooler-zoom-controls">
                            <button
                                type="button"
                                className="zoom-reset"
                                onClick={() => setZoomLevel(1)}
                            >
                                100%
                            </button>

                            <button
                                type="button"
                                onClick={zoomOut}
                                disabled={zoomLevel <= MIN_ZOOM}
                            >
                                −
                            </button>

                            <span>
                                {Math.round(zoomLevel * 100)}%
                            </span>

                            <button
                                type="button"
                                onClick={zoomIn}
                                disabled={zoomLevel >= MAX_ZOOM}
                            >
                                +
                            </button>
                        </div>
                    </div>
                )}
            </div>


            {/* ==================================================
                Zone badges
            ================================================== */}

            <ZoneBadges
                counts={counts}
                onSelect={
                    selectZone
                }
            />


            {/* ==================================================
                Placement banner
            ================================================== */}

            {placementPallet && (
                <div className="placement-banner">
                    <div>
                        <strong>
                            שיבוץ משטח במקרר
                        </strong>

                        <span>
                            <small>
                                {
                                    placementPallet.quantity
                                }{" "}
                                {placementPallet.itemType ===
                                    "kegs"
                                    ? "חביות"
                                    : "ארגזים"}
                            </small>

                            <small>
                                {" · "}
                                {
                                    beerStyleClass(
                                        placementPallet.beerStyle
                                    ).displayLabel
                                }
                            </small>
                        </span>
                    </div>

                    <button
                        type="button"
                        onClick={
                            clearPlacement
                        }
                    >
                        ביטול
                    </button>
                </div>
            )}


            {/* ==================================================
                Error
            ================================================== */}

            {error && (
                <div className="cooler-error">
                    {error}
                </div>
            )}


            {/* ==================================================
                Pending
            ================================================== */}

            {tab ===
                "pending" && (
                    <PendingTray
                        {...trayProps}
                        pallets={
                            zones.pending
                        }
                    />
                )}


            {/* ==================================================
                Bottle room
            ================================================== */}

            {tab ===
                "bottleRoom" && (
                    <BottleRoomTray
                        {...trayProps}
                        pallets={
                            zones.bottleRoom
                        }
                    />
                )}


            {/* ==================================================
                Loading dock
            ================================================== */}

            {tab === "dock" && (
                <LoadingDockView pallets={zones.loadingDock} />
            )}


            {/* ==================================================
                Physical cooler map
            ================================================== */}

            {tab === "map" && (
                <div className="cooler-map-wrap">
                    <div className="cooler-map-explainer">
                        {organizeMode ? (
                            <span>
                                מצב סידור
                                מקרר:
                                לחץ על
                                משטח
                                כדי לבחור
                                אותו,
                                ואז על
                                התא
                                היעד כדי
                                להעביר.
                            </span>
                        ) : (
                            <>
                                <span>
                                    כדי לשבץ
                                    משטח
                                    ממתין:
                                    בחר אותו
                                    במסך
                                    ממתינים
                                    לשיבוץ
                                    ובחר
                                    את התא
                                    הרצוי.
                                </span>

                                <span>
                                    כדי להזיז
                                    משטח
                                    בתוך
                                    המקרר:
                                    הפעל
                                    מצב
                                    סידור
                                    מקרר.
                                </span>
                            </>
                        )}
                    </div>

                    <div
                        className="cooler-map-scroll"
                        onTouchStart={
                            handleMapTouchStart
                        }
                        onTouchMove={
                            handleMapTouchMove
                        }
                        onTouchEnd={
                            handleMapTouchEnd
                        }
                        onTouchCancel={
                            handleMapTouchEnd
                        }
                    >
                        <div className="cooler-map-zoom">
                            <div
                                className="cooler-physical-map"
                                style={
                                    {
                                        zoom: zoomLevel,
                                    } as React.CSSProperties
                                }
                            >
                                {/* =================================
                                    Right side
                                ================================= */}

                                <div className="cooler-side-block right-side">
                                    <div className="silent-door-marker"></div>
                                    {RIGHT_SIDE_COLUMNS.map(
                                        (
                                            column
                                        ) => (
                                            <CoolerColumn
                                                key={
                                                    column.col
                                                }
                                                side="right"
                                                col={
                                                    column.col
                                                }
                                                label={
                                                    column.label
                                                }
                                                rows={
                                                    column.rows
                                                }
                                                cautionRows={
                                                    column.cautionRows
                                                }
                                                palletsByCell={
                                                    palletsByCell
                                                }
                                                placementPallet={
                                                    placementPallet
                                                }
                                                organizeMode={
                                                    organizeMode
                                                }
                                                onDropHere={
                                                    moveSelectedToCell
                                                }
                                                onEdit={
                                                    setEditingPallet
                                                }
                                                onSelectForMove={
                                                    chooseForPlacement
                                                }
                                                onOpenMoveZone={
                                                    setMovingZonePallet
                                                }
                                                onMarkShipment={
                                                    markShipment
                                                }
                                                onReorder={
                                                    reorder
                                                }
                                            />
                                        )
                                    )}

                                    <div className="door-marker">
                                        <span>
                                            מקרר כשות
                                        </span>
                                    </div>
                                    <div className="silent-door-marker"></div>

                                </div>


                                {/* =================================
                                    Corridor
                                ================================= */}

                                <Corridor
                                    palletsByCell={
                                        palletsByCell
                                    }
                                    placementPallet={
                                        placementPallet
                                    }
                                    organizeMode={
                                        organizeMode
                                    }
                                    onDropHere={
                                        moveSelectedToCell
                                    }
                                    onEdit={
                                        setEditingPallet
                                    }
                                    onSelectForMove={
                                        chooseForPlacement
                                    }
                                    onOpenMoveZone={
                                        setMovingZonePallet
                                    }
                                    onMarkShipment={
                                        markShipment
                                    }
                                    onReorder={
                                        reorder
                                    }
                                />


                                {/* =================================
                                    Left side
                                ================================= */}

                                <div className="cooler-side-block left-side">
                                    <div className="silent-door-marker"></div>
                                    {LEFT_SIDE_COLUMNS.map(
                                        (
                                            column
                                        ) => (
                                            <CoolerColumn
                                                key={
                                                    column.col
                                                }
                                                side="left"
                                                col={
                                                    column.col
                                                }
                                                label={
                                                    column.label
                                                }
                                                rows={
                                                    column.rows
                                                }
                                                palletsByCell={
                                                    palletsByCell
                                                }
                                                placementPallet={
                                                    placementPallet
                                                }
                                                organizeMode={
                                                    organizeMode
                                                }
                                                onDropHere={
                                                    moveSelectedToCell
                                                }
                                                onEdit={
                                                    setEditingPallet
                                                }
                                                onSelectForMove={
                                                    chooseForPlacement
                                                }
                                                onOpenMoveZone={
                                                    setMovingZonePallet
                                                }
                                                onMarkShipment={
                                                    markShipment
                                                }
                                                onReorder={
                                                    reorder
                                                }
                                            />
                                        )
                                    )}
                                    <div className="silent-door-marker"></div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}


            {/* ==================================================
                Zone move modal
            ================================================== */}

            {movingZonePallet && (
                <ZoneMoveModal
                    pallet={
                        movingZonePallet
                    }
                    onMove={
                        moveZone
                    }
                    onClose={() =>
                        setMovingZonePallet(
                            null
                        )
                    }
                />
            )}


            {/* ==================================================
                Edit pallet
            ================================================== */}

            {editingPallet && (
                <PalletEditModal
                    pallet={
                        editingPallet
                    }
                    onClose={() =>
                        setEditingPallet(
                            null
                        )
                    }
                    onDone={() =>
                        setEditingPallet(
                            null
                        )
                    }
                />
            )}


            {/* ==================================================
                Add pallet
            ================================================== */}

            {showAddModal && (
                <AddPalletModal
                    brews={brews}
                    onClose={() =>
                        setShowAddModal(
                            false
                        )
                    }
                    onDone={() =>
                        setShowAddModal(
                            false
                        )
                    }
                />
            )}


            {/* ==================================================
                Delete confirmation
            ================================================== */}

            {deletePalletTarget && (
                <ConfirmModal
                    title="מחיקת משטח"
                    message="האם אתה בטוח שברצונך למחוק את המשטח?"
                    onCancel={() => {
                        if (
                            !deletingPallet
                        ) {
                            setDeletePalletTarget(
                                null
                            );
                        }
                    }}
                    onConfirm={
                        confirmDeletePallet
                    }
                    cancelLabel="ביטול"
                    confirmLabel={
                        deletingPallet
                            ? "מוחק..."
                            : "מחק משטח"
                    }
                    danger
                />
            )}
            {operationLoading && (
                <BeerLoader message={operationLoading} overlay />
            )}
        </div>
    );
}