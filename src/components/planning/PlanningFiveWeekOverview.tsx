import { Fragment, useMemo, useRef, useState, type TouchEvent } from "react";
import { beerStyleClass } from "../../SERVICES/cooler/Pallettypes ";
import {
  addDays,
  emptyWeek,
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
type GeneralEventType = "vacation" | "general";

type PlannerEvent = {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  type: GeneralEventType;
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
};

type CompactItem = {
  key: string;
  title: string;
  meta: string;
  pending?: boolean;
  styleClass?: string;
};

type EditableSelection =
  | { kind: "brew"; weekId: string; brewId: string }
  | { kind: "packaging"; weekId: string; runIndex: number }
  | { kind: "custom"; weekId: string; eventId: string };

type CalendarEvent = {
  key: string;
  label: string;
  type: "packaging" | "brews" | "holiday" | "vacation" | "general";
  styleClass?: string;
  pending?: boolean;
  note?: string;
  startsBefore?: boolean;
  continuesAfter?: boolean;
  selection?: EditableSelection;
};

type EventDraft = {
  type: GeneralEventType;
  title: string;
  startDate: string;
  endDate: string;
  note: string;
};

const DAY_NAMES = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
const BASE_CALENDAR_WIDTH = 1050;
const MIN_ZOOM = 0.32;
const MAX_ZOOM = 1.55;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function dateInRange(date: string, start: string, end: string) {
  return date >= start && date <= end;
}

function sizeMultiplier(label: ReturnType<typeof brewSizeLabel>) {
  if (label === "משולש") return 3;
  if (label === "כפול") return 2;
  return 1;
}

function sameSelection(a: EditableSelection | null, b?: EditableSelection) {
  if (!a || !b || a.kind !== b.kind || a.weekId !== b.weekId) return false;
  if (a.kind === "brew" && b.kind === "brew") return a.brewId === b.brewId;
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
  const rangeStart = weekIds[0];
  const rangeEnd = addDays(rangeStart, 34);
  const calendarDays = useMemo(
    () => Array.from({ length: 35 }, (_, index) => addDays(rangeStart, index)),
    [rangeStart],
  );

  const [eventDraft, setEventDraft] = useState<EventDraft>(() => ({
    type: "general",
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

  function inferredTentativeTank(plan: ExtendedPlan, brew: ExtendedBrew) {
    if (brew.tankId) return brew.tankId;
    if (brew.tentativeTankId) return brew.tentativeTankId;
    const reserved = new Set(
      plan.brews
        .filter((candidate) => candidate.id !== brew.id)
        .map((candidate) => candidate.tankId || candidate.tentativeTankId)
        .filter((id): id is string => !!id),
    );
    return tanks
      .filter((tank) => tank.ready <= addDays(plan.id, 6) && !reserved.has(tank.id))
      .sort((a, b) => a.ready.localeCompare(b.ready) || Number(a.number) - Number(b.number))[0]?.id;
  }

  function resolvedBrewTank(plan: ExtendedPlan, brew: ExtendedBrew) {
    return brew.tankId || brew.tentativeTankId || inferredTentativeTank(plan, brew);
  }

  function brewEndDate(brew: ExtendedBrew) {
    return brew.endDate && brew.endDate >= brew.date ? brew.endDate : addDays(brew.date, 2);
  }

  function brewCount(plan: ExtendedPlan, brew: ExtendedBrew) {
    const tankId = resolvedBrewTank(plan, brew);
    const number = tankId ? tankNumber(tankId) : undefined;
    return sizeMultiplier(brewSizeLabel(brew.liters, number));
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
    const details = Array.from(grouped.values())
      .map((item) => `${item.label} ${Math.round(item.quantity)}`)
      .join(" · ");
    return [{ key: `shipment:${weekId}`, title: "משלוח טמפו", meta: details }];
  }

  function packagingSummary(weekId: string): CompactItem[] {
    const plan = planFor(weekId);
    if (!plan) return [];
    const grouped = new Map<string, { style: string; type: "crates" | "kegs"; quantity: number; pending: number; tankNumbers: Set<string> }>();
    for (const run of plan.packaging.filter((item) => item.quantity > 0)) {
      const product = productFor(run.productId);
      if (!product) continue;
      const number = String(tankNumber(run.tankId, run.tankNumber));
      const key = `${run.productId}:${number}`;
      const current = grouped.get(key) ?? {
        style: displayStyle(product.style),
        type: product.type,
        quantity: 0,
        pending: 0,
        tankNumbers: new Set<string>(),
      };
      current.quantity += run.quantity;
      current.tankNumbers.add(number);
      if (!run.date) current.pending += 1;
      grouped.set(key, current);
    }
    return Array.from(grouped.entries()).map(([key, item]) => ({
      key,
      title: `הורדת ${item.style} · מיכל ${Array.from(item.tankNumbers).join(", ")}`,
      meta: `${Math.round(item.quantity)} ${item.type === "crates" ? "ארגזים" : "חביות"}`,
      pending: item.pending > 0 && weekId > currentWeek,
      styleClass: beerStyleClass(item.style).className,
    }));
  }

  function brewSummary(weekId: string): CompactItem[] {
    const plan = planFor(weekId);
    if (!plan) return [];
    const grouped = new Map<string, { count: number; pending: number }>();
    for (const brew of plan.brews) {
      const style = displayStyle(brew.style);
      const current = grouped.get(style) ?? { count: 0, pending: 0 };
      current.count += brewCount(plan, brew);
      if (!brew.tankId) current.pending += 1;
      grouped.set(style, current);
    }
    return Array.from(grouped.entries()).map(([style, item]) => ({
      key: style,
      title: style,
      meta: `${item.count} ${item.count === 1 ? "בישול" : "בישולים"}`,
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

  function calendarEvents(date: string): CalendarEvent[] {
    const events: CalendarEvent[] = [];
    for (const holiday of holidays.filter((item) => item.date === date)) {
      events.push({ key: `holiday:${holiday.date}:${holiday.title}`, label: holiday.title, type: "holiday" });
    }
    for (const source of plans) {
      const plan = asExtended(source);
      plan.packaging.forEach((run, runIndex) => {
        if (run.quantity <= 0 || run.date !== date) return;
        const product = productFor(run.productId);
        const style = product ? displayStyle(product.style) : run.productId;
        const number = tankNumber(run.tankId, run.tankNumber);
        const quantityLabel = product?.type === "crates" ? "ארגזים" : "חביות";
        const noteKey = `pack:${run.id ?? runIndex}`;
        const note = noteFor(plan, noteKey);
        events.push({
          key: `${plan.id}:${noteKey}`,
          label: `הורדת ${style} מיכל ${number} ל־${Math.round(run.quantity)} ${quantityLabel}`,
          type: "packaging",
          styleClass: beerStyleClass(style).className,
          note,
          selection: { kind: "packaging", weekId: plan.id, runIndex },
        });
      });
      for (const brew of plan.brews) {
        const endDate = brewEndDate(brew);
        if (!dateInRange(date, brew.date, endDate)) continue;
        const tankId = resolvedBrewTank(plan, brew);
        const number = tankId ? tankNumber(tankId) : "?";
        const tentative = !brew.tankId;
        events.push({
          key: `${plan.id}:brew:${brew.id}`,
          label: `בישול ${displayStyle(brew.style)} · מיכל ${number}${tentative ? " מוצע" : ""}`,
          type: "brews",
          styleClass: beerStyleClass(brew.style).className,
          pending: tentative,
          note: brew.note ?? "",
          startsBefore: date > brew.date,
          continuesAfter: date < endDate,
          selection: { kind: "brew", weekId: plan.id, brewId: brew.id },
        });
      }
      for (const custom of plan.calendarEvents ?? []) {
        if (!dateInRange(date, custom.startDate, custom.endDate)) continue;
        events.push({
          key: `${plan.id}:custom:${custom.id}`,
          label: custom.title,
          type: custom.type,
          note: custom.note,
          startsBefore: date > custom.startDate,
          continuesAfter: date < custom.endDate,
          selection: { kind: "custom", weekId: plan.id, eventId: custom.id },
        });
      }
    }
    return events;
  }

  async function updatePlan(weekId: string, updater: (plan: ExtendedPlan) => ExtendedPlan) {
    if (disabled || busy) return;
    const existing = planFor(weekId) ?? ({ ...emptyWeek(weekId), maxRuns: settings.preferredRuns } as ExtendedPlan);
    setBusy(true);
    setMessage("");
    try {
      await saveWeek(updater(existing) as WeekPlan);
      setMessage("נשמר");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "השמירה נכשלה");
    } finally {
      setBusy(false);
    }
  }

  async function addGeneralEvent() {
    if (!eventDraft.title.trim()) return setMessage("יש להזין שם לאירוע");
    if (eventDraft.endDate < eventDraft.startDate) return setMessage("תאריך הסיום חייב להיות אחרי תאריך ההתחלה");
    const weekId = weekStart(eventDraft.startDate);
    await updatePlan(weekId, (plan) => ({
      ...plan,
      calendarEvents: [...(plan.calendarEvents ?? []), {
        id: crypto.randomUUID(),
        type: eventDraft.type,
        title: eventDraft.title.trim(),
        startDate: eventDraft.startDate,
        endDate: eventDraft.endDate,
        note: eventDraft.note.trim(),
      }],
      changeReason: "עדכון אירועים בלוח 5 שבועות",
    }));
    setShowEventForm(false);
    setEventDraft({ type: "general", title: "", startDate: nextPlanningWeek, endDate: nextPlanningWeek, note: "" });
  }

  function selectedPlan() {
    return selected ? planFor(selected.weekId) : undefined;
  }

  function selectedBrew() {
    const plan = selectedPlan();
    return selected?.kind === "brew" ? plan?.brews.find((brew) => brew.id === selected.brewId) : undefined;
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
      if (selected.kind === "brew") {
        return {
          ...plan,
          brews: plan.brews.map((brew) => brew.id === selected.brewId ? { ...brew, note } : brew),
          changeReason: "עדכון טקסט אירוע בישול",
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

  const brew = selectedBrew();
  const custom = selectedCustom();
  const packaging = selectedPackaging();
  const selectedNote = brew?.note ?? custom?.note ?? selectedPackagingNote();
  const selectedPlanValue = selectedPlan();
  const selectedTankId = brew && selectedPlanValue ? resolvedBrewTank(selectedPlanValue, brew) : undefined;
  const selectedTitle = brew
    ? `בישול ${displayStyle(brew.style)} · מיכל ${selectedTankId ? tankNumber(selectedTankId) : "?"}${brew.tankId ? "" : " מוצע"}`
    : packaging
      ? (() => {
          const product = productFor(packaging.productId);
          const style = product ? displayStyle(product.style) : packaging.productId;
          return `הורדת ${style} מיכל ${tankNumber(packaging.tankId, packaging.tankNumber)} ל־${Math.round(packaging.quantity)} ${product?.type === "crates" ? "ארגזים" : "חביות"}`;
        })()
      : custom?.title ?? "אירוע";
  const selectedDates = brew
    ? `${shortDate(brew.date)}–${shortDate(brewEndDate(brew))}`
    : packaging?.date
      ? shortDate(packaging.date)
      : custom
        ? `${shortDate(custom.startDate)}${custom.endDate !== custom.startDate ? `–${shortDate(custom.endDate)}` : ""}`
        : "";

  return (
    <section className="bp-five-week-overview">
      <div className="bp-section-heading bp-five-week-heading">
        <div>
          <h2>מבט 5 שבועות</h2>
          <p className="bp-muted">שבוע קודם, השבוע הנוכחי ושלושה שבועות קדימה.</p>
        </div>
        <div className="bp-five-week-toolbar">
          <button type="button" onClick={() => setShowEventForm((value) => !value)}>+ אירוע / חופשה</button>
          <div className="bp-five-week-toggle" role="group" aria-label="אופן תצוגה">
            <button type="button" aria-pressed={view === "calendar"} onClick={() => setView("calendar")}>לוח 5 שבועות</button>
            <button type="button" aria-pressed={view === "summary"} onClick={() => setView("summary")}>סיכום שבועי</button>
          </div>
        </div>
      </div>

      {message && <p className="bp-five-week-message" role="status">{message}</p>}

      {showEventForm && (
        <div className="bp-calendar-editor">
          <h3>אירוע חדש</h3>
          <label>סוג<select value={eventDraft.type} onChange={(event) => setEventDraft((draft) => ({ ...draft, type: event.target.value as GeneralEventType }))}>
            <option value="general">אירוע כללי</option>
            <option value="vacation">חופשה</option>
          </select></label>
          <label>שם<input value={eventDraft.title} placeholder="שם האירוע" onChange={(event) => setEventDraft((draft) => ({ ...draft, title: event.target.value }))} /></label>
          <label>התחלה<input type="date" value={eventDraft.startDate} onChange={(event) => setEventDraft((draft) => ({ ...draft, startDate: event.target.value }))} /></label>
          <label>סיום<input type="date" value={eventDraft.endDate} onChange={(event) => setEventDraft((draft) => ({ ...draft, endDate: event.target.value }))} /></label>
          <label className="bp-calendar-note-field">הערה<input value={eventDraft.note} placeholder="הערה (אופציונלי)" onChange={(event) => setEventDraft((draft) => ({ ...draft, note: event.target.value }))} /></label>
          <div className="bp-calendar-editor-actions">
            <button type="button" disabled={disabled || busy} onClick={addGeneralEvent}>שמירה</button>
            <button type="button" onClick={() => setShowEventForm(false)}>ביטול</button>
          </div>
        </div>
      )}

      {view === "summary" ? (
        <div className="bp-five-week-scroll">
          <div className="bp-five-week-grid" role="table" aria-label="תכנון לחמישה שבועות">
            <div className="bp-five-week-corner" />
            {weekIds.map((weekId) => (
              <div
                key={`head:${weekId}`}
                className={`bp-five-week-head ${weekId === currentWeek ? "is-current" : ""} ${weekId === nextPlanningWeek ? "is-next" : ""}`}
              >
                <b>שבוע {weekNumber(weekId)}</b>
                <span>{shortDate(weekId)}–{shortDate(addDays(weekId, 6))}</span>
                {weekId === currentWeek && <small>השבוע</small>}
                {weekId === nextPlanningWeek && <small>שבוע התכנון הבא</small>}
              </div>
            ))}

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
          <div
            className="bp-month-scroll"
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={() => { pinchRef.current = null; }}
          >
            <div className="bp-month-zoom-layer" style={{ width: `${BASE_CALENDAR_WIDTH * zoom}px` }}>
              <div className="bp-month-calendar" role="grid" aria-label="לוח תכנון לחמישה שבועות">
                {DAY_NAMES.map((name) => <div className="bp-month-day-name" key={name}>{name}</div>)}
                {calendarDays.map((date) => {
                  const events = calendarEvents(date);
                  const weekId = weekStart(date);
                  const dayNumber = Number(date.slice(8, 10));
                  return (
                    <div
                      className={`bp-month-day ${date === today ? "is-today" : ""} ${weekId === currentWeek ? "is-current-week" : ""} ${weekId === nextPlanningWeek ? "is-next-week" : ""}`}
                      key={date}
                    >
                      <div className="bp-month-date"><b>{dayNumber}</b><small>{shortDate(date)}</small></div>
                      <div className="bp-month-events">
                        {events.map((event) => (
                          <button
                            type="button"
                            className={`bp-month-event is-${event.type} ${event.pending ? "is-pending" : ""} ${event.styleClass ?? ""} ${sameSelection(selected, event.selection) ? "is-selected" : ""}`}
                            key={event.key}
                            title={event.note || event.label}
                            disabled={!event.selection}
                            onClick={() => event.selection && setSelected(event.selection)}
                          >
                            <span>
                              {event.startsBefore && <span aria-hidden="true">← </span>}
                              {event.label}
                              {event.continuesAfter && <span aria-hidden="true"> →</span>}
                            </span>
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
        <div className="bp-calendar-editor bp-calendar-floating-editor">
          <h3>{selectedTitle}</h3>
          {selectedDates && <p className="bp-calendar-event-dates">{selectedDates}</p>}
          <p className="bp-calendar-event-lock">התכנון עצמו מנוהל במסך התכנון. כאן עורכים רק את הטקסט שמופיע ביומן.</p>
          <label className="bp-calendar-note-field">
            טקסט / הערה ביומן
            <textarea
              key={`${selected.kind}:${selected.weekId}:${selected.kind === "brew" ? selected.brewId : selected.kind === "custom" ? selected.eventId : selected.runIndex}:${selectedNote}`}
              defaultValue={selectedNote}
              placeholder="אפשר להוסיף כאן הערה שתופיע בתוך האירוע"
              onBlur={(event) => { if (event.target.value !== selectedNote) void saveSelectedNote(event.target.value); }}
            />
          </label>
          <div className="bp-calendar-editor-actions">
            <button type="button" onClick={() => setSelected(null)}>סגירה</button>
          </div>
        </div>
      )}
    </section>
  );
}
