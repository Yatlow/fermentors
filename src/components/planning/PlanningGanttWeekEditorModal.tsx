import { useEffect, useRef, useState, type ComponentProps, type MouseEvent as ReactMouseEvent } from "react";
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
      // Do not override the React-controlled "Add brew" disabled state here.
      // The weekly editor calculates capacity from existing decisions plus
      // remaining free tanks; the old DOM count used only the latter and
      // incorrectly disabled this button while tanks 13/18 were available.
    };
    const frame = window.requestAnimationFrame(syncFocusedEditor);
    const observer = new MutationObserver(syncFocusedEditor);
    if (hostRef.current) observer.observe(hostRef.current, { childList: true, subtree: true, characterData: true });
    return () => { window.cancelAnimationFrame(frame); observer.disconnect(); };
  }, [kind, hasPackagingDecision, packagingDecisionCount, hasBrewDecision, plannerProps.disabled, replacementPackagingCount, week]);

  const requestOverflowConfirmation = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (kind !== "brews" || !(event.target instanceof Element)) return;
    const button = event.target.closest("button");
    if (!button?.textContent?.includes("מעבר למיכלים הזמינים כחריגה")) return;
    // Keep native React availability state authoritative and show the modal
    // before the one-shot exception is created.
    event.preventDefault();
    event.stopPropagation();
    setConfirmOverflow(true);
  };

  const approveOverflowBrew = () => {
    window.dispatchEvent(new Event("bp-approve-brew-overflow"));
    setConfirmOverflow(false);
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
        <div className="bp-gantt-editor-body" ref={hostRef} onClickCapture={requestOverflowConfirmation}>
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
