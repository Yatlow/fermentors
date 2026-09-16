import { useMemo, useState, type ComponentProps } from "react";
import PlanningWeeklyRecommendationsEnhanced from "./PlanningWeeklyRecommendationsEnhanced";
import { buildWeeklyPlanningModel } from "../../SERVICES/planning/weeklyPlanningModel";
import { brewSizeLabel } from "../../SERVICES/planning/productionCycle";
import type { BrewPlan, WeekPlan } from "../../SERVICES/planning/planningEngine";
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
 * 2. every unassigned brew decision gets a tentative tank before persistence;
 * 3. the planner can also mark/unmark any eligible physical pallet manually,
 *    while seeing its expiry date and current physical zone.
 *
 * The work board can later keep or change the tentative tank and confirm it.
 */
export default function PlanningWeeklyReservations(props: Props) {
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [markingMessage, setMarkingMessage] = useState("");

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

  async function saveWithTentativeTankAssignments(next: WeekPlan) {
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
      if (brew.tankId) return existing;

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
        liters: option.workLiters,
        tankAssignmentStatus: "tentative",
      };
    });

    await props.saveWeek({ ...next, brews });
  }

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
