import { useEffect, useRef, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";
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

  useEffect(() => {
    const targetDate = shortDate(week);
    const timer = window.setTimeout(() => {
      const buttons = hostRef.current?.querySelectorAll<HTMLButtonElement>(".bp-week-picker button") ?? [];
      const target = Array.from(buttons).find((button) => button.querySelector("small")?.textContent?.trim() === targetDate);
      if (target && target.getAttribute("aria-pressed") !== "true") target.click();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [week]);

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

  // The focused editor must inspect the persisted WeekPlan, not a pending/
  // execution-filtered projection. That is what decides whether packaging has
  // already been accepted and therefore whether the action is "replace".
  const savedPlans = plannerProps.historyPlans ?? plannerProps.plans;

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
            plans={savedPlans}
            historyPlans={savedPlans}
          />
        </div>
      </section>
    </div>
  );

  return createPortal(modal, document.body);
}
