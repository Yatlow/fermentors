import {
    useMemo,
    useState,
    type ComponentProps,
    type ReactNode,
} from "react";
import {
    ArrowRightLeft,
    Pencil,
    ClipboardClock,
    BottleWine,
    Truck,
    Check,
    Trash2,
    LayerArrowUp,
    LayerArrowDown,
} from "lucide-react";

import { beerStyleClass } from "../SERVICES/Pallettypes ";
import type { Pallet, PalletZone } from "../SERVICES/Pallettypes ";

import {
    reorderPalletsInZone,
} from "../SERVICES/Palletservice";

// ============================================================
// Zone options
// ============================================================

const ZONE_OPTIONS: {
    value: PalletZone;
    label: string;
    icon: ReactNode;
}[] = [
    {
        value: "pending",
        label: "ממתינים לשיבוץ",
        icon: <ClipboardClock size={18} />,
    },
    {
        value: "bottleRoom",
        label: "חדר בקבוקים",
        icon: <BottleWine size={18} />,
    },
    {
        value: "loadingDock",
        label: "בהעמסה למשלוח",
        icon: <Truck size={18} />,
    },
];

// ============================================================
// Sorting
// ============================================================

function sortPalletsByStyleThenQuantity(
    pallets: Pallet[]
): Pallet[] {
    return [...pallets].sort((a, b) => {
        const styleA =
            beerStyleClass(a.beerStyle).displayLabel;

        const styleB =
            beerStyleClass(b.beerStyle).displayLabel;

        const styleCompare =
            styleA.localeCompare(styleB, "he");

        if (styleCompare !== 0) {
            return styleCompare;
        }

        return a.quantity - b.quantity;
    });
}

function sortPalletsInFlatZone(
    pallets: Pallet[]
): Pallet[] {
    const hasManualOrder =
        pallets.some(
            (p) => typeof p.orderInZone === "number"
        );

    if (hasManualOrder) {
        return [...pallets].sort(
            (a, b) =>
                (a.orderInZone ?? Number.MAX_SAFE_INTEGER) -
                (b.orderInZone ?? Number.MAX_SAFE_INTEGER)
        );
    }

    return sortPalletsByStyleThenQuantity(pallets);
}

// ============================================================
// Move modal
// ============================================================

export function ZoneMoveModal({
    pallet,
    onMove,
    onClose,
}: {
    pallet: Pallet;
    onMove: (
        id: string,
        zone: PalletZone
    ) => Promise<void>;
    onClose: () => void;
}) {
    const options = ZONE_OPTIONS.filter(
        (z) => z.value !== pallet.zone
    );

    const [targetZone, setTargetZone] =
        useState<PalletZone>(
            options[0]?.value ?? "pending"
        );

    const [moving, setMoving] = useState(false);

    async function handleMove() {
        try {
            setMoving(true);

            await onMove(
                pallet.id,
                targetZone
            );

            onClose();
        } finally {
            setMoving(false);
        }
    }

    return (
        <div
            className="modal-overlay"
            onClick={onClose}
        >
            <div
                className="modal-box zone-move-modal"
                onClick={(e) => e.stopPropagation()}
                dir="rtl"
            >
                <div className="modal-header-row">
                    <div>
                        <span className="modal-kicker">
                            העברת משטח
                        </span>

                        <h3>
                            לאן להעביר?
                        </h3>
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

                    <span>
                        {" · "}
                        {
                            beerStyleClass(
                                pallet.beerStyle
                            ).displayLabel
                        }
                    </span>

                    {pallet.batchNumber && (
                        <span>
                            {" · "}
                            אצווה{" "}
                            {pallet.batchNumber}
                        </span>
                    )}
                </p>

                <div className="zone-move-modal-options">
                    {options.map((z) => (
                        <button
                            key={z.value}
                            type="button"
                            className={`zone-move-modal-option ${
                                targetZone === z.value
                                    ? "active"
                                    : ""
                            }`}
                            onClick={() =>
                                setTargetZone(
                                    z.value
                                )
                            }
                            disabled={moving}
                        >
                            {z.icon}

                            <span className="zone-move-modal-option-label">
                                {z.label}
                            </span>

                            {targetZone === z.value && (
                                <Check
                                    size={16}
                                    className="zone-move-modal-option-check"
                                />
                            )}
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
                        {moving
                            ? "מעביר..."
                            : "אשר העברה"}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ============================================================
// Zone list item
// ============================================================

function ZoneListItem({
    pallet,
    selected,
    bulkMode,
    isFirst,
    isLast,
    onSelectForPlacement,
    onToggleBulk,
    onEditPallet,
    onOpenMoveModal,
    onDeletePallet,
    onMoveUp,
    onMoveDown,
}: {
    pallet: Pallet;
    selected: boolean;
    bulkMode: boolean;

    isFirst: boolean;
    isLast: boolean;

    onSelectForPlacement: (
        pallet: Pallet
    ) => void;

    onToggleBulk: (
        id: string
    ) => void;

    onEditPallet: (
        pallet: Pallet
    ) => void;

    onOpenMoveModal: (
        pallet: Pallet
    ) => void;

    onDeletePallet: (
        pallet: Pallet
    ) => void;

    onMoveUp: (
        palletId: string
    ) => Promise<void>;

    onMoveDown: (
        palletId: string
    ) => Promise<void>;
}) {
    const itemLabel =
        pallet.itemType === "kegs"
            ? "חביות"
            : "ארגזים";

    return (
        <article
            className={`zone-tray-item ${
                beerStyleClass(
                    pallet.beerStyle
                ).className
            } ${
                selected
                    ? "selected"
                    : ""
            }`}
        >
            {bulkMode && (
                <label
                    className="zone-bulk-check"
                    onClick={(e) =>
                        e.stopPropagation()
                    }
                >
                    <input
                        type="checkbox"
                        checked={selected}
                        onChange={() =>
                            onToggleBulk(
                                pallet.id
                            )
                        }
                    />
                </label>
            )}

            <div className="zone-tray-item-main">
                <div className="zone-tray-item-title">
                    <span className="zone-item-icon">
                        {pallet.itemType ===
                        "kegs"
                            ? "🛢️"
                            : "📦"}
                    </span>

                    {
                        beerStyleClass(
                            pallet.beerStyle
                        ).displayLabel
                    }

                    {pallet.subLabel
                        ? ` · ${pallet.subLabel}`
                        : ""}
                </div>

                <div className="zone-tray-item-meta">
                    <strong>
                        {pallet.quantity}{" "}
                        {itemLabel}
                    </strong>

                    {pallet.batchNumber
                        ? ` · אצווה ${pallet.batchNumber}`
                        : ""}
                </div>
            </div>

            <div
                className="zone-tray-item-actions"
                onClick={(e) =>
                    e.stopPropagation()
                }
            >
                {/* =====================================================
                    Manual order buttons
                   ===================================================== */}

                {!bulkMode && (
                    <div
                        className="zone-reorder-buttons"
                        title="שינוי סדר"
                    >
                        <button
                            type="button"
                            className="zone-reorder-button"
                            onClick={() =>
                                onMoveUp(
                                    pallet.id
                                )
                            }
                            disabled={isFirst}
                            title="הזז למעלה"
                            aria-label="הזז למעלה"
                        >
                            <LayerArrowUp
                                size={16}
                            />
                        </button>

                        <button
                            type="button"
                            className="zone-reorder-button"
                            onClick={() =>
                                onMoveDown(
                                    pallet.id
                                )
                            }
                            disabled={isLast}
                            title="הזז למטה"
                            aria-label="הזז למטה"
                        >
                            <LayerArrowDown
                                size={16}
                            />
                        </button>
                    </div>
                )}

                {/* =====================================================
                    Placement
                   ===================================================== */}

                {!bulkMode && (
                    <button
                        className="zone-primary-action"
                        onClick={() =>
                            onSelectForPlacement(
                                pallet
                            )
                        }
                    >
                        שבץ במפה
                    </button>
                )}

                {/* =====================================================
                    Edit
                   ===================================================== */}

                <button
                    className="zone-secondary-action"
                    onClick={() =>
                        onEditPallet(
                            pallet
                        )
                    }
                >
                    <Pencil size={14} />
                    עריכה
                </button>

                {/* =====================================================
                    Move / Delete
                   ===================================================== */}

                {!bulkMode && (
                    <>
                        <button
                            className="zone-secondary-action"
                            onClick={() =>
                                onOpenMoveModal(
                                    pallet
                                )
                            }
                        >
                            <ArrowRightLeft
                                size={14}
                            />
                            העבר
                        </button>

                        <button
                            className="zone-danger-action"
                            onClick={() =>
                                onDeletePallet(
                                    pallet
                                )
                            }
                            title="מחק משטח"
                        >
                            <Trash2 size={14} />
                            מחק
                        </button>
                    </>
                )}
            </div>
        </article>
    );
}

// ============================================================
// Bulk move modal
// ============================================================

function BulkZoneMoveModal({
    count,
    currentZone,
    onMove,
    onClose,
}: {
    count: number;
    currentZone: PalletZone;
    onMove: (
        zone: PalletZone
    ) => Promise<void>;
    onClose: () => void;
}) {
    const options = ZONE_OPTIONS.filter(
        (z) => z.value !== currentZone
    );

    const [targetZone, setTargetZone] =
        useState<PalletZone>(
            options[0]?.value ?? "pending"
        );

    const [moving, setMoving] =
        useState(false);

    async function handleMove() {
        try {
            setMoving(true);

            await onMove(
                targetZone
            );

            onClose();
        } finally {
            setMoving(false);
        }
    }

    return (
        <div
            className="modal-overlay"
            onClick={onClose}
        >
            <div
                className="modal-box zone-move-modal"
                onClick={(e) =>
                    e.stopPropagation()
                }
                dir="rtl"
            >
                <div className="modal-header-row">
                    <div>
                        <span className="modal-kicker">
                            העברה מרובה
                        </span>

                        <h3>
                            לאן להעביר?
                        </h3>
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
                    נבחרו{" "}
                    <strong>
                        {count}
                    </strong>{" "}
                    משטחים
                </p>

                <div className="zone-move-modal-options">
                    {options.map((z) => (
                        <button
                            key={z.value}
                            type="button"
                            className={`zone-move-modal-option ${
                                targetZone ===
                                z.value
                                    ? "active"
                                    : ""
                            }`}
                            onClick={() =>
                                setTargetZone(
                                    z.value
                                )
                            }
                            disabled={moving}
                        >
                            {z.icon}

                            <span className="zone-move-modal-option-label">
                                {z.label}
                            </span>

                            {targetZone ===
                                z.value && (
                                <Check
                                    size={16}
                                    className="zone-move-modal-option-check"
                                />
                            )}
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
                        onClick={
                            handleMove
                        }
                        disabled={moving}
                    >
                        {moving
                            ? "מעביר..."
                            : "אשר העברה"}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ============================================================
// Zone tray
// ============================================================

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
    onDeletePallet,
}: {
    title: string;
    hint: string;
    pallets: Pallet[];
    selectedPalletIds: Set<string>;
    bulkMode: boolean;

    onStartBulk: () => void;
    onCancelBulk: () => void;

    onSelectForPlacement: (
        pallet: Pallet
    ) => void;

    onToggleBulk: (
        id: string
    ) => void;

    onBulkMove: (
        zone: PalletZone
    ) => Promise<void>;

    onEditPallet: (
        pallet: Pallet
    ) => void;

    onMoveZone: (
        id: string,
        zone: PalletZone
    ) => Promise<void>;

    onDeletePallet: (
        pallet: Pallet
    ) => void;
}) {
    const [
        movingPallet,
        setMovingPallet,
    ] = useState<Pallet | null>(null);

    const [
        showBulkMoveModal,
        setShowBulkMoveModal,
    ] = useState(false);

    const [
        movingOrderId,
        setMovingOrderId,
    ] = useState<string | null>(null);

    // ========================================================
    // Display order
    // ========================================================

    const displayPallets = useMemo(
        () =>
            sortPalletsInFlatZone(
                pallets
            ),
        [pallets]
    );

    // ========================================================
    // Bulk selection
    // ========================================================

    const allSelected =
        pallets.length > 0 &&
        pallets.every((p) =>
            selectedPalletIds.has(
                p.id
            )
        );

    function selectAll() {
        pallets.forEach((p) => {
            if (
                !selectedPalletIds.has(
                    p.id
                )
            ) {
                onToggleBulk(
                    p.id
                );
            }
        });
    }

    function clearAll() {
        pallets.forEach((p) => {
            if (
                selectedPalletIds.has(
                    p.id
                )
            ) {
                onToggleBulk(
                    p.id
                );
            }
        });
    }

    // ========================================================
    // Manual reorder
    // ========================================================

    async function movePalletUp(
        palletId: string
    ) {
        if (
            movingOrderId !== null
        ) {
            return;
        }

        const currentIndex =
            displayPallets.findIndex(
                (p) =>
                    p.id ===
                    palletId
            );

        if (
            currentIndex <= 0
        ) {
            return;
        }

        const orderedIds =
            displayPallets.map(
                (p) => p.id
            );

        [
            orderedIds[
                currentIndex - 1
            ],
            orderedIds[
                currentIndex
            ],
        ] = [
            orderedIds[
                currentIndex
            ],
            orderedIds[
                currentIndex - 1
            ],
        ];

        try {
            setMovingOrderId(
                palletId
            );

            await reorderPalletsInZone(
                orderedIds
            );
        } finally {
            setMovingOrderId(
                null
            );
        }
    }

    async function movePalletDown(
        palletId: string
    ) {
        if (
            movingOrderId !== null
        ) {
            return;
        }

        const currentIndex =
            displayPallets.findIndex(
                (p) =>
                    p.id ===
                    palletId
            );

        if (
            currentIndex === -1 ||
            currentIndex >=
                displayPallets.length - 1
        ) {
            return;
        }

        const orderedIds =
            displayPallets.map(
                (p) => p.id
            );

        [
            orderedIds[
                currentIndex
            ],
            orderedIds[
                currentIndex + 1
            ],
        ] = [
            orderedIds[
                currentIndex + 1
            ],
            orderedIds[
                currentIndex
            ],
        ];

        try {
            setMovingOrderId(
                palletId
            );

            await reorderPalletsInZone(
                orderedIds
            );
        } finally {
            setMovingOrderId(
                null
            );
        }
    }

    // ========================================================
    // Render
    // ========================================================

    return (
        <div className="zone-tray">
            <div className="zone-tray-header">
                <div>
                    <h3>
                        {title}
                    </h3>

                    <p>
                        {hint}
                    </p>
                </div>

                {!bulkMode ? (
                    <button
                        className="bulk-mode-btn"
                        onClick={
                            onStartBulk
                        }
                        disabled={
                            pallets.length ===
                            0
                        }
                    >
                        בחר כמה להעברה
                    </button>
                ) : (
                    <button
                        className="bulk-mode-cancel"
                        onClick={
                            onCancelBulk
                        }
                    >
                        יציאה מבחירה
                    </button>
                )}
            </div>

            {/* ====================================================
                Bulk action bar
               ==================================================== */}

            {bulkMode && (
                <div className="bulk-action-bar">
                    <div className="bulk-selection-info">
                        <strong>
                            {
                                selectedPalletIds.size
                            }{" "}
                            נבחרו
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
                        disabled={
                            selectedPalletIds.size ===
                            0
                        }
                        onClick={() =>
                            setShowBulkMoveModal(
                                true
                            )
                        }
                    >
                        העבר נבחרים
                    </button>
                </div>
            )}

            {/* ====================================================
                List
               ==================================================== */}

            {pallets.length ===
            0 ? (
                <div className="zone-tray-empty">
                    אין משטחים באזור הזה כרגע.
                </div>
            ) : (
                <div className="zone-tray-list">
                    {displayPallets.map(
                        (
                            p,
                            index
                        ) => (
                            <ZoneListItem
                                key={p.id}
                                pallet={p}
                                selected={selectedPalletIds.has(
                                    p.id
                                )}
                                bulkMode={
                                    bulkMode
                                }
                                isFirst={
                                    index ===
                                    0
                                }
                                isLast={
                                    index ===
                                    displayPallets.length -
                                        1
                                }
                                onSelectForPlacement={
                                    onSelectForPlacement
                                }
                                onToggleBulk={
                                    onToggleBulk
                                }
                                onEditPallet={
                                    onEditPallet
                                }
                                onOpenMoveModal={
                                    setMovingPallet
                                }
                                onDeletePallet={
                                    onDeletePallet
                                }
                                onMoveUp={
                                    movePalletUp
                                }
                                onMoveDown={
                                    movePalletDown
                                }
                            />
                        )
                    )}
                </div>
            )}

            {/* ====================================================
                Single move modal
               ==================================================== */}

            {movingPallet && (
                <ZoneMoveModal
                    pallet={
                        movingPallet
                    }
                    onMove={
                        onMoveZone
                    }
                    onClose={() =>
                        setMovingPallet(
                            null
                        )
                    }
                />
            )}

            {/* ====================================================
                Bulk move modal
               ==================================================== */}

            {showBulkMoveModal && (
                <BulkZoneMoveModal
                    count={
                        selectedPalletIds.size
                    }
                    currentZone={
                        pallets[0]?.zone ??
                        "pending"
                    }
                    onMove={
                        onBulkMove
                    }
                    onClose={() =>
                        setShowBulkMoveModal(
                            false
                        )
                    }
                />
            )}
        </div>
    );
}

// ============================================================
// Pending tray
// ============================================================

export function PendingTray(
    props: Omit<
        ComponentProps<
            typeof ZoneTray
        >,
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

// ============================================================
// Bottle room tray
// ============================================================

export function BottleRoomTray(
    props: Omit<
        ComponentProps<
            typeof ZoneTray
        >,
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