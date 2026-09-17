import { Fragment, useMemo, useRef, useState, type TouchEvent } from "react";
import { beerStyleClass } from "../../SERVICES/cooler/Pallettypes ";
import {
  addDays,
  daysBetween,
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

type EditableSelection =
  | { kind: "brew"; weekId: string; brewId: string }
  | { kind: "packaging"; weekId: string; runIndex: number }
  | { kind: "custom"; weekId: string; eventId: string };

type EventDraft = {
  type: GeneralEventType;
  title: string;
  startDate: string;
  endDate: string;
  note: string;
};

const DAY_NAMES = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function dateInRange(date: string, start: string, end: string) {
  return date >= start && date <= end;
}

function rangeIncludes(date: string, start: string, end: string) {
  return date >= start && date <= end;
}

function sizeMultiplier(label: ReturnType<typeof brewSizeLabel>) {
  if (label === "משולש") return 3;
  if (label === "כפול") return 2;
  return 1;
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
    return [{
      key: `shipment:${weekId}`,
      title: "משלוח טמפו",
      meta: details,
    }];
  }

  function packagingSummary(weekId: string): CompactItem[] {
    const plan = planFor(weekId);
    if (!plan) return [];
    const grouped = new Map<string, {
      style: string;
      type: "crates" | "kegs";
      quantity: number;
      pending: number;
      tankNumbers: Set<string>;
    }>();
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
      meta: `${Math.round(item.quantity)} ${item.type === "crates" ? "בקבוקים" : "חביות"}`,
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
      events.push({
        key: `holiday:${holiday.date}:${holiday.title}`,
        label: holiday.title,
        type: "holiday",
      });
    }

    for (const source of plans) {
      const plan = asExtended(source);

      plan.packaging.forEach((run, runIndex) => {
        if (run.quantity <= 0 || run.date !== date) return;
        const product = productFor(run.productId);
        const style = product ? displayStyle(product.style) : run.productId;
        const number = tankNumber(run.tankId, run.tankNumber);
        const quantityLabel = product?.type === "crates" ? "בקבוקים" : "חביות";
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
        if (!rangeIncludes(date, brew.date, endDate)) continue;
        const tankId = resolvedBrewTank(plan, brew);
        const number = tankId ? tankNumber(tankId) : "?";
        const tentative = !brew.tankId;
        const note = brew.note ?? "";
        events.push({
          key: `${plan.id}:brew:${brew.id}`,
          label: `בישול ${displayStyle(brew.style)} · מיכל ${number}${tentative ? " מוצע" : ""}`,
          type: "brews",
          styleClass: beerStyleClass(brew.style).className,
          pending: tentative,
          note,
          startsBefore: date > brew.date,
          continuesAfter: date < endDate,
          selection: { kind: "brew", weekId: plan.id, brewId: brew.id },
        });
      }

      for (const custom of plan.calendarEvents ?? []) {
        if (!rangeIncludes(date, custom.startDate, custom.endDate)) continue;
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
      calendarEvents: [
        ...(plan.calendarEvents ?? []),
        {
          id: crypto.randomUUID(),
          type: eventDraft.type,
          title: eventDraft.title.trim(),
          startDate: eventDraft.startDate,
          endDate: eventDraft.endDate,
          note: eventDraft.note.trim(),
        },
      ],
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

  const activeBrew = selectedBrew();
  const activeCustom = selectedCustom();
  const activePlan = selectedPlan();
  const activePack = selected?.kind === "packaging" ? activePlan?.packaging[selected.runIndex] : undefined;
  const activePackNoteKey = selected?.kind === "packaging" ? `pack:${activePack?.id ?? selected.runIndex}` : "";
  const activePackNote = activePlan && activePackNoteKey ? noteFor(activePlan, activePackNoteKey) : "";

  async function saveBrewEdit(startDate: string, duration: number, note: string) {
    if (!selected || selected.kind !== "brew" || !activeBrew || !activePlan) return;
    const inferred = resolvedBrewTank(activePlan, activeBrew);
    await updatePlan(selected.weekId, (plan) => ({
      ...plan,
      brews: plan.brews.map((brew) => brew.id === selected.brewId ? {
        ...brew,
        date: startDate,
        endDate: addDays(startDate, duration - 1),
        note: note.trim(),
        tentativeTankId: brew.tankId ? brew.tentativeTankId : (brew.tentativeTankId || inferred),
      } : brew),
      changeReason: "עדכון אירוע בישול בלוח 5 שבועות",
    }));
    setSelected(null);
  }

  async function savePackagingNote(note: string) {
    if (!selected || selected.kind !== "packaging" || !activePlan) return;
    await updatePlan(selected.weekId, (plan) => ({
      ...plan,
      calendarNotes: { ...(plan.calendarNotes ?? {}), [activePackNoteKey]: note.trim() },
      changeReason: "עדכון הערת אריזה בלוח 5 שבועות",
    }));
    setSelected(null);
  }

  async function saveCustomEdit(title: string, startDate: string, endDate: string, note: string) {
    if (!selected || selected.kind !== "custom" || !activeCustom) return;
    if (!title.trim() || endDate < startDate) return;
    await updatePlan(selected.weekId, (plan) => ({
      ...plan,
      calendarEvents: (plan.calendarEvents ?? []).map((event) => event.id === selected.eventId ? {
        ...event,
        title: title.trim(),
        startDate,
        endDate,
        note: note.trim(),
      } : event),
      changeReason: "עדכון אירוע כללי בלוח 5 שבועות",
    }));
    setSelected(null);
  }

  async function deleteCustomEvent() {
    if (!selected || selected.kind !== "custom") return;
    await updatePlan(selected.weekId, (plan) => ({
      ...plan,
      calendarEvents: (plan.calendarEvents ?? []).filter((event) => event.id !== selected.eventId),
      changeReason: "מחיקת אירוע כללי מלוח 5 שבועות",
    }));
    setSelected(null);
  }

  function pinchDistance(event: TouchEvent<HTMLDivElement>) {
    const a = event.touches[0];
    const b = event.touches[1];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  function onTouchStart(event: TouchEvent<HTMLDivElement>) {
    if (event.touches.length !== 2) return;
    pinchRef.current = { distance: pinchDistance(event), zoom };
  }

  function onTouchMove(event: TouchEvent<HTMLDivElement>) {
    if (event.touches.length !== 2 || !pinchRef.current) return;
    event.preventDefault();
    const ratio = pinchDistance(event) / Math.max(1, pinchRef.current.distance);
    setZoom(clamp(pinchRef.current.zoom * ratio, 0.65, 1.6));
  }

  function onTouchEnd(event: TouchEvent<HTMLDivElement>) {
    if (event.touches.length < 2) pinchRef.current = null;
  }

  return (
    <section className="bp-five-week-overview">
      <div className="bp-section-heading bp-five-week-heading">
        <div>
          <h2>מבט 5 שבועות</h2>
          <p className="bp-muted">שבוע קודם, השבוע הנוכחי ושלושה שבועות קדימה.</p>
        </div>
        <div className="bp-five-week-toolbar">
          <div className="bp-five-week-toggle" role="group" aria-label="אופן תצוגה">
            <button type="button" aria-pressed={view === "calendar"} onClick={() => setView("calendar")}>לוח</button>
            <button type="button" aria-pressed={view === "summary"} onClick={() => setView("summary")}>סיכום שבועי</button>
          </div>
          <button type="button" disabled={disabled || busy} onClick={() => setShowEventForm((value) => !value)}>+ אירוע / חופשה</button>
        </div>
      </div>

      {message && <p className="bp-five-week-message" role="status">{message}</p>}

      {showEventForm && (
        <div className="bp-calendar-editor bp-calendar-add-event">
          <label>סוג
            <select value={eventDraft.type} onChange={(event) => setEventDraft((prev) => ({ ...prev, type: event.target.value as GeneralEventType }))}>
              <option value="general">אירוע כללי</option>
              <option value="vacation">חופשה</option>
            </select>
          </label>
          <label>כותרת<input value={eventDraft.title} onChange={(event) => setEventDraft((prev) => ({ ...prev, title: event.target.value }))} /></label>
          <label>מתאריך<input type="date" value={eventDraft.startDate} onChange={(event) => setEventDraft((prev) => ({ ...prev, startDate: event.target.value, endDate: prev.endDate < event.target.value ? event.target.value : prev.endDate }))} /></label>
          <label>עד תאריך<input type="date" value={eventDraft.endDate} onChange={(event) => setEventDraft((prev) => ({ ...prev, endDate: event.target.value }))} /></label>
          <label className="bp-calendar-note-field">הערה<textarea value={eventDraft.note} onChange={(event) => setEventDraft((prev) => ({ ...prev, note: event.target.value }))} /></label>
          <div className="bp-calendar-editor-actions">
            <button type="button" disabled={busy} onClick={addGeneralEvent}>שמירה</button>
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
                        <article className={`bp-five-week-item ${item.styleClass ?? ""} ${item.pending ? "is-pending" : ""}`} key={item.key}>
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
            <span>זום</span>
            <button type="button" onClick={() => setZoom((value) => clamp(value - 0.1, 0.65, 1.6))}>−</button>
            <button type="button" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
            <button type="button" onClick={() => setZoom((value) => clamp(value + 0.1, 0.65, 1.6))}>+</button>
            <small>אפשר גם pinch בשתי אצבעות</small>
          </div>
          <div className="bp-month-scroll" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
            <div
              className="bp-month-calendar"
              role="grid"
              aria-label="לוח תכנון לחמישה שבועות"
              style={{ minWidth: `${1050 * zoom}px` }}
            >
              {DAY_NAMES.map((name) => <div className="bp-month-day-name" key={name}>{name}</div>)}
              {calendarDays.map((date) => {
                const events = calendarEvents(date);
                const weekId = weekStart(date);
                return (
                  <div
                    className={`bp-month-day ${date === today ? "is-today" : ""} ${weekId === currentWeek ? "is-current-week" : ""} ${weekId === nextPlanningWeek ? "is-next-week" : ""}`}
                    key={date}
                    style={{ minHeight: `${126 * zoom}px` }}
                  >
                    <div className="bp-month-date"><b>{Number(date.slice(8, 10))}</b><small>{shortDate(date)}</small></div>
                    <div className="bp-month-events">
                      {events.map((event) => (
                        <button
                          type="button"
                          className={`bp-month-event is-${event.type} ${event.styleClass ?? ""} ${event.pending ? "is-pending" : ""} ${event.startsBefore ? "continues-before" : ""} ${event.continuesAfter ? "continues-after" : ""}`}
                          key={event.key}
                          title={event.note || event.label}
                          disabled={!event.selection || disabled}
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
            </div>
          </div>
        </>
      )}

      {selected?.kind === "brew" && activeBrew && activePlan && (
        <BrewEditor
          brew={activeBrew}
          tankNumber={String(tankNumber(resolvedBrewTank(activePlan, activeBrew)))}
          defaultEnd={brewEndDate(activeBrew)}
          busy={busy}
          onCancel={() => setSelected(null)}
          onSave={saveBrewEdit}
        />
      )}

      {selected?.kind === "packaging" && activePack && (
        <NoteEditor
          title="הערה לאירוע אריזה"
          initialValue={activePackNote}
          busy={busy}
          onCancel={() => setSelected(null)}
          onSave={savePackagingNote}
        />
      )}

      {selected?.kind === "custom" && activeCustom && (
        <CustomEventEditor
          event={activeCustom}
          busy={busy}
          onCancel={() => setSelected(null)}
          onDelete={deleteCustomEvent}
          onSave={saveCustomEdit}
        />
      )}
    </section>
  );
}

function NoteEditor({
  title,
  initialValue,
  busy,
  onCancel,
  onSave,
}: {
  title: string;
  initialValue: string;
  busy: boolean;
  onCancel: () => void;
  onSave: (note: string) => Promise<void>;
}) {
  const [note, setNote] = useState(initialValue);
  return (
    <div className="bp-calendar-editor bp-calendar-floating-editor">
      <h3>{title}</h3>
      <label className="bp-calendar-note-field">הערה<textarea value={note} onChange={(event) => setNote(event.target.value)} /></label>
      <div className="bp-calendar-editor-actions">
        <button type="button" disabled={busy} onClick={() => onSave(note)}>שמירה</button>
        <button type="button" onClick={onCancel}>ביטול</button>
      </div>
    </div>
  );
}

function BrewEditor({
  brew,
  tankNumber,
  defaultEnd,
  busy,
  onCancel,
  onSave,
}: {
  brew: ExtendedBrew;
  tankNumber: string;
  defaultEnd: string;
  busy: boolean;
  onCancel: () => void;
  onSave: (startDate: string, duration: number, note: string) => Promise<void>;
}) {
  const [startDate, setStartDate] = useState(brew.date);
  const initialDuration = clamp(daysBetween(brew.date, defaultEnd) + 1, 2, 3);
  const [duration, setDuration] = useState(initialDuration);
  const [note, setNote] = useState(brew.note ?? "");
  return (
    <div className="bp-calendar-editor bp-calendar-floating-editor">
      <h3>בישול {displayStyle(brew.style)} · מיכל {tankNumber}</h3>
      <div className="bp-brew-edit-move">
        <button type="button" onClick={() => setStartDate((date) => addDays(date, -1))}>← יום</button>
        <label>התחלה<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
        <button type="button" onClick={() => setStartDate((date) => addDays(date, 1))}>יום →</button>
      </div>
      <label>משך
        <select value={duration} onChange={(event) => setDuration(Number(event.target.value))}>
          <option value={3}>3 ימים</option>
          <option value={2}>2 ימים</option>
        </select>
      </label>
      <label className="bp-calendar-note-field">הערה<textarea value={note} onChange={(event) => setNote(event.target.value)} /></label>
      <div className="bp-calendar-editor-actions">
        <button type="button" disabled={busy} onClick={() => onSave(startDate, duration, note)}>שמירה</button>
        <button type="button" onClick={onCancel}>ביטול</button>
      </div>
    </div>
  );
}

function CustomEventEditor({
  event,
  busy,
  onCancel,
  onDelete,
  onSave,
}: {
  event: PlannerEvent;
  busy: boolean;
  onCancel: () => void;
  onDelete: () => Promise<void>;
  onSave: (title: string, startDate: string, endDate: string, note: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(event.title);
  const [startDate, setStartDate] = useState(event.startDate);
  const [endDate, setEndDate] = useState(event.endDate);
  const [note, setNote] = useState(event.note ?? "");
  return (
    <div className="bp-calendar-editor bp-calendar-floating-editor">
      <h3>{event.type === "vacation" ? "חופשה" : "אירוע כללי"}</h3>
      <label>כותרת<input value={title} onChange={(change) => setTitle(change.target.value)} /></label>
      <label>מתאריך<input type="date" value={startDate} onChange={(change) => setStartDate(change.target.value)} /></label>
      <label>עד תאריך<input type="date" value={endDate} onChange={(change) => setEndDate(change.target.value)} /></label>
      <label className="bp-calendar-note-field">הערה<textarea value={note} onChange={(change) => setNote(change.target.value)} /></label>
      <div className="bp-calendar-editor-actions">
        <button type="button" disabled={busy} onClick={() => onSave(title, startDate, endDate, note)}>שמירה</button>
        <button type="button" disabled={busy} onClick={onDelete}>מחיקה</button>
        <button type="button" onClick={onCancel}>ביטול</button>
      </div>
    </div>
  );
}
