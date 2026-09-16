import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import PlanningWeeklyRecommendationsEnhanced from "./PlanningWeeklyRecommendationsEnhanced";
import { buildWeeklyPlanningModel } from "../../SERVICES/planning/weeklyPlanningModel";
import { brewSizeLabel } from "../../SERVICES/planning/productionCycle";
import { weekStart, type BrewPlan, type WeekPlan } from "../../SERVICES/planning/planningEngine";
import {
  isPlanningShipmentPickZone,
  palletsForPlanningShipmentPicking,
} from "../../SERVICES/planning/planningShipmentReservations";
import { expiryIso } from "../../SERVICES/planning/shipmentPicking";
import { setMarkedForShipment } from "../../SERVICES/cooler/Palletservice";

type Props = ComponentProps<typeof PlanningWeeklyRecommendationsEnhanced>;
type BrewWithAssignment = BrewPlan & {
  tankAssignmentStatus?: "tentative" | "confirmed";
};

const ZONE_LABELS = {
  cooler: "מקרר",
  pending: "ממתינים לשיבוץ",
  bottleRoom: "חדר בקבוקים",
} as const;

/**
 * Planner adapter:
 * 1. cooler + pending + bottleRoom are one FEFO candidate pool;
 * 2. every future unassigned brew decision gets a tentative tank before persistence;
 * 3. existing future plans are backfilled one week at a time after deployment;
 * 4. the planner can also mark/unmark any eligible physical pallet manually,
 *    while seeing its expiry date and current physical zone.
 *
 * The work board can later keep or change the tentative tank and confirm it.
 */
export default function PlanningWeeklyReservations(props: Props) {
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [markingMessage, setMarkingMessage] = useState("");
  const backfillInFlight = useRef(false);
  const backfillAttempted = useRef(new Set<string>());

  const planningPallets = useMemo(
    () => palletsForPlanningShipmentPicking(props.pallets),
    [props.pallets],
  );

  const shipmentPallets = useMemo(
    () => props.pallets
      .filter((pallet) => isPlanningShipmentPickZone(pallet.zone))
      .sort((a, b) => {
        const expiryA = expiryIso(a.expiryDateStr) ?? "9999-12-31";
        const expiryB = expiryIso(b.expiryDateStr) ?? "9999-12-31";
        return expiryA.localeCompare(expiryB) ||
          a.beerStyle.localeCompare(b.beerStyle, "he") ||
          a.quantity - b.quantity;
      }),
    [props.pallets],
  );

  async function toggleManualShipmentMark(palletId: string, currentlyMarked: boolean) {
    if (props.disabled || markingId) return;
    setMarkingId(palletId);
    setMarkingMessage("");
    try {
      await setMarkedForShipment(palletId, !currentlyMarked);
    } catch (error) {
      setMarkingMessage(error instanceof Error ? error.message : "עדכון סימון המשטח נכשל");
    } finally {
      setMarkingId(null);
    }
  }

  const assignTentativeTankAssignments = useCallback((next: WeekPlan): WeekPlan => {
    const model = buildWeeklyPlanningModel({
      settings: props.settings,
      pallets: planningPallets,
      tanks: props.tanks,
      plans: props.plans,
      actuals: props.actuals,
      sources: props.sources,
      today: props.today,
      week: next.id,
      holidays: props.holidays,
      shipments: props.shipments,
    });

    const usedTankIds = new Set(
      next.brews.filter((brew) => !!brew.tankId).map((brew) => brew.tankId),
    );

    const brews: BrewWithAssignment[] = next.brews.map((brew) => {
      const existing = brew as BrewWithAssignment;
      if (brew.tankId || brew.date < props.today) return existing;

      const size = brewSizeLabel(brew.liters);
      const option = model.brewTankOptions.find((candidate) =>
        !usedTankIds.has(candidate.tankId) &&
        candidate.availableDate <= brew.date &&
        candidate.sizeLabel === size,
      ) ?? model.brewTankOptions.find((candidate) =>
        !usedTankIds.has(candidate.tankId) &&
        candidate.availableDate <= brew.date &&
        candidate.workLiters >= brew.liters,
      );

      if (!option) return existing;
      usedTankIds.add(option.tankId);
      return {
        ...brew,
        tankId: option.tankId,
        tankAssignmentStatus: "tentative",
      };
    });

    return { ...next, brews };
  }, [
    planningPallets,
    props.actuals,
    props.holidays,
    props.plans,
    props.settings,
    props.shipments,
    props.sources,
    props.tanks,
    props.today,
  ]);

  async function saveWithTentativeTankAssignments(next: WeekPlan) {
    await props.saveWeek(assignTentativeTankAssignments(next));
  }

  // Migration/backfill for planningWeeks that already existed before this PR.
  // We intentionally process one future week at a time so the next render sees
  // the newly-reserved tank before allocating a tank to a later week.
  useEffect(() => {
    if (props.disabled || backfillInFlight.current) return;

    const currentWeek = weekStart(props.today);
    const candidate = [...props.plans]
      .filter((plan) =>
        plan.id >= currentWeek &&
        plan.brews.some((brew) => !brew.tankId && brew.date >= props.today),
      )
      .sort((a, b) => a.id.localeCompare(b.id))[0];

    if (!candidate) return;

    const attemptKey = `${candidate.id}:${candidate.brews
      .filter((brew) => !brew.tankId && brew.date >= props.today)
      .map((brew) => brew.id)
      .sort()
      .join(",")}`;
    if (backfillAttempted.current.has(attemptKey)) return;
    backfillAttempted.current.add(attemptKey);

    const enriched = assignTentativeTankAssignments(candidate);
    const assignedSomething = enriched.brews.some((brew, index) =>
      !candidate.brews[index]?.tankId && !!brew.tankId,
    );
    if (!assignedSomething) return;

    backfillInFlight.current = true;
    void props.saveWeek(enriched)
      .catch((error) => {
        console.error("Failed backfilling tentative brew tanks", error);
        backfillAttempted.current.delete(attemptKey);
      })
      .finally(() => {
        backfillInFlight.current = false;
      });
  }, [
    assignTentativeTankAssignments,
    props.disabled,
    props.plans,
    props.saveWeek,
    props.today,
  ]);

  return (
    <>
      <PlanningWeeklyRecommendationsEnhanced
        {...props}
        pallets={planningPallets}
        saveWeek={saveWithTentativeTankAssignments}
      />

      <details className="bp-shipment-pallets">
        <summary>משטחים זמינים לסימון משלוח · מקרר / ממתינים / חדר בקבוקים</summary>
        <p className="bp-muted">
          תאריך התפוגה מוצג כאן כדי לאפשר בדיקת FEFO גם בסימון ידני. הבחירה האוטומטית משתמשת באותם שלושת האזורים.
        </p>
        {markingMessage && <p role="alert" className="bp-alert">{markingMessage}</p>}
        {shipmentPallets.length === 0 ? (
          <p className="bp-muted">אין כרגע משטחים באזורים האלה.</p>
        ) : (
          <div className="bp-shipment-pallet-list">
            {shipmentPallets.map((pallet) => {
              const expiry = expiryIso(pallet.expiryDateStr);
              const validForShipment = !!expiry && expiry >= props.today;
              const zoneLabel = ZONE_LABELS[pallet.zone as keyof typeof ZONE_LABELS] ?? pallet.zone;
              return (
                <div className="bp-rec-line" key={pallet.id}>
                  <span>
                    <b>{pallet.beerStyle}</b>
                    {` · ${pallet.quantity} ${pallet.itemType === "crates" ? "ארגזים" : "חביות"}`}
                    {pallet.batchNumber ? ` · אצווה ${pallet.batchNumber}` : ""}
                    {` · ${zoneLabel}`}
                    {` · תוקף ${pallet.expiryDateStr || "לא הוגדר"}`}
                    {!validForShipment && <small> · לא כשיר כרגע למשלוח</small>}
                  </span>
                  <button
                    type="button"
                    disabled={props.disabled || markingId !== null || (!pallet.markedForShipment && !validForShipment)}
                    onClick={() => void toggleManualShipmentMark(pallet.id, !!pallet.markedForShipment)}
                  >
                    {markingId === pallet.id
                      ? "מעדכן…"
                      : pallet.markedForShipment
                        ? "בטל סימון"
                        : "סמן למשלוח"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </details>
    </>
  );
}
