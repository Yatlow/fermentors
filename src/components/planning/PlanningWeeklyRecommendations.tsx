import BeerLoader from "../general/Loading";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Fermentor } from "../../App";
import { beerStyleClass, type Pallet } from "../../SERVICES/cooler/Pallettypes ";
import { calcTruckSlots, MAX_TRUCK_SLOTS } from "../../SERVICES/cooler/truckCapacity";
import { markPlanningPallets } from "../../SERVICES/planning/picking";
import { expiryIso, palletQuantity, hasMarkedPallets } from "../../SERVICES/planning/shipmentPicking";
import { shipmentDecisionPickOptions } from "../../SERVICES/planning/shipmentDecisionPicking";
import {
    addDays,
    emptyWeek,
    litersPerUnit,
    sameStyle,
    weeklyDemand,
    weekNumber,
    weekStart,
    type Actual,
    type DeliveryPlan,
    type Holiday,
    type Plan,
    type Product,
    type Settings,
    type Tank,
    type WeekPlan,
} from "../../SERVICES/planning/planningEngine";
import { openRuns, shortDate, type ShipmentEvent } from "../../SERVICES/planning/dailyPlanner";
import { displayStyle, isCoreStyle, CORE_STYLES, formatPalletCount } from "../../SERVICES/planning/planningPresentation";
import { projectedPallets } from "../../SERVICES/planning/truckPlanner";
import { buildWeeklyPlanningModel } from "../../SERVICES/planning/weeklyPlanningModel";
import {
    brewLitersForSize,
    brewSizeLabel,
    type BrewSizeLabel,
} from "../../SERVICES/planning/productionCycle";

type Kind = "delivery" | "packaging" | "brew";
type BrewDraft = { style: string; liters: number };
type ManualPackDraft = { id: string; tankId: string; productId: string; quantity: number };
type ShipmentSelectionState = {
    selected: Pallet[];
    details: Array<{
        product: Product;
        itemType: Pallet["itemType"];
        requested: number;
        available: number;
        actualSelected: number;
        nominalCovered: number;
        missing: number;
        partialEquivalentGap: number;
    }>;
    slots: number;
    fefoScore: number;
    overage: number;
};

const fmt = (n: number) => Math.round(n).toLocaleString("he-IL");
const palletSize = (p: Product) => (p.type === "crates" ? 84 : 20);
const defaultWeek = (today: string) => addDays(weekStart(today), 7);
const coverLabel = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "—" : `${value.toFixed(1)} שב׳`;
const PARTIAL_CRATE_HINT_THRESHOLD = 60;
const MAX_MANUAL_CRATES = 252;
const BREW_SIZES: BrewSizeLabel[] = ["בודד", "כפול", "משולש"];

function palletLabel(quantity: number, p: Product) {
    return formatPalletCount(quantity / palletSize(p));
}

function unique(values: (string | number | null | undefined)[]) {
    return [...new Set(values.filter((v): v is string | number => v !== null && v !== undefined && String(v) !== ""))];
}

function coverageClass(value: number | null | undefined, target: number) {
    if (value === null || value === undefined || !Number.isFinite(value)) return "";
    if (value < target * 0.65) return "is-critical";
    if (value < target) return "is-warning";
    return "is-ok";
}

function pruneShipmentStates(states: ShipmentSelectionState[]) {
    const deduped = new Map<string, ShipmentSelectionState>();
    for (const state of states) {
        const key = state.selected.map((p) => p.id).sort().join("|");
        const existing = deduped.get(key);
        if (!existing || state.fefoScore < existing.fefoScore || (state.fefoScore === existing.fefoScore && state.slots < existing.slots)) {
            deduped.set(key, state);
        }
    }
    const all = [...deduped.values()];
    const byFefo = [...all].sort((a, b) => a.fefoScore - b.fefoScore || a.overage - b.overage || a.slots - b.slots).slice(0, 260);
    const byCapacity = [...all].sort((a, b) => a.slots - b.slots || a.fefoScore - b.fefoScore || a.overage - b.overage).slice(0, 120);
    return [...new Map([...byFefo, ...byCapacity].map((state) => [state.selected.map((p) => p.id).sort().join("|"), state])).values()];
}

export default function PlanningWeeklyRecommendations({
    settings, plans, tanks, sources, pallets, actuals, shipments, holidays, today, disabled, saveWeek, onOpenCoolerMap: _onOpenCoolerMap,
}: {
    settings: Settings;
    plans: WeekPlan[];
    tanks: Tank[];
    sources: Fermentor[];
    pallets: Pallet[];
    actuals: Actual[];
    shipments: ShipmentEvent[];
    holidays: Holiday[];
    today: string;
    disabled: boolean;
    saveWeek: (week: WeekPlan) => Promise<void>;
    onOpenCoolerMap?: () => void;
}) {
    const [week, setWeek] = useState(() => defaultWeek(today));
    const [editing, setEditing] = useState<Kind | null>(null);
    const [shipDraft, setShipDraft] = useState<Record<string, number>>({});
    const [packDraft, setPackDraft] = useState<Record<string, number>>({});
    const [manualPacks, setManualPacks] = useState<ManualPackDraft[]>([]);
    const [cancelledPackagingKeys, setCancelledPackagingKeys] = useState<Set<string>>(new Set());
    const [brewDraft, setBrewDraft] = useState<BrewDraft[]>([]);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const [markFeedback, setMarkFeedback] = useState("");
    const [shipmentError, setShipmentError] = useState<{ productId: string; text: string } | null>(null);
    const markFeedbackRef = useRef<HTMLParagraphElement>(null);

    useEffect(() => {
        if (!markFeedback) return;
        markFeedbackRef.current?.focus({ preventScroll: true });
        markFeedbackRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, [markFeedback]);

    const current = plans.find((w) => w.id === week) ?? { ...emptyWeek(week), maxRuns: settings.preferredRuns };
    const model = useMemo(
        () => buildWeeklyPlanningModel({ settings, pallets, tanks, plans, actuals, sources, today, week, holidays, shipments }),
        [settings, pallets, tanks, plans, actuals, sources, today, week, holidays, shipments],
    );
    const products = settings.products.filter((p) =>
        (p.monthly > 0 && isCoreStyle(p.style)) || current.deliveries?.some((d) => d.productId === p.id && d.quantity > 0),
    );
    const product = (id: string) => settings.products.find((p) => p.id === id);
    const holidaysThisWeek = holidays.filter((h) => h.date >= week && h.date <= model.weekEnd);
    const shipmentRec = new Map(model.shipmentRecommendation.map((r) => [r.productId, r]));

    const currentOpenPackaging = useMemo(
        () => openRuns(plans, settings.products, actuals).filter((r) => r.week === week && r.remaining > 0),
        [plans, settings.products, actuals, week],
    );
    const visiblePackagingRecommendations = model.packagingRecommendation.filter((rec) =>
        !currentOpenPackaging.some((saved) => saved.tankId === rec.tankId && saved.productId === rec.productId),
    );
    const allPackagingRecByProduct = new Map<string, number>();
    for (const r of model.packagingRecommendation) {
        allPackagingRecByProduct.set(r.productId, (allPackagingRecByProduct.get(r.productId) ?? 0) + r.quantity);
    }

    const currentShipmentQty = (id: string) => (current.deliveries ?? [])
        .filter((d) => d.productId === id)
        .reduce((s, d) => s + d.quantity, 0);
    const currentPackagingQty = (id: string) => current.packaging
        .filter((r) => r.productId === id)
        .reduce((s, r) => s + r.quantity, 0);
    const currentPackagingRemainingQty = (id: string) => currentOpenPackaging
        .filter((r) => r.productId === id)
        .reduce((s, r) => s + r.remaining, 0);

    function openRunForSavedPlan(run: Plan) {
        return run.id
            ? currentOpenPackaging.find((r) => r.id === run.id)
            : currentOpenPackaging.find((r) => r.productId === run.productId && r.tankId === run.tankId);
    }

    function completedQty(run: Plan) {
        const open = openRunForSavedPlan(run);
        return Math.max(0, run.quantity - (open?.remaining ?? run.quantity));
    }

    function effectiveSavedRemaining(run: Plan, targetQuantity: number) {
        return Math.max(0, targetQuantity - completedQty(run));
    }

    function shipmentSlots(draft: Record<string, number>) {
        const manifest = settings.products.flatMap((p) =>
            projectedPallets(p, Math.max(0, draft[p.id] ?? 0), `weekly-edit:${week}:${p.id}`).map((x) => x.pallet),
        );
        if (!manifest.length) return 0;
        try { return calcTruckSlots(manifest); } catch { return Infinity; }
    }

    const sameWeekPackagingQty = (p: Product) => currentPackagingRemainingQty(p.id);
    const safeShipmentQty = (p: Product) => Math.max(0, model.weekStartRows.get(p.id)?.breweryUnits ?? 0);

    function maxShipmentQty(p: Product) {
        const units = safeShipmentQty(p) + sameWeekPackagingQty(p);
        return units > 0 ? Math.ceil(units / palletSize(p)) * palletSize(p) : 0;
    }

    function hasPackagingSource(p: Product) {
        return tanks.some((tank) =>
            tank.ready <= model.weekEnd &&
            sameStyle(tank.style, p.style) &&
            (model.tankAvailableLiters.get(tank.id) ?? tank.liters) >= 20,
        );
    }

    function packagingDependencyQty(p: Product, qty: number) {
        const fromExpectedBrewery = safeShipmentQty(p);
        return Math.max(0, Math.min(qty - fromExpectedBrewery, sameWeekPackagingQty(p)));
    }

    function expectedShipmentCover(p: Product) {
        return model.weekStartRows.get(p.id)?.tempoCover ?? null;
    }

    function shipmentCoverAfter(p: Product, nominalQty: number) {
        const state = model.weekStartRows.get(p.id);
        const demand = weeklyDemand(p);
        if (!state || state.tempoUnits === null || demand <= 0) return null;
        const physicallyExpected = Math.max(0, state.breweryUnits + sameWeekPackagingQty(p));
        const deliverable = Math.min(Math.max(0, nominalQty), physicallyExpected);
        return (state.tempoUnits + deliverable) / demand;
    }

    function draftShipmentCover(p: Product) {
        return shipmentCoverAfter(p, shipDraft[p.id] ?? 0);
    }

    function shipmentRecommendationCover(p: Product) {
        return shipmentCoverAfter(p, shipmentRec.get(p.id)?.quantity ?? 0);
    }

    function partialCrateHint(p: Product) {
        if (p.type !== "crates") return null;
        return pallets
            .filter((x) => x.zone === "cooler" && !x.markedForShipment && x.itemType === "crates" && sameStyle(x.beerStyle, p.style))
            .filter((x) => palletQuantity(x) > 0 && palletQuantity(x) < PARTIAL_CRATE_HINT_THRESHOLD)
            .sort((a, b) => palletQuantity(a) - palletQuantity(b))[0] ?? null;
    }

    function packagingRecommendationCover(p: Product) {
        const before = model.rows.afterShipment.get(p.id);
        const quantity = allPackagingRecByProduct.get(p.id) ?? 0;
        return !before || before.tempoUnits === null || !quantity || weeklyDemand(p) <= 0
            ? null
            : (before.tempoUnits + before.breweryUnits + quantity) / weeklyDemand(p);
    }

    function recommendationTankLabel(productId: string) {
        const values = unique(model.packagingRecommendation.filter((r) => r.productId === productId).map((r) => r.tankNumber));
        return values.length ? `מיכל ${values.join(", ")}` : "";
    }

    function decisionTankLabel(productId: string) {
        const values = unique(currentOpenPackaging.filter((r) => r.productId === productId).map((r) =>
            r.tankNumber ?? tanks.find((t) => t.id === r.tankId)?.number,
        ));
        return values.length ? `מיכל ${values.join(", ")}` : "";
    }

    const shipmentProducts = [...products].sort((a, b) =>
        (expectedShipmentCover(a) ?? Infinity) - (expectedShipmentCover(b) ?? Infinity),
    );
    const packagingProducts = [...products].sort((a, b) =>
        (model.rows.afterShipment.get(a.id)?.totalCover ?? Infinity) - (model.rows.afterShipment.get(b.id)?.totalCover ?? Infinity),
    );

    function beginEdit(kind: Kind) {
        setEditing(kind);
        setMessage("");
        setShipmentError(null);
        if (kind === "delivery") {
            setShipDraft(Object.fromEntries(products.map((p) => [p.id, currentShipmentQty(p.id)])));
        } else if (kind === "packaging") {
            setPackDraft(Object.fromEntries(current.packaging.map((r) => [r.id ?? `${r.productId}:${r.tankId}`, r.quantity])));
            setManualPacks([]);
            setCancelledPackagingKeys(new Set());
        } else {
            setBrewDraft(current.brews.map((b) => ({ style: b.style, liters: b.liters })));
        }
    }

    function stepShipment(p: Product, delta: number) {
        setShipDraft((prev) => {
            const proposed = Math.max(0, (prev[p.id] ?? 0) + delta * palletSize(p));
            if (delta > 0 && proposed > maxShipmentQty(p)) {
                setShipmentError({ productId: p.id, text: `אין מלאי או תכנון שמתאימים לביצוע משלוח פריט זה השבוע.` });
                return prev;
            }
            const next = { ...prev, [p.id]: proposed };
            if (delta > 0 && shipmentSlots(next) > MAX_TRUCK_SLOTS) {
                setMessage(`המשאית מלאה — מקסימום ${MAX_TRUCK_SLOTS} מקומות.`);
                return prev;
            }
            setMessage("");
            setShipmentError(null);
            return next;
        });
    }

    async function saveShipment() {
        if (disabled || busy) return;
        const slots = shipmentSlots(shipDraft);
        if (slots > MAX_TRUCK_SLOTS || products.some((p) => (shipDraft[p.id] ?? 0) > maxShipmentQty(p))) {
            return setMessage("המלאי או הקיבולת השתנו. יש לעדכן את החלטת המשלוח לפני השמירה.");
        }
        const packagingDependent = products.some((p) => packagingDependencyQty(p, shipDraft[p.id] ?? 0) > 0);
        setBusy(true);
        setMessage("");
        try {
            const date = addDays(week, 1);
            const deliveries: DeliveryPlan[] = products.flatMap((p) => {
                const quantity = Math.max(0, shipDraft[p.id] ?? 0);
                return quantity ? [{ id: crypto.randomUUID(), productId: p.id, quantity, dispatchDate: date, arrivalDate: date, truckId: `truck:${week}`, pallets: [] }] : [];
            });
            await saveWeek({ ...current, deliveries, deliveryDates: deliveries.length ? [date] : [], changeReason: "עדכון החלטת משלוח שבועית" });
            setEditing(null);
            setMessage(`${slots > 0 && slots < MAX_TRUCK_SLOTS ? `נשמר משלוח חלקי ${slots}/${MAX_TRUCK_SLOTS}.` : "החלטת המשלוח נשמרה."}${packagingDependent ? " ⚠️ חלק מהמלאי ייארז באותו שבוע." : ""}`);
        } catch (e) {
            setMessage(e instanceof Error ? e.message : "שמירת המשלוח נכשלה");
        } finally {
            setBusy(false);
        }
    }

    async function acceptShipmentRecommendation() {
        const date = addDays(week, 1);
        const deliveries: DeliveryPlan[] = products.flatMap((p) => {
            const quantity = shipmentRec.get(p.id)?.quantity ?? 0;
            return quantity ? [{ id: crypto.randomUUID(), productId: p.id, quantity, dispatchDate: date, arrivalDate: date, truckId: `truck:${week}`, pallets: [] }] : [];
        });
        setBusy(true);
        setMessage("");
        try {
            await saveWeek({ ...current, deliveries, deliveryDates: deliveries.length ? [date] : [], changeReason: "אישור המלצת משלוח שבועית" });
            setMessage(current.deliveries?.length ? "החלטת המשלוח הקיימת הוחלפה בהמלצה." : "המלצת המשלוח נשמרה כהחלטה חדשה.");
        } catch (e) {
            setMessage(e instanceof Error ? e.message : "שמירת המשלוח נכשלה");
        } finally {
            setBusy(false);
        }
    }

    const nearestShipmentWeek = plans
        .filter((w) => w.id >= weekStart(today) && (w.deliveries ?? []).some((d) => d.quantity > 0))
        .sort((a, b) => a.id.localeCompare(b.id))[0]?.id;
    const isNearShipmentWeek = week === weekStart(today) || week === addDays(weekStart(today), 7);
    const markingBlocked = hasMarkedPallets(pallets);
    const canOfferMapMarking = isNearShipmentWeek && nearestShipmentWeek === week && (current.deliveries ?? []).some((d) => d.quantity > 0);

    async function markShipmentOnCoolerMap() {
        if (!canOfferMapMarking || disabled || busy) return;
        if (markingBlocked) {
            return setMarkFeedback("כבר יש משטחים מסומנים במפת המקרר. יש להשלים את המשלוח או לבטל את הסימון לפני סימון מתכנון.");
        }

        setBusy(true);
        setMarkFeedback("בודק התאמה של המשטחים להחלטת המשלוח…");
        try {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            if (current.deliveries?.some((d) => d.quantity > 0 && !product(d.productId))) {
                return setMarkFeedback("ההחלטה כוללת מק״ט לא מוכר. יש לתקן את ההחלטה לפני הסימון.");
            }

            const shipmentLines = products
                .map((product) => ({ product, requested: currentShipmentQty(product.id) }))
                .filter((line) => line.requested > 0)
                .map((line) => {
                    const candidates = pallets.filter((pallet) =>
                        pallet.zone === "cooler" && !pallet.markedForShipment &&
                        pallet.itemType === line.product.type &&
                        sameStyle(pallet.beerStyle, line.product.style) &&
                        (!!expiryIso(pallet.expiryDateStr) && expiryIso(pallet.expiryDateStr)! >= today),
                    );
                    const available = candidates.reduce((sum, pallet) => sum + palletQuantity(pallet), 0);
                    const options = shipmentDecisionPickOptions(candidates, line.requested, palletSize(line.product));
                    return { ...line, candidates, available, options };
                });

            let states: ShipmentSelectionState[] = [{ selected: [], details: [], slots: 0, fefoScore: 0, overage: 0 }];
            for (const line of shipmentLines) {
                const nextStates: ShipmentSelectionState[] = [];
                for (const state of states) {
                    for (const option of line.options) {
                        const combined = [...state.selected, ...option.selected];
                        let slots: number;
                        try { slots = calcTruckSlots(combined); } catch { continue; }
                        if (slots > MAX_TRUCK_SLOTS) continue;
                        nextStates.push({
                            selected: combined,
                            details: [...state.details, {
                                product: line.product,
                                itemType: option.selected[0]?.itemType ?? line.product.type,
                                requested: line.requested,
                                available: line.available,
                                actualSelected: option.actualTotal,
                                nominalCovered: option.nominalCovered,
                                missing: option.missingNominal,
                                partialEquivalentGap: option.partialEquivalentGap,
                            }],
                            slots,
                            fefoScore: state.fefoScore + option.fefoScore,
                            overage: state.overage + option.overage,
                        });
                    }
                }
                states = pruneShipmentStates(nextStates);
                if (!states.length) {
                    return setMarkFeedback(`לא נמצאה קומבינציית משטחים פיזית שנכנסת ב־${MAX_TRUCK_SLOTS} מקומות במשאית.`);
                }
            }

            const best = [...states].sort((a, b) =>
                a.details.reduce((sum, d) => sum + d.missing, 0) - b.details.reduce((sum, d) => sum + d.missing, 0) ||
                a.fefoScore - b.fefoScore ||
                a.overage - b.overage ||
                a.slots - b.slots ||
                a.selected.length - b.selected.length,
            )[0];
            if (!best) return setMarkFeedback("לא נמצאה בחירה שמתאימה למגבלות המשאית.");

            const palletIds = [...new Set(best.selected.map((p) => p.id))];
            const missingNotes = best.details.filter((detail) => detail.missing > 0).map((detail) =>
                `${displayStyle(detail.product.style)} (${detail.itemType === "crates" ? "בקבוקים" : "חביות"}): חסר עוד ${fmt(detail.missing)} ${detail.itemType === "crates" ? "ארגזים" : "חביות"} מבחינת מקומות משטח.`,
            );
            const partialNotes = best.details.filter((detail) => detail.partialEquivalentGap > 0).map((detail) =>
                `${displayStyle(detail.product.style)} (${detail.itemType === "crates" ? "בקבוקים" : "חביות"}): משטח חלקי נספר כמקום משטח מלא; בפועל סומנו ${fmt(detail.actualSelected)} מתוך ${fmt(detail.nominalCovered)} ${detail.itemType === "crates" ? "ארגזים" : "חביות"} מתוכננים.`,
            );
            const smallPartialNotes = best.selected
                .filter((p) => p.itemType === "crates" && palletQuantity(p) < PARTIAL_CRATE_HINT_THRESHOLD)
                .map((p) => `${displayStyle(p.beerStyle)} (בקבוקים): סומן משטח חלקי של ${fmt(palletQuantity(p))} ארגזים — ייתכן שכדאי להחליף אותו ידנית במפת המקרר.`);

            if (best.selected.length) {
                setMarkFeedback("מסמן את המשטחים הזמינים במפת המקרר…");
                await markPlanningPallets(best.selected);
            }
            const result = best.selected.length
                ? `סומנו ${formatPalletCount(palletIds.length)} זמינים למשלוח (${best.slots}/${MAX_TRUCK_SLOTS} מקומות במשאית).`
                : "אין כרגע משטחים מתאימים לסימון אוטומטי.";
            const notes = [...missingNotes, ...partialNotes, ...smallPartialNotes];
            setMarkFeedback(`${result}${notes.length ? ` ${notes.join(" · ")}` : ""}`);
        } catch (e) {
            setMarkFeedback(e instanceof Error ? e.message : "סימון המשטחים במפה נכשל");
        } finally {
            setBusy(false);
        }
    }

    function allDraftPackLines() {
        const lines: { tankId?: string; productId: string; quantity: number }[] = [];
        for (const r of current.packaging) {
            const key = r.id ?? `${r.productId}:${r.tankId}`;
            if (cancelledPackagingKeys.has(key)) continue;
            const quantity = effectiveSavedRemaining(r, Math.max(0, packDraft[key] ?? r.quantity));
            if (quantity) lines.push({ tankId: r.tankId, productId: r.productId, quantity });
        }
        for (const r of visiblePackagingRecommendations) {
            const quantity = Math.max(0, packDraft[`rec:${r.id}`] ?? 0);
            if (quantity) lines.push({ tankId: r.tankId, productId: r.productId, quantity });
        }
        for (const r of manualPacks) {
            if (r.tankId && r.productId && r.quantity > 0) lines.push(r);
        }
        return lines;
    }

    function remainingLitersForTank(tankId: string, excludeManualId?: string) {
        const base = model.tankAvailableLiters.get(tankId) ?? tanks.find((t) => t.id === tankId)?.liters ?? 0;
        const used = [
            ...current.packaging.map((r) => {
                const key = r.id ?? `${r.productId}:${r.tankId}`;
                return {
                    id: `saved:${key}`,
                    tankId: r.tankId,
                    productId: r.productId,
                    quantity: cancelledPackagingKeys.has(key)
                        ? 0
                        : effectiveSavedRemaining(r, Math.max(0, packDraft[key] ?? r.quantity)),
                };
            }),
            ...visiblePackagingRecommendations.map((r) => ({ id: `rec:${r.id}`, tankId: r.tankId, productId: r.productId, quantity: Math.max(0, packDraft[`rec:${r.id}`] ?? 0) })),
            ...manualPacks.map((r) => ({ ...r, id: `manual:${r.id}` })),
        ].filter((r) => r.tankId === tankId && (!excludeManualId || r.id !== `manual:${excludeManualId}`));
        return Math.max(0, base - used.reduce((sum, r) => {
            const p = product(r.productId);
            return sum + (p ? r.quantity * litersPerUnit(p) : 0);
        }, 0));
    }

    function manualProductsForTank(tankId: string) {
        const t = tanks.find((x) => x.id === tankId);
        return t ? products.filter((p) => sameStyle(p.style, t.style)) : [];
    }

    function manualMaxQuantity(p: Product | undefined, tankId: string, manualId: string) {
        if (!p || !tankId) return 0;
        const unitsFromTank = Math.floor(remainingLitersForTank(tankId, manualId) / litersPerUnit(p));
        return p.type === "crates" ? Math.min(MAX_MANUAL_CRATES, unitsFromTank) : unitsFromTank;
    }

    const addManualPack = () => setManualPacks((rows) => [...rows, { id: crypto.randomUUID(), tankId: "", productId: "", quantity: 0 }]);

    function changeManualTank(id: string, tankId: string) {
        setManualPacks((rows) => rows.map((r) => {
            if (r.id !== id) return r;
            const p = manualProductsForTank(tankId)[0];
            const next = { ...r, tankId, productId: p?.id ?? "", quantity: 0 };
            return { ...next, quantity: manualMaxQuantity(p, tankId, id) };
        }));
    }

    function changeManualProduct(id: string, productId: string) {
        setManualPacks((rows) => rows.map((r) => {
            if (r.id !== id) return r;
            const p = product(productId);
            return { ...r, productId, quantity: manualMaxQuantity(p, r.tankId, id) };
        }));
    }

    function draftPackagingCover(p: Product) {
        const before = model.rows.afterShipment.get(p.id);
        if (!before || before.tempoUnits === null || weeklyDemand(p) <= 0) return null;
        const planned = allDraftPackLines().filter((r) => r.productId === p.id).reduce((s, r) => s + r.quantity, 0);
        return (before.tempoUnits + before.breweryUnits + planned) / weeklyDemand(p);
    }

    function recomputeEmptyTankFlags(lines: Plan[]) {
        const usedByTank = new Map<string, number>();
        return lines.map((run) => {
            if (!run.tankId) return run;
            const p = product(run.productId);
            if (!p) return run;
            const base = model.tankAvailableLiters.get(run.tankId) ?? tanks.find((t) => t.id === run.tankId)?.liters ?? 0;
            const existing = current.packaging.find((saved) =>
                saved.id && run.id ? saved.id === run.id : saved.productId === run.productId && saved.tankId === run.tankId,
            );
            const futureQuantity = existing ? effectiveSavedRemaining(existing, run.quantity) : run.quantity;
            const usedBefore = usedByTank.get(run.tankId) ?? 0;
            const usedNow = futureQuantity * litersPerUnit(p);
            usedByTank.set(run.tankId, usedBefore + usedNow);
            return { ...run, emptyTank: base - usedBefore - usedNow < 20 };
        });
    }

    async function savePackaging() {
        setBusy(true);
        setMessage("");
        try {
            const packaging: Plan[] = current.packaging.flatMap((r) => {
                const key = r.id ?? `${r.productId}:${r.tankId}`;
                const completed = completedQty(r);
                if (cancelledPackagingKeys.has(key)) {
                    return completed > 0 ? [{ ...r, quantity: completed }] : [];
                }
                const quantity = Math.max(completed, packDraft[key] ?? r.quantity);
                return quantity > 0 ? [{ ...r, quantity }] : [];
            });

            for (const rec of visiblePackagingRecommendations) {
                const quantity = Math.max(0, packDraft[`rec:${rec.id}`] ?? 0);
                if (!quantity) continue;
                packaging.push({
                    id: rec.id,
                    productId: rec.productId,
                    quantity,
                    tankId: rec.tankId,
                    tankNumber: rec.tankNumber,
                    source: "recommendation",
                });
            }

            for (const manual of manualPacks) {
                if (!manual.tankId || !manual.productId || manual.quantity <= 0) continue;
                const t = tanks.find((x) => x.id === manual.tankId)!;
                const p = product(manual.productId)!;
                const base = model.tankAvailableLiters.get(t.id) ?? t.liters;
                const used = packaging.filter((x) => x.tankId === t.id).reduce((sum, x) => {
                    const usedProduct = product(x.productId);
                    return sum + (usedProduct ? effectiveSavedRemaining(x, x.quantity) * litersPerUnit(usedProduct) : 0);
                }, 0);
                const maxByTank = Math.floor(Math.max(0, base - used) / litersPerUnit(p));
                const maxAllowed = p.type === "crates" ? Math.min(MAX_MANUAL_CRATES, maxByTank) : maxByTank;
                const quantity = Math.min(manual.quantity, maxAllowed);
                if (!quantity) continue;
                packaging.push({
                    id: manual.id,
                    productId: p.id,
                    quantity,
                    tankId: t.id,
                    tankNumber: String(t.number),
                    source: "manual",
                });
            }

            await saveWeek({ ...current, packaging: recomputeEmptyTankFlags(packaging), changeReason: "עדכון החלטת אריזה שבועית" });
            setEditing(null);
            setManualPacks([]);
            setCancelledPackagingKeys(new Set());
            setMessage("החלטת האריזה נשמרה.");
        } catch (e) {
            setMessage(e instanceof Error ? e.message : "שמירת האריזה נכשלה");
        } finally {
            setBusy(false);
        }
    }

    async function acceptPackagingRecommendation() {
        const additions: Plan[] = visiblePackagingRecommendations.map((r) => ({
            id: r.id,
            productId: r.productId,
            quantity: r.quantity,
            tankId: r.tankId,
            tankNumber: r.tankNumber,
            source: "recommendation",
        }));
        if (!additions.length) return;
        setBusy(true);
        setMessage("");
        try {
            const packaging = current.packaging.length ? [...current.packaging, ...additions] : additions;
            await saveWeek({
                ...current,
                packaging: recomputeEmptyTankFlags(packaging),
                changeReason: current.packaging.length ? "הוספת המלצות אריזה חסרות" : "אישור המלצת אריזה שבועית",
            });
            setMessage(current.packaging.length ? "המלצות האריזה החסרות נוספו להחלטה הקיימת." : "המלצת האריזה נשמרה כהחלטה חדשה.");
        } catch (e) {
            setMessage(e instanceof Error ? e.message : "שמירת האריזה נכשלה");
        } finally {
            setBusy(false);
        }
    }

    async function saveBrews() {
        setBusy(true);
        setMessage("");
        try {
            const brews = brewDraft
                .filter((b) => b.style && b.liters > 0)
                .map((b) => ({ id: crypto.randomUUID(), style: b.style, liters: b.liters, tankId: "", date: addDays(week, 1) }));
            await saveWeek({ ...current, brews, changeReason: "עדכון החלטת בישול שבועית" });
            setEditing(null);
            setMessage(brews.length > model.brewTankCapacity || brewDraftExceedsSizeCapacity(brewDraft)
                ? "החלטת הבישול נשמרה, אך לפחות אחד מסוגי הבישול אינו תואם לקיבולת המיכלים הצפויה השבוע."
                : "החלטת הבישול נשמרה.");
        } catch (e) {
            setMessage(e instanceof Error ? e.message : "שמירת הבישול נכשלה");
        } finally {
            setBusy(false);
        }
    }

    async function acceptBrewRecommendations() {
        if (!model.brewRecommendations.length) return;
        const additions = model.brewRecommendations.map((b) => ({
            id: crypto.randomUUID(), style: b.style, liters: b.liters, tankId: "", date: addDays(week, 1),
        }));
        setBusy(true);
        setMessage("");
        try {
            await saveWeek({ ...current, brews: [...current.brews, ...additions], changeReason: "הוספת המלצות בישול שבועיות" });
            setMessage(current.brews.length ? "המלצות הבישול נוספו להחלטות הקיימות." : "המלצות הבישול נשמרו כהחלטות חדשות. את המיכלים והימים תשבץ בלוח העבודה.");
        } catch (e) {
            setMessage(e instanceof Error ? e.message : "שמירת הבישולים נכשלה");
        } finally {
            setBusy(false);
        }
    }

    function brewSizeCapacity(size: BrewSizeLabel) {
        return model.brewTankOptions.filter((option) => option.sizeLabel === size).length;
    }

    function brewSizeCount(rows: BrewDraft[], size: BrewSizeLabel, excludeIndex = -1) {
        return rows.filter((row, index) => index !== excludeIndex && brewSizeLabel(row.liters) === size).length;
    }

    function canUseBrewSize(rows: BrewDraft[], size: BrewSizeLabel, excludeIndex = -1) {
        return brewSizeCount(rows, size, excludeIndex) < brewSizeCapacity(size);
    }

    function brewDraftExceedsSizeCapacity(rows: BrewDraft[]) {
        return BREW_SIZES.some((size) => brewSizeCount(rows, size) > brewSizeCapacity(size));
    }

    function addBrew() {
        setBrewDraft((rows) => {
            const recommendation = model.brewRecommendations[rows.length];
            const recommendedSize = recommendation?.sizeLabel;
            const size = recommendedSize && canUseBrewSize(rows, recommendedSize)
                ? recommendedSize
                : BREW_SIZES.find((candidate) => canUseBrewSize(rows, candidate)) ?? recommendedSize ?? "כפול";
            const style = recommendation?.style ?? CORE_STYLES[0];
            return [...rows, { style, liters: brewLitersForSize(style, size) }];
        });
    }

    function changeBrewStyle(index: number, style: string) {
        setBrewDraft((rows) => rows.map((row, i) => i === index
            ? { style, liters: brewLitersForSize(style, brewSizeLabel(row.liters)) }
            : row));
    }

    function changeBrewSize(index: number, size: BrewSizeLabel) {
        setBrewDraft((rows) => {
            if (!canUseBrewSize(rows, size, index)) return rows;
            return rows.map((row, i) => i === index
                ? { ...row, liters: brewLitersForSize(row.style, size) }
                : row);
        });
    }

    function pushBrewRecommendationsToDraft() {
        if (!model.brewRecommendations.length) return;
        setEditing("brew");
        setBrewDraft([
            ...current.brews.map((b) => ({ style: b.style, liters: b.liters })),
            ...model.brewRecommendations.map((b) => ({ style: b.style, liters: b.liters })),
        ]);
    }

    function styleCover(style: string) {
        const values = [...model.rows.afterPackaging.values()]
            .filter((r) => sameStyle(r.product.style, style))
            .map((r) => r.totalCover)
            .filter((v): v is number => v !== null);
        return values.length ? Math.min(...values) : null;
    }

    const usedShipSlots = shipmentSlots(editing === "delivery"
        ? shipDraft
        : Object.fromEntries(products.map((p) => [p.id, currentShipmentQty(p.id)])));
    const packagingDependentLines = products
        .map((p) => ({ p, quantity: editing === "delivery" ? shipDraft[p.id] ?? 0 : currentShipmentQty(p.id) }))
        .map((x) => ({ ...x, dependency: packagingDependencyQty(x.p, x.quantity) }))
        .filter((x) => x.dependency > 0);
    const selectedWeekText = `שבוע ${weekNumber(week)} · ${shortDate(week)}–${shortDate(model.weekEnd)}`;
    const packagingDecisionCount = currentOpenPackaging.length;
    const packagingRecommendationCount = model.packagingRecommendation.length;
    const plannedBrewRows = editing === "brew"
        ? brewDraft
        : current.brews.map((b) => ({ style: b.style, liters: b.liters }));
    const plannedBrewCount = plannedBrewRows.length;
    const brewCapacityWarning = plannedBrewCount > model.brewTankCapacity || brewDraftExceedsSizeCapacity(plannedBrewRows);

    return <section className="bp-weekly-planner">
        {busy && <BeerLoader overlay message="מעדכן את התכנון…" />}
        <div className="bp-week-picker">
            {Array.from({ length: 8 }, (_, i) => addDays(weekStart(today), i * 7)).map((w) =>
                <button key={w} aria-pressed={w === week} disabled={busy} onClick={() => {
                    setWeek(w);
                    setEditing(null);
                    setMessage("");
                    setMarkFeedback("");
                    setCancelledPackagingKeys(new Set());
                }}>שבוע {weekNumber(w)}<small>{shortDate(w)}</small></button>)}
        </div>
        <div className="bp-week-sticky">
            <b>{selectedWeekText}</b>
            <small>{editing ? `עורך: ${editing === "delivery" ? "משלוח" : editing === "packaging" ? "אריזה" : "בישול"}` : "תכנון שבועי"}</small>
        </div>
        {holidaysThisWeek.length > 0 && <div className="bp-week-events"><b>חגים ואירועים השבוע</b>{holidaysThisWeek.map((h) => <span key={`${h.date}:${h.title}`}>{shortDate(h.date)} · {h.title}</span>)}</div>}
        {message && <p role="status" className="bp-week-message">{message}</p>}

        <div className="bp-week-recommendations">
            <article className="bp-week-rec-card bp-week-shipment-card">
                <header>
                    <div><small>1 · משלוח · {selectedWeekText}</small><h3>מה לשלוח השבוע</h3></div>
                    <b>משלוח: {Number.isFinite(usedShipSlots) ? usedShipSlots : 0}/{MAX_TRUCK_SLOTS} מקומות</b>
                </header>
                <p className="bp-rec-principle">
                    ● המק"טים ממוינים לפי הכיסוי הנמוך ביותר.<br />
                    ● משטח חלקי יכול לייצג מקום משטח מלא כשאין מספיק מלאי למשטח מלא; הכמות הפיזית נשמרת במפת המקרר.
                </p>
                <div className="bp-saved-summary">
                    <b>משלוח{editing === "delivery" ? " בעריכה" : ""}: {Number.isFinite(usedShipSlots) ? usedShipSlots : 0}/{MAX_TRUCK_SLOTS} מקומות בשימוש</b>
                    {" · "}נותרו {Number.isFinite(usedShipSlots) ? Math.max(0, MAX_TRUCK_SLOTS - Number(usedShipSlots)) : 0}
                </div>
                {packagingDependentLines.length > 0 && <div className="bp-same-week-warning" role="alert">
                    <b>⚠️ משלוח תלוי באריזה של אותו שבוע</b><span>יש לארוז לפני יום שני.</span>
                    {packagingDependentLines.map(({ p, dependency }) =>
                        <small key={p.id}>{palletLabel(dependency, p)} {displayStyle(p.style)} עדיין תלויים באריזה השבוע.</small>)}
                </div>}
                <div className="bp-actions">
                    {editing === "delivery" ? <>
                        <button disabled={busy} onClick={saveShipment}>שמירת המשלוח</button>
                        <button onClick={() => setEditing(null)}>ביטול</button>
                    </> : <>
                        <button className={(current.deliveries ?? []).length ? "bp-action-warning" : ""} disabled={disabled || busy || !model.shipmentCanFillTruck} onClick={acceptShipmentRecommendation}>
                            {(current.deliveries ?? []).length ? "מחק נתונים ואשר המלצה" : "צור משלוח מההמלצה"}
                        </button>
                        <button disabled={disabled || busy} onClick={() => beginEdit("delivery")}>עריכת המשלוח</button>
                    </>}
                </div>

                {!model.shipmentCanFillTruck && model.shipmentSlots > 0 &&
                    <p className="bp-alert">אין כרגע מספיק מלאי צפוי כדי להרכיב משאית מלאה. אפשר לשמור משלוח חלקי ידנית.</p>}

                {canOfferMapMarking && <div className="bp-map-marking">
                    <button type="button" disabled={disabled || busy || markingBlocked || editing === "delivery"} onClick={markShipmentOnCoolerMap}>סמן את המשלוח במפת המקרר</button>
                    {markFeedback && <p ref={markFeedbackRef} tabIndex={-1} role="status" aria-live="polite" className="bp-shipment-feedback">{markFeedback}</p>}
                    {markingBlocked && <p role="status">כבר יש משטחים מסומנים במפת המקרר. יש להשלים את המשלוח או לבטל את הסימון לפני סימון מתכנון.</p>}
                </div>}

                <div className="bp-shipment-plan-table">
                    <div className="bp-shipment-plan-head"><span>מק"ט</span><span>כיסוי צפוי בטמפו</span><span>המלצת מערכת</span><span>החלטה לביצוע</span></div>
                    {shipmentProducts.map((p) => {
                        const rec = shipmentRec.get(p.id);
                        const projected = model.weekStartRows.get(p.id);
                        const decided = currentShipmentQty(p.id);
                        const draftQty = editing === "delivery" ? shipDraft[p.id] ?? 0 : decided;
                        const expectedCover = projected?.tempoCover ?? null;
                        const shownAfter = editing === "delivery" ? draftShipmentCover(p) : shipmentCoverAfter(p, decided);
                        const recAfter = shipmentRecommendationCover(p);
                        const dependency = packagingDependencyQty(p, draftQty);
                        const decidedSlots = shipmentSlots({ [p.id]: draftQty });
                        const decidedSlotsLabel = Number.isFinite(decidedSlots) ? `${decidedSlots} מקומות` : "חורג ממגבלת הגובה";
                        const partial = draftQty > 0 ? partialCrateHint(p) : null;
                        const unavailable = maxShipmentQty(p) <= 0 && decided <= 0;
                        return <div className={`bp-shipment-plan-row ${coverageClass(expectedCover, settings.targetWeeks)} ${unavailable ? "is-unavailable" : ""}`} key={p.id}>
                            <span className={`bp-week-sku ${beerStyleClass(p.style).className}`}><b>{displayStyle(p.style)}</b><small>{p.type === "crates" ? "ארגזים" : "חביות"}</small></span>
                            <span>{coverLabel(expectedCover)}</span>
                            <span>
                                {rec ? formatPalletCount(rec.pallets) : "—"}
                                {rec && <small>{rec.slots} מקומות</small>}
                                {rec && <small>יגדיל כיסוי ל־{coverLabel(recAfter)}</small>}
                                {unavailable && <small className="bp-risk-text">אין מלאי או תכנון שמתאימים לביצוע משלוח פריט זה השבוע.</small>}
                            </span>
                            <span>{editing === "delivery" ?
                                <div className="bp-stepper">
                                    <button onClick={() => stepShipment(p, -1)}>−</button>
                                    <b>{Math.round((shipDraft[p.id] ?? 0) / palletSize(p))}</b>
                                    <button disabled={unavailable} onClick={() => stepShipment(p, 1)}>+</button>
                                    {!unavailable && <small>{decidedSlotsLabel}</small>}
                                    {(shipDraft[p.id] ?? 0) > 0 && <small>יגדיל כיסוי ל־{coverLabel(shownAfter)}</small>}
                                    {shipmentError?.productId === p.id && <small role="alert" className="bp-risk-text">{shipmentError.text}</small>}
                                    {dependency > 0 && <small className="bp-risk-text">⚠️ {palletLabel(dependency, p)} מאריזה השבוע</small>}
                                    {partial && <small className="bp-partial-pallet-hint">⚠️ קיים משטח חלקי של {fmt(palletQuantity(partial))} ארגזים; ייתכן שכדאי להחליף ידנית במפה.</small>}
                                </div>
                                : <>
                                    {decided > 0 ? palletLabel(decided, p) : "—"}
                                    {decided > 0 && <small>{decidedSlotsLabel}</small>}
                                    {decided > 0 && <small>יגדיל כיסוי ל־{coverLabel(shownAfter)}</small>}
                                    {dependency > 0 && <small className="bp-risk-text">⚠️ {palletLabel(dependency, p)} מאריזה השבוע</small>}
                                    {partial && <small className="bp-partial-pallet-hint">⚠️ קיים משטח חלקי של {fmt(palletQuantity(partial))} ארגזים; ייתכן שכדאי להחליף אותו ידנית במפה.</small>}
                                </>}
                            </span>
                        </div>;
                    })}
                </div>
            </article>

            <article className="bp-week-rec-card bp-week-packaging-card">
                <header>
                    <div><small>2 · אריזה · {selectedWeekText}</small><h3>מה לארוז השבוע</h3></div>
                    <b>{packagingDecisionCount ? `${packagingDecisionCount} אריזות` : `${packagingRecommendationCount} אריזות מומלצות`}</b>
                </header>
                <p className="bp-rec-principle">
                    ● המק"טים ממוינים לפי הכיסוי הנמוך ביותר.<br />
                    ● ברירת המחדל היא עד 252 ארגזים בביקבוק וריקון מיכל בחביות.
                </p>
                <div className="bp-actions">
                    {editing === "packaging" ? <>
                        <button disabled={busy} onClick={savePackaging}>שמור שינויים</button>
                        <button onClick={() => { setEditing(null); setManualPacks([]); setCancelledPackagingKeys(new Set()); }}>ביטול עריכה</button>
                    </> : <>
                        <button disabled={disabled || busy || !visiblePackagingRecommendations.length} onClick={acceptPackagingRecommendation}>
                            {current.packaging.length ? "הוסף אריזות מהמלצה לביצוע" : "צור אריזות מההמלצה"}
                        </button>
                        <button disabled={disabled || busy} onClick={() => beginEdit("packaging")}>עריכת האריזות</button>
                    </>}
                </div>

                {editing === "packaging" && <div className="bp-decided-list">
                    <b>החלטות קיימות</b>
                    {current.packaging.some((r) => !cancelledPackagingKeys.has(r.id ?? `${r.productId}:${r.tankId}`))
                        ? current.packaging.map((r) => {
                            const p = product(r.productId);
                            const key = r.id ?? `${r.productId}:${r.tankId}`;
                            if (cancelledPackagingKeys.has(key)) return null;
                            const value = packDraft[key] ?? r.quantity;
                            const completed = completedQty(r);
                            return <div className="bp-rec-line is-decided" key={key}>
                                <span><b>{p ? displayStyle(p.style) : r.productId}</b> · מיכל {r.tankNumber ?? tanks.find((t) => t.id === r.tankId)?.number ?? "—"}{completed > 0 && <small> · {fmt(completed)} כבר בוצעו</small>}</span>
                                <input type="number" min={completed} value={value} onChange={(e) => setPackDraft((d) => ({ ...d, [key]: Math.max(completed, Number(e.target.value)) }))} />
                                <button type="button" onClick={() => setCancelledPackagingKeys((currentKeys) => new Set([...currentKeys, key]))}>בטל אריזה</button>
                            </div>;
                        })
                        : <small>אין החלטות אריזה פתוחות.</small>}

                    <b>המלצות זמינות</b>
                    {visiblePackagingRecommendations.length ? visiblePackagingRecommendations.map((r) => {
                        const p = product(r.productId)!;
                        const key = `rec:${r.id}`;
                        const value = packDraft[key] ?? 0;
                        return <div className="bp-rec-line" key={r.id}>
                            <span><b>{displayStyle(p.style)} · {p.type === "crates" ? "ארגזים" : "חביות"}</b> · מיכל {r.tankNumber}</span>
                            <input type="number" min="0" value={value} onChange={(e) => setPackDraft((d) => ({ ...d, [key]: Math.max(0, Number(e.target.value)) }))} />
                            <button onClick={() => setPackDraft((d) => ({ ...d, [key]: value ? 0 : r.quantity }))}>{value ? "בטל" : `הוסף ${fmt(r.quantity)}`}</button>
                        </div>;
                    }) : <small>אין המלצות נוספות מעבר להחלטות שכבר נקבעו.</small>}

                    {manualPacks.map((r) => {
                        const remaining = r.tankId ? remainingLitersForTank(r.tankId, r.id) : 0;
                        const p = product(r.productId);
                        const max = manualMaxQuantity(p, r.tankId, r.id);
                        const valid = !!r.tankId && !!r.productId && r.quantity > 0;
                        return <div className="bp-manual-pack" key={r.id}>
                            <label>מיכל
                                <select value={r.tankId} onChange={(e) => changeManualTank(r.id, e.target.value)}>
                                    <option value="">בחר מיכל</option>
                                    {tanks.filter((t) => t.ready <= model.weekEnd && (model.tankAvailableLiters.get(t.id) ?? t.liters) >= 20).map((t) =>
                                        <option value={t.id} key={t.id}>מיכל {t.number} · {displayStyle(t.style)} · {fmt(model.tankAvailableLiters.get(t.id) ?? t.liters)} ל׳</option>)}
                                </select>
                            </label>
                            <label>סוג אריזה
                                <select value={r.productId} disabled={!r.tankId} onChange={(e) => changeManualProduct(r.id, e.target.value)}>
                                    <option value="">בחר</option>
                                    {manualProductsForTank(r.tankId).map((item) => <option value={item.id} key={item.id}>{item.type === "crates" ? "ארגזים" : "חביות"}</option>)}
                                </select>
                            </label>
                            <label>כמות
                                <input type="number" min="0" max={max || undefined} value={r.quantity || ""} onChange={(e) => {
                                    const value = Math.max(0, Number(e.target.value));
                                    setManualPacks((rows) => rows.map((x) => x.id === r.id ? { ...x, quantity: Math.min(value, max) } : x));
                                }} />
                                <small>יתרה במיכל לפני שורה זו: {fmt(remaining)} ל׳{p?.type === "crates" ? ` · עד ${MAX_MANUAL_CRATES} ארגזים באריזה ידנית` : ""}</small>
                            </label>
                            <div className="bp-manual-pack-actions">
                                <button type="button" disabled={!valid || busy} onClick={savePackaging}>שמור אריזה</button>
                                <button type="button" onClick={() => setManualPacks((rows) => rows.filter((x) => x.id !== r.id))}>הסר</button>
                            </div>
                        </div>;
                    })}
                    <button type="button" onClick={addManualPack}>+ הוסף אריזה</button>
                </div>}

                <div className="bp-shipment-plan-table">
                    <div className="bp-shipment-plan-head"><span>מק"ט</span><span>כיסוי כולל</span><span>המלצת מערכת</span><span>החלטה לביצוע</span></div>
                    {packagingProducts.map((p) => {
                        const before = model.rows.afterShipment.get(p.id);
                        const after = model.rows.afterPackaging.get(p.id);
                        const rec = allPackagingRecByProduct.get(p.id) ?? 0;
                        const decided = currentPackagingQty(p.id);
                        const remaining = currentPackagingRemainingQty(p.id);
                        const completed = Math.max(0, decided - remaining);
                        const shownAfter = editing === "packaging" ? draftPackagingCover(p) : after?.totalCover ?? null;
                        const recTank = recommendationTankLabel(p.id);
                        const decisionTank = decisionTankLabel(p.id);
                        const recAfter = packagingRecommendationCover(p);
                        const tone = coverageClass(before?.totalCover, settings.totalTargetWeeks ?? settings.targetWeeks);
                        const unavailable = rec <= 0 && remaining <= 0 && !hasPackagingSource(p);
                        return <div className={`bp-shipment-plan-row ${tone} ${remaining > 0 ? "is-decided" : ""} ${unavailable ? "is-unavailable" : ""}`} key={p.id}>
                            <span className={`bp-week-sku ${beerStyleClass(p.style).className}`}><b>{displayStyle(p.style)}</b><small>{p.type === "crates" ? "ארגזים" : "חביות"}</small></span>
                            <span>{coverLabel(before?.totalCover ?? null)}</span>
                            <span>
                                {rec > 0 ? `${fmt(rec)} ${p.type === "crates" ? "ארגזים" : "חביות"}` : "—"}
                                {recTank && <small>{recTank}</small>}
                                {rec > 0 && <small>יגדיל כיסוי ל־{coverLabel(recAfter)}</small>}
                                {unavailable && <small className="bp-risk-text">אין מיכל עם {displayStyle(p.style)} שמתאים לאריזה השבוע.</small>}
                            </span>
                            <span>
                                {remaining > 0 ? <>{fmt(remaining)} {p.type === "crates" ? "ארגזים" : "חביות"}</> : "—"}
                                {decisionTank && <small>{decisionTank}</small>}
                                {remaining > 0 && <small>יגדיל כיסוי ל־{coverLabel(shownAfter)}</small>}
                                {completed > 0 && <small>{fmt(completed)} כבר נארזו בפועל</small>}
                            </span>
                        </div>;
                    })}
                </div>
            </article>

            <article className="bp-week-rec-card bp-week-brew-card">
                <header>
                    <div><small>3 · בישול · {selectedWeekText}</small><h3>מה לבשל השבוע</h3></div>
                    <b>{model.availableBrewTanks} מיכלים פנויים</b>
                </header>

                <div className="bp-brew-tank-options">
                    <b>מיכלים שיכולים לשמש לבישולים השבוע</b>
                    {model.brewTankOptions.length ? <div className="bp-brew-tank-list">
                        {model.brewTankOptions.map((option) =>
                            <span className="bp-brew-tank-chip" key={option.tankId}>
                                <b>מיכל {option.tankNumber}</b>
                                <span>{option.sizeLabel}</span>
                            </span>)}
                    </div> : <small>לא ידוע כרגע על מיכל שיכול לקבל בישול בשבוע הזה.</small>}
                </div>

                {brewCapacityWarning && <div className="bp-brew-capacity-warning" role="alert">
                    <b>⚠️ הבישולים המתוכננים לא תואמים לקיבולת המיכלים השבוע</b>
                    <span>מתוכננים {plannedBrewCount} בישולים מול {model.brewTankCapacity} מיכלים אפשריים. יש להתאים גם את גודל הבישול — בודד/כפול/משולש — למיכלים שמופיעים למעלה.</span>
                </div>}
                <div className="bp-actions">
                    {editing === "brew" ? <>
                        <button type="button" disabled={!model.brewRecommendations.length} onClick={pushBrewRecommendationsToDraft}>צור בישולים מההמלצות</button>
                        <button disabled={busy} onClick={saveBrews}>שמירת הבישולים</button>
                        <button onClick={() => setEditing(null)}>ביטול</button>
                    </> : <>
                        <button type="button" disabled={disabled || busy || !model.brewRecommendations.length} onClick={acceptBrewRecommendations}>
                            {current.brews.length ? "הוסף המלצות לבישולים" : "צור בישולים מהמלצות"}
                        </button>
                        <button disabled={disabled || busy} onClick={() => beginEdit("brew")}>עריכת הבישולים</button>
                    </>}
                </div>

                {editing === "brew" && <div className="bp-decided-list">
                    <b>עריכת הבישולים</b>
                    {brewDraft.map((b, i) => {
                        const currentSize = brewSizeLabel(b.liters);
                        return <div className="bp-brew-edit-row" key={i}>
                            <select value={b.style} onChange={(e) => changeBrewStyle(i, e.target.value)}>
                                {CORE_STYLES.map((s) => <option value={s} key={s}>{displayStyle(s)}</option>)}<option value="אחר">אחר</option>
                            </select>
                            <select value={currentSize} onChange={(e) => changeBrewSize(i, e.target.value as BrewSizeLabel)}>
                                {BREW_SIZES.map((size) => <option
                                    value={size}
                                    key={size}
                                    disabled={size !== currentSize && !canUseBrewSize(brewDraft, size, i)}
                                >בישול {size} · {brewSizeCapacity(size)} מיכלים</option>)}
                            </select>
                            <button onClick={() => setBrewDraft((d) => d.filter((_, j) => j !== i))}>הסר</button>
                        </div>;
                    })}
                    {!brewDraft.length && <small>אין בישולים בטיוטה. הוסף בישול כדי להתחיל.</small>}
                    <button type="button" disabled={brewDraft.length >= model.brewTankCapacity} onClick={addBrew}>+ הוסף בישול</button>
                </div>}

                <div className="bp-decided-list">
                    <b>המלצת המערכת</b>
                    {model.brewRecommendations.length ? model.brewRecommendations.map((r, i) =>
                        <div className={`bp-rec-line ${coverageClass(styleCover(r.style), settings.totalTargetWeeks ?? settings.targetWeeks)}`} key={`${r.style}:${i}`}>
                            <span className={`bp-week-sku ${beerStyleClass(r.style).className}`}><b>{displayStyle(r.style)}</b></span>
                            <span>בישול {r.sizeLabel} · מתאים למיכל {r.tankNumber}<small> · זמין מ־{shortDate(r.availableDate)}</small></span>
                        </div>) : <small>אין כרגע המלצת בישול נוספת.</small>}
                </div>

                <div className="bp-decided-list">
                    <b>החלטות שנקבעו</b>
                    {current.brews.length ? current.brews.map((b) =>
                        <div className={`bp-rec-line ${coverageClass(styleCover(b.style), settings.totalTargetWeeks ?? settings.targetWeeks)}`} key={b.id}>
                            <span className={`bp-week-sku ${beerStyleClass(b.style).className}`}><b>{displayStyle(b.style)}</b></span>
                            <span>בישול {brewSizeLabel(b.liters)}{b.tankId ? ` · שובץ למיכל ${tanks.find((t) => t.id === b.tankId)?.number ?? b.tankId}` : " · טרם שובץ למיכל"}</span>
                        </div>) : <small>טרם נקבעו בישולים.</small>}
                </div>
            </article>
        </div>
    </section>;
}
