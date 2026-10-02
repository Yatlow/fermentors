import { useEffect, useRef, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";
import { buildWeeklyPlanningModel } from "../../SERVICES/planning/weeklyPlanningModel";
import PlanningWeeklyRecommendationsEnhanced from "./PlanningWeeklyRecommendationsEnhanced";

type PlannerProps = ComponentProps<typeof PlanningWeeklyRecommendationsEnhanced>;
type EditorKind = "deliveries" | "packaging" | "brews";

type Props = PlannerProps & {
  week: string;
  kind: EditorKind;
  onClose: () => void;
};

const KIND_LABEL: Record<EditorKind, string> = {
  deliveries: "משלוח",
  packaging: "אריזה",
  brews: "בישולים",
};

export default function PlanningGanttWeekEditorModal({ week, kind, onClose, ...plannerProps }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

  // The focused editor must inspect the persisted WeekPlan, not a pending/
  // execution-filtered projection. That is what decides whether packaging has
  // already been accepted and therefore whether the action is "replace".
  const savedPlans = plannerProps.historyPlans ?? plannerProps.plans;
  const savedPlan = savedPlans.find((plan) => plan.id === week);
  const hasPackagingDecision = (savedPlan?.packaging ?? []).some((run) => run.quantity > 0);
  const packagingDecisionCount = (savedPlan?.packaging ?? []).filter((run) => run.quantity > 0).length;
  const hasBrewDecision = (savedPlan?.brews ?? []).length > 0;

  const replacementPackagingCount = kind === "packaging" && hasPackagingDecision
    ? buildWeeklyPlanningModel({
        settings: plannerProps.settings,
        pallets: plannerProps.pallets,
        tanks: plannerProps.tanks,
        plans: savedPlans.map((plan) => plan.id === week ? { ...plan, packaging: [] } : plan),
        actuals: plannerProps.actuals,
        sources: plannerProps.sources,
        today: plannerProps.today,
        week,
        holidays: plannerProps.holidays,
        shipments: plannerProps.shipments,
      }).packagingRecommendation.filter((run) => run.quantity > 0).length
    : 0;

  useEffect(() => {
    const syncFocusedEditor = () => {
      const host = hostRef.current;
      if (!host) return;

      if (kind === "packaging" && hasPackagingDecision) {
        const button = host.querySelector<HTMLButtonElement>(".bp-week-packaging-card .bp-actions button:first-child");
        if (button) {
          if (button.textContent?.trim() !== "מחק אריזות ואשר המלצה") {
            button.textContent = "מחק אריזות ואשר המלצה";
          }
          button.classList.add("bp-action-warning");
          button.disabled = plannerProps.disabled || replacementPackagingCount === 0;
        }
      }

      // The five-day note describes a real five-run packaging decision, not a
      // general weekly hint. Do not show it before five packaging decisions exist.
      if (packagingDecisionCount !== 5) {
        host.querySelectorAll<HTMLElement>("p, small, div, span").forEach((node) => {
          const text = node.textContent?.trim() ?? "";
          if (text.includes("5 ימי אריזה") || (text.includes("חריגה נקודתית") && text.includes("ברירת המחדל"))) {
            node.style.display = "none";
          }
        });
      }

      if (kind !== "brews") return;

      // Once the planner has chosen brews, the old recommendation list is no
      // longer actionable and only creates noise in the focused editor.
      if (hasBrewDecision) {
        const lists = host.querySelectorAll<HTMLElement>(".bp-week-brew-card .bp-decided-list");
        lists.forEach((list) => {
          const heading = list.querySelector("b")?.textContent?.trim();
          if (heading === "המלצת המערכת") list.style.display = "none";
        });
      }

      // Use the tanks actually shown as available in this editor. The model's
      // broader capacity can include exception/reuse candidates and must not
      // silently authorize extra brews.
      const capacity = host.querySelectorAll(".bp-week-brew-card .bp-brew-tank-chip").length;
      const draftCount = host.querySelectorAll(".bp-week-brew-card .bp-brew-edit-row").length;
      const buttons = [...host.querySelectorAll<HTMLButtonElement>(".bp-week-brew-card button")];
      const normalAdd = buttons.find((button) => button.textContent?.trim() === "+ הוסף בישול");
      const oldException = buttons.find((button) => button.textContent?.includes("מעבר למיכלים הזמינים כחריגה"));
      if (!normalAdd || draftCount < capacity) return;

      // Reaching physical tank capacity must not turn into an unlimited bypass.
      // Each additional brew requires a fresh, explicit approval.
      normalAdd.disabled = true;
      if (oldException) oldException.style.display = "none";

      const editList = normalAdd.closest<HTMLElement>(".bp-decided-list");
      if (!editList || editList.querySelector("[data-brew-overflow-confirm]")) return;
      const approve = document.createElement("button");
      approve.type = "button";
      approve.className = "bp-secondary-action";
      approve.dataset.brewOverflowConfirm = "true";
      approve.textContent = "הוסף בישול עם מיכל לא פנוי";
      approve.onclick = () => {
        const confirmed = window.confirm("כל המיכלים הזמינים לשבוע כבר תפוסים. להוסיף בישול נוסף שידרוש שיבוץ מפורש למיכל שאינו פנוי כרגע?");
        if (!confirmed) return;
        normalAdd.disabled = false;
        normalAdd.click();
        normalAdd.disabled = true;
      };
      editList.appendChild(approve);
    };

    const frame = window.requestAnimationFrame(syncFocusedEditor);
    const observer = new MutationObserver(syncFocusedEditor);
    if (hostRef.current) observer.observe(hostRef.current, { childList: true, subtree: true, characterData: true });
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [kind, hasPackagingDecision, packagingDecisionCount, hasBrewDecision, plannerProps.disabled, replacementPackagingCount, week]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const modal = (
    <div
      className="brew-planning bp-gantt-editor-backdrop"
      dir="rtl"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={`bp-gantt-editor-modal is-focus-${kind}`}
        role="dialog"
        aria-modal="true"
        aria-label={`עריכת ${KIND_LABEL[kind]} לשבוע ${shortDate(week)}`}
      >
        <header className="bp-gantt-editor-header">
          <div>
            <b>{KIND_LABEL[kind]} · המלצה מול החלטה</b>
            <small>שבוע שמתחיל ב־{shortDate(week)}</small>
          </div>
          <button type="button" className="bp-gantt-editor-close" aria-label="סגירה" onClick={onClose}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <div className="bp-gantt-editor-body" ref={hostRef}>
          <PlanningWeeklyRecommendationsEnhanced
            {...plannerProps}
            initialSelectedWeek={week}
            plans={savedPlans}
            historyPlans={savedPlans}
          />
        </div>
      </section>
    </div>
  );

  return createPortal(modal, document.body);
}
