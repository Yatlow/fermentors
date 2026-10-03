import { useEffect, useRef, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";
import { buildWeeklyPlanningModel } from "../../SERVICES/planning/weeklyPlanningModel";
import PlanningWeeklyRecommendationsEnhanced from "./PlanningWeeklyRecommendationsEnhanced";

type PlannerProps = ComponentProps<typeof PlanningWeeklyRecommendationsEnhanced>;
type EditorKind = "deliveries" | "packaging" | "brews";

type Props = PlannerProps & { week: string; kind: EditorKind; onClose: () => void };

const KIND_LABEL: Record<EditorKind, string> = { deliveries: "משלוח", packaging: "אריזה", brews: "בישולים" };

export default function PlanningGanttWeekEditorModal({ week, kind, onClose, ...plannerProps }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [confirmOverflow, setConfirmOverflow] = useState(false);
  const savedPlans = plannerProps.historyPlans ?? plannerProps.plans;
  const savedPlan = savedPlans.find((plan) => plan.id === week);
  const hasPackagingDecision = (savedPlan?.packaging ?? []).some((run) => run.quantity > 0);
  const packagingDecisionCount = (savedPlan?.packaging ?? []).filter((run) => run.quantity > 0).length;
  const hasBrewDecision = (savedPlan?.brews ?? []).length > 0;

  const replacementPackagingCount = kind === "packaging" && hasPackagingDecision
    ? buildWeeklyPlanningModel({
        settings: plannerProps.settings, pallets: plannerProps.pallets, tanks: plannerProps.tanks,
        plans: savedPlans.map((plan) => plan.id === week ? { ...plan, packaging: [] } : plan),
        actuals: plannerProps.actuals, sources: plannerProps.sources, today: plannerProps.today,
        week, holidays: plannerProps.holidays, shipments: plannerProps.shipments,
      }).packagingRecommendation.filter((run) => run.quantity > 0).length
    : 0;

  useEffect(() => {
    const syncFocusedEditor = () => {
      const host = hostRef.current;
      if (!host) return;
      if (kind === "packaging" && hasPackagingDecision) {
        const button = host.querySelector<HTMLButtonElement>(".bp-week-packaging-card .bp-actions button:first-child");
        if (button) {
          if (button.textContent?.trim() !== "מחק אריזות ואשר המלצה") button.textContent = "מחק אריזות ואשר המלצה";
          button.classList.add("bp-action-warning");
          button.disabled = plannerProps.disabled || replacementPackagingCount === 0;
        }
      }
      if (packagingDecisionCount !== 5) {
        host.querySelectorAll<HTMLElement>("p, small, div, span").forEach((node) => {
          const text = node.textContent?.trim() ?? "";
          if (text.includes("5 ימי אריזה") || (text.includes("חריגה נקודתית") && text.includes("ברירת המחדל"))) node.style.display = "none";
        });
      }
      if (kind !== "brews") return;
      if (hasBrewDecision) {
        host.querySelectorAll<HTMLElement>(".bp-week-brew-card .bp-decided-list").forEach((list) => {
          if (list.querySelector("b")?.textContent?.trim() === "המלצת המערכת") list.style.display = "none";
        });
      }
      const capacity = host.querySelectorAll(".bp-week-brew-card .bp-brew-tank-chip").length;
      const draftCount = host.querySelectorAll(".bp-week-brew-card .bp-brew-edit-row").length;
      const buttons = [...host.querySelectorAll<HTMLButtonElement>(".bp-week-brew-card button")];
      const normalAdd = buttons.find((button) => button.textContent?.trim() === "+ הוסף בישול");
      const nativeException = buttons.find((button) => button.textContent?.includes("מעבר למיכלים הזמינים כחריגה"));
      if (!normalAdd || draftCount < capacity) return;

      // Keep the real React one-shot exception control in the DOM. The focused
      // modal supplies the confirmation UI, then delegates to that control so
      // the underlying planner state is actually authorized for exactly one brew.
      normalAdd.disabled = true;
      if (nativeException) nativeException.style.display = "none";
      const editList = normalAdd.closest<HTMLElement>(".bp-decided-list");
      if (!editList || editList.querySelector("[data-brew-overflow-confirm]")) return;
      const approve = document.createElement("button");
      approve.type = "button";
      approve.className = "bp-secondary-action";
      approve.dataset.brewOverflowConfirm = "true";
      approve.textContent = "הוסף בישול עם מיכל לא פנוי";
      approve.onclick = () => setConfirmOverflow(true);
      editList.appendChild(approve);
    };
    const frame = window.requestAnimationFrame(syncFocusedEditor);
    const observer = new MutationObserver(syncFocusedEditor);
    if (hostRef.current) observer.observe(hostRef.current, { childList: true, subtree: true, characterData: true });
    return () => { window.cancelAnimationFrame(frame); observer.disconnect(); };
  }, [kind, hasPackagingDecision, packagingDecisionCount, hasBrewDecision, plannerProps.disabled, replacementPackagingCount, week]);

  const approveOverflowBrew = () => {
    const host = hostRef.current;
    if (!host) { setConfirmOverflow(false); return; }
    const buttons = [...host.querySelectorAll<HTMLButtonElement>(".bp-week-brew-card button")];
    const nativeException = buttons.find((button) => button.textContent?.includes("מעבר למיכלים הזמינים כחריגה"));
    if (!nativeException) { setConfirmOverflow(false); return; }

    // First update the planner's real React state (one-shot authorization).
    nativeException.click();
    setConfirmOverflow(false);

    // Let React commit allowUnavailableBrewException=true, then invoke the real
    // add button. addBrew itself immediately consumes/resets that authorization.
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const refreshed = [...(hostRef.current?.querySelectorAll<HTMLButtonElement>(".bp-week-brew-card button") ?? [])];
        const normalAdd = refreshed.find((button) => button.textContent?.trim() === "+ הוסף בישול");
        if (!normalAdd) return;
        normalAdd.disabled = false;
        normalAdd.click();
      });
    });
  };

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener("keydown", onKey); };
  }, [onClose]);

  const modal = (
    <div className="brew-planning bp-gantt-editor-backdrop" dir="rtl" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className={`bp-gantt-editor-modal is-focus-${kind}`} role="dialog" aria-modal="true" aria-label={`עריכת ${KIND_LABEL[kind]} לשבוע ${shortDate(week)}`}>
        <header className="bp-gantt-editor-header">
          <div><b>{KIND_LABEL[kind]} · המלצה מול החלטה</b><small>שבוע שמתחיל ב־{shortDate(week)}</small></div>
          <button type="button" className="bp-gantt-editor-close" aria-label="סגירה" onClick={onClose}><X size={20} aria-hidden="true" /></button>
        </header>
        <div className="bp-gantt-editor-body" ref={hostRef}>
          <PlanningWeeklyRecommendationsEnhanced {...plannerProps} initialSelectedWeek={week} plans={savedPlans} historyPlans={savedPlans} />
        </div>
        {confirmOverflow && <div className="bp-inline-confirm-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirmOverflow(false); }}>
          <section className="bp-inline-confirm" role="alertdialog" aria-modal="true" aria-labelledby="brew-overflow-title">
            <h3 id="brew-overflow-title">שיבוץ במיכל שאינו פנוי</h3>
            <p>כל המיכלים הזמינים לשבוע כבר תפוסים. הבישול הנוסף ידרוש שיבוץ מפורש למיכל שאינו פנוי כרגע.</p>
            <div className="bp-inline-confirm-actions">
              <button type="button" onClick={() => setConfirmOverflow(false)}>ביטול</button>
              <button type="button" className="bp-action-warning" onClick={approveOverflowBrew}>אשר והוסף בישול</button>
            </div>
          </section>
        </div>}
      </section>
    </div>
  );
  return createPortal(modal, document.body);
}
