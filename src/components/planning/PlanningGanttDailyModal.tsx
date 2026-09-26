import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { Fermentor } from "../../App";
import type { Pallet } from "../../SERVICES/cooler/Pallettypes ";
import type { Actual, Holiday, Settings, Tank, WeekPlan } from "../../SERVICES/planning/planningEngine";
import type { ShipmentEvent } from "../../SERVICES/planning/dailyPlanner";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";
import PlanningBoard from "./PlanningBoard";

type Kind = "deliveries" | "packaging" | "brews";

type Props = {
  week: string;
  kind: Kind;
  onClose: () => void;
  settings: Settings;
  plans: WeekPlan[];
  tanks: Tank[];
  sources: Fermentor[];
  pallets: Pallet[];
  actuals: Actual[];
  shipments: ShipmentEvent[];
  holidays: Holiday[];
  today: string;
  disabled: boolean;
  saveWeek: (week: WeekPlan) => Promise<void>;
};

const LABELS: Record<Kind, string> = {
  deliveries: "משלוח",
  packaging: "אריזות",
  brews: "בישולים",
};

export default function PlanningGanttDailyModal({
  week,
  kind,
  onClose,
  settings,
  plans,
  tanks,
  sources,
  pallets,
  actuals,
  shipments,
  holidays,
  today,
  disabled,
  saveWeek,
}: Props) {
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

  return createPortal(
    <div
      className="brew-planning bp-gantt-editor-backdrop"
      dir="rtl"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={`bp-gantt-editor-modal bp-gantt-daily-modal is-focus-${kind}`}
        role="dialog"
        aria-modal="true"
        aria-label={`תכנון יומי · ${LABELS[kind]} · ${shortDate(week)}`}
      >
        <header className="bp-gantt-editor-header">
          <div>
            <b>תכנון יומי · {LABELS[kind]}</b>
            <small>שבוע שמתחיל ב־{shortDate(week)}</small>
          </div>
          <button type="button" className="bp-gantt-editor-close" aria-label="סגירה" onClick={onClose}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <div className="bp-gantt-editor-body">
          <PlanningBoard
            settings={settings}
            plans={plans}
            tanks={tanks}
            brews={sources}
            pallets={pallets}
            actuals={actuals}
            shipments={shipments}
            today={today}
            holidays={holidays}
            disabled={disabled}
            saveWeek={saveWeek}
            initialWeek={week}
          />
        </div>
      </section>
    </div>,
    document.body,
  );
}
