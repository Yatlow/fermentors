import { Fragment, useMemo, useRef, useState, type CSSProperties, type TouchEvent } from "react";
import { beerStyleClass } from "../../SERVICES/cooler/Pallettypes ";
import {
  addDays,
  daysBetween,
  emptyWeek,
  sameStyle,
  weekNumber,
  weekStart,
  type Holiday,
  type Settings,
  type Tank,
  type WeekPlan,
} from "../../SERVICES/planning/planningEngine";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";
import { displayStyle } from "../../SERVICES/planning/planningPresentation";
import { brewSizeLabel } from "../../SERVICES/planning/productionCycle";

const ROWS = [
  { id: "deliveries", label: "משלוחים" },
  { id: "packaging", label: "אריזות" },
  { id: "brews", label: "בישולים" },
] as const;

type RowId = (typeof ROWS)[number]["id"];
type ViewMode = "summary" | "calendar";

type PlannerEvent = {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  type: "general";
  note?: string;
};

type ExtendedBrew = WeekPlan["brews"][number] & {
  endDate?: string;
  note?: string;
  tentativeTankId?: string;
};

type ExtendedPlan = Omit<WeekPlan, "brews"> & {
  brews: ExtendedBrew[];
  calendarEvents?: PlannerEvent[];
  calendarNotes?: Record<string, string>;
  calendarBrewDurationDays?: 2 | 3;
};

type CompactItem = {
  key: string;
  title: string;
  meta: string;
  pending?: boolean;
  styleClass?: string;
};

type EditableSelection =
  | { kind: "brewGroup"; weekId: string }
  | { kind: "packaging"; weekId: string; runIndex: number }
  | { kind: "custom"; weekId: string; eventId: string };

type DayEvent = {
  key: string;
  label: string;
  type: "packaging" | "holiday";
  styleClass?: string;
  note?: string;
  selection?: EditableSelection;
};

type SpanEvent = {
  key: string;
  label: string;
  kind: "brewGroup" | "custom";
  pending?: boolean;
  note?: string;
  selection: EditableSelection;
  startCol: number;
  endCol: number;
  lane: number;
};

type EventDraft = {
  title: string;
  startDate: string;
  endDate: string;
  note: string;
};

const DAY_NAMES = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
const MIN_ZOOM = 0.32;
const MAX_ZOOM = 1.55;
const BASE_CALENDAR_WIDTH = 1050;
const CRATE_LITERS = 24 * 0.33;
const KEG_LITERS = 20;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const minDate = (a: string, b: string) => (a < b ? a : b);
const maxDate = (a: string, b: string) => (a > b ? a : b);
const formatLiters = (liters: number) => `${Math.round(liters).toLocaleString("he-IL")} ל׳`;
const packagingLiters = (quantity: number, type: "crates" | "kegs") =>
  quantity * (type === "crates" ? CRATE_LITERS : KEG_LITERS);

function sizeMultiplier(label: ReturnType<typeof brewSizeLabel>) {
  if (label === "משולש") return 3;
  if (label === "כפול") return 2;
  return 1;
}

function sameSelection(a: EditableSelection | null, b?: EditableSelection) {
  if (!a || !b || a.kind !== b.kind || a.weekId !== b.weekId) return false;
  if (a.kind === "brewGroup" && b.kind === "brewGroup") return true;
  if (a.kind === "custom" && b.kind === "custom") return a.eventId === b.eventId;
  return a.kind === "packaging" && b.kind === "packaging" && a.runIndex === b.runIndex;
}

export default function PlanningFiveWeekOverview({
  settings,
  plans,
  tanks,
  holidays,
  today,
  disabled,
  saveWeek,
}: {
  settings: Settings;
  plans: WeekPlan[];
  tanks: Tank[];
  holidays: Holiday[];
  today: string;
  disabled: boolean;
  saveWeek: (week: WeekPlan) => Promise<void>;
}) {
  const [view, setView] = useState<ViewMode>("calendar");
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [showEventForm, setShowEventForm] = useState(false);
  const [selected, setSelected] = useState<EditableSelection | null>(null);
  const pinchRef = useRef<{ distance: number; zoom: number } | null>(null);

  const currentWeek = weekStart(today);
  const weekIds = useMemo(
    () => Array.from({ length: 5 }, (_, index) => addDays(currentWeek, (index - 1) * 7)),
    [currentWeek],
  );
  const nextPlanningWeek = addDays(currentWeek, 7);

  const [eventDraft, setEventDraft] = useState<EventDraft>(() => ({
    title: "",
    startDate: nextPlanningWeek,
    endDate: nextPlanningWeek,
    note: "",
  }));

  const productFor = (id: string) => settings.products.find((product) => product.id === id);
  const asExtended = (plan: WeekPlan): ExtendedPlan => plan as ExtendedPlan;
  const planFor = (weekId: string): ExtendedPlan | undefined => plans.find((item) => item.id === weekId) as ExtendedPlan | undefined;
  const tankNumber = (tankId?: string, fallback?: string | number) =>
    tanks.find((tank) => tank.id === tankId)?.number ?? fallback ?? "?";

  function tentativeTankMap(plan: ExtendedPlan) {
    const result = new Map<string, string>();
    const reserved = new Set<string>();

    for (const brew of plan.brews) {
      const existing = brew.tankId || brew.tentativeTankId;
      if (!existing) continue;
      result.set(brew.id, existing);
      reserved.add(existing);
    }

    for (const brew of plan.brews) {
      if (result.has(brew.id)) continue;
      const candidate = tanks
        .filter((tank) => tank.ready <= addDays(plan.id, 6) && !reserved.has(tank.id))
        .sort((a, b) => a.ready.localeCompare(b.ready) || Number(a.number) - Number(b.number))[0];
      if (!candidate) continue;
      result.set(brew.id, candidate.id);
      reserved.add(candidate.id);
    }

    return result;
  }

  function resolvedBrewTank(plan: ExtendedPlan, brew: ExtendedBrew) {
    return tentativeTankMap(plan).get(brew.id);
  }

  function tentativePackagingTankMap(plan: ExtendedPlan) {
    const result = new Map<string, string>();
    const usedLiters = new Map<string, number>();
    const runKey = (run: WeekPlan["packaging"][number], index: number) => String(run.id ?? index);

    plan.packaging.forEach((run, index) => {
      const product = productFor(run.productId);
      if (!product || run.quantity <= 0) return;
      const explicitTankId = run.tankId || tanks.find((tank) => String(tank.number) === String(run.tankNumber ?? ""))?.id;
      if (!explicitTankId) return;
      result.set(runKey(run, index), explicitTankId);
      usedLiters.set(
        explicitTankId,
        (usedLiters.get(explicitTankId) ?? 0) + packagingLiters(run.quantity, product.type),
      );
    });

    plan.packaging.forEach((run, index) => {
      const key = runKey(run, index);
      if (result.has(key) || run.quantity <= 0) return;
      const product = productFor(run.productId);
      if (!product) return;
      const needed = packagingLiters(run.quantity, product.type);
      const targetDate = run.date ?? addDays(plan.id, 6);
      const candidate = tanks
        .filter((tank) =>
          tank.ready <= targetDate &&
          sameStyle(tank.style, product.style) &&
          Math.max(0, tank.liters - (usedLiters.get(tank.id) ?? 0)) >= needed
        )
        .sort((a, b) => a.ready.localeCompare(b.ready) || Number(a.number) - Number(b.number))[0];
      if (!candidate) return;
      result.set(key, candidate.id);
      usedLiters.set(candidate.id, (usedLiters.get(candidate.id) ?? 0) + needed);
    });

    return result;
  }

  function resolvedPackagingTank(plan: ExtendedPlan, run: WeekPlan["packaging"][number], runIndex: number) {
    const explicit = run.tankId || tanks.find((tank) => String(tank.number) === String(run.tankNumber ?? ""))?.id;
    if (explicit) return { number: tankNumber(explicit, run.tankNumber), tentative: false };
    const candidate = tentativePackagingTankMap(plan).get(String(run.id ?? runIndex));
    return candidate
      ? { number: tankNumber(candidate), tentative: true }
      : { number: "?", tentative: false };
  }

  function packagingTankLabel(plan: ExtendedPlan, run: WeekPlan["packaging"][number], runIndex: number) {
    const resolved = resolvedPackagingTank(plan, run, runIndex);
    return resolved.tentative ? `${resolved.number} (מוצע)` : String(resolved.number);
  }

  function brewEndDate(brew: ExtendedBrew) {
    return brew.endDate && brew.endDate >= brew.date ? brew.endDate : addDays(brew.date, 2);
  }

  function brewCount(plan: ExtendedPlan, brew: ExtendedBrew) {
    const tankId = resolvedBrewTank(plan, brew);
    const number = tankId ? tankNumber(tankId) : undefined;
    return sizeMultiplier(brewSizeLabel(brew.liters, number));
  }

  function weeklyProductionTotals(weekId: string) {
    const plan = planFor(weekId);
    if (!plan) return { packaging: 0, brewing: 0 };

    const packaging = plan.packaging.reduce((sum, run) => {
      const product = productFor(run.productId);
      if (!product || run.quantity <= 0) return sum;
      return sum + packagingLiters(run.quantity, product.type);
    }, 0);

    const brewing = plan.brews.reduce((sum, brew) => {
      const liters = Number(brew.liters);
      return sum + (Number.isFinite(liters) && liters > 0 ? liters : 0);
    }, 0);

    return { packaging, brewing };
  }

  function shipmentSummary(weekId: string): CompactItem[] {
    const plan = planFor(weekId);
    if (!plan?.deliveries?.length) return [];
    const grouped = new Map<string, { label: string; quantity: number }>();
    for (const delivery of plan.deliveries) {
      const product = productFor(delivery.productId);
      const label = product
        ? `${displayStyle(product.style)} ${product.type === "crates" ? "ארגזים" : "חביות"}`
        : delivery.productId;
      const current = grouped.get(delivery.productId) ?? { label, quantity: 0 };
      current.quantity += delivery.quantity;
      grouped.set(delivery.productId, current);
    }
    return [{
      key: `shipment:${weekId}`,
      title: "משלוח טמפו",
      meta: Array.from(grouped.values()).map((item) => `${item.label} ${Math.round(item.quantity)}`).join(" · "),
    }];
  }

  function packagingSummary(weekId: string): CompactItem[] {
    const plan = planFor(weekId);
    if (!plan) return [];
    const grouped = new Map<string, { style: string; type: "crates" | "kegs"; quantity: number; liters: number; pending: number; tanks: Set<string> }>();
    plan.packaging.filter((item) => item.quantity > 0).forEach((run, runIndex) => {
      const product = productFor(run.productId);
      if (!product) return;
      const number = packagingTankLabel(plan, run, runIndex);
      const key = `${run.productId}:${number}`;
      const item = grouped.get(key) ?? {
        style: displayStyle(product.style),
        type: product.type,
        quantity: 0,
        liters: 0,
        pending: 0,
        tanks: new Set<string>(),
      };
      item.quantity += run.quantity;
      item.liters += packagingLiters(run.quantity, product.type);
      item.tanks.add(number);
      if (!run.date) item.pending += 1;
      grouped.set(key, item);
    });
    return Array.from(grouped.entries()).map(([key, item]) => ({
      key,
      title: `הורדת ${item.style} · מיכל ${Array.from(item.tanks).join(", ")}`,
      meta: `${Math.round(item.quantity)} ${item.type === "crates" ? "ארגזים" : "חביות"} · ${formatLiters(item.liters)}`,
      pending: item.pending > 0 && weekId > currentWeek,
      styleClass: beerStyleClass(item.style).className,
    }));
  }

  function brewSummary(weekId: string): CompactItem[] {
    const plan = planFor(weekId);
    if (!plan) return [];
    const grouped = new Map<string, { count: number; liters: number; pending: number }>();
    for (const brew of plan.brews) {
      const style = displayStyle(brew.style);
      const item = grouped.get(style) ?? { count: 0, liters: 0, pending: 0 };
      item.count += brewCount(plan, brew);
      const liters = Number(brew.liters);
      if (Number.isFinite(liters) && liters > 0) item.liters += liters;
      if (!brew.tankId) item.pending += 1;
      grouped.set(style, item);
    }
    return Array.from(grouped.entries()).map(([style, item]) => ({
      key: style,
      title: style,
      meta: `${item.count} ${item.count === 1 ? "בישול" : "בישולים"} · ${formatLiters(item.liters)}`,
      pending: item.pending > 0 && weekId > currentWeek,
      styleClass: beerStyleClass(style).className,
    }));
  }

  function itemsFor(row: RowId, weekId: string) {
    if (row === "deliveries") return shipmentSummary(weekId);
    if (row === "packaging") return packagingSummary(weekId);
    return brewSummary(weekId);
  }

  function noteFor(plan: ExtendedPlan, key: string) {
    return plan.calendarNotes?.[key] ?? "";
  }

  function dayEvents(date: string): DayEvent[] {
    const events: DayEvent[] = holidays
      .filter((item) => item.date === date)
      .map((item) => ({ key: `holiday:${item.date}:${item.title}`, label: item.title, type: "holiday" as const }));

    for (const source of plans) {
      const plan = asExtended(source);
      plan.packaging.forEach((run, runIndex) => {
        if (run.quantity <= 0 || run.date !== date) return;
        const product = productFor(run.productId);
        const style = product ? displayStyle(product.style) : run.productId;
        const number = packagingTankLabel(plan, run, runIndex);
        const quantityLabel = product?.type === "crates" ? "ארגזים" : "חביות";
        const noteKey = `pack:${run.id ?? runIndex}`;
        events.push({
          key: `${plan.id}:${noteKey}`,
          label: `הורדת ${style} מיכל ${number} ל־${Math.round(run.quantity)} ${quantityLabel}`,
          type: "packaging",
          note: noteFor(plan, noteKey),
          selection: { kind: "packaging", weekId: plan.id, runIndex },
        });
      });
    }
    return events;
  }

  function brewGroupLabel(plan: ExtendedPlan) {
    const tankMap = tentativeTankMap(plan);
    const parts = plan.brews.map((brew) => {
      const tankId = tankMap.get(brew.id);
      const number = tankId ? tankNumber(tankId) : "לא נמצא";
      return `${displayStyle(brew.style)} מיכל ${number}`;
    });
    return `בישולים- ${parts.join(" · ")}`;
  }

  function brewGroupRange(plan: ExtendedPlan) {
    if (!plan.brews.length) return null;
    const start = plan.brews.map((brew) => brew.date).sort()[0];
    const explicitDuration =
      plan.calendarBrewDurationDays ??
      Number(plan.calendarNotes?.["brew-duration-days"]);
    if (explicitDuration === 2 || explicitDuration === 3) {
      return { start, end: addDays(start, explicitDuration - 1) };
    }
    const end = plan.brews.map((brew) => brewEndDate(brew)).sort().at(-1);
    return end ? { start, end } : null;
  }

  function spanEventsForWeek(weekId: string): { events: SpanEvent[]; laneCount: number } {
    const weekEnd = addDays(weekId, 6);
    const candidates: Array<Omit<SpanEvent, "startCol" | "endCol" | "lane"> & { start: string; end: string }> = [];

    for (const source of plans) {
      const plan = asExtended(source);
      const range = brewGroupRange(plan);
      if (range && range.end >= weekId && range.start <= weekEnd) {
        candidates.push({
          key: `${plan.id}:brew-group`,
          label: brewGroupLabel(plan),
          kind: "brewGroup",
          pending: plan.brews.some((brew) => !brew.tankId),
          note: noteFor(plan, "brew-group"),
          selection: { kind: "brewGroup", weekId: plan.id },
          start: maxDate(range.start, weekId),
          end: minDate(range.end, weekEnd),
        });
      }

      for (const event of plan.calendarEvents ?? []) {
        if (event.endDate < weekId || event.startDate > weekEnd) continue;
        candidates.push({
          key: `${plan.id}:custom:${event.id}`,
          label: event.title,
          kind: "custom",
          note: event.note,
          selection: { kind: "custom", weekId: plan.id, eventId: event.id },
          start: maxDate(event.startDate, weekId),
          end: minDate(event.endDate, weekEnd),
        });
      }
    }

    candidates.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
    const laneEnds: string[] = [];
    const events = candidates.map((item) => {
      let lane = laneEnds.findIndex((end) => end < item.start);
      if (lane < 0) {
        lane = laneEnds.length;
        laneEnds.push(item.end);
      } else {
        laneEnds[lane] = item.end;
      }
      return {
        ...item,
        startCol: daysBetween(weekId, item.start) + 1,
        endCol: daysBetween(weekId, item.end) + 2,
        lane,
      };
    });
    return { events, laneCount: laneEnds.length };
  }

  async function updatePlan(weekId: string, updater: (plan: ExtendedPlan) => ExtendedPlan): Promise<boolean> {
    if (disabled || busy) return false;
    const existing = planFor(weekId) ?? ({ ...emptyWeek(weekId), maxRuns: settings.preferredRuns } as ExtendedPlan);
    setBusy(true);
    setMessage("");
    try {
      await saveWeek(updater(existing) as WeekPlan);
      setMessage("נשמר");
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "השמירה נכשלה");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addGeneralEvent() {
    if (!eventDraft.title.trim()) return setMessage("יש להזין שם לאירוע");
    if (eventDraft.endDate < eventDraft.startDate) return setMessage("תאריך הסיום חייב להיות אחרי תאריך ההתחלה");
    const weekId = weekStart(eventDraft.startDate);
    const saved = await updatePlan(weekId, (plan) => ({
      ...plan,
      calendarEvents: [...(plan.calendarEvents ?? []), {
        id: crypto.randomUUID(),
        type: "general",
        title: eventDraft.title.trim(),
        startDate: eventDraft.startDate,
        endDate: eventDraft.endDate,
        note: eventDraft.note.trim(),
      }],
      changeReason: "הוספת אירוע ללוח 5 שבועות",
    }));
    if (!saved) return;
    setShowEventForm(false);
    setEventDraft({ title: "", startDate: nextPlanningWeek, endDate: nextPlanningWeek, note: "" });
  }

  function selectedPlan() {
    return selected ? planFor(selected.weekId) : undefined;
  }

  function selectedCustom() {
    const plan = selectedPlan();
    return selected?.kind === "custom" ? plan?.calendarEvents?.find((event) => event.id === selected.eventId) : undefined;
  }

  function selectedPackaging() {
    const plan = selectedPlan();
    return selected?.kind === "packaging" ? plan?.packaging[selected.runIndex] : undefined;
  }

  function selectedPackagingNote() {
    const plan = selectedPlan();
    const run = selectedPackaging();
    if (!plan || !run || selected?.kind !== "packaging") return "";
    return noteFor(plan, `pack:${run.id ?? selected.runIndex}`);
  }

  async function saveSelectedNote(note: string) {
    if (!selected) return;
    await updatePlan(selected.weekId, (plan) => {
      if (selected.kind === "brewGroup") {
        return {
          ...plan,
          calendarNotes: { ...(plan.calendarNotes ?? {}), "brew-group": note },
          changeReason: "עדכון טקסט אירוע בישולים",
        };
      }
      if (selected.kind === "custom") {
        return {
          ...plan,
          calendarEvents: (plan.calendarEvents ?? []).map((event) => event.id === selected.eventId ? { ...event, note } : event),
          changeReason: "עדכון טקסט אירוע",
        };
      }
      const run = plan.packaging[selected.runIndex];
      if (!run) return plan;
      const key = `pack:${run.id ?? selected.runIndex}`;
      return {
        ...plan,
        calendarNotes: { ...(plan.calendarNotes ?? {}), [key]: note },
        changeReason: "עדכון טקסט אירוע אריזה",
      };
    });
  }

  async function saveCustomTitle(title: string) {
    if (selected?.kind !== "custom" || !title.trim()) return;
    await updatePlan(selected.weekId, (plan) => ({
      ...plan,
      calendarEvents: (plan.calendarEvents ?? []).map((event) => event.id === selected.eventId ? { ...event, title: title.trim() } : event),
      changeReason: "עדכון שם אירוע",
    }));
  }

  async function moveSelectedBrewGroupTo(nextDate: string) {
    if (selected?.kind !== "brewGroup") return;
    const plan = selectedPlan();
    const range = plan ? brewGroupRange(plan) : null;
    if (!plan || !range) return;
    const duration = daysBetween(range.start, range.end) + 1;
    const nextEnd = addDays(nextDate, duration - 1);
    if (weekStart(nextDate) !== selected.weekId || nextEnd > addDays(selected.weekId, 6)) {
      setMessage("אפשר להזיז את הבישולים רק בתוך אותו שבוע");
      return;
    }
    const delta = daysBetween(range.start, nextDate);
    await updatePlan(selected.weekId, (current) => ({
      ...current,
      brews: current.brews.map((brew) => ({
        ...brew,
        date: addDays(brew.date, delta),
        endDate: addDays(brewEndDate(brew), delta),
      })),
      changeReason: "הזזת ימי הבישול בלוח 5 שבועות",
    }));
  }

  async function resizeSelectedBrewGroup(days: 2 | 3) {
    if (selected?.kind !== "brewGroup") return;
    const plan = selectedPlan();
    const range = plan ? brewGroupRange(plan) : null;
    if (!plan || !range) return;
    const nextEnd = addDays(range.start, days - 1);
    if (nextEnd > addDays(selected.weekId, 6)) return setMessage("משך הבישולים חייב להישאר בתוך אותו שבוע");
    await updatePlan(selected.weekId, (current) => ({
      ...current,
      calendarNotes: {
        ...(current.calendarNotes ?? {}),
        "brew-duration-days": String(days),
      },
      changeReason: "שינוי משך הבישולים בלוח 5 שבועות",
    }));
  }

  async function deleteSelectedCustomEvent() {
    if (selected?.kind !== "custom") return;
    const eventId = selected.eventId;
    const saved = await updatePlan(selected.weekId, (plan) => ({
      ...plan,
      calendarEvents: (plan.calendarEvents ?? []).filter((event) => event.id !== eventId),
      changeReason: "מחיקת אירוע ידני מלוח 5 שבועות",
    }));
    if (saved) setSelected(null);
  }

  function touchDistance(event: TouchEvent<HTMLDivElement>) {
    if (event.touches.length < 2) return null;
    const a = event.touches[0];
    const b = event.touches[1];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  function handleTouchStart(event: TouchEvent<HTMLDivElement>) {
    const distance = touchDistance(event);
    if (distance) pinchRef.current = { distance, zoom };
  }

  function handleTouchMove(event: TouchEvent<HTMLDivElement>) {
    const distance = touchDistance(event);
    const initial = pinchRef.current;
    if (!distance || !initial) return;
    event.preventDefault();
    setZoom(clamp(initial.zoom * (distance / initial.distance), MIN_ZOOM, MAX_ZOOM));
  }

  const selectedPlanValue = selectedPlan();
  const custom = selectedCustom();
  const packaging = selectedPackaging();
  const selectedBrewRange = selected?.kind === "brewGroup" && selectedPlanValue ? brewGroupRange(selectedPlanValue) : null;
  const selectedNote = selected?.kind === "brewGroup" && selectedPlanValue
    ? noteFor(selectedPlanValue, "brew-group")
    : custom?.note ?? selectedPackagingNote();
  const selectedTitle = selected?.kind === "brewGroup" && selectedPlanValue
    ? brewGroupLabel(selectedPlanValue)
    : packaging && selectedPlanValue && selected?.kind === "packaging"
      ? (() => {
          const product = productFor(packaging.productId);
          const style = product ? displayStyle(product.style) : packaging.productId;
          const number = packagingTankLabel(selectedPlanValue, packaging, selected.runIndex);
          return `הורדת ${style} מיכל ${number} ל־${Math.round(packaging.quantity)} ${product?.type === "crates" ? "ארגזים" : "חביות"}`;
        })()
      : custom?.title ?? "אירוע";
  const selectedDates = selectedBrewRange
    ? `${shortDate(selectedBrewRange.start)}–${shortDate(selectedBrewRange.end)}`
    : packaging?.date
      ? shortDate(packaging.date)
      : custom
        ? `${shortDate(custom.startDate)}${custom.endDate !== custom.startDate ? `–${shortDate(custom.endDate)}` : ""}`
        : "";
  const brewDuration = selectedBrewRange ? daysBetween(selectedBrewRange.start, selectedBrewRange.end) + 1 : 0;
  const maxBrewStart = selected?.kind === "brewGroup" && selectedBrewRange
    ? addDays(addDays(selected.weekId, 6), -(brewDuration - 1))
    : "";

  return (
    <section className="bp-five-week-overview">
      <div className="bp-section-heading bp-five-week-heading">
        <div>
          <h2>מבט 5 שבועות</h2>
          <p className="bp-muted">שבוע קודם, השבוע הנוכחי ושלושה שבועות קדימה.</p>
        </div>
        <div className="bp-five-week-toolbar">
          {view === "calendar" && <button type="button" onClick={() => setShowEventForm((value) => !value)}>+ אירוע</button>}
          <div className="bp-five-week-toggle" role="group" aria-label="אופן תצוגה">
            <button type="button" aria-pressed={view === "calendar"} onClick={() => setView("calendar")}>לוח 5 שבועות</button>
            <button type="button" aria-pressed={view === "summary"} onClick={() => setView("summary")}>סיכום שבועי</button>
          </div>
        </div>
      </div>

      {message && <p className="bp-five-week-message" role="status">{message}</p>}

      {view === "calendar" && showEventForm && (
        <div className="bp-calendar-editor">
          <h3>אירוע חדש</h3>
          <label>שם<input value={eventDraft.title} placeholder="שם האירוע" onChange={(event) => setEventDraft((draft) => ({ ...draft, title: event.target.value }))} /></label>
          <label>התחלה<input type="date" value={eventDraft.startDate} onChange={(event) => setEventDraft((draft) => ({ ...draft, startDate: event.target.value }))} /></label>
          <label>סיום<input type="date" value={eventDraft.endDate} onChange={(event) => setEventDraft((draft) => ({ ...draft, endDate: event.target.value }))} /></label>
          <label className="bp-calendar-note-field">הערה<input value={eventDraft.note} placeholder="הערה (אופציונלי)" onChange={(event) => setEventDraft((draft) => ({ ...draft, note: event.target.value }))} /></label>
          <div className="bp-calendar-editor-actions">
            <button type="button" disabled={disabled || busy} onClick={() => void addGeneralEvent()}>שמירה</button>
            <button type="button" onClick={() => setShowEventForm(false)}>ביטול</button>
          </div>
        </div>
      )}

      {view === "summary" ? (
        <div className="bp-five-week-scroll">
          <div className="bp-five-week-grid" role="table" aria-label="תכנון לחמישה שבועות">
            <div className="bp-five-week-corner" />
            {weekIds.map((weekId) => {
              const totals = weeklyProductionTotals(weekId);
              return (
                <div key={`head:${weekId}`} className={`bp-five-week-head ${weekId === currentWeek ? "is-current" : ""} ${weekId === nextPlanningWeek ? "is-next" : ""}`}>
                  <b>שבוע {weekNumber(weekId)}</b>
                  <span>{shortDate(weekId)}–{shortDate(addDays(weekId, 6))}</span>
                  {(totals.packaging > 0 || totals.brewing > 0) && (
                    <small>{`אריזה ${formatLiters(totals.packaging)} · בישול ${formatLiters(totals.brewing)}`}</small>
                  )}
                  {weekId === currentWeek && <small>השבוע</small>}
                  {weekId === nextPlanningWeek && <small>שבוע התכנון הבא</small>}
                </div>
              );
            })}
            {ROWS.map((row) => (
              <Fragment key={row.id}>
                <div className={`bp-five-week-row-label is-${row.id}`}>{row.label}</div>
                {weekIds.map((weekId) => {
                  const items = itemsFor(row.id, weekId);
                  return (
                    <div className={`bp-five-week-cell is-${row.id}`} key={`${row.id}:${weekId}`}>
                      {items.map((item) => (
                        <article className={`bp-five-week-item ${item.pending ? "is-pending" : ""} ${item.styleClass ?? ""}`} key={item.key}>
                          <b>{item.title}</b>
                          <small>{item.meta}</small>
                          {item.pending && <span>ממתין לשיבוץ</span>}
                        </article>
                      ))}
                      {!items.length && <span className="bp-five-week-empty">—</span>}
                    </div>
                  );
                })}
              </Fragment>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="bp-calendar-zoom-bar">
            <b>זום</b>
            <button type="button" onClick={() => setZoom((value) => clamp(value - .1, MIN_ZOOM, MAX_ZOOM))}>−</button>
            <span>{Math.round(zoom * 100)}%</span>
            <button type="button" onClick={() => setZoom((value) => clamp(value + .1, MIN_ZOOM, MAX_ZOOM))}>+</button>
            <button type="button" onClick={() => setZoom(1)}>איפוס</button>
            <small>אפשר גם pinch בשתי אצבעות</small>
          </div>
          <div className="bp-month-scroll" onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={() => { pinchRef.current = null; }}>
            <div className="bp-month-zoom-shell" style={{ width: `${BASE_CALENDAR_WIDTH * zoom}px` }}>
              <div className="bp-month-zoom-layer" style={{ transform: `scale(${zoom})`, width: `${BASE_CALENDAR_WIDTH}px` }}>
                <div className="bp-month-day-names">
                  {DAY_NAMES.map((name) => <div className="bp-month-day-name" key={name}>{name}</div>)}
                </div>
                {weekIds.map((weekId) => {
                  const days = Array.from({ length: 7 }, (_, index) => addDays(weekId, index));
                  const spans = spanEventsForWeek(weekId);
                  return (
                    <div className="bp-month-week" key={weekId} style={{ "--span-rows": spans.laneCount } as CSSProperties}>
                      {days.map((date) => {
                        const events = dayEvents(date);
                        return (
                          <div className={`bp-month-day ${date === today ? "is-today" : ""} ${weekId === currentWeek ? "is-current-week" : ""} ${weekId === nextPlanningWeek ? "is-next-week" : ""}`} key={date}>
                            <div className="bp-month-date"><b>{Number(date.slice(8, 10))}</b><small>{shortDate(date)}</small></div>
                            <div className="bp-month-events">
                              {events.map((event) => (
                                <button
                                  type="button"
                                  className={`bp-month-event is-${event.type} ${event.styleClass ?? ""} ${sameSelection(selected, event.selection) ? "is-selected" : ""}`}
                                  key={event.key}
                                  title={event.note || event.label}
                                  disabled={!event.selection}
                                  onClick={() => event.selection && setSelected(event.selection)}
                                >
                                  <span>{event.label}</span>
                                  {event.note && <small>{event.note}</small>}
                                </button>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                      <div className="bp-week-span-layer" aria-label={`אירועים שבוע ${weekNumber(weekId)}`}>
                        {spans.events.map((event) => (
                          <button
                            type="button"
                            key={event.key}
                            className={`bp-span-event is-${event.kind} ${event.pending ? "is-pending" : ""} ${sameSelection(selected, event.selection) ? "is-selected" : ""}`}
                            style={{ gridColumn: `${event.startCol} / ${event.endCol}`, gridRow: event.lane + 1 }}
                            title={event.note || event.label}
                            onClick={() => { setSelected(event.selection); setMessage(""); }}
                          >
                            <span>{event.label}</span>
                            {event.note && <small>{event.note}</small>}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </>
      )}

      {selected && (
        <div className="bp-calendar-editor-backdrop" onClick={() => setSelected(null)}>
          <div className="bp-calendar-editor bp-calendar-floating-editor" onClick={(event) => event.stopPropagation()}>
            <h3>{selectedTitle}</h3>
            {selectedDates && <p className="bp-calendar-event-dates">{selectedDates}</p>}
            {selected.kind === "brewGroup" && selectedBrewRange && (
              <>
                <label>
                  תחילת הבישולים
                  <input type="date" value={selectedBrewRange.start} min={selected.weekId} max={maxBrewStart} disabled={disabled || busy} onChange={(event) => void moveSelectedBrewGroupTo(event.target.value)} />
                </label>
                <div className="bp-calendar-editor-actions">
                  <span>משך:</span>
                  <button type="button" className={brewDuration === 2 ? "active" : ""} disabled={disabled || busy} onClick={() => void resizeSelectedBrewGroup(2)}>2 ימים</button>
                  <button type="button" className={brewDuration === 3 ? "active" : ""} disabled={disabled || busy} onClick={() => void resizeSelectedBrewGroup(3)}>3 ימים</button>
                </div>
              </>
            )}
            {selected.kind === "custom" && custom && (
              <label>שם האירוע<input key={`title:${custom.id}:${custom.title}`} defaultValue={custom.title} onBlur={(event) => { if (event.target.value.trim() && event.target.value.trim() !== custom.title) void saveCustomTitle(event.target.value); }} /></label>
            )}
            <label className="bp-calendar-note-field">
              טקסט / הערה ביומן
              <textarea
                key={`${selected.kind}:${selected.weekId}:${selected.kind === "custom" ? selected.eventId : selected.kind === "packaging" ? selected.runIndex : "group"}:${selectedNote}`}
                defaultValue={selectedNote}
                placeholder="אפשר להוסיף כאן הערה שתופיע בתוך האירוע"
                onBlur={(event) => { if (event.target.value !== selectedNote) void saveSelectedNote(event.target.value); }}
              />
            </label>
            <div className="bp-calendar-editor-actions">
              {selected.kind === "custom" && (
                <button type="button" className="bp-danger-button" disabled={disabled || busy} onClick={() => void deleteSelectedCustomEvent()}>
                  מחיקת אירוע
                </button>
              )}
              <button type="button" onClick={() => setSelected(null)}>סגירה</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
