import BeerLoader from "../general/Loading";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Fermentor } from "../../App";
import { addDays, tanksFrom, weekStart, type Settings, type WeekPlan } from "../../SERVICES/planning/planningEngine";
import { buildWeeklyPlanningModel } from "../../SERVICES/planning/weeklyPlanningModel";
import { validatePlanningDecisionChange } from "../../SERVICES/planning/planningDecisionSafety";
import { changedMixedPackagingDays } from "../../SERVICES/planning/planningValidation";
import { hasSundayKegOverageApproval, sundayKegOverages, withSundayKegOverageApprovals } from "../../SERVICES/planning/sundayKegCapacity";
import { pendingShipmentSubLabelReviews, type ShipmentSubLabelReview } from "../../SERVICES/planning/planningShipmentReservations";
import { setMarkedForShipment } from "../../SERVICES/cooler/Palletservice";
import { truckPlanningGroupKey } from "../../SERVICES/planning/truckPlanner";
import { planningReadRequirements } from "../../SERVICES/planning/planningReadCoverage";
import { pendingStockExecutionPlans } from "../../SERVICES/planning/planningStockExecution";
import { auditShipmentAvailability, classifyPlanningShortageIncreases, describePlanningShortageIncrease, newlyWorsenedShipmentShortages } from "../../SERVICES/planning/shipmentAvailabilityAudit";
import { confirmableUnpackedShipmentShortages, formatPlannedPackagingDay, weeklyShipmentPackagingRuns } from "../../SERVICES/planning/shipmentProvisionalPlanning";
import { openRuns } from "../../SERVICES/planning/dailyPlanner";
import type { RecommendationEvidence, RecommendationKind } from "../../SERVICES/planning/recommendationAudit";
import { withStablePackagingIdentity } from "../../SERVICES/planning/planIdentity";
import { withTentativeFiveWeekTanks } from "../../SERVICES/planning/tentativePackaging";
import { useHolidays, usePlanning, usePlanningToday, type PlanningReadScope } from "../../SERVICES/planning/usePlanning";
import { mergeCompletedDeliveriesBack, pendingPlansAfterActualShipments, settingsAfterActualShipments } from "../../SERVICES/planning/shipmentActuals";
import { mergeCompletedPackagingBack, plansAfterActualPackagingCompletion } from "../../SERVICES/planning/packagingActuals";
import PlanningBoard from "./PlanningBoard";
import PlanningData from "./PlanningData";
import PlanningStock from "./PlanningStock";
import PlanningReview from "./PlanningReview";
import PlanningTanks from "./PlanningTanks";
import PlanningWeeklyReservations from "./PlanningWeeklyReservations";
import PlanningShipmentStatusPortal from "./PlanningShipmentStatusPortal";
import PlanningGantt from "./PlanningGantt";
import type { PlanningTab } from "./planningTabs";
import "./planning.css";
import "./planningEnhancements.css";
import "./planningFiveWeek.css";
import "./planningFiveWeekCalendarSpacing.css";
import "./planningGantt.css";


/**
 * Old planning documents can contain the same delivery row many times. Keep one
 * copy of an identical historical row; never add quantities, because the repeats
 * are corruption rather than separate planned shipments.
 */
export function withoutDuplicateDeliveries(week: WeekPlan): WeekPlan {
  if (!Array.isArray(week.deliveries) || week.deliveries.length < 2) return week;
  const seen = new Set<string>();
  const deliveries = week.deliveries.filter((delivery) => {
    const key = JSON.stringify(delivery, Object.keys(delivery).sort());
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return deliveries.length === week.deliveries.length ? week : { ...week, deliveries };
}

export default function PlanningView({ brews, canEdit, tab, onTabChange, onOpenCoolerMap, onPendingDailyWorkChange }: {
  brews: Fermentor[];
  canEdit: boolean;
  tab: PlanningTab;
  onTabChange: (tab: PlanningTab) => void;
  onOpenCoolerMap?: () => void;
  onPendingDailyWorkChange?: (count: number) => void;
}) {
  const today = usePlanningToday();
  const productionTanks = useMemo(() => brews.filter((t) => Number(t.tankNumber) !== 1), [brews]);
  const stickyReadScope = useRef<PlanningReadScope>({ plans: true });
  const [inventoryInputOpen, setInventoryInputOpen] = useState(false);
  const { pallets: needsPallets, actuals: needsActuals, shipments: needsShipments } =
    planningReadRequirements(tab);
  if (needsPallets) stickyReadScope.current.pallets = true;
  if (needsActuals) stickyReadScope.current.actuals = true;
  if (needsShipments) stickyReadScope.current.shipments = true;

  const readScope = useMemo<PlanningReadScope>(() => ({
    plans: true,
    pallets: stickyReadScope.current.pallets === true,
    actuals: stickyReadScope.current.actuals === true,
    shipments: stickyReadScope.current.shipments === true,
    snapshots: tab === "review",
  }), [tab, needsPallets, needsActuals, needsShipments]);

  const data = usePlanning(today, productionTanks, readScope);
  const { settings, plans, pallets, actuals } = data;
  const { holidays, error: holidayError } = useHolidays(weekStart(today), addDays(weekStart(today), 90));
  const tanks = useMemo(() => tanksFrom(productionTanks, settings, actuals), [productionTanks, settings, actuals]);
  const tankNumbersById = useMemo(() => Object.fromEntries(
    productionTanks.filter((tank) => tank.tankNumber != null)
      .map((tank) => [tank.id, String(tank.tankNumber)]),
  ), [productionTanks]);
  const identityAlignedPlans = useMemo(() =>
    withStablePackagingIdentity(plans, tankNumbersById), [plans, tankNumbersById]);
  const [message, setMessage] = useState("");
  const [specialPalletReviews, setSpecialPalletReviews] = useState<ShipmentSubLabelReview[]>([]);
  const [specialPalletChoice, setSpecialPalletChoice] = useState<"approve" | "decline" | null>(null);
  const [specialPalletBusy, setSpecialPalletBusy] = useState(false);
  const [specialPalletError, setSpecialPalletError] = useState("");
  const [dismissedSpecialPallets, setDismissedSpecialPallets] = useState<Set<string>>(() => {
    try {
      const stored = JSON.parse(window.sessionStorage.getItem("shipment-sublabel-declines-v1") || "[]");
      return new Set(Array.isArray(stored) ? stored : []);
    } catch { return new Set(); }
  });
  useEffect(() => {
    if (!canEdit || data.loading || !readScope.pallets) return;
    let cancelled = false;
    void pendingShipmentSubLabelReviews(pallets)
      .then((reviews) => {
        if (!cancelled) setSpecialPalletReviews(reviews.filter((review) =>
          !dismissedSpecialPallets.has(`${review.truckId}:${review.dispatchDate}:${review.palletId}`)));
      })
      .catch((error) => {
        if (!cancelled) console.warn("Unable to preview special-label shipment pallets", error);
      });
    return () => { cancelled = true; };
  }, [canEdit, data.loading, readScope.pallets, tab, pallets, identityAlignedPlans, dismissedSpecialPallets]);

  const specialPalletReview = specialPalletReviews[0] ?? null;
  function skipSpecialPalletReview() {
    if (!specialPalletReview) return;
    const key = `${specialPalletReview.truckId}:${specialPalletReview.dispatchDate}:${specialPalletReview.palletId}`;
    setDismissedSpecialPallets((current) => {
      const next = new Set([...current, key]);
      try { window.sessionStorage.setItem("shipment-sublabel-declines-v1", JSON.stringify([...next])); } catch { /* session only */ }
      return next;
    });
    setSpecialPalletReviews((current) => current.filter((row) => row.palletId !== specialPalletReview.palletId));
    setSpecialPalletChoice(null);
    setSpecialPalletError("");
  }
  async function approveSpecialPallet(palletId: string) {
    if (specialPalletBusy) return;
    setSpecialPalletBusy(true);
    setSpecialPalletError("");
    try {
      await setMarkedForShipment(palletId, true);
      skipSpecialPalletReview();
    } catch (error) {
      setSpecialPalletError(error instanceof Error ? error.message : "לא ניתן לסמן את המשטח");
    } finally {
      setSpecialPalletBusy(false);
    }
  }
  const [confirmation, setConfirmation] = useState<{ title: string; message: string; confirmLabel?: string } | null>(null);
  const confirmationResolver = useRef<((approved: boolean) => void) | null>(null);
  function confirmPlanning(message: string, title = "אישור שינוי בתכנון", confirmLabel?: string): Promise<boolean> {
    if (confirmationResolver.current) return Promise.resolve(false);
    return new Promise((resolve) => {
      confirmationResolver.current = resolve;
      setConfirmation({ title, message, confirmLabel });
    });
  }
  function closePlanningConfirmation(approved: boolean) {
    const resolve = confirmationResolver.current;
    confirmationResolver.current = null;
    setConfirmation(null);
    resolve?.(approved);
  }
  useEffect(() => () => {
    confirmationResolver.current?.(false);
    confirmationResolver.current = null;
  }, []);
  const availabilityIssues = useMemo(() => data.loading || !readScope.pallets || !readScope.actuals ? [] : auditShipmentAvailability(settings, pallets, identityAlignedPlans, actuals, today, data.actualShipments), [data.loading, readScope.pallets, readScope.actuals, settings, pallets, identityAlignedPlans, actuals, today, data.actualShipments]);
  const disabled = !canEdit || data.loading || data.offline || !!data.error;
  const executionPlans = useMemo(() => (tab === "calendar" ? plansAfterActualPackagingCompletion(identityAlignedPlans, settings.products, actuals, productionTanks) : identityAlignedPlans), [tab, identityAlignedPlans, settings.products, actuals, productionTanks]);
  const stockPlans = useMemo(() => pendingStockExecutionPlans(
    identityAlignedPlans, settings.products, actuals, data.actualShipments,
    productionTanks,
  ), [identityAlignedPlans, settings.products, actuals, data.actualShipments, productionTanks]);
  const weeklyPlans = useMemo(() => (tab === "calendar" ? pendingPlansAfterActualShipments(executionPlans, data.actualShipments, settings.products) : identityAlignedPlans), [tab, executionPlans, identityAlignedPlans, data.actualShipments, settings.products]);
  const calendarSettings = useMemo(() => ((tab === "calendar" || tab === "fiveWeeks" || tab === "schedule") ? settingsAfterActualShipments(settings, data.actualShipments, today) : settings), [tab, settings, data.actualShipments, today]);
  const fiveWeekPlans = useMemo(() => (tab === "fiveWeeks" ? withTentativeFiveWeekTanks(identityAlignedPlans, tanks, calendarSettings) : identityAlignedPlans), [tab, identityAlignedPlans, tanks, calendarSettings]);
  const pendingDailyWork = useMemo(() => {
    const firstWeek = weekStart(today);
    // The badge represents pending daily assignments in the planning data, not
    // an arbitrary five-week window. The daily board can navigate later planned
    // weeks as well, so keep every current/future week in the count.
    const upcomingPlans = identityAlignedPlans.filter((plan) => plan.id >= firstWeek);
    const brewsToAssign = upcomingPlans.reduce((sum, plan) => sum + plan.brews.filter((brew) => !brew.tankId).length, 0);
    const packagingToAssign = upcomingPlans.reduce((sum, plan) => sum + plan.packaging.filter((run) => run.quantity > 0 && !run.date).length, 0);
    return { brews: brewsToAssign, packaging: packagingToAssign, total: brewsToAssign + packagingToAssign };
  }, [identityAlignedPlans, today]);

  useEffect(() => {
    onPendingDailyWorkChange?.(pendingDailyWork.total);
  }, [onPendingDailyWorkChange, pendingDailyWork.total]);

  async function saveSettings(next: Settings) {
    await data.saveSettings(next);
    setMessage("הנתונים נשמרו");
  }
  async function saveWeeklyPlan(next: Parameters<typeof data.saveWeek>[0], options?: Parameters<typeof data.saveWeek>[1]) {
    const original = identityAlignedPlans.find((week) => week.id === next.id);
    let merged = original ? mergeCompletedDeliveriesBack(original, next, data.actualShipments, settings.products) : next;
    if (original) merged = mergeCompletedPackagingBack(
      original, merged, settings.products, actuals, productionTanks,
      identityAlignedPlans,
    );
    const allWithEditedWeek = identityAlignedPlans.map((week) => week.id === merged.id ? merged : week);
    if (!allWithEditedWeek.some((week) => week.id === merged.id)) allWithEditedWeek.push(merged);
    const identified = withStablePackagingIdentity(allWithEditedWeek, tankNumbersById).find((week) => week.id === merged.id) ?? merged;
    // An exception belongs to the exact physical truck + dispatch date.
    // When a trip is removed/moved, never let its old approval silently
    // authorize a later unrelated trip that happens to reuse the same ID.
    const liveTruckKeys = new Set((identified.deliveries ?? []).map(truckPlanningGroupKey));
    let canonical = identified.oversizeTruckApprovals?.length
      ? { ...identified, oversizeTruckApprovals: identified.oversizeTruckApprovals
          .filter((key) => liveTruckKeys.has(key)) }
      : identified;
    // A Sunday keg capacity approval belongs to the exact date and *exact*
    // total. Reuse an existing unchanged approval, but discard stale approvals
    // when the day/quantity changes or the overage is removed.
    canonical = withSundayKegOverageApprovals({
      ...canonical,
      sundayKegOverageApprovals: canonical.sundayKegOverageApprovals ?? original?.sundayKegOverageApprovals,
    }, settings.products);
    const unapprovedSundayKegs = sundayKegOverages(canonical, settings.products)
      .filter((overage) => !hasSundayKegOverageApproval(canonical, overage));
    if (unapprovedSundayKegs.length) {
      const details = unapprovedSundayKegs.map(({ date, quantity }) =>
        `• ${date}: ${quantity} חביות (${quantity - 100} מעל המגבלה של 100)`)
        .join("\n");
      const accepted = await confirmPlanning(
        `ביום ראשון מגבלת האריזה הרגילה היא 100 חביות.\\n\\n${details}\\n\\n` +
        "זוהי חריגה תפעולית נקודתית שמחייבת בדיקת היתכנות לכוח אדם, ציוד וזמן משמרת. " +
        "האישור יחול רק על התאריך והכמות המוצגים, ולא יבטל מגבלות אחרות.\\n\\n" +
        "לאשר את החריגה ולשמור?",
        "אישור חריגה · אריזת חביות ביום ראשון",
        "אשר חריגה ושמור",
      );
      if (!accepted) throw new Error("השמירה בוטלה: חריגת החביות ביום ראשון לא אושרה.");
      canonical = withSundayKegOverageApprovals(canonical, settings.products, unapprovedSundayKegs);
    }
    // Warn only when this save introduces/changes a shipment decision.
    // A deliberate no-shipment week remains permitted.
    const shipmentDecisionChanged = JSON.stringify(original?.deliveries ?? []) !== JSON.stringify(canonical.deliveries ?? []);
    const packagingDecisionChanged = JSON.stringify(original?.packaging ?? []) !== JSON.stringify(canonical.packaging ?? []);
    const nextPlans = identityAlignedPlans.filter((w) => w.id !== canonical.id).concat(canonical);
    const integrityError = validatePlanningDecisionChange({
      before: identityAlignedPlans, after: nextPlans, edited: canonical, previous: original,
      settings, tanks, sources: productionTanks, actuals, today,
    });
    if (integrityError) throw new Error("התכנון אינו ניתן לביצוע: " + integrityError);
    // A mixed-format shift is a planner decision, not a global bypass of
    // capacity, inventory, other-product or tank-cycle validations.
    // Ask only when the day's actual packaging commitments change.
    const mixedDays = changedMixedPackagingDays(original, canonical, settings);
    if (mixedDays.length) {
      const detail = mixedDays.map(({ date, crates, kegs }) =>
        `• ${date}: ${crates} ארגזים ו־${kegs} חביות`).join("\n");
      const approved = await confirmPlanning(
        "⚠️ אישור שילוב אריזות באותו יום\n\n" +
        detail +
        "\n\nזהו שילוב של אריזת בקבוקים וחביות באותה משמרת. " +
        "מגבלות הכמות לכל סוג והבדיקות התפעוליות נשארות פעילות.\n\n" +
        "האם לאשר את השילוב ולשמור את התכנון?"
      );
      if (!approved) throw new Error("השמירה בוטלה: שילוב בקבוקים וחביות לא אושר.");
    }
    if ((shipmentDecisionChanged || packagingDecisionChanged) && !data.loading && readScope.pallets && readScope.actuals) {
      const after = auditShipmentAvailability(settings, pallets, nextPlans, actuals, today, data.actualShipments);
      const before = auditShipmentAvailability(settings, pallets, identityAlignedPlans, actuals, today, data.actualShipments);
      const increases = newlyWorsenedShipmentShortages(before, after);
      // An undated packaging decision is a legitimate weekly draft. For this
      // single case, a shipment may be saved provisionally after confirmation;
      // the shortage remains in the audit until packaging is reported.
      const provisional = confirmableUnpackedShipmentShortages(
        increases, nextPlans, settings.products, actuals, canonical.id,
        { settings, pallets, today, shipments: data.actualShipments });
      const { blocking, confirmable: futureShortages } =
        classifyPlanningShortageIncreases(
          increases.filter((increase) => !provisional.includes(increase)),
          canonical.id);
      if (blocking.length) {
        throw new Error("לא ניתן לשמור חוסר חדש בשבוע הנערך או שיבוץ משטח/משאית בלתי תקינים: " +
          blocking.map((increase) => describePlanningShortageIncrease(increase, settings.products)).join("; "));
      }
      if (provisional.length) {
        const description = provisional.map((increase) =>
          "• " + describePlanningShortageIncrease(increase, settings.products)).join("\n");
        const pending = openRuns(nextPlans, settings.products, actuals);
        const skus = new Set(provisional.map(({ issue }) => issue.productId));
        const schedule = settings.products
          .filter((product) => skus.has(product.id))
          .flatMap((product) => weeklyShipmentPackagingRuns(pending, canonical.id, product.id)
            .map((run) => {
              const tankNumber = run.tankNumber ??
                productionTanks.find((tank) => tank.id === run.tankId)?.tankNumber ?? "לא ידוע";
              const departures = (canonical.deliveries ?? [])
                .filter((delivery) => delivery.productId === product.id)
                .map((delivery) => delivery.dispatchDate).sort();
              const tooLate = !!run.date && departures.some((date) => date < run.date!);
              return "• " + product.style +
                " · מיכל " + String(tankNumber) +
                " · " + run.remaining + (product.type === "crates" ? " ארגזים" : " חביות") +
                " · " + formatPlannedPackagingDay(run.date) +
                (tooLate ? " ⚠️ לאחר מועד יציאת המשאית (" + departures[0] + ")" : "");
            })).join("\n");
        const accepted = await confirmPlanning(
          "⚠️ המשלוח מתבסס על אריזה שטרם בוצעה בשבוע המשלוח:\n\n" +
          description +
          (schedule ? "\n\nימי האריזות שבהן המשלוח תלוי:\n" + schedule : "") +
          "\n\nהמשלוח יישמר כתכנון מותנה בלבד. אם יום האריזה מאוחר מיום יציאת המשאית, יש לדחות את היציאה או להקדים אריזה. אין להעמיס או לשלח מלאי שטרם נארז.\n\nלאשר את התכנון המותנה?"
        );
        if (!accepted) throw new Error("השמירה בוטלה: תלות באריזה שלא הושלמה לא אושרה.");
      }
      if (futureShortages.length) {
        const description = futureShortages.map((increase) =>
          "• " + describePlanningShortageIncrease(increase, settings.products)).join("\n");
        const accepted = await confirmPlanning(
          "⚠️ שינוי זה ייצור או יגדיל חוסר במשלוחים בשבועות מאוחרים:\n\n" +
          description +
          "\n\nאפשר לשמור את התכנון, אך המשלוחים המפורטים יישארו בלתי מכוסים עד שתעודכן תוכנית האריזה או המלאי.\n\nלאשר שמירה למרות החוסרים?"
        );
        if (!accepted) throw new Error("השמירה בוטלה בעקבות חוסרים עתידיים. לא בוצע שינוי.");
      }
    }
    const priorWeekId = addDays(canonical.id, -7);
    const priorWeek = identityAlignedPlans.find((week) => week.id === priorWeekId);
    const hasNewShipment = (canonical.deliveries ?? []).some((delivery) => delivery.quantity > 0);
    const previousWeekHasShipment = (priorWeek?.deliveries ?? []).some((delivery) => delivery.quantity > 0);
    if (shipmentDecisionChanged && hasNewShipment && canonical.id > weekStart(today) && !previousWeekHasShipment) {
      const accepted = await confirmPlanning(
        `שים לב: מתוכנן משלוח בשבוע ${canonical.id}, אך בשבוע הקודם (${priorWeekId}) אין משלוח מתוכנן.\\nייתכן שהוחמץ שבוע בתכנון.\\n\\nהאם לשמור בכל זאת?`
      );
      if (!accepted) throw new Error("השמירה בוטלה לבקשתך. לא בוצע שינוי.");
    }
    const changed: RecommendationKind[] = [];
    if (JSON.stringify(original?.deliveries ?? []) !== JSON.stringify(canonical.deliveries ?? [])) changed.push("shipment");
    if (JSON.stringify(original?.packaging ?? []) !== JSON.stringify(canonical.packaging ?? [])) changed.push("packaging");
    if (JSON.stringify(original?.brews ?? []) !== JSON.stringify(canonical.brews ?? [])) changed.push("brewing");
    // Reuse the same already-loaded inputs as the planner; no extra Firestore reads.
    // Compute before writing the decision. Never backfill a past recommendation.
    // Remove the edited week's commitments from the recommendation inputs,
    // otherwise the engine can mistake the user's decision for its own proposal.
    const recommendationPlans = identityAlignedPlans.map((plan) => plan.id === canonical.id
      ? { ...plan, deliveries: [], packaging: [], brews: [] }
      : plan);
    const recommendation = changed.length ? buildWeeklyPlanningModel({
      // The saved decision evidence must be based on the same reconciled Tempo
      // stock shown to planners, not an older explicit stock snapshot.
      settings: settingsAfterActualShipments(settings, data.actualShipments, today),
      pallets, tanks, plans: recommendationPlans, actuals,
      sources: productionTanks, today, week: canonical.id, holidays,
      shipments: data.actualShipments,
    }) : null;
    const capturedAt = new Date().toISOString();
    const suppliedOriginalKinds = new Set((canonical.recommendationEvidence ?? [])
      .filter((row) => row.provenance === "decision-time" && row.weekId === canonical.id)
      .map((row) => row.kind));
    const evidence: RecommendationEvidence[] = changed.filter((kind) => !suppliedOriginalKinds.has(kind)).map((kind) => ({
      id: `${canonical.id}:${kind}:${capturedAt}`,
      weekId: canonical.id,
      kind,
      capturedAt,
      algorithmVersion: "weeklyPlanningModel-2026-10",
      provenance: "recomputed-at-save",
      recommended: (kind === "shipment" ? recommendation!.shipmentRecommendation
        : kind === "packaging" ? recommendation!.packagingRecommendation
        : recommendation!.brewRecommendations).map((item) => ({ ...item })),
      decided: (kind === "shipment" ? canonical.deliveries ?? []
        : kind === "packaging" ? canonical.packaging : canonical.brews).map((item) => ({ ...item })),
    }));
    const previousEvidence = original?.recommendationEvidence ?? [];
    const suppliedEvidence = canonical.recommendationEvidence ?? [];
    const uniqueEvidence = [...previousEvidence, ...suppliedEvidence, ...evidence].filter(
      (item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index,
    );
    await data.saveWeek(withoutDuplicateDeliveries({
      ...canonical,
      recommendationEvidence: uniqueEvidence,
    }), options);
  }

  return (
    <section className="brew-planning" dir="rtl">
      {availabilityIssues.length > 0 && <div role="alert" className="bp-alert" style={{ padding: 12, marginBottom: 12 }}>
        <strong>⚠️ בדיקת משלוחים: {availabilityIssues.filter((issue) => !issue.severity || issue.severity === "blocking").length} חסימות, {availabilityIssues.filter((issue) => issue.severity === "partial").length} פערי כמות, {availabilityIssues.filter((issue) => issue.severity === "advisory").length} חריגות קיבולת שאושרו בתכנון</strong>
        <ul>{availabilityIssues.map((issue) => <li key={`${issue.week}:${issue.date}:${issue.productId}:${issue.severity ?? "blocking"}`}>שבוע {issue.week} · {issue.message}</li>)}</ul>
      </div>}
      {data.loading && !data.error && <div role="status"><BeerLoader message="טוען את לוח העבודה…" /></div>}
      {data.error && <p role="alert" className="bp-alert">טעינת הנתונים נכשלה: {data.error}</p>}
      {data.offline && !data.loading && <p role="status">ממתין לחיבור לשרת.</p>}
      {message && (tab === "data" || tab === "settings") && <p role="status" className="bp-success">{message}</p>}
      {!data.loading && !data.error && <>
        {tab === "stock" && <PlanningStock settings={settingsAfterActualShipments(settings, data.actualShipments, today)} pallets={pallets} today={today} plans={stockPlans}/>} 
        {tab === "calendar" && <><>{holidayError && <details><summary>לוח החגים לא נטען</summary>{holidayError}</details>}</><PlanningWeeklyReservations settings={calendarSettings} plans={weeklyPlans} historyPlans={identityAlignedPlans} tanks={tanks} sources={productionTanks} pallets={pallets} actuals={actuals} shipments={data.actualShipments} holidays={holidays} today={today} disabled={disabled} saveWeek={saveWeeklyPlan} onOpenCoolerMap={onOpenCoolerMap}/><PlanningShipmentStatusPortal plans={identityAlignedPlans} shipments={data.actualShipments} products={settings.products}/></>}
        {tab === "fiveWeeks" && <><>{holidayError && <details><summary>לוח החגים לא נטען</summary>{holidayError}</details>}</><PlanningGantt onOpenInventoryInput={() => setInventoryInputOpen(true)} settings={calendarSettings} plans={fiveWeekPlans} editorPlans={identityAlignedPlans} historyPlans={identityAlignedPlans} tanks={tanks} sources={productionTanks} pallets={pallets} actuals={actuals} shipments={data.actualShipments} holidays={holidays} today={today} disabled={disabled} canEdit={canEdit} saveWeek={saveWeeklyPlan} moveCalendarEvent={data.moveCalendarEvent} onOpenCoolerMap={onOpenCoolerMap}/></>}
        {tab === "schedule" && <><>{holidayError && <details><summary>לוח החגים לא נטען</summary>{holidayError}</details>}</><PlanningBoard settings={calendarSettings} plans={identityAlignedPlans} tanks={tanks} brews={productionTanks} pallets={pallets} actuals={actuals} shipments={data.actualShipments} today={today} holidays={holidays} disabled={disabled} saveWeek={saveWeeklyPlan}/></>}
        {(tab === "data" || tab === "settings") && <PlanningData key={tab} mode={tab} settings={settings} today={today} disabled={disabled} save={saveSettings}/>} 
        {tab === "tanks" && <PlanningTanks tanks={tanks} sources={productionTanks} plans={identityAlignedPlans} settings={settings} actuals={actuals} today={today}/>} 
        {tab === "review" && <PlanningReview settings={settings} plans={identityAlignedPlans} actuals={actuals} shipments={data.actualShipments} snapshots={data.snapshots} error={data.snapshotError} today={today}/>} 
      </>}
      {specialPalletReview && canEdit && (
        <div className="bp-inventory-dialog-backdrop">
          <section className="bp-modal bp-planning-scroll-modal" role="dialog" aria-modal="true"
            aria-labelledby="bp-special-pallet-title" style={{ width: "min(92vw, 580px)", maxWidth: 580 }}>
            <h3 id="bp-special-pallet-title">אישור משטח עם תווית משנה</h3>
            <p>במשלוח המתוכנן לתאריך {specialPalletReview.dispatchDate} עבור מק״ט {specialPalletReview.productId},
              נבחר לפי סדר התוקף משטח בכמות {specialPalletReview.quantity} עם תווית משנה:</p>
            <p><strong>{specialPalletReview.subLabel}</strong></p>
            <p>האם לסמן את המשטח הזה למשלוח?</p>
            {specialPalletError && <p role="alert" className="bp-alert">{specialPalletError}</p>}
            {specialPalletChoice === "decline" ? (
              <>
                <p>המשטח לא יסומן אוטומטית. האם לשנות את החלטת המשלוח ולסמן משטח אחר במקום?</p>
                <div className="bp-modal-actions" style={{ flexWrap: "wrap" }}>
                  {specialPalletReview.alternativePallets.map((alternative) => (
                    <button key={alternative.id} type="button" className="btn-primary" disabled={specialPalletBusy}
                      onClick={() => void approveSpecialPallet(alternative.id)}>
                      סמן {alternative.name} · {alternative.quantity} יח׳ · תוקף {alternative.expiry || "לא ידוע"}
                    </button>
                  ))}
                  <button type="button" className="btn-secondary" onClick={() => {
                    skipSpecialPalletReview();
                    onTabChange("calendar");
                    setMessage("תווית המשנה לא אושרה. יש לערוך את החלטת המשלוח ולבחור משטח מתאים.");
                  }}>עבור לתכנון המשלוח</button>
                  <button type="button" className="btn-secondary" onClick={skipSpecialPalletReview}>השאר ללא סימון</button>
                </div>
              </>
            ) : (
              <div className="bp-modal-actions">
                <button type="button" className="btn-secondary" disabled={specialPalletBusy}
                  onClick={() => setSpecialPalletChoice("decline")}>לא, בחר משטח אחר</button>
                <button type="button" className="btn-primary" disabled={specialPalletBusy}
                  onClick={() => void approveSpecialPallet(specialPalletReview.palletId)}>
                  {specialPalletBusy ? "מסמן..." : "כן, סמן למשלוח"}
                </button>
              </div>
            )}
          </section>
        </div>
      )}
      {confirmation && createPortal(
        <div className="bp-inventory-dialog-backdrop brew-planning" dir="rtl"
          style={{ zIndex: "calc(var(--layer-modal, 1000) + 20)" }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closePlanningConfirmation(false);
          }}>
          <section className="bp-modal bp-planning-scroll-modal" role="dialog" aria-modal="true"
            aria-labelledby="bp-confirmation-title" aria-describedby="bp-confirmation-description"
            style={{ maxWidth: 560, width: "min(92vw, 560px)", padding: 20 }}>
            <h3 id="bp-confirmation-title">{confirmation.title}</h3>
            <p id="bp-confirmation-description" style={{ whiteSpace: "pre-line", lineHeight: 1.7 }}>{confirmation.message}</p>
            <div className="bp-modal-actions">
              <button type="button" className="btn-secondary" onClick={() => closePlanningConfirmation(false)}>ביטול</button>
              <button type="button" className="btn-primary" onClick={() => closePlanningConfirmation(true)}>{confirmation.confirmLabel ?? "אישור ושמירה"}</button>
            </div>
          </section>
        </div>,
        document.body,
      )}
      {inventoryInputOpen && tab === "fiveWeeks" && (
        <div className="bp-inventory-dialog-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setInventoryInputOpen(false);
        }}>
          <section className="bp-inventory-dialog" role="dialog" aria-modal="true" aria-label="הזנת נתוני מלאי">
            <button type="button" onClick={() => setInventoryInputOpen(false)}>סגור</button>
            <PlanningData mode="data" settings={settings} today={today} disabled={disabled} save={saveSettings} />
          </section>
        </div>
      )}
    </section>
  );
}