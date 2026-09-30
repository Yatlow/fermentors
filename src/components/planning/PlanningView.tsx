import BeerLoader from "../general/Loading";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  doc,
  getDocFromServer,
  getDocsFromServer,
  query,
  Timestamp,
  where,
  updateDoc,
  serverTimestamp,
} from "firebase/firestore";
import type { Fermentor } from "../../App";
import { runtimeConfig } from "../../config/runtimeConfig";
import { auth, db } from "../../firebase";
import { addDays, parseDate, tanksFrom, weekStart, type Settings } from "../../SERVICES/planning/planningEngine";
import { withTentativeFiveWeekTanks } from "../../SERVICES/planning/tentativePackaging";
import { startOfJerusalemDay, useHolidays, usePlanning, usePlanningToday, type PlanningReadScope } from "../../SERVICES/planning/usePlanning";
import {
  mergeCompletedDeliveriesBack,
  pendingPlansAfterActualShipments,
  settingsAfterActualShipments,
} from "../../SERVICES/planning/shipmentActuals";
import {
  mergeCompletedPackagingBack,
  plansAfterActualPackagingCompletion,
} from "../../SERVICES/planning/packagingActuals";
import PlanningBoard from "./PlanningBoard";
import PlanningData from "./PlanningData";
import PlanningStock from "./PlanningStock";
import PlanningReview from "./PlanningReview";
import PlanningTanks from "./PlanningTanks";
import PlanningWeeklyReservations from "./PlanningWeeklyReservations";
import PlanningShipmentStatusPortal from "./PlanningShipmentStatusPortal";
import PlanningGantt from "./PlanningGantt";
import PlanningShadowV2 from "./PlanningShadowV2";
import type { PlanningTab } from "./planningTabs";
import "./planning.css";
import "./planningEnhancements.css";
import "./planningFiveWeek.css";
import "./planningFiveWeekCalendarSpacing.css";
import "./planningGantt.css";

type PlanningQueryTiming = {
  label: string;
  ms: number;
  docs: number;
  error?: string;
};

export default function PlanningView({ brews, canEdit, tab, onOpenCoolerMap }: {
  brews: Fermentor[];
  canEdit: boolean;
  tab: PlanningTab;
  onTabChange: (tab: PlanningTab) => void;
  onOpenCoolerMap?: () => void;
}) {
  const today = usePlanningToday();
  const productionTanks = useMemo(() => brews.filter((t) => Number(t.tankNumber) !== 1), [brews]);

  const stickyReadScope = useRef<PlanningReadScope>({ plans: true });
  const needsPallets = tab === "stock" || tab === "calendar" || tab === "fiveWeeks" || tab === "schedule";
  const needsActuals = tab === "calendar" || tab === "fiveWeeks" || tab === "schedule" || tab === "tanks" || tab === "review";
  const needsShipments = tab === "calendar" || tab === "fiveWeeks" || tab === "schedule";
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
  const { holidays, error: holidayError } = useHolidays(weekStart(today), addDays(weekStart(today), 83));
  const planningAuditStartedAt = useRef(Date.now());
  const planningAuditLogged = useRef(false);
  const planningServerProbeStarted = useRef(false);
  const [planningAuditElapsedMs, setPlanningAuditElapsedMs] = useState<number | null>(null);
  const [planningQueryTimings, setPlanningQueryTimings] = useState<PlanningQueryTiming[]>([]);
  const showPreviewDiagnostics = runtimeConfig.deployEnv !== "production";

  // One diagnostic write per PlanningView mount. This intentionally does not
  // write again when the user switches tabs inside Planning.
  useEffect(() => {
    const currentUser = auth.currentUser;
    if (!currentUser?.email) return;
    void updateDoc(doc(db, "approvedUsers", currentUser.email), {
      lastPlanningOpenedAt: serverTimestamp(),
      lastPlanningTab: tab,
    }).catch((error) => {
      console.error("Failed to record planning open:", error);
    });
    // The initial tab is captured on mount only by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (data.loading || planningAuditLogged.current) return;
    planningAuditLogged.current = true;
    const elapsedMs = Date.now() - planningAuditStartedAt.current;
    setPlanningAuditElapsedMs(elapsedMs);
    console.info("[planning-read-audit] initial planning load", {
      tab,
      elapsedMs,
      plans: plans.length,
      pallets: pallets.length,
      packagingActuals: actuals.length,
      shipments: data.actualShipments.length,
      snapshots: data.snapshots.length,
      productionTanks: productionTanks.length,
      readScope,
      offlineOrCacheBacked: data.offline,
    });
  }, [
    actuals.length,
    data.actualShipments.length,
    data.loading,
    data.offline,
    data.snapshots.length,
    pallets.length,
    plans.length,
    productionTanks.length,
    readScope,
    tab,
  ]);

  useEffect(() => {
    if (!showPreviewDiagnostics || planningServerProbeStarted.current) return;
    planningServerProbeStarted.current = true;
    let cancelled = false;
    const start = weekStart(today);
    const end = addDays(start, 84);
    const logStart = [
      addDays(start, -84),
      ...productionTanks
        .filter((tank) => tank.tankStatus !== true && tank.batchNumber)
        .map((tank) => parseDate(tank.brewDate))
        .filter((date): date is string => !!date && date < today),
    ].sort()[0];

    const timed = async (
      label: string,
      load: () => Promise<{ size?: number; exists?: () => boolean }>,
    ): Promise<PlanningQueryTiming> => {
      const started = performance.now();
      try {
        const result = await load();
        return {
          label,
          ms: performance.now() - started,
          docs: typeof result.size === "number" ? result.size : result.exists?.() ? 1 : 0,
        };
      } catch (error) {
        return {
          label,
          ms: performance.now() - started,
          docs: 0,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    };

    void Promise.all([
      timed("Settings", () => getDocFromServer(doc(db, "planningSettings", "main"))),
      timed("Plans", () => getDocsFromServer(query(
        collection(db, "planningWeeks"),
        where("id", ">=", addDays(start, -84)),
        where("id", "<", end),
      ))),
      timed("Pallets", () => getDocsFromServer(query(
        collection(db, "pallets"),
        where("zone", "in", ["cooler", "pending", "bottleRoom", "loadingDock"]),
      ))),
      timed("Packaging", () => getDocsFromServer(query(
        collection(db, "packagingLog"),
        where("timestamp", ">=", startOfJerusalemDay(logStart).getTime()),
        where("timestamp", "<", startOfJerusalemDay(end).getTime()),
      ))),
      timed("Shipments", () => getDocsFromServer(query(
        collection(db, "shipments"),
        where("createdAt", ">=", Timestamp.fromDate(startOfJerusalemDay(start))),
        where("createdAt", "<", Timestamp.fromDate(startOfJerusalemDay(end))),
      ))),
    ]).then((results) => {
      if (cancelled) return;
      setPlanningQueryTimings(results);
      console.info("[planning-read-audit] per-query server timings", results);
    });

    return () => { cancelled = true; };
  }, [productionTanks, showPreviewDiagnostics, today]);

  const tanks = useMemo(() => tanksFrom(productionTanks, settings, actuals), [productionTanks, settings, actuals]);

  const identityAlignedPlans = plans;
  const [message, setMessage] = useState("");
  const disabled = !canEdit || data.loading || data.offline || !!data.error;

  const executionPlans = useMemo(
    () => plansAfterActualPackagingCompletion(identityAlignedPlans, settings.products, actuals, productionTanks),
    [identityAlignedPlans, settings.products, actuals, productionTanks],
  );

  const weeklyPlans = useMemo(
    () => pendingPlansAfterActualShipments(executionPlans, data.actualShipments, settings.products),
    [executionPlans, data.actualShipments, settings.products],
  );

  const calendarSettings = useMemo(
    () => settingsAfterActualShipments(settings, data.actualShipments, today),
    [settings, data.actualShipments, today],
  );

  const fiveWeekPlans = useMemo(
    () => withTentativeFiveWeekTanks(identityAlignedPlans, tanks, calendarSettings),
    [identityAlignedPlans, tanks, calendarSettings],
  );

  const pendingDailyWork = useMemo(() => {
    const firstWeek = weekStart(today);
    const horizonEnd = addDays(firstWeek, 34);
    const upcomingPlans = identityAlignedPlans.filter((plan) => plan.id >= firstWeek && plan.id <= horizonEnd);
    const brewsToAssign = upcomingPlans.reduce((sum, plan) => sum + plan.brews.filter((brew) => !brew.tankId).length, 0);
    const packagingToAssign = upcomingPlans.reduce((sum, plan) => sum + plan.packaging.filter((run) => run.quantity > 0 && !run.date).length, 0);
    return { brews: brewsToAssign, packaging: packagingToAssign, total: brewsToAssign + packagingToAssign };
  }, [identityAlignedPlans, today]);

  useEffect(() => {
    const applyBadge = () => {
      const nav = document.querySelector<HTMLElement>('nav[aria-label="תכנון"]');
      const button = Array.from(nav?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((item) => item.textContent?.includes("לוח עבודה יומי"));
      if (!button) return;
      if (pendingDailyWork.total > 0) {
        button.dataset.planningBadge = String(pendingDailyWork.total);
        button.title = `${pendingDailyWork.brews} בישולים ו־${pendingDailyWork.packaging} אריזות ממתינים לשיבוץ בחמשת השבועות הקרובים`;
        button.setAttribute("aria-label", `לוח עבודה יומי, ${pendingDailyWork.brews} בישולים ו־${pendingDailyWork.packaging} אריזות ממתינים לשיבוץ בחמשת השבועות הקרובים`);
      } else {
        delete button.dataset.planningBadge;
        button.removeAttribute("title");
        button.setAttribute("aria-label", "לוח עבודה יומי");
      }
    };
    applyBadge();
    const header = document.querySelector(".dashboard-header");
    const observer = new MutationObserver(() => requestAnimationFrame(applyBadge));
    if (header) observer.observe(header, { childList: true, subtree: true, attributes: true });
    const interval = window.setInterval(applyBadge, 1500);
    return () => { observer.disconnect(); window.clearInterval(interval); };
  }, [pendingDailyWork.brews, pendingDailyWork.packaging, pendingDailyWork.total]);

  async function saveSettings(next: Settings) {
    await data.saveSettings(next);
    setMessage("הנתונים נשמרו");
  }

  async function saveWeeklyPlan(next: Parameters<typeof data.saveWeek>[0], options?: Parameters<typeof data.saveWeek>[1]) {
    const original = plans.find((week) => week.id === next.id);
    let merged = original ? mergeCompletedDeliveriesBack(original, next, data.actualShipments, settings.products) : next;
    if (original) merged = mergeCompletedPackagingBack(original, merged, settings.products, actuals, productionTanks);
    await data.saveWeek(merged, options);
  }

  return (
    <section className="brew-planning" dir="rtl">
      {data.loading && !data.error && <div role="status"><BeerLoader message="טוען את לוח העבודה…" /></div>}
      {data.error && <p role="alert" className="bp-alert">טעינת הנתונים נכשלה: {data.error}</p>}
      {data.offline && <p role="status">ממתין לחיבור לשרת.</p>}
      {message && (tab === "data" || tab === "settings") && <p role="status" className="bp-success">{message}</p>}
      {showPreviewDiagnostics && !data.loading && !data.error && (
        <div
          dir="ltr"
          style={{
            margin: "8px 12px",
            padding: "8px 10px",
            border: "1px dashed currentColor",
            borderRadius: 8,
            fontSize: 12,
            lineHeight: 1.5,
            overflowWrap: "anywhere",
          }}
        >
          <div>
            <strong>Planning audit</strong>
            {` · Plans ${plans.length}`}
            {` · Pallets ${pallets.length}`}
            {` · Packaging ${actuals.length}`}
            {` · Shipments ${data.actualShipments.length}`}
            {` · Tanks ${productionTanks.length}`}
            {planningAuditElapsedMs !== null ? ` · Load ${(planningAuditElapsedMs / 1000).toFixed(2)}s` : ""}
            {` · ${data.offline ? "cache/offline" : "server/live"}`}
          </div>
          <div style={{ marginTop: 4 }}>
            <strong>Server probes</strong>
            {planningQueryTimings.length === 0
              ? " · running…"
              : planningQueryTimings.map((item) =>
                  ` · ${item.label} ${(item.ms / 1000).toFixed(2)}s/${item.docs}${item.error ? " ERR" : ""}`
                ).join("")}
          </div>
        </div>
      )}

      {!data.loading && !data.error && <>
        {tab === "stock" && <PlanningStock settings={settings} pallets={pallets} today={today} plans={identityAlignedPlans}/>}
        {tab === "calendar" && <>
          {holidayError && <details><summary>לוח החגים לא נטען</summary>{holidayError}</details>}
          <PlanningWeeklyReservations settings={calendarSettings} plans={weeklyPlans} historyPlans={identityAlignedPlans} tanks={tanks} sources={productionTanks} pallets={pallets} actuals={actuals} shipments={data.actualShipments} holidays={holidays} today={today} disabled={disabled} saveWeek={saveWeeklyPlan} onOpenCoolerMap={onOpenCoolerMap}/>
          <PlanningShipmentStatusPortal plans={identityAlignedPlans} shipments={data.actualShipments} products={settings.products}/>
        </>}
        {tab === "fiveWeeks" && <>
          {holidayError && <details><summary>לוח החגים לא נטען</summary>{holidayError}</details>}
          <PlanningGantt
            settings={calendarSettings}
            plans={fiveWeekPlans}
            editorPlans={identityAlignedPlans}
            historyPlans={identityAlignedPlans}
            tanks={tanks}
            sources={productionTanks}
            pallets={pallets}
            actuals={actuals}
            shipments={data.actualShipments}
            holidays={holidays}
            today={today}
            disabled={disabled}
            canEdit={canEdit}
            saveWeek={saveWeeklyPlan}
            moveCalendarEvent={data.moveCalendarEvent}
            onOpenCoolerMap={onOpenCoolerMap}
          />
        </>}
        {tab === "schedule" && <>
          {holidayError && <details><summary>לוח החגים לא נטען</summary>{holidayError}</details>}
          <PlanningBoard settings={settings} plans={identityAlignedPlans} tanks={tanks} brews={productionTanks} pallets={pallets} actuals={actuals} shipments={data.actualShipments} today={today} holidays={holidays} disabled={disabled} saveWeek={saveWeeklyPlan}/>
        </>}
        {(tab === "data" || tab === "settings") && <PlanningData key={tab} mode={tab} settings={settings} today={today} disabled={disabled} save={saveSettings}/>} 
        {tab === "tanks" && <PlanningTanks tanks={tanks} sources={productionTanks} plans={identityAlignedPlans} settings={settings} actuals={actuals} today={today}/>} 
        {tab === "review" && <PlanningReview settings={settings} plans={identityAlignedPlans} actuals={actuals} snapshots={data.snapshots} error={data.snapshotError} today={today}/>} 
        {tab === "settings" && <PlanningShadowV2 settings={settings} plans={identityAlignedPlans} tanks={tanks} sources={productionTanks} actuals={actuals} today={today}/>} 
      </>}
    </section>
  );
}
