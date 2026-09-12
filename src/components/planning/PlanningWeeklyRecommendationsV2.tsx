import { useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import type { Pallet } from "../../SERVICES/cooler/Pallettypes ";
import { calcTruckSlots, MAX_TRUCK_SLOTS, setMarkedForShipment } from "../../SERVICES/cooler/Palletservice";
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
import { displayStyle, isCoreStyle, CORE_STYLES } from "../../SERVICES/planning/planningPresentation";
import { projectedPallets } from "../../SERVICES/planning/truckPlanner";
import { buildWeeklyPlanningModel } from "../../SERVICES/planning/weeklyPlanningModel";
import { weekday } from "../../SERVICES/planning/productionCycle";

type Kind = "delivery" | "packaging" | "brew";
type BrewDraft = { style: string; liters: number };
type ManualPackDraft = { id: string; tankId: string; productId: string; quantity: number };
type PalletSelectionOption = {
  selected: Pallet[];
  total: number;
  slots: number;
  overage: number;
  fefoScore: number;
};
type ShipmentSelectionState = {
  selected: Pallet[];
  details: Array<{
    product: Product;
    requested: number;
    available: number;
    selectedTotal: number;
    missing: number;
    overage: number;
  }>;
  slots: number;
  fefoScore: number;
  overage: number;
};

const fmt = (n: number) => Math.round(n).toLocaleString("he-IL");
const palletSize = (p: Product) => (p.type === "crates" ? 84 : 20);
const defaultWeek = (today: string) => weekday(today) >= 5 ? addDays(weekStart(today), 7) : weekStart(today);
const coverLabel = (value: number | null) => value === null || !Number.isFinite(value) ? "—" : `${value.toFixed(1)} שב׳`;

function palletLabel(quantity: number, p: Product) {
  return `${(quantity / palletSize(p)).toLocaleString("he-IL", { maximumFractionDigits: 2 })} מש׳`;
}

function unique(values: (string | number | null | undefined)[]) {
  return [...new Set(values.filter((v): v is string | number => v !== null && v !== undefined && String(v) !== ""))];
}

function expiryIso(value: string | null | undefined) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parts = value.split(/[./]/).map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  const [d, m, rawY] = parts;
  const y = rawY < 100 ? rawY + 2000 : rawY;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function palletQuantity(pallet: Pallet) {
  return Math.max(0, Math.round(Number(pallet.quantity || 0)));
}

function compareFefo(a: Pallet, b: Pallet) {
  return String(expiryIso(a.expiryDateStr) ?? "9999").localeCompare(String(expiryIso(b.expiryDateStr) ?? "9999")) ||
    String(a.batchNumber ?? "").localeCompare(String(b.batchNumber ?? "")) ||
    a.id.localeCompare(b.id);
}

function greedyPalletSelection(ordered: Pallet[], target: number) {
  const selected: Pallet[] = [];
  let total = 0;
  for (const pallet of ordered) {
    if (total >= target) break;
    const qty = palletQuantity(pallet);
    if (!qty) continue;
    selected.push(pallet);
    total += qty;
  }
  return { selected, total };
}

function palletSelectionOptions(candidates: Pallet[], requestedTarget: number): PalletSelectionOption[] {
  const requested = Math.max(0, Math.round(requestedTarget));
  const available = candidates.reduce((sum, pallet) => sum + palletQuantity(pallet), 0);
  const target = Math.min(requested, available);
  if (!target) return [{ selected: [], total: 0, slots: 0, overage: 0, fefoScore: 0 }];

  const fefo = [...candidates].filter((p) => palletQuantity(p) > 0).sort(compareFefo);
  const fefoRank = new Map(fefo.map((pallet, index) => [pallet.id, index]));
  const byExpiryPartialFirst = [...fefo].sort((a, b) => compareFefo(a, b) || palletQuantity(a) - palletQuantity(b));
  const byExpiryFullFirst = [...fefo].sort((a, b) => {
    const expiry = String(expiryIso(a.expiryDateStr) ?? "9999").localeCompare(String(expiryIso(b.expiryDateStr) ?? "9999"));
    if (expiry) return expiry;
    const batch = String(a.batchNumber ?? "").localeCompare(String(b.batchNumber ?? ""));
    if (batch) return batch;
    return palletQuantity(b) - palletQuantity(a) || a.id.localeCompare(b.id);
  });
  const compact = [...fefo].sort((a, b) => palletQuantity(b) - palletQuantity(a) || compareFefo(a, b));
  const partialFirst = [...fefo].sort((a, b) => palletQuantity(a) - palletQuantity(b) || compareFefo(a, b));

  const rawSelections: Pallet[][] = [];
  const pushGreedy = (ordered: Pallet[]) => {
    const { selected, total } = greedyPalletSelection(ordered, target);
    if (total >= target) rawSelections.push(selected);
  };

  pushGreedy(byExpiryPartialFirst);
  pushGreedy(byExpiryFullFirst);
  pushGreedy(compact);
  pushGreedy(partialFirst);

  // Generate compact alternatives around the greedy solutions. This lets a fuller
  // pallet replace one or two partial pallets when the FEFO-only choice would waste
  // truck slots, while still keeping FEFO alternatives in the option pool.
  for (const base of [...rawSelections]) {
    const baseIds = new Set(base.map((p) => p.id));
    const unselected = fefo.filter((p) => !baseIds.has(p.id));
    const baseTotal = base.reduce((sum, p) => sum + palletQuantity(p), 0);

    for (const add of unselected) {
      for (let i = 0; i < base.length; i++) {
        const total = baseTotal - palletQuantity(base[i]) + palletQuantity(add);
        if (total >= target) {
          rawSelections.push([...base.filter((_, index) => index !== i), add]);
        }
      }

      for (let i = 0; i < base.length; i++) {
        for (let j = i + 1; j < base.length; j++) {
          const total = baseTotal - palletQuantity(base[i]) - palletQuantity(base[j]) + palletQuantity(add);
          if (total >= target) {
            rawSelections.push([...base.filter((_, index) => index !== i && index !== j), add]);
          }
        }
      }
    }
  }

  const uniqueOptions = new Map<string, PalletSelectionOption>();
  for (const selected of rawSelections) {
    const deduped = [...new Map(selected.map((p) => [p.id, p])).values()];
    const total = deduped.reduce((sum, p) => sum + palletQuantity(p), 0);
    if (total < target) continue;
    let slots: number;
    try { slots = calcTruckSlots(deduped); } catch { continue; }
    const ids = deduped.map((p) => p.id).sort();
    const key = ids.join("|");
    const option: PalletSelectionOption = {
      selected: deduped,
      total,
      slots,
      overage: Math.max(0, total - target),
      fefoScore: deduped.reduce((sum, p) => sum + (fefoRank.get(p.id) ?? fefo.length), 0),
    };
    const existing = uniqueOptions.get(key);
    if (!existing || option.slots < existing.slots || (option.slots === existing.slots && option.fefoScore < existing.fefoScore)) {
      uniqueOptions.set(key, option);
    }
  }

  return [...uniqueOptions.values()]
    .sort((a, b) => a.slots - b.slots || a.fefoScore - b.fefoScore || a.overage - b.overage || a.selected.length - b.selected.length)
    .slice(0, 60);
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
  const byCapacity = [...all].sort((a, b) => a.slots - b.slots || a.fefoScore - b.fefoScore || a.overage - b.overage).slice(0, 220);
  const byFefo = [...all].sort((a, b) => a.fefoScore - b.fefoScore || a.overage - b.overage || a.slots - b.slots).slice(0, 220);
  return [...new Map([...byCapacity, ...byFefo].map((state) => [state.selected.map((p) => p.id).sort().join("|"), state])).values()];
}

export default function PlanningWeeklyRecommendationsV2({
  settings, plans, tanks, sources, pallets, actuals, shipments, holidays, today, disabled, saveWeek, onOpenCoolerMap,
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
  const [brewDraft, setBrewDraft] = useState<BrewDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const current = plans.find((w) => w.id === week) ?? { ...emptyWeek(week), maxRuns: settings.preferredRuns };
  const model = useMemo(
    () => buildWeeklyPlanningModel({ settings, pallets, tanks, plans, actuals, sources, today, week, holidays, shipments }),
    [settings, pallets, tanks, plans, actuals, sources, today, week, holidays, shipments],
  );
  const products = settings.products.filter((p) => p.monthly > 0 && isCoreStyle(p.style));
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
  const packagingRecByProduct = new Map<string, number>();
  for (const r of visiblePackagingRecommendations) {
    packagingRecByProduct.set(r.productId, (packagingRecByProduct.get(r.productId) ?? 0) + r.quantity);
  }

  const shipmentProducts = [...products].sort((a, b) =>
    (model.rows.base.get(a.id)?.tempoCover ?? Infinity) - (model.rows.base.get(b.id)?.tempoCover ?? Infinity),
  );
  const packagingProducts = [...products].sort((a, b) =>
    (model.rows.afterShipment.get(a.id)?.totalCover ?? Infinity) - (model.rows.afterShipment.get(b.id)?.totalCover ?? Infinity),
  );

  const currentShipmentQty = (id: string) => (current.deliveries ?? []).filter((d) => d.productId === id).reduce((s, d) => s + d.quantity, 0);
  const currentPackagingQty = (id: string) => current.packaging.filter((r) => r.productId === id).reduce((s, r) => s + r.quantity, 0);
  const currentPackagingRemainingQty = (id: string) => currentOpenPackaging.filter((r) => r.productId === id).reduce((s, r) => s + r.remaining, 0);

  function openRunForSavedPlan(run: Plan) {
    return run.id
      ? currentOpenPackaging.find((r) => r.id === run.id)
      : currentOpenPackaging.find((r) => r.productId === run.productId && r.tankId === run.tankId);
  }
  function effectiveSavedRemaining(run: Plan, targetQuantity: number) {
    const open = openRunForSavedPlan(run);
    const completed = Math.max(0, run.quantity - (open?.remaining ?? run.quantity));
    return Math.max(0, targetQuantity - completed);
  }
  function shipmentSlots(draft: Record<string, number>) {
    const manifest = products.flatMap((p) =>
      projectedPallets(p, Math.max(0, draft[p.id] ?? 0), `weekly-edit:${week}:${p.id}`).map((x) => x.pallet),
    );
    if (!manifest.length) return 0;
    try { return calcTruckSlots(manifest); } catch { return Infinity; }
  }
  function physicalInventory(p: Product) {
    return pallets
      .filter((x) => x.zone !== "shipped" && x.itemType === p.type && sameStyle(x.beerStyle, p.style))
      .reduce((s, x) => s + Number(x.quantity || 0), 0);
  }
  function safeShipmentQty(p: Product) {
    return Math.floor((model.rows.base.get(p.id)?.breweryUnits ?? 0) / palletSize(p)) * palletSize(p);
  }
  const sameWeekPackagingQty = (p: Product) => currentPackagingRemainingQty(p.id);
  function maxShipmentQty(p: Product) {
    return Math.floor(((model.rows.base.get(p.id)?.breweryUnits ?? 0) + sameWeekPackagingQty(p)) / palletSize(p)) * palletSize(p);
  }
  const riskyShipmentQty = (p: Product, qty: number) => Math.max(0, qty - safeShipmentQty(p));
  function regularMaxCover(p: Product) {
    const base = model.rows.base.get(p.id);
    const demand = weeklyDemand(p);
    return !base || base.tempoUnits === null || demand <= 0 ? Infinity : (base.tempoUnits + safeShipmentQty(p)) / demand;
  }
  function draftShipmentCover(p: Product) {
    const base = model.rows.base.get(p.id);
    return !base || base.tempoUnits === null || weeklyDemand(p) <= 0
      ? null
      : (base.tempoUnits + (shipDraft[p.id] ?? 0)) / weeklyDemand(p);
  }
  function shipmentRecommendationCover(p: Product) {
    const base = model.rows.base.get(p.id);
    const rec = shipmentRec.get(p.id);
    return !base || base.tempoUnits === null || !rec || weeklyDemand(p) <= 0
      ? null
      : (base.tempoUnits + rec.quantity) / weeklyDemand(p);
  }
  function packagingRecommendationCover(p: Product) {
    const before = model.rows.afterShipment.get(p.id);
    const quantity = packagingRecByProduct.get(p.id) ?? 0;
    return !before || before.tempoUnits === null || !quantity || weeklyDemand(p) <= 0
      ? null
      : (before.tempoUnits + before.breweryUnits + quantity) / weeklyDemand(p);
  }
  function recommendationTankLabel(productId: string) {
    const values = unique(visiblePackagingRecommendations.filter((r) => r.productId === productId).map((r) => r.tankNumber));
    return values.length ? `מיכל ${values.join(", ")}` : "";
  }
  function decisionTankLabel(productId: string) {
    const values = unique(currentOpenPackaging.filter((r) => r.productId === productId).map((r) =>
      r.tankNumber ?? tanks.find((t) => t.id === r.tankId)?.number,
    ));
    return values.length ? `מיכל ${values.join(", ")}` : "";
  }

  function beginEdit(kind: Kind) {
    setEditing(kind); setMessage("");
    if (kind === "delivery") {
      setShipDraft(Object.fromEntries(products.map((p) => [p.id, currentShipmentQty(p.id)])));
    } else if (kind === "packaging") {
      setPackDraft(Object.fromEntries(current.packaging.map((r) => [r.id ?? `${r.productId}:${r.tankId}`, r.quantity])));
      setManualPacks([]);
    } else {
      setBrewDraft(current.brews.map((b) => ({ style: b.style, liters: b.liters })));
    }
  }

  function stepShipment(p: Product, delta: number) {
    setShipDraft((prev) => {
      const proposed = Math.max(0, (prev[p.id] ?? 0) + delta * palletSize(p));
      if (delta > 0 && proposed > maxShipmentQty(p)) {
        setMessage(`אין מספיק מלאי זמין עד השבוע הזה עבור ${displayStyle(p.style)}.`);
        return prev;
      }
      const next = { ...prev, [p.id]: proposed };
      if (delta > 0 && shipmentSlots(next) > MAX_TRUCK_SLOTS) {
        setMessage(`המשאית מלאה — מקסימום ${MAX_TRUCK_SLOTS} מקומות.`);
        return prev;
      }
      setMessage("");
      return next;
    });
  }

  async function saveShipment() {
    const slots = shipmentSlots(shipDraft);
    const risky = products.some((p) => riskyShipmentQty(p, shipDraft[p.id] ?? 0) > 0);
    setBusy(true); setMessage("");
    try {
      const date = current.deliveries?.[0]?.dispatchDate ?? addDays(week, 1);
      const deliveries: DeliveryPlan[] = products.flatMap((p) => {
        const quantity = Math.max(0, shipDraft[p.id] ?? 0);
        return quantity ? [{ id: crypto.randomUUID(), productId: p.id, quantity, dispatchDate: date, arrivalDate: date, truckId: `truck:${week}`, pallets: [] }] : [];
      });
      await saveWeek({ ...current, deliveries, deliveryDates: deliveries.length ? [date] : [], changeReason: "עדכון החלטת משלוח שבועית" });
      setEditing(null);
      setMessage(`${slots > 0 && slots < MAX_TRUCK_SLOTS ? `נשמר משלוח חלקי ${slots}/${MAX_TRUCK_SLOTS}.` : "החלטת המשלוח נשמרה."}${risky ? " ⚠️ חלק מהמלאי ייארז באותו שבוע." : ""}`);
    } catch (e) { setMessage(e instanceof Error ? e.message : "שמירת המשלוח נכשלה"); }
    finally { setBusy(false); }
  }

  async function acceptShipmentRecommendation() {
    const date = current.deliveries?.[0]?.dispatchDate ?? addDays(week, 1);
    const deliveries: DeliveryPlan[] = products.flatMap((p) => {
      const quantity = shipmentRec.get(p.id)?.quantity ?? 0;
      return quantity ? [{ id: crypto.randomUUID(), productId: p.id, quantity, dispatchDate: date, arrivalDate: date, truckId: `truck:${week}`, pallets: [] }] : [];
    });
    setBusy(true); setMessage("");
    try {
      await saveWeek({ ...current, deliveries, deliveryDates: deliveries.length ? [date] : [], changeReason: "אישור המלצת משלוח שבועית" });
      setMessage(current.deliveries?.length ? "החלטת המשלוח הקיימת הוחלפה בהמלצה." : "המלצת המשלוח נשמרה כהחלטה חדשה.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "שמירת המשלוח נכשלה"); }
    finally { setBusy(false); }
  }

  const nearestShipmentWeek = plans
    .filter((w) => w.id >= weekStart(today) && (w.deliveries ?? []).some((d) => d.quantity > 0))
    .sort((a, b) => a.id.localeCompare(b.id))[0]?.id;
  const isNearShipmentWeek = week === weekStart(today) || week === addDays(weekStart(today), 7);
  const canOfferMapMarking = isNearShipmentWeek && nearestShipmentWeek === week && (current.deliveries ?? []).some((d) => d.quantity > 0);

  async function markShipmentOnCoolerMap() {
    console.log("[SHIPMENT MARK] start", {
      week,
      today,
      canOfferMapMarking,
      deliveries: current.deliveries,
      products: products.map((p) => ({ id: p.id, style: p.style, type: p.type, requested: currentShipmentQty(p.id) })),
      palletCount: pallets.length,
      coolerPalletCount: pallets.filter((p) => p.zone === "cooler").length,
    });

    if (!canOfferMapMarking) {
      console.warn("[SHIPMENT MARK] aborted: canOfferMapMarking=false");
      return;
    }

    const shipmentLines = products
      .map((product) => ({ product, requested: currentShipmentQty(product.id) }))
      .filter((line) => line.requested > 0)
      .map((line) => {
        const candidates = pallets.filter((pallet) =>
          pallet.zone === "cooler" &&
          pallet.itemType === line.product.type &&
          sameStyle(pallet.beerStyle, line.product.style) &&
          (!expiryIso(pallet.expiryDateStr) || expiryIso(pallet.expiryDateStr)! >= today),
        );
        const available = candidates.reduce((sum, pallet) => sum + palletQuantity(pallet), 0);
        const options = palletSelectionOptions(candidates, line.requested);
        console.log("[SHIPMENT MARK] product options", {
          productId: line.product.id,
          style: line.product.style,
          type: line.product.type,
          requestedQuantity: line.requested,
          available,
          candidateCount: candidates.length,
          optionCount: options.length,
          bestOptions: options.slice(0, 8).map((option) => ({
            ids: option.selected.map((p) => p.id),
            quantities: option.selected.map((p) => p.quantity),
            total: option.total,
            slots: option.slots,
            overage: option.overage,
            fefoScore: option.fefoScore,
          })),
        });
        return { ...line, candidates, available, options };
      });

    let states: ShipmentSelectionState[] = [{ selected: [], details: [], slots: 0, fefoScore: 0, overage: 0 }];

    for (const line of shipmentLines) {
      if (!line.options.length) {
        console.warn("[SHIPMENT MARK] no selection options", { productId: line.product.id, requested: line.requested, available: line.available });
        return setMessage(`לא נמצאה קומבינציית משטחים עבור ${displayStyle(line.product.style)}.`);
      }

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
              requested: line.requested,
              available: line.available,
              selectedTotal: option.total,
              missing: Math.max(0, line.requested - line.available),
              overage: Math.max(0, option.total - Math.min(line.requested, line.available)),
            }],
            slots,
            fefoScore: state.fefoScore + option.fefoScore,
            overage: state.overage + option.overage,
          });
        }
      }

      states = pruneShipmentStates(nextStates);
      console.log("[SHIPMENT MARK] combined states", {
        productId: line.product.id,
        remainingStates: states.length,
        bestByCapacity: states.slice().sort((a, b) => a.slots - b.slots || a.fefoScore - b.fefoScore).slice(0, 5).map((state) => ({
          slots: state.slots,
          palletCount: state.selected.length,
          fefoScore: state.fefoScore,
          overage: state.overage,
        })),
      });

      if (!states.length) {
        console.warn("[SHIPMENT MARK] no truck-feasible state", { productId: line.product.id, maxSlots: MAX_TRUCK_SLOTS });
        return setMessage(`לא נמצאה קומבינציית משטחים פיזית שמכסה את החלטת המשלוח ונכנסת ב־${MAX_TRUCK_SLOTS} מקומות במשאית.`);
      }
    }

    const best = [...states].sort((a, b) =>
      a.fefoScore - b.fefoScore ||
      a.overage - b.overage ||
      a.slots - b.slots ||
      a.selected.length - b.selected.length,
    )[0];

    if (!best || !best.selected.length) {
      console.warn("[SHIPMENT MARK] aborted: no selected pallets", { shipmentLines });
      return setMessage("לא נמצאו משטחים פיזיים מתאימים לסימון.");
    }

    const palletIds = [...new Set(best.selected.map((p) => p.id))];
    const notes = best.details.flatMap((detail) => {
      const result: string[] = [];
      if (detail.missing > 0) {
        result.push(`${displayStyle(detail.product.style)}: חסרים ${fmt(detail.missing)} ${detail.product.type === "crates" ? "ארגזים" : "חביות"} פיזיים במקרר`);
      }
      if (detail.overage > 0) {
        result.push(`${displayStyle(detail.product.style)}: נבחרו ${fmt(detail.selectedTotal)} עבור דרישה פיזית של ${fmt(Math.min(detail.requested, detail.available))} כי לא מפצלים משטח קיים`);
      }
      return result;
    });

    console.log("[SHIPMENT MARK] selected truck-feasible pallets", {
      palletIds,
      slots: best.slots,
      palletCount: best.selected.length,
      fefoScore: best.fefoScore,
      overage: best.overage,
      pallets: best.selected.map((p) => ({
        id: p.id,
        quantity: p.quantity,
        style: p.beerStyle,
        type: p.itemType,
        batchNumber: p.batchNumber,
        expiryDateStr: p.expiryDateStr,
      })),
      details: best.details,
      notes,
    });

    setBusy(true); setMessage("");
    try {
      console.log("[SHIPMENT MARK] firebase writes start", { palletIds });
      await Promise.all(palletIds.map(async (id) => {
        console.log("[SHIPMENT MARK] marking pallet", id);
        await setMarkedForShipment(id, true);
        console.log("[SHIPMENT MARK] marked pallet", id);
      }));
      console.log("[SHIPMENT MARK] firebase writes complete", { palletIds });
      setMessage(
        `סומנו ${palletIds.length} משטחים פיזיים למשלוח (${best.slots}/${MAX_TRUCK_SLOTS} מקומות במשאית).${notes.length ? ` ⚠️ ${notes.join(" · ")}` : ""}`,
      );
      onOpenCoolerMap?.();
    } catch (e) {
      console.error("[SHIPMENT MARK] firebase write failed", e);
      setMessage(e instanceof Error ? e.message : "סימון המשטחים במפה נכשל");
    } finally {
      setBusy(false);
      console.log("[SHIPMENT MARK] done");
    }
  }

  function allDraftPackLines() {
    const lines: { tankId?: string; productId: string; quantity: number }[] = [];
    for (const r of current.packaging) {
      const key = r.id ?? `${r.productId}:${r.tankId}`;
      const quantity = effectiveSavedRemaining(r, Math.max(0, packDraft[key] ?? r.quantity));
      if (quantity) lines.push({ tankId: r.tankId, productId: r.productId, quantity });
    }
    for (const r of visiblePackagingRecommendations) {
      const quantity = Math.max(0, packDraft[`rec:${r.id}`] ?? 0);
      if (quantity) lines.push({ tankId: r.tankId, productId: r.productId, quantity });
    }
    for (const r of manualPacks) if (r.tankId && r.productId && r.quantity > 0) lines.push(r);
    return lines;
  }
  function remainingLitersForTank(tankId: string, excludeManualId?: string) {
    const base = model.tankAvailableLiters.get(tankId) ?? tanks.find((t) => t.id === tankId)?.liters ?? 0;
    const used = [
      ...current.packaging.map((r) => ({
        id: `saved:${r.id}`, tankId: r.tankId, productId: r.productId,
        quantity: effectiveSavedRemaining(r, Math.max(0, packDraft[r.id ?? `${r.productId}:${r.tankId}`] ?? r.quantity)),
      })),
      ...visiblePackagingRecommendations.map((r) => ({ id: `rec:${r.id}`, tankId: r.tankId, productId: r.productId, quantity: Math.max(0, packDraft[`rec:${r.id}`] ?? 0) })),
      ...manualPacks.map((r) => ({ ...r, id: `manual:${r.id}` })),
    ].filter((r) => r.tankId === tankId && (!excludeManualId || r.id !== `manual:${excludeManualId}`));
    return Math.max(0, base - used.reduce((sum, r) => sum + r.quantity * litersPerUnit(product(r.productId)!), 0));
  }
  function manualProductsForTank(tankId: string) {
    const t = tanks.find((x) => x.id === tankId);
    return t ? products.filter((p) => sameStyle(p.style, t.style)) : [];
  }
  const addManualPack = () => setManualPacks((rows) => [...rows, { id: crypto.randomUUID(), tankId: "", productId: "", quantity: 0 }]);
  function changeManualTank(id: string, tankId: string) {
    setManualPacks((rows) => rows.map((r) => {
      if (r.id !== id) return r;
      const p = manualProductsForTank(tankId)[0];
      const liters = remainingLitersForTank(tankId, id);
      return { ...r, tankId, productId: p?.id ?? "", quantity: p ? Math.floor(liters / litersPerUnit(p)) : 0 };
    }));
  }
  function changeManualProduct(id: string, productId: string) {
    setManualPacks((rows) => rows.map((r) => {
      if (r.id !== id) return r;
      const p = product(productId);
      const liters = remainingLitersForTank(r.tankId, id);
      return { ...r, productId, quantity: p ? Math.floor(liters / litersPerUnit(p)) : 0 };
    }));
  }
  function draftPackagingCover(p: Product) {
    const before = model.rows.afterShipment.get(p.id);
    if (!before || before.tempoUnits === null || weeklyDemand(p) <= 0) return null;
    const planned = allDraftPackLines().filter((r) => r.productId === p.id).reduce((s, r) => s + r.quantity, 0);
    return (before.tempoUnits + before.breweryUnits + planned) / weeklyDemand(p);
  }

  async function savePackaging() {
    setBusy(true); setMessage("");
    try {
      const packaging: Plan[] = current.packaging
        .map((r) => ({ ...r, quantity: Math.max(0, packDraft[r.id ?? `${r.productId}:${r.tankId}`] ?? r.quantity) }))
        .filter((r) => r.quantity > 0);
      for (const rec of visiblePackagingRecommendations) {
        const quantity = Math.max(0, packDraft[`rec:${rec.id}`] ?? 0);
        if (!quantity) continue;
        const p = product(rec.productId)!;
        packaging.push({ id: rec.id, productId: rec.productId, quantity, tankId: rec.tankId, tankNumber: rec.tankNumber, source: "recommendation", emptyTank: rec.liters - rec.quantity * litersPerUnit(p) < 20 });
      }
      for (const manual of manualPacks) {
        if (!manual.tankId || !manual.productId || manual.quantity <= 0) continue;
        const t = tanks.find((x) => x.id === manual.tankId)!;
        const p = product(manual.productId)!;
        const base = model.tankAvailableLiters.get(t.id) ?? t.liters;
        const used = packaging.filter((x) => x.tankId === t.id).reduce((sum, x) => sum + effectiveSavedRemaining(x, x.quantity) * litersPerUnit(product(x.productId)!), 0);
        const quantity = Math.min(manual.quantity, Math.floor(Math.max(0, base - used) / litersPerUnit(p)));
        if (!quantity) continue;
        packaging.push({ id: manual.id, productId: p.id, quantity, tankId: t.id, tankNumber: String(t.number), source: "manual", emptyTank: base - used - quantity * litersPerUnit(p) < 20 });
      }
      await saveWeek({ ...current, packaging, changeReason: "עדכון החלטת אריזה שבועית" });
      setEditing(null); setManualPacks([]); setMessage("החלטת האריזה נשמרה.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "שמירת האריזה נכשלה"); }
    finally { setBusy(false); }
  }

  async function acceptPackagingRecommendation() {
    const additions: Plan[] = visiblePackagingRecommendations.map((r) => ({
      id: r.id, productId: r.productId, quantity: r.quantity, tankId: r.tankId, tankNumber: r.tankNumber,
      source: "recommendation", emptyTank: r.liters - r.quantity * litersPerUnit(product(r.productId)!) < 20,
    }));
    if (!additions.length) return;
    setBusy(true); setMessage("");
    try {
      const packaging = current.packaging.length ? [...current.packaging, ...additions] : additions;
      await saveWeek({ ...current, packaging, changeReason: current.packaging.length ? "הוספת המלצות אריזה חסרות" : "אישור המלצת אריזה שבועית" });
      setMessage(current.packaging.length ? "המלצות האריזה החסרות נוספו להחלטה הקיימת." : "המלצת האריזה נשמרה כהחלטה חדשה.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "שמירת האריזה נכשלה"); }
    finally { setBusy(false); }
  }

  async function saveBrews() {
    setBusy(true); setMessage("");
    try {
      const brews = brewDraft.filter((b) => b.style && b.liters > 0).map((b) => ({ id: crypto.randomUUID(), style: b.style, liters: b.liters, tankId: "", date: addDays(week, 1) }));
      await saveWeek({ ...current, brews, changeReason: "עדכון החלטת בישול שבועית" });
      setEditing(null); setMessage("החלטת הבישול נשמרה.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "שמירת הבישול נכשלה"); }
    finally { setBusy(false); }
  }
  async function acceptBrewRecommendations() {
    if (!model.brewRecommendations.length) return;
    const additions = model.brewRecommendations.map((b) => ({ id: crypto.randomUUID(), style: b.style, liters: b.liters, tankId: "", date: addDays(week, 1) }));
    setBusy(true); setMessage("");
    try {
      await saveWeek({ ...current, brews: [...current.brews, ...additions], changeReason: "הוספת המלצות בישול שבועיות" });
      setMessage(current.brews.length ? "המלצות הבישול נוספו להחלטות הקיימות." : "המלצות הבישול נשמרו כהחלטות חדשות. את המיכלים והימים תשבץ בלוח העבודה.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "שמירת הבישולים נכשלה"); }
    finally { setBusy(false); }
  }
  function addBrew() {
    if (editing !== "brew") {
      setEditing("brew");
      setBrewDraft([...current.brews.map((b) => ({ style: b.style, liters: b.liters })), { style: model.brewRecommendations[0]?.style ?? CORE_STYLES[0], liters: model.brewRecommendations[0]?.liters ?? 2500 }]);
    } else {
      setBrewDraft((rows) => [...rows, { style: model.brewRecommendations[rows.length]?.style ?? CORE_STYLES[0], liters: model.brewRecommendations[rows.length]?.liters ?? 2500 }]);
    }
  }
  function pushBrewRecommendationsToDraft() {
    if (!model.brewRecommendations.length) return;
    setEditing("brew");
    setBrewDraft([...current.brews.map((b) => ({ style: b.style, liters: b.liters })), ...model.brewRecommendations]);
  }

  const usedShipSlots = editing === "delivery" ? shipmentSlots(shipDraft) : null;
  const riskyShipmentLines = products
    .map((p) => ({ p, quantity: editing === "delivery" ? shipDraft[p.id] ?? 0 : currentShipmentQty(p.id) }))
    .map((x) => ({ ...x, risky: riskyShipmentQty(x.p, x.quantity) }))
    .filter((x) => x.risky > 0);
  const selectedWeekText = `שבוע ${weekNumber(week)} · ${shortDate(week)}–${shortDate(model.weekEnd)}`;
  const packagingDecisionCount = currentOpenPackaging.length;
  const packagingRecommendationCount = visiblePackagingRecommendations.length;

  return <section className="bp-weekly-planner">
    <div className="bp-section-heading"><div><h2>המלצות שבועיות</h2><p className="bp-muted">המערכת מחשבת ומסבירה; המתכנן מחליט. משלוח → אריזה → בישול.</p></div></div>
    <div className="bp-week-picker">{Array.from({ length: 8 }, (_, i) => addDays(weekStart(today), i * 7)).map((w) => <button key={w} aria-pressed={w === week} onClick={() => { setWeek(w); setEditing(null); setMessage(""); }}>שבוע {weekNumber(w)}<small>{shortDate(w)}</small></button>)}</div>
    <div className="bp-week-sticky"><b>{selectedWeekText}</b><small>{editing ? `עורך: ${editing === "delivery" ? "משלוח" : editing === "packaging" ? "אריזה" : "בישול"}` : "תכנון שבועי"}</small></div>
    {holidaysThisWeek.length > 0 && <div className="bp-week-events"><b>חגים / מגבלות השבוע</b>{holidaysThisWeek.map((h) => <span key={`${h.date}:${h.title}`}>{shortDate(h.date)} · {h.title}{h.closed ? " · סגור" : ""}</span>)}</div>}
    {message && <p role="status" className="bp-week-message">{message}</p>}

    <div className="bp-week-recommendations">
      <article className="bp-week-rec-card bp-week-shipment-card">
        <header><div><small>1 · משלוח · {selectedWeekText}</small><h3>מה לשלוח השבוע</h3></div><b>{model.shipmentSlots}/{MAX_TRUCK_SLOTS} מקומות בהמלצה</b></header>
        <p className="bp-rec-principle">הכיסוי הוא כיסוי טמפו צפוי לסוף השבוע. הזמינות מוצגת במשטחים. מלאי מאריזה של אותו שבוע מוצג כאפשרות חריגה רק כשבלעדיו לא ניתן להגיע לכיסוי היעד.</p>
        {editing === "delivery" && <div className="bp-saved-summary"><b>{Number.isFinite(usedShipSlots) ? usedShipSlots : 0}/{MAX_TRUCK_SLOTS} מקומות בשימוש</b> · נותרו {Number.isFinite(usedShipSlots) ? Math.max(0, MAX_TRUCK_SLOTS - Number(usedShipSlots)) : 0}</div>}
        {riskyShipmentLines.length > 0 && <div className="bp-same-week-warning" role="alert"><b>⚠️ משלוח נשען על אריזה של אותו שבוע</b><span>יש לארוז לפני או ביום המשלוח. זו חריגה שהמתכנן בחר, לא המלצה אוטומטית.</span>{riskyShipmentLines.map(({ p, risky }) => <small key={p.id}>{displayStyle(p.style)} · {palletLabel(risky, p)} עדיין תלויים באריזה השבוע.</small>)}</div>}
        <div className="bp-shipment-plan-table"><div className="bp-shipment-plan-head"><span>מקט</span><span>כיסוי</span><span>מומלץ</span><span>החלטה</span></div>
          {shipmentProducts.map((p) => {
            const base = model.rows.base.get(p.id); const after = model.rows.committed.get(p.id); const rec = shipmentRec.get(p.id);
            const decided = currentShipmentQty(p.id); const draftQty = editing === "delivery" ? shipDraft[p.id] ?? 0 : decided;
            const physical = physicalInventory(p); const expected = base?.breweryUnits ?? 0; const plannedDelta = expected - physical; const sameWeek = sameWeekPackagingQty(p);
            const risky = riskyShipmentQty(p, draftQty); const shownAfter = editing === "delivery" ? draftShipmentCover(p) : after?.tempoCover ?? null;
            const showSameWeek = sameWeek > 0 && regularMaxCover(p) < settings.targetWeeks;
            const recAfter = shipmentRecommendationCover(p);
            return <div className={`bp-shipment-plan-row ${risky > 0 ? "has-same-week-risk" : (shownAfter ?? Infinity) < settings.targetWeeks ? "is-warning" : "is-ok"}`} key={p.id}>
              <span><b>{displayStyle(p.style)}</b><small>{p.type === "crates" ? "ארגזים" : "חביות"}</small></span>
              <span>{coverLabel(base?.tempoCover ?? null)}<small>זמין: {palletLabel(expected, p)} · פיזי היום {palletLabel(physical, p)}{plannedDelta > 0 ? ` · +${palletLabel(plannedDelta, p)} מתכנון קודם` : plannedDelta < 0 ? ` · ${palletLabel(plannedDelta, p)} מהחלטות קודמות` : ""}</small>{showSameWeek && <small className="bp-risk-text">⚠️ עוד {palletLabel(sameWeek, p)} מאריזה השבוע — אפשריים כחריגה</small>}</span>
              <span>{rec?.pallets ?? 0} מש׳<small>{rec?.slots ?? 0} מק׳</small>{rec && <small>יגדיל כיסוי ל־{coverLabel(recAfter)}</small>}</span>
              <span>{editing === "delivery" ? <div className="bp-stepper"><button onClick={() => stepShipment(p, -1)}>−</button><b>{Math.round((shipDraft[p.id] ?? 0) / palletSize(p))}</b><button onClick={() => stepShipment(p, 1)}>+</button><small>משטחים · אחרי: {coverLabel(shownAfter)}</small>{risky > 0 && <small className="bp-risk-text">⚠️ {palletLabel(risky, p)} מאריזה השבוע</small>}</div> : <>{Math.ceil(decided / palletSize(p))} מש׳<small>אחרי החלטה: {coverLabel(shownAfter)}</small>{risky > 0 && <small className="bp-risk-text">⚠️ {palletLabel(risky, p)} מאריזה השבוע</small>}</>}</span>
            </div>;
          })}
        </div>
        {!model.shipmentCanFillTruck && model.shipmentSlots > 0 && <p className="bp-alert">אין כרגע מספיק מלאי רגיל צפוי כדי להרכיב המלצה של משאית מלאה. עדיין אפשר לשמור החלטה חלקית ידנית.</p>}
        {canOfferMapMarking && <div className="bp-map-marking"><button type="button" disabled={disabled || busy} onClick={markShipmentOnCoolerMap}>סמן את המשלוח במפת המקרר</button><small>בוחר קומבינציית משטחים פיזיים שנכנסת בפועל ב־12 מקומות, תוך העדפת FEFO/FIFO ומשטחים חלקיים כשאפשר. קיבולת המשאית מחושבת דרך Palletservice.</small></div>}
        <div className="bp-actions">{editing === "delivery" ? <><button disabled={busy} onClick={saveShipment}>שמירת החלטת המשלוח</button><button onClick={() => setEditing(null)}>ביטול</button></> : <><button className={(current.deliveries ?? []).length ? "bp-action-warning" : ""} disabled={disabled || busy || !model.shipmentCanFillTruck} onClick={acceptShipmentRecommendation}>{(current.deliveries ?? []).length ? "⚠️ החלף החלטה קיימת בהמלצה" : "צור החלטה מהמלצת 12/12"}</button><button disabled={disabled || busy} onClick={() => beginEdit("delivery")}>עריכת המשלוח</button></>}</div>
      </article>

      <article className="bp-week-rec-card">
        <header><div><small>2 · אריזה · {selectedWeekText}</small><h3>מה לארוז השבוע</h3></div><b>{packagingDecisionCount ? `${packagingDecisionCount} פעולות בתכנון · קיבולת ${model.packagingCapacity} ימים` : `${packagingRecommendationCount} פעולות בהמלצה · קיבולת ${model.packagingCapacity} ימים`}</b></header>
        <p className="bp-rec-principle">ברירת המחדל היא עד 252 ארגזים בריצה. אם 252 משאירים פחות מ־7% והמיכל כולו נכנס בעד 270, ההמלצה מסיימת את המיכל. המלצה שכבר הפכה להחלטה אינה מוצגת שוב כהמלצה.</p>
        <div className="bp-shipment-plan-table"><div className="bp-shipment-plan-head"><span>מקט</span><span>כיסוי כולל</span><span>מומלץ</span><span>החלטה</span></div>
          {packagingProducts.map((p) => {
            const before = model.rows.afterShipment.get(p.id); const after = model.rows.afterPackaging.get(p.id);
            const rec = packagingRecByProduct.get(p.id) ?? 0; const decided = currentPackagingQty(p.id); const remaining = currentPackagingRemainingQty(p.id); const completed = Math.max(0, decided - remaining);
            const shownAfter = editing === "packaging" ? draftPackagingCover(p) : after?.totalCover ?? null;
            const recTank = recommendationTankLabel(p.id); const decisionTank = decisionTankLabel(p.id); const recAfter = packagingRecommendationCover(p);
            return <div className={`bp-shipment-plan-row ${(shownAfter ?? Infinity) < (settings.totalTargetWeeks ?? settings.targetWeeks) ? "is-warning" : "is-ok"}`} key={p.id}>
              <span><b>{displayStyle(p.style)}</b><small>{p.type === "crates" ? "ארגזים" : "חביות"}</small></span><span>{coverLabel(before?.totalCover ?? null)}</span>
              <span>{fmt(rec)}{recTank && <small>{recTank}</small>}{rec > 0 && <small>יגדיל כיסוי ל־{coverLabel(recAfter)}</small>}</span>
              <span>{fmt(remaining)}{decisionTank && <small>{decisionTank}</small>}<small>נותר בתכנון · אחרי החלטה: {coverLabel(shownAfter)}</small>{completed > 0 && <small>{fmt(completed)} כבר נארזו בפועל</small>}</span>
            </div>;
          })}
        </div>
        {editing === "packaging" && <div className="bp-decided-list"><b>החלטות קיימות</b>{current.packaging.length ? current.packaging.map((r) => {
          const p = product(r.productId); const key = r.id ?? `${r.productId}:${r.tankId}`; const value = packDraft[key] ?? r.quantity; const open = openRunForSavedPlan(r); const completed = Math.max(0, r.quantity - (open?.remaining ?? r.quantity));
          return <div className="bp-rec-line" key={key}><span><b>{p ? displayStyle(p.style) : r.productId}</b> · מיכל {r.tankNumber ?? tanks.find((t) => t.id === r.tankId)?.number ?? "—"}{completed > 0 && <small> · {fmt(completed)} כבר בוצעו</small>}</span><input type="number" min={completed} value={value} onChange={(e) => setPackDraft((d) => ({ ...d, [key]: Math.max(completed, Number(e.target.value)) }))}/><button onClick={() => setPackDraft((d) => ({ ...d, [key]: completed }))}>בטל יתרה</button></div>;
        }) : <small>אין החלטות אריזה שמורות.</small>}
          <b>המלצות זמינות</b>{visiblePackagingRecommendations.length ? visiblePackagingRecommendations.map((r) => { const p = product(r.productId)!; const key = `rec:${r.id}`; const value = packDraft[key] ?? 0; return <div className="bp-rec-line" key={r.id}><span><b>{displayStyle(p.style)} · {p.type === "crates" ? "ארגזים" : "חביות"}</b> · מיכל {r.tankNumber}</span><input type="number" min="0" value={value} onChange={(e) => setPackDraft((d) => ({ ...d, [key]: Math.max(0, Number(e.target.value)) }))}/><button onClick={() => setPackDraft((d) => ({ ...d, [key]: value ? 0 : r.quantity }))}>{value ? "בטל" : `הוסף ${fmt(r.quantity)}`}</button></div>; }) : <small>אין המלצות נוספות מעבר להחלטות שכבר נקבעו.</small>}
          {manualPacks.map((r) => { const remaining = r.tankId ? remainingLitersForTank(r.tankId, r.id) : 0; return <div className="bp-manual-pack" key={r.id}><label>מיכל<select value={r.tankId} onChange={(e) => changeManualTank(r.id, e.target.value)}><option value="">בחר מיכל</option>{tanks.filter((t) => t.ready <= model.weekEnd && (model.tankAvailableLiters.get(t.id) ?? t.liters) >= 20).map((t) => <option value={t.id} key={t.id}>מיכל {t.number} · {displayStyle(t.style)} · {fmt(model.tankAvailableLiters.get(t.id) ?? t.liters)} ל׳</option>)}</select></label><label>פורמט<select value={r.productId} disabled={!r.tankId} onChange={(e) => changeManualProduct(r.id, e.target.value)}><option value="">בחר</option>{manualProductsForTank(r.tankId).map((p) => <option value={p.id} key={p.id}>{p.type === "crates" ? "ארגזים" : "חביות"}</option>)}</select></label><label>כמות<input type="number" min="0" value={r.quantity || ""} onChange={(e) => setManualPacks((rows) => rows.map((x) => x.id === r.id ? { ...x, quantity: Math.max(0, Number(e.target.value)) } : x))}/><small>יתרה לפני שורה זו: {fmt(remaining)} ל׳</small></label><button type="button" onClick={() => setManualPacks((rows) => rows.filter((x) => x.id !== r.id))}>הסר</button></div>; })}
          <button type="button" onClick={addManualPack}>+ הוסף אריזה</button>
        </div>}
        <div className="bp-actions">{editing === "packaging" ? <><button disabled={busy} onClick={savePackaging}>שמירת החלטת האריזה</button><button onClick={() => { setEditing(null); setManualPacks([]); }}>ביטול</button></> : <><button disabled={disabled || busy || !visiblePackagingRecommendations.length} onClick={acceptPackagingRecommendation}>{current.packaging.length ? "הוסף המלצות חסרות להחלטה" : "צור החלטה מההמלצה"}</button><button disabled={disabled || busy} onClick={() => beginEdit("packaging")}>עריכת האריזות</button></>}</div>
      </article>

      <article className="bp-week-rec-card">
        <header><div><small>3 · בישול · {selectedWeekText}</small><h3>מה לבשל השבוע</h3></div><b>{model.availableBrewTanks} מקומות בישול פנויים אחרי ההחלטות</b></header>
        <p className="bp-rec-principle">החלטת אריזה שמרוקנת מיכל נחשבת כריקון מתוכנן. אחרי ששיבצת בישול למיכל בלוח העבודה, אותו מיכל נחשב תפוס ואינו מוצע לבישול נוסף.</p>
        <div className="bp-decided-list"><b>המלצת המערכת</b>{model.brewRecommendations.length ? model.brewRecommendations.map((r, i) => <div className="bp-rec-line" key={`${r.style}:${i}`}><span><b>{displayStyle(r.style)}</b></span><span>{fmt(r.liters)} ל׳</span></div>) : <small>אין כרגע המלצת בישול נוספת.</small>}</div>
        <div className="bp-decided-list"><b>החלטות שנקבעו</b>{current.brews.length ? current.brews.map((b) => <div className="bp-rec-line" key={b.id}><span><b>{displayStyle(b.style)}</b></span><span>{fmt(b.liters)} ל׳{b.tankId ? ` · שובץ למיכל ${tanks.find((t) => t.id === b.tankId)?.number ?? b.tankId}` : " · טרם שובץ למיכל"}</span></div>) : <small>טרם נקבעו בישולים.</small>}</div>
        {editing === "brew" && <div className="bp-decided-list"><b>עריכת החלטת הבישול</b>{brewDraft.map((b, i) => <div className="bp-brew-edit-row" key={i}><select value={b.style} onChange={(e) => setBrewDraft((d) => d.map((x, j) => j === i ? { ...x, style: e.target.value } : x))}>{CORE_STYLES.map((s) => <option value={s} key={s}>{displayStyle(s)}</option>)}</select><input type="number" min="1" value={b.liters} onChange={(e) => setBrewDraft((d) => d.map((x, j) => j === i ? { ...x, liters: Number(e.target.value) } : x))}/><button onClick={() => setBrewDraft((d) => d.filter((_, j) => j !== i))}>הסר</button></div>)}</div>}
        <div className="bp-actions">{editing === "brew" ? <><button type="button" disabled={!model.brewRecommendations.length} onClick={pushBrewRecommendationsToDraft}>הוסף את ההמלצות לעריכה</button><button type="button" onClick={addBrew}>+ הוסף בישול</button><button disabled={busy} onClick={saveBrews}>שמירת החלטת הבישול</button><button onClick={() => setEditing(null)}>ביטול</button></> : <><button type="button" disabled={disabled || busy || !model.brewRecommendations.length} onClick={acceptBrewRecommendations}>{current.brews.length ? "הוסף המלצות בישול להחלטות" : "צור החלטות מהמלצות הבישול"}</button><button type="button" disabled={disabled || busy} onClick={addBrew}>+ הוסף בישול</button><button disabled={disabled || busy} onClick={() => beginEdit("brew")}>עריכת הבישולים</button></>}</div>
      </article>
    </div>
  </section>;
}
