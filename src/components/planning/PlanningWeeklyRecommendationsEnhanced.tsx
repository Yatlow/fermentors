import { useMemo, useState, type ComponentProps, type MouseEvent as ReactMouseEvent } from "react";
import {
import TransientNumberInput from "../general/TransientNumberInput";
    addDays,
    emptyWeek,
    litersPerUnit,
    sameStyle,
    weekStart,
    type Plan,
    type Product,
    type Tank,
} from "../../SERVICES/planning/planningEngine";
import { openRuns, shortDate } from "../../SERVICES/planning/dailyPlanner";
import { displayStyle } from "../../SERVICES/planning/planningPresentation";
import { buildWeeklyPlanningModel } from "../../SERVICES/planning/weeklyPlanningModel";
import { brewSizeLabel, weekday } from "../../SERVICES/planning/productionCycle";
import { shipmentMatchesForPlans } from "../../SERVICES/planning/shipmentActuals";
import PlanningWeeklyRecommendations from "./PlanningWeeklyRecommendations";
import "./planningPackagingModal.css";

type Props = ComponentProps<typeof PlanningWeeklyRecommendations> & {
    historyPlans?: ComponentProps<typeof PlanningWeeklyRecommendations>["plans"];
};

type PackRow = {
    key: string;
    originalId?: string;
    source: "existing" | "recommendation" | "manual";
    tankId: string;
    productId: string;
    quantity: number;
    completed: number;
};

const MAX_CRATES_PER_RUN = 252;
const fmt = (value: number) => Math.round(value).toLocaleString("he-IL");
const initialWeek = (today: string) => weekday(today) >= 5 ? addDays(weekStart(today), 7) : weekStart(today);

function dateFromWeekButton(button: HTMLButtonElement): string | null {
    const text = button.querySelector("small")?.textContent?.trim() ?? "";
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
    if (!match) return null;
    return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

function tankSize(tank: Tank) {
    return brewSizeLabel(tank.liters, tank.number);
}

export default function PlanningWeeklyRecommendationsEnhanced(props: Props) {
    const { settings, plans, historyPlans = plans, tanks, actuals, shipments, today, disabled, saveWeek } = props;
    const [selectedWeek, setSelectedWeek] = useState(() => initialWeek(today));
    const [packStyle, setPackStyle] = useState<string | null | undefined>(undefined);
    const [rows, setRows] = useState<PackRow[]>([]);
    const [modalMessage, setModalMessage] = useState("");
    const [saving, setSaving] = useState(false);

    const current = plans.find((week) => week.id === selectedWeek) ?? {
        ...emptyWeek(selectedWeek),
        maxRuns: settings.preferredRuns,
    };

    const model = useMemo(() => buildWeeklyPlanningModel({
        settings,
        pallets: props.pallets,
        tanks,
        plans,
        actuals,
        sources: props.sources,
        today,
        week: selectedWeek,
        holidays: props.holidays,
        shipments,
    }), [settings, props.pallets, tanks, plans, actuals, props.sources, today, selectedWeek, props.holidays, shipments]);

    const openedRuns = useMemo(
        () => openRuns(plans, settings.products, actuals).filter((run) => run.week === selectedWeek),
        [plans, settings.products, actuals, selectedWeek],
    );

    const product = (id: string): Product | undefined => settings.products.find((item) => item.id === id);

    function completedForPlan(run: Plan) {
        const open = run.id
            ? openedRuns.find((item) => item.id === run.id)
            : openedRuns.find((item) => item.productId === run.productId && item.tankId === run.tankId);
        return Math.max(0, run.quantity - (open?.remaining ?? run.quantity));
    }

    const styleProducts = (style: string) => settings.products.filter((item) => sameStyle(item.style, style));

    const availableStyles = useMemo(() => {
        const values: string[] = [];
        const add = (style?: string) => {
            if (!style || values.some((known) => sameStyle(known, style))) return;
            values.push(style);
        };
        settings.products.filter((item) => item.monthly > 0).forEach((item) => add(item.style));
        current.packaging.forEach((run) => add(product(run.productId)?.style));
        model.packagingRecommendation.forEach((run) => add(product(run.productId)?.style));
        return values;
    }, [settings.products, current.packaging, model.packagingRecommendation]);

    function tanksForStyle(style: string) {
        return tanks
            .filter((tank) =>
                sameStyle(tank.style, style) &&
                tank.ready <= model.weekEnd &&
                (model.tankAvailableLiters.get(tank.id) ?? tank.liters) >= 20,
            )
            .sort((a, b) => a.brewed.localeCompare(b.brewed) || Number(a.number) - Number(b.number));
    }

    function fifoLabel(tank: Tank, style: string) {
        const peers = tanksForStyle(style);
        const rank = peers.findIndex((item) => item.id === tank.id) + 1;
        if (rank <= 0) return "";
        return `FIFO ${rank}/${peers.length}${rank === 1 && peers.length > 1 ? " · הוותיק ביותר" : ""}`;
    }

    function tankLabel(tank: Tank, style: string) {
        return `מיכל ${tank.number} · ${tankSize(tank)} · ${fifoLabel(tank, style)} · בושל ${shortDate(tank.brewed)}`;
    }

    function buildRows(style: string): PackRow[] {
        return current.packaging.flatMap((run, index) => {
            const p = product(run.productId);
            if (!p || !sameStyle(p.style, style)) return [];
            return [{
                key: run.id ?? `existing:${index}:${run.productId}:${run.tankId ?? ""}`,
                originalId: run.id,
                source: "existing" as const,
                tankId: run.tankId ?? "",
                productId: run.productId,
                quantity: run.quantity,
                completed: completedForPlan(run),
            }];
        });
    }

    function openPackEditor(style?: string) {
        setModalMessage("");
        if (!style) {
            setPackStyle(null);
            setRows([]);
            return;
        }
        setPackStyle(style);
        setRows(buildRows(style));
    }

    function chooseStyle(style: string) {
        setModalMessage("");
        setPackStyle(style);
        setRows(buildRows(style));
    }

    function handleCapture(event: ReactMouseEvent<HTMLDivElement>) {
        const target = event.target as HTMLElement;
        const weekButton = target.closest<HTMLButtonElement>(".bp-week-picker button");
        if (weekButton) {
            const date = dateFromWeekButton(weekButton);
            if (date) {
                setSelectedWeek(date);
                setPackStyle(undefined);
                setRows([]);
            }
            return;
        }

        const packagingCard = target.closest<HTMLElement>(".bp-week-packaging-card");
        if (packagingCard) {
            const editButton = target.closest<HTMLButtonElement>("button");
            if (editButton?.textContent?.includes("עריכת האריזות")) {
                event.preventDefault();
                event.stopPropagation();
                openPackEditor();
                return;
            }

            const sku = target.closest<HTMLElement>(".bp-week-sku");
            if (sku) {
                const styleText = sku.querySelector("b")?.textContent?.trim();
                const matched = settings.products.find((item) => displayStyle(item.style) === styleText);
                if (matched) {
                    event.preventDefault();
                    event.stopPropagation();
                    openPackEditor(matched.style);
                }
                return;
            }
        }

        const sku = target.closest<HTMLElement>(".bp-week-sku");
        const card = sku?.closest<HTMLElement>(".bp-week-rec-card");
        if (!sku || !card) return;
        const editButton = [...card.querySelectorAll<HTMLButtonElement>("button")]
            .find((button) => button.textContent?.includes("עריכת"));
        if (editButton && !editButton.disabled) {
            event.preventDefault();
            event.stopPropagation();
            window.setTimeout(() => editButton.click(), 0);
        }
    }

    function pendingUnits(row: PackRow) {
        return Math.max(0, row.quantity - row.completed);
    }

    function defaultQuantityForSelection(productId: string, tankId: string, currentRows: PackRow[], excludeKey?: string, completed = 0) {
        const p = product(productId);
        if (!p || !tankId) return completed;
        const base = model.tankAvailableLiters.get(tankId) ?? tanks.find((tank) => tank.id === tankId)?.liters ?? 0;
        const usedByOthers = currentRows
            .filter((other) => other.key !== excludeKey && other.tankId === tankId)
            .reduce((sum, other) => {
                const otherProduct = product(other.productId);
                return sum + (otherProduct ? pendingUnits(other) * litersPerUnit(otherProduct) : 0);
            }, 0);
        const available = Math.max(0, base - usedByOthers);
        const additional = Math.floor((available + 1e-8) / litersPerUnit(p));
        const allowedAdditional = p.type === "crates" ? Math.min(MAX_CRATES_PER_RUN, additional) : additional;
        return completed + allowedAdditional;
    }

    function recommendationRemaining(rec: (typeof model.packagingRecommendation)[number], currentRows: PackRow[] = rows) {
        const alreadyPlanned = currentRows
            .filter((row) => row.productId === rec.productId && row.tankId === rec.tankId)
            .reduce((sum, row) => sum + row.quantity, 0);
        return Math.max(0, rec.quantity - alreadyPlanned);
    }

    function addManualRow() {
        if (!packStyle) return;

        const recommended = model.packagingRecommendation.find((rec) => {
            const p = product(rec.productId);
            return p && sameStyle(p.style, packStyle) && recommendationRemaining(rec) > 0;
        });

        if (recommended) {
            setRows((currentRows) => [...currentRows, {
                key: `rec:${recommended.id}`,
                source: "recommendation",
                tankId: recommended.tankId,
                productId: recommended.productId,
                quantity: recommendationRemaining(recommended, currentRows),
                completed: 0,
            }]);
            return;
        }

        const products = styleProducts(packStyle);
        const styleTanks = tanksForStyle(packStyle);
        const defaultProduct = products[0];
        const defaultTank = styleTanks[0];
        const key = `manual:${crypto.randomUUID()}`;
        setRows((currentRows) => {
            const quantity = defaultProduct && defaultTank
                ? defaultQuantityForSelection(defaultProduct.id, defaultTank.id, currentRows, key, 0)
                : 0;
            return [...currentRows, {
                key,
                source: "manual",
                tankId: defaultTank?.id ?? "",
                productId: defaultProduct?.id ?? "",
                quantity,
                completed: 0,
            }];
        });
    }

    function addRecommendation(recId: string) {
        const rec = model.packagingRecommendation.find((item) => item.id === recId);
        if (!rec) return;
        setRows((currentRows) => {
            const remaining = recommendationRemaining(rec, currentRows);
            if (remaining <= 0) return currentRows;
            return [...currentRows, {
                key: `rec:${rec.id}`,
                source: "recommendation",
                tankId: rec.tankId,
                productId: rec.productId,
                quantity: remaining,
                completed: 0,
            }];
        });
    }

    function maxQuantityForRow(row: PackRow) {
        return defaultQuantityForSelection(row.productId, row.tankId, rows, row.key, row.completed);
    }

    function updateRow(key: string, patch: Partial<PackRow>) {
        setRows((currentRows) => currentRows.map((row) => {
            if (row.key !== key) return row;
            const next = { ...row, ...patch };
            if (patch.tankId !== undefined || patch.productId !== undefined) {
                next.quantity = defaultQuantityForSelection(next.productId, next.tankId, currentRows, key, next.completed);
            }
            return next;
        }));
    }

    function removeRow(key: string) {
        setRows((currentRows) => currentRows.filter((row) => row.key !== key));
    }

    const modalRecommendations = packStyle
        ? model.packagingRecommendation.flatMap((rec) => {
            const p = product(rec.productId);
            if (!p || !sameStyle(p.style, packStyle)) return [];
            const remainingQuantity = recommendationRemaining(rec);
            return remainingQuantity > 0 ? [{ ...rec, remainingQuantity }] : [];
        })
        : [];

    function recomputeEmptyFlags(packaging: Plan[]) {
        const usedByTank = new Map<string, number>();
        return packaging.map((run) => {
            if (!run.tankId) return run;
            const p = product(run.productId);
            if (!p) return run;
            const base = model.tankAvailableLiters.get(run.tankId) ?? tanks.find((tank) => tank.id === run.tankId)?.liters ?? 0;
            const original = current.packaging.find((item) => item.id && run.id && item.id === run.id);
            const completed = original ? completedForPlan(original) : 0;
            const pending = Math.max(0, run.quantity - completed);
            const usedBefore = usedByTank.get(run.tankId) ?? 0;
            const usedNow = pending * litersPerUnit(p);
            usedByTank.set(run.tankId, usedBefore + usedNow);
            return { ...run, emptyTank: base - usedBefore - usedNow < 20 };
        });
    }

    async function savePackagingModal() {
        if (!packStyle || disabled || saving) return;
        setSaving(true);
        setModalMessage("");
        try {
            const untouched = current.packaging.filter((run) => {
                const p = product(run.productId);
                return !p || !sameStyle(p.style, packStyle);
            });
            const edited: Plan[] = [];

            for (const row of rows) {
                const p = product(row.productId);
                const tank = tanks.find((item) => item.id === row.tankId);
                if (!p || !tank || !sameStyle(p.style, packStyle) || !sameStyle(tank.style, packStyle)) continue;
                const max = maxQuantityForRow(row);
                const quantity = Math.max(row.completed, Math.min(row.quantity, max));
                if (quantity <= 0) continue;
                edited.push({
                    id: row.originalId ?? row.key.replace(/^rec:/, ""),
                    productId: p.id,
                    quantity,
                    tankId: tank.id,
                    tankNumber: String(tank.number),
                    source: row.source === "recommendation" ? "recommendation" : row.source === "manual" ? "manual" : current.packaging.find((run) => run.id === row.originalId)?.source,
                });
            }

            for (const original of current.packaging) {
                const p = product(original.productId);
                if (!p || !sameStyle(p.style, packStyle)) continue;
                const stillExists = rows.some((row) => row.originalId && row.originalId === original.id);
                if (stillExists) continue;
                const completed = completedForPlan(original);
                if (completed > 0) edited.push({ ...original, quantity: completed, emptyTank: false });
            }

            await saveWeek({
                ...current,
                packaging: recomputeEmptyFlags([...untouched, ...edited]),
                changeReason: `עריכת אריזות ${displayStyle(packStyle)}`,
            });
            setPackStyle(undefined);
            setRows([]);
        } catch (error) {
            setModalMessage(error instanceof Error ? error.message : "שמירת האריזות נכשלה");
        } finally {
            setSaving(false);
        }
    }

    const actualThisWeek = shipments.filter((shipment) => weekStart(shipment.date) === selectedWeek);
    const shipmentMatches = shipmentMatchesForPlans(historyPlans, shipments, settings.products)
        .filter((match) => match.week === selectedWeek);
    const matchedTrips = shipmentMatches.filter((match) => match.status !== "pending");
    const pendingTrips = shipmentMatches.filter((match) => match.status === "pending");

    return <>
        {actualThisWeek.length > 0 && <div className="bp-actual-shipment-status" role="status">
            <b>✓ {actualThisWeek.length === 1 ? "בוצע משלוח" : `בוצעו ${actualThisWeek.length} משלוחים`} השבוע</b>
            <span>
                {pendingTrips.length > 0
                    ? ` · נשאר ${pendingTrips.length === 1 ? "משלוח מתוכנן נוסף" : `${pendingTrips.length} משלוחים מתוכננים נוספים`}`
                    : " · ההמלצה חושבה מחדש אחרי מה שכבר נשלח"}
            </span>
            {matchedTrips.some((match) => match.status === "actual-different") && <small>לפחות משלוח אחד בוצע בהרכב שונה מההחלטה.</small>}
        </div>}

        <div onClickCapture={handleCapture} className="bp-enhanced-weekly-planner">
            <PlanningWeeklyRecommendations {...props} />
        </div>

        {packStyle !== undefined && <div className="bp-pack-modal-backdrop" role="presentation" onMouseDown={(event) => {
            if (event.target === event.currentTarget && !saving) setPackStyle(undefined);
        }}>
            <section className="bp-pack-modal" role="dialog" aria-modal="true" aria-label="עריכת אריזות">
                <header>
                    <div>
                        <small>שבוע {shortDate(selectedWeek)}–{shortDate(model.weekEnd)}</small>
                        <h3>{packStyle ? `אריזות · ${displayStyle(packStyle)}` : "בחר סגנון לעריכת אריזות"}</h3>
                    </div>
                    <button type="button" disabled={saving} onClick={() => setPackStyle(undefined)}>✕</button>
                </header>

                {packStyle === null ? <div className="bp-pack-style-picker">
                    {availableStyles.map((style) => <button type="button" key={style} onClick={() => chooseStyle(style)}>{displayStyle(style)}</button>)}
                </div> : <>
                    <div className="bp-pack-modal-summary">
                        <span>מיכלים מוצגים לפי FIFO — הוותיק ביותר ראשון.</span>
                        <button type="button" onClick={() => setPackStyle(null)}>החלף סגנון</button>
                    </div>

                    <div className="bp-pack-modal-rows">
                        {rows.map((row) => {
                            const p = product(row.productId);
                            const styleTanks = tanksForStyle(packStyle!);
                            const max = maxQuantityForRow(row);
                            return <div className="bp-pack-modal-row" key={row.key}>
                                <label>סוג אריזה
                                    <select value={row.productId} onChange={(event) => updateRow(row.key, { productId: event.target.value })}>
                                        {styleProducts(packStyle!).map((item) => <option key={item.id} value={item.id}>{item.type === "crates" ? "ארגזים" : "חביות"}</option>)}
                                    </select>
                                </label>
                                <label>מיכל
                                    <select value={row.tankId} onChange={(event) => updateRow(row.key, { tankId: event.target.value })}>
                                        <option value="">בחר מיכל</option>
                                        {styleTanks.map((tank) => <option key={tank.id} value={tank.id}>{tankLabel(tank, packStyle!)}</option>)}
                                    </select>
                                </label>
                                <label>כמות
                                    <TransientNumberInput
                                        min={row.completed}
                                        max={max}
                                        value={row.quantity}
                                        onNumberChange={(nextValue) => {
                                            const value = Math.max(row.completed, nextValue);
                                            updateRow(row.key, { quantity: Math.min(value, max) });
                                        }}
                                    />
                                    <small>{p?.type === "crates" ? "ארגזים" : "חביות"} · עד {fmt(max)}{row.completed > 0 ? ` · ${fmt(row.completed)} כבר בוצעו` : ""}</small>
                                </label>
                                <button type="button" className="bp-pack-remove" onClick={() => removeRow(row.key)}>{row.completed > 0 ? "השאר רק את מה שבוצע" : "הסר"}</button>
                            </div>;
                        })}
                        {!rows.length && <p className="bp-muted">אין כרגע החלטות אריזה לסגנון הזה.</p>}
                    </div>

                    {modalRecommendations.length > 0 && <div className="bp-pack-recommendations">
                        <b>המלצות זמינות</b>
                        {modalRecommendations.map((rec) => {
                            const p = product(rec.productId)!;
                            const tank = tanks.find((item) => item.id === rec.tankId);
                            return <button type="button" key={rec.id} onClick={() => addRecommendation(rec.id)}>
                                הוסף {fmt(rec.remainingQuantity)} {p.type === "crates" ? "ארגזים" : "חביות"}
                                {tank ? ` · מיכל ${tank.number} · ${tankSize(tank)} · FIFO ${rec.fifoRank}/${rec.fifoTotal}${rec.fifoRank === 1 && rec.fifoTotal > 1 ? " · הוותיק ביותר" : ""}` : ""}
                            </button>;
                        })}
                    </div>}

                    <button type="button" className="bp-pack-add" onClick={addManualRow}>+ הוסף אריזה</button>
                    {modalMessage && <p role="alert" className="bp-alert">{modalMessage}</p>}
                    <footer>
                        <button type="button" disabled={saving || disabled} onClick={savePackagingModal}>{saving ? "שומר…" : "שמור אריזות"}</button>
                        <button type="button" disabled={saving} onClick={() => setPackStyle(undefined)}>ביטול</button>
                    </footer>
                </>}
            </section>
        </div>}
    </>;
}
