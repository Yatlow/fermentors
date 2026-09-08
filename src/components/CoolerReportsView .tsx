import BeerLoader from "./Loading";

import { useEffect, useMemo, useState } from "react";

import type {
    Pallet,
    PalletZone,
} from "../SERVICES/Pallettypes ";

import {
    collection,
    onSnapshot,
    query,
    where,
} from "firebase/firestore";

import { db } from "../firebase";

import { beerStyleClass } from "../SERVICES/Pallettypes ";

// ============================================================
// TYPES
// ============================================================

type ViewMode = "cards" | "table";

type StyleInventory = {
    beerStyle: string;

    cratesQuantity: number;
    cratesPallets: number;

    kegsQuantity: number;
    kegsPallets: number;

    totalQuantity: number;
    totalPallets: number;
};

// ============================================================
// ONLY THESE ZONES COUNT AS ACTIVE INVENTORY
// ============================================================

const INVENTORY_ZONES: PalletZone[] = [
    "cooler",
    "pending",
    "bottleRoom",
];

// ============================================================
// STYLE SORT ORDER
// ============================================================

const STYLE_ORDER: Record<string, number> = {
    ipa: 1,
    pale: 2,
    hoppyLager: 3,
    lager: 4,
    wheat: 5,
    stout: 6,
    sour: 7,
    other: 99,
};

function normalizeBeerStyle(style: string): string {
    const trimmed = style.trim();

    // IPA — כל וריאציה של אותיות תיחשב IPA אחד
    if (/^ipa$/i.test(trimmed)) {
        return "IPA";
    }

    // פייל
    if (/^פייל$/i.test(trimmed)) {
        return "פייל";
    }

    // הופי לאגר
    if (/הופי.*לאגר/i.test(trimmed)) {
        return "הופי לאגר";
    }

    // לאגר
    if (/לאגר/i.test(trimmed)) {
        return "לאגר";
    }

    // חיטה
    if (/חיטה/i.test(trimmed)) {
        return "חיטה";
    }

    // סטאוט
    if (/סטאוט/i.test(trimmed)) {
        return "סטאוט";
    }

    // סאואר
    if (/sour/i.test(trimmed) || /סאוט/i.test(trimmed)) {
        return "סאואר";
    }

    return trimmed;
}
// ============================================================
// COMPONENT
// ============================================================

export default function InventoryReportView() {
    const [pallets, setPallets] = useState<Pallet[]>([]);

    const [loading, setLoading] = useState(true);

    const [viewMode, setViewMode] =
        useState<ViewMode>("cards");

    // ========================================================
    // FIRESTORE
    // ========================================================

    useEffect(() => {
        setLoading(true);

        const palletsRef = collection(db, "pallets");

        /*
         * IMPORTANT:
         *
         * loadingDock is intentionally NOT here.
         *
         * Only:
         * cooler
         * pending
         * bottleRoom
         */

        const inventoryQuery = query(
            palletsRef,
            where("zone", "in", INVENTORY_ZONES)
        );

        const unsubscribe = onSnapshot(
            inventoryQuery,
            (snapshot) => {
                const inventoryPallets: Pallet[] =
                    snapshot.docs.map(
                        (firebaseDoc) =>
                        ({
                            id: firebaseDoc.id,
                            ...firebaseDoc.data(),
                        } as Pallet)
                    );

                setPallets(inventoryPallets);
                setLoading(false);
            },
            (error) => {
                console.error(
                    "Inventory report error:",
                    error
                );

                setPallets([]);
                setLoading(false);
            }
        );

        return () => unsubscribe();
    }, []);

    // ========================================================
    // GROUP BY BEER STYLE
    // ========================================================

   const inventoryByStyle = useMemo<
    StyleInventory[]
>(() => {
    const map = new Map<
        string,
        StyleInventory
    >();

    pallets.forEach((pallet) => {
        /*
         * IMPORTANT:
         *
         * Normalize the style BEFORE using it
         * as the Map key.
         *
         * Example:
         * "ipa"
         * "IPA"
         * "Ipa"
         *
         * all become:
         * "IPA"
         */
        const normalizedStyle =
            normalizeBeerStyle(
                pallet.beerStyle
            );

        let current = map.get(
            normalizedStyle
        );

        if (!current) {
            current = {
                beerStyle: normalizedStyle,

                cratesQuantity: 0,
                cratesPallets: 0,

                kegsQuantity: 0,
                kegsPallets: 0,

                totalQuantity: 0,
                totalPallets: 0,
            };

            map.set(
                normalizedStyle,
                current
            );
        }

        current.totalQuantity +=
            pallet.quantity;

        current.totalPallets += 1;

        if (
            pallet.itemType ===
            "crates"
        ) {
            current.cratesQuantity +=
                pallet.quantity;

            current.cratesPallets += 1;
        }

        if (
            pallet.itemType ===
            "kegs"
        ) {
            current.kegsQuantity +=
                pallet.quantity;

            current.kegsPallets += 1;
        }
    });

    return Array.from(
        map.values()
    ).sort((a, b) => {
        const aStyle = beerStyleClass(
            a.beerStyle
        );

        const bStyle = beerStyleClass(
            b.beerStyle
        );

        const aOrder =
            STYLE_ORDER[
                aStyle.category
            ] ?? 99;

        const bOrder =
            STYLE_ORDER[
                bStyle.category
            ] ?? 99;

        if (aOrder !== bOrder) {
            return aOrder - bOrder;
        }

        return a.beerStyle.localeCompare(
            b.beerStyle,
            "he"
        );
    });
}, [pallets]);

    // ========================================================
    // GRAND TOTALS
    // ========================================================

    const grandTotals = useMemo(() => {
        return pallets.reduce(
            (result, pallet) => {
                if (
                    pallet.itemType ===
                    "crates"
                ) {
                    result.crates +=
                        pallet.quantity;
                }

                if (
                    pallet.itemType ===
                    "kegs"
                ) {
                    result.kegs +=
                        pallet.quantity;
                }

                result.pallets += 1;

                return result;
            },
            {
                crates: 0,
                kegs: 0,
                pallets: 0,
            }
        );
    }, [pallets]);

    // ========================================================
    // LOADING
    // ========================================================

    if (loading) {
        return (
            <div
                className="inventory-report"
                dir="rtl"
            >
                <div className="inventory-loading">
                    <BeerLoader
                        message="טוען מלאי..."
                        size="small"
                    />
                </div>
            </div>
        );
    }

    // ========================================================
    // RENDER
    // ========================================================

    return (
        <div
            className="inventory-report"
            dir="rtl"
        >
            {/* ==================================================
                HEADER
            ================================================== */}

            <div className="inventory-header">
                <div className="inventory-header-title">
                    <h2>מלאי מוצר מוגמר</h2>

                </div>

                {/* ==================================================
                    TOGGLE
                ================================================== */}

                <div className="inventory-view-toggle">
                    <button
                        type="button"
                        className={
                            viewMode === "cards"
                                ? "inventory-toggle-active"
                                : ""
                        }
                        onClick={() =>
                            setViewMode("cards")
                        }
                    >
                        <span>▦</span>
                        כרטיסיות
                    </button>

                    <button
                        type="button"
                        className={
                            viewMode === "table"
                                ? "inventory-toggle-active"
                                : ""
                        }
                        onClick={() =>
                            setViewMode("table")
                        }
                    >
                        <span>☷</span>
                        טבלה
                    </button>
                </div>
            </div>

            {/* ==================================================
                GRAND TOTALS
            ================================================== */}

            <div className="inventory-totals">
                <div className="inventory-total-box">
                    <span>ארגזים</span>

                    <strong>
                        {grandTotals.crates.toLocaleString()}
                    </strong>
                </div>

                <div className="inventory-total-box">
                    <span>חביות</span>

                    <strong>
                        {grandTotals.kegs.toLocaleString()}
                    </strong>
                </div>

                
            </div>

            {/* ==================================================
                EMPTY
            ================================================== */}

            {inventoryByStyle.length === 0 && (
                <div className="inventory-empty">
                    אין מלאי פעיל להצגה
                </div>
            )}

            {/* ==================================================
                CARDS
            ================================================== */}

            {viewMode === "cards" &&
                inventoryByStyle.length > 0 && (
                    <div className="inventory-cards">
                        {inventoryByStyle.map(
                            (style) => {
                                const styleInfo =
                                    beerStyleClass(
                                        style.beerStyle
                                    );

                                return (
                                    <div
                                        key={
                                            style.beerStyle
                                        }
                                        className={`inventory-card ${styleInfo.className}`}
                                    >
                                        {/* CARD HEADER */}

                                        <div className="inventory-card-header">
                                            <div className="inventory-card-style">
                                                {
                                                    styleInfo.displayLabel
                                                }

                                                {styleInfo.displayLabel !==
                                                    style.beerStyle && (
                                                        <small>
                                                            {
                                                                style.beerStyle
                                                            }
                                                        </small>
                                                    )}
                                            </div>

                                            <div className="inventory-card-total">
                                                {
                                                    style.totalQuantity.toLocaleString()
                                                }
                                            </div>
                                        </div>

                                        {/* ITEMS */}

                                        <div className="inventory-card-items">
                                            {/* BOTTLES */}

                                            <div className="inventory-card-item">
                                                <div>
                                                    <span>
                                                        ארגזים
                                                    </span>

                                                    <small>
                                                        {
                                                            style.cratesPallets
                                                        }{" "}
                                                        משטחים
                                                    </small>
                                                </div>

                                                <strong>
                                                    {style.cratesQuantity.toLocaleString()}
                                                </strong>
                                            </div>

                                            {/* KEGS */}

                                            <div className="inventory-card-item">
                                                <div>
                                                    <span>
                                                        חביות
                                                    </span>

                                                    <small>
                                                        {
                                                            style.kegsPallets
                                                        }{" "}
                                                        משטחים
                                                    </small>
                                                </div>

                                                <strong>
                                                    {style.kegsQuantity.toLocaleString()}
                                                </strong>
                                            </div>
                                        </div>
                                    </div>
                                );
                            }
                        )}
                    </div>
                )}

            {/* ==================================================
                TABLE
            ================================================== */}

            {viewMode === "table" &&
                inventoryByStyle.length > 0 && (
                    <div className="inventory-table-container">
                        <table className="inventory-table">
                            <thead>
                                <tr>
                                    <th>סגנון</th>
                                    <th>סוג</th>
                                    <th>כמות</th>
                                    <th>משטחים</th>
                                </tr>
                            </thead>

                            <tbody>
                                {inventoryByStyle.map((style) => {
                                    const styleInfo = beerStyleClass(
                                        style.beerStyle
                                    );

                                    const rows = [];

                                    if (style.kegsQuantity > 0) {
                                        rows.push(
                                            <tr key={`${style.beerStyle}-kegs`}>
                                                <td
                                                    className={`inventory-table-style ${styleInfo.className}`}
                                                >
                                                    <strong>
                                                        {style.beerStyle}
                                                    </strong>
                                                </td>

                                                <td>חביות</td>

                                                <td className="inventory-table-quantity">
                                                    {style.kegsQuantity.toLocaleString()}
                                                </td>

                                                <td>
                                                    {style.kegsPallets}
                                                </td>

                                                
                                            </tr>
                                        );
                                    }

                                    if (style.cratesQuantity > 0) {
                                        rows.push(
                                            <tr key={`${style.beerStyle}-crates`}>
                                                <td
                                                    className={`inventory-table-style ${styleInfo.className}`}
                                                >
                                                    <strong>
                                                        {style.beerStyle}
                                                    </strong>
                                                </td>

                                                <td>ארגזים</td>

                                                <td className="inventory-table-quantity">
                                                    {style.cratesQuantity.toLocaleString()}
                                                </td>

                                                <td>
                                                    {style.cratesPallets}
                                                </td>

                                                
                                            </tr>
                                        );
                                    }

                                    return rows;
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
        </div>
    );
}