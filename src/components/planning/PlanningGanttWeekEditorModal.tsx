import { useEffect, useRef, type ComponentProps } from "react";
import { X } from "lucide-react";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";
import PlanningWeeklyRecommendationsEnhanced from "./PlanningWeeklyRecommendationsEnhanced";

type PlannerProps = ComponentProps<typeof PlanningWeeklyRecommendationsEnhanced>;

type Props = PlannerProps & {
  week: string;
  onClose: () => void;
};

export default function PlanningGanttWeekEditorModal({ week, onClose, ...plannerProps }: Props) {
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
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="bp-gantt-editor-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="bp-gantt-editor-modal" role="dialog" aria-modal="true" aria-label={`עריכת תכנון שבוע ${shortDate(week)}`}>
        <header className="bp-gantt-editor-header">
          <div>
            <b>המלצה והחלטה שבועית</b>
            <small>{shortDate(week)}</small>
          </div>
          <button type="button" className="bp-gantt-editor-close" aria-label="סגירה" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <div className="bp-gantt-editor-body" ref={hostRef}>
          <PlanningWeeklyRecommendationsEnhanced {...plannerProps} />
        </div>
      </section>
    </div>
  );
}
