import BeerLoader from "../general/Loading";
import { useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import type { Pallet } from "../../SERVICES/cooler/Pallettypes ";
import {
  addDays,
  emptyWeek,
  sameStyle,
  weekStart,
  weekNumber,
  type Actual,
  type BrewPlan,
  type Holiday,
  type Settings,
  type Tank,
  type WeekPlan,
} from "../../SERVICES/planning/planningEngine";
import { futureTanks, shortDate, type ShipmentEvent } from "../../SERVICES/planning/dailyPlanner";
import {
  normalizeEmptyTankFlagsForSchedule,
  tankReleases,
  validateProduction,
  validateBrewReleases,
} from "../../SERVICES/planning/productionCycle";
import { validatePlanningWeek } from "../../SERVICES/planning/planningValidation";
import { displayStyle, weekIsClosed } from "../../SERVICES/planning/planningPresentation";
import PlanningBrewAssignmentEditor from "./PlanningBrewAssignmentEditor";
import PlanningWeekGantt from "./PlanningWeekGantt";

type BrewWithAssignment = BrewPlan & {
  tankAssignmentStatus?: "tentative" | "confirmed";
  batchNumber?: string;
};

function assignmentStatus(brew: BrewPlan) {
  return (brew as BrewWithAssignment).tankAssignmentStatus;
}

function plannedBatch(brew: BrewPlan) {
  return (brew as BrewWithAssignment).batchNumber;
}

function forecastDateUndatedPackaging(plans: WeekPlan[]) {
  return plans.map((w) => ({
    ...w,
    packaging: w.packaging.map((r) => r.date ? r : { ...r, date: addDays(w.id, 4) }),
  }));
}

function confirmAssignedBrews(plan: WeekPlan): WeekPlan {
  return {
    ...plan,
    brews: plan.brews.map((brew) => brew.tankId
      ? { ...brew, tankAssignmentStatus: "confirmed" as const }
      : brew),
  };
}

export default function PlanningBoard({
  settings,
  plans,
  tanks,
  brews,
  pallets: _pallets,
  actuals,
  shipments: _shipments,
  today,
  holidays: _holidays,
  disabled,
  saveWeek,
  initialWeek,
}: {
  settings: Settings;
  plans: WeekPlan[];
  tanks: Tank[];
  brews: Fermentor[];
  pallets: Pallet[];
  actuals: Actual[];
  shipments: ShipmentEvent[];
  today: string;
  holidays: Holiday[];
  disabled: boolean;
  saveWeek: (week: WeekPlan) => Promise<void>;
  initialWeek?: string;
}) {
  const pickerStart = weekStart(today);
  const defaultPlanningWeek = addDays(pickerStart, 7);
  const [week, setWeek] = useState(() => initialWeek ?? defaultPlanningWeek);
  const [brewDraft, setBrewDraft] = useState<WeekPlan | null>(null);
  const [selectedPackaging, setSelectedPackaging] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const closed = weekIsClosed(week, today);
  const readOnly = disabled || closed;
  const current = plans.find((w) => w.id === week) ?? { ...emptyWeek(week), maxRuns: settings.preferredRuns };
  const releasePlans = useMemo(() => forecastDateUndatedPackaging(plans), [plans]);
  const reservedOutsideWeek = useMemo(() => new Set(
    plans
      .filter((w) => w.id !== week)
      .flatMap((w) => w.brews)
      .filter((b) => !!b.tankId && b.date >= today)
      .map((b) => b.tankId),
  ), [plans, week, today]);
  const releases = useMemo(
    () => tankReleases(brews, tanks, releasePlans, settings, actuals, today)
      .filter((release) => !reservedOutsideWeek.has(release.tankId)),
    [brews, tanks, releasePlans, settings, actuals, today, reservedOutsideWeek],
  );

  const productLabel = (id: string) => {
    const product = settings.products.find((item) => item.id === id);
    return product ? `${displayStyle(product.style)} · ${product.type === "crates" ? "ארגזים" : "חביות"}` : id;
  };

  const shipmentSummary = (current.deliveries ?? []).map((delivery) => `${productLabel(delivery.productId)} · ${Math.round(delivery.quantity)}`);
  const brewSummary = current.brews.map((brew) => {
    if (!brew.tankId) return `${displayStyle(brew.style)} · טרם שובץ למיכל`;
    const source = brews.find((tank) => tank.id === brew.tankId);
    const tankNumber = source?.tankNumber ?? brew.tankId;
    const batch = plannedBatch(brew);
    const started = Number(source?.action) === 1 && (
      (batch && String(source?.batchNumber) === batch) ||
      (!batch && brew.date <= today && sameStyle(source?.beerStyle ?? "", brew.style))
    );
    if (started) {
      return `${displayStyle(brew.style)} · מיכל ${tankNumber} · בוצע${source?.batchNumber ? ` · אצווה ${source.batchNumber}` : ""}`;
    }
    const status = assignmentStatus(brew) === "tentative" ? "מוצע" : "מאושר";
    return `${displayStyle(brew.style)} · מיכל ${tankNumber} (${status})${batch ? ` · אצווה ${batch}` : ""}`;
  });
  const packagingSummary = current.packaging.map((run) =>
    `${productLabel(run.productId)} · ${Math.round(run.quantity)} · מיכל ${tanks.find((tank) => tank.id === run.tankId)?.number ?? run.tankNumber ?? "?"}${run.date ? ` · ${shortDate(run.date)}` : " · טרם שובץ ליום"}`,
  );

  async function persist(next: WeekPlan, confirmBrews = false) {
    if (weekIsClosed(next.id, today)) throw new Error("השבוע נסגר לתכנון בתחילת יום שישי.");
    const confirmedNext = confirmBrews ? confirmAssignedBrews(next) : next;
    const effectiveNext = normalizeEmptyTankFlagsForSchedule(confirmedNext);
    const all = [...plans.filter((w) => w.id !== effectiveNext.id), effectiveNext];
    const error = validatePlanningWeek(effectiveNext, settings, all, today);
    if (error) throw new Error(error);

    const datedOnly = all.map((w) => ({ ...w, packaging: w.packaging.filter((run) => !!run.date) }));
    const production = validateProduction(datedOnly, settings, futureTanks(tanks, all, settings), actuals, today);
    if (production) throw new Error(production);

    const assignedOnly = forecastDateUndatedPackaging(all).map((w) => ({ ...w, brews: w.brews.filter((brew) => !!brew.tankId) }));
    const dependency = validateBrewReleases(brews, tanks, assignedOnly, settings, actuals, today);
    if (dependency) throw new Error(dependency);

    await saveWeek(effectiveNext);
    setBrewDraft(null);
    setSelectedPackaging(null);
    setMessage(confirmBrews ? "סדר הבישולים ושיבוצי המיכלים אושרו" : "לוח העבודה נשמר");
  }

  function openBrews() {
    if (readOnly) return;
    setBrewDraft(structuredClone(current));
  }

  async function selectPackaging(id: string) {
    if (readOnly || busy) return;
    if (!selectedPackaging) {
      setSelectedPackaging(id);
      setMessage("האריזה נבחרה. לחץ על יום כדי לשבץ, או בחר אריזה אחרת כדי להחליף ביניהן.");
      return;
    }
    if (selectedPackaging === id) {
      setSelectedPackaging(null);
      setMessage("");
      return;
    }

    const next = structuredClone(current);
    const first = next.packaging.find((run) => run.id === selectedPackaging);
    const second = next.packaging.find((run) => run.id === id);
    if (!first || !second) {
      setSelectedPackaging(id);
      return;
    }

    if (!first.date && second.date) {
      first.date = second.date;
      setBusy(true);
      try {
        await persist(next);
        setMessage(`האריזה נוספה ל־${shortDate(second.date)} לצד האריזות שכבר שובצו ליום.`);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "שיבוץ האריזה נכשל");
      } finally {
        setBusy(false);
        setSelectedPackaging(null);
      }
      return;
    }

    if (!first.date && !second.date) {
      setSelectedPackaging(id);
      setMessage("האריזה נבחרה. לחץ על יום כדי לשבץ אותה.");
      return;
    }

    if (first.date === second.date) {
      setSelectedPackaging(id);
      setMessage("האריזה נבחרה. לחץ על יום כדי לשבץ אותה.");
      return;
    }

    const firstDate = first.date;
    const secondDate = second.date;
    first.date = secondDate;
    second.date = firstDate;
    setBusy(true);
    try {
      await persist(next);
      setMessage(firstDate && secondDate ? "ימי האריזות הוחלפו." : "האריזות הוחלפו בין היום לאזור ההמתנה.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "ההחלפה נכשלה");
    } finally {
      setBusy(false);
      setSelectedPackaging(null);
    }
  }

  async function assignSelectedPackagingToDate(date: string) {
    if (!selectedPackaging || readOnly || busy) return;
    const next = structuredClone(current);
    const run = next.packaging.find((item) => item.id === selectedPackaging);
    if (!run) {
      setSelectedPackaging(null);
      return;
    }
    if (run.date === date) {
      setSelectedPackaging(null);
      setMessage("האריזה כבר משובצת ליום הזה.");
      return;
    }

    run.date = date;
    setBusy(true);
    try {
      await persist(next);
      setMessage(`האריזה שובצה ל־${shortDate(date)}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "שיבוץ האריזה נכשל");
    } finally {
      setBusy(false);
      setSelectedPackaging(null);
    }
  }

  return <section>
    {busy && !brewDraft && <BeerLoader overlay message="שומר את התכנון…" />}

    <div className="bp-section-heading">
      <div>
        <h2>לוח עבודה</h2>
        <p className="bp-muted">החלטות המשלוח והבישול הן שבועיות. האריזות משובצות ליום ביצוע.</p>
      </div>
    </div>

    <div className="bp-week-picker">
      {Array.from({ length: 8 }, (_, index) => addDays(pickerStart, index * 7)).map((value) => (
        <button key={value} aria-pressed={week === value} disabled={!!brewDraft} onClick={() => { setWeek(value); setSelectedPackaging(null); }}>
          שבוע {weekNumber(value)}<small>{shortDate(value)}</small>
        </button>
      ))}
    </div>

    <div className="bp-week-sticky" role="status">
      <b>שבוע {weekNumber(week)}</b>
      <span>{shortDate(week)}–{shortDate(addDays(week, 6))}</span>
      <small>{week === defaultPlanningWeek ? "שבוע התכנון הבא" : "לוח עבודה"}</small>
    </div>

    {closed && <p role="status">השבוע הסתיים לתכנון בתחילת יום שישי · צפייה בלבד.</p>}
    {message && <p role="status">{message}</p>}

    <div className="bp-daily-sets bp-weekly-execution-sets">
      <article className="bp-daily-set is-delivery">
        <h3>משלוח לטמפו · שבועי</h3>
        <div><b>החלטה ליישום</b>{shipmentSummary.length ? shipmentSummary.map((item, index) => <span key={index}>{item}</span>) : <small>לא נקבע משלוח</small>}</div>
      </article>

      <article className="bp-daily-set is-brew">
        <h3>בישולים · שבועי</h3>
        <div><b>החלטות ליישום</b>{brewSummary.length ? brewSummary.map((item, index) => <span key={index}>{item}</span>) : <small>לא נקבעו בישולים</small>}</div>
        <small>מנהל העבודה קובע את סדר הבישולים ואת המיכל. מספרי האצווה מתעדכנים אוטומטית לפי הסדר.</small>
        <button type="button" disabled={readOnly || current.brews.length === 0} onClick={openBrews}>סדר ושיבוץ בישולים</button>
      </article>

      <article className="bp-daily-set is-packaging">
        <h3>אריזות · יומי</h3>
        <div><b>החלטות השבוע</b>{packagingSummary.length ? packagingSummary.map((item, index) => <span key={index}>{item}</span>) : <small>לא נקבעו אריזות</small>}</div>
      </article>
    </div>

    <PlanningWeekGantt
      settings={settings}
      plans={plans}
      tanks={tanks}
      week={week}
      onAssignPackagingToDate={assignSelectedPackagingToDate}
      selectedPackagingId={selectedPackaging}
      onSelectPackaging={selectPackaging}
    />

    {brewDraft && <div className="bp-modal-backdrop" role="presentation">
      <div className="bp-modal bp-planning-scroll-modal" role="dialog" aria-modal="true" aria-label="שיבוץ בישולים למיכלים">
        <PlanningBrewAssignmentEditor
          initial={brewDraft}
          brews={brews}
          releases={releases}
          disabled={readOnly || busy}
          onSave={async (next) => {
            setBusy(true);
            try { await persist(next, true); }
            finally { setBusy(false); }
          }}
          onCancel={() => setBrewDraft(null)}
        />
      </div>
    </div>}
  </section>;
}
