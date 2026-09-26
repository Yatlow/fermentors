import { useEffect, useMemo, useRef, type ComponentProps, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { emptyWeek } from "../../SERVICES/planning/planningEngine";
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
  const replacingPackagingRef = useRef(false);

  const savedWeek = useMemo(
    () => (plannerProps.historyPlans ?? plannerProps.plans).find((plan) => plan.id === week),
    [plannerProps.historyPlans, plannerProps.plans, week],
  );
  const hasPackagingDecision = !!savedWeek?.packaging.some((run) => run.quantity > 0);

  const replacementPackaging = useMemo(() => {
    if (kind !== "packaging" || !hasPackagingDecision) return [];
    const plansWithoutThisPackaging = plannerProps.plans.map((plan) =>
      plan.id === week ? { ...plan, packaging: [] } : plan,
    );
    const model = buildWeeklyPlanningModel({
      settings: plannerProps.settings,
      pallets: plannerProps.pallets,
      tanks: plannerProps.tanks,
      plans: plansWithoutThisPackaging,
      actuals: plannerProps.actuals,
      sources: plannerProps.sources,
      today: plannerProps.today,
      week,
      holidays: plannerProps.holidays,
      shipments: plannerProps.shipments,
    });
    const recommendations = model.packagingRecommendation.filter((run) => run.quantity > 0);
    return recommendations.map((run, index, all) => ({
      id: run.id,
      productId: run.productId,
      quantity: run.quantity,
      tankId: run.tankId,
      tankNumber: run.tankNumber,
      source: "recommendation" as const,
      emptyTank: !all.slice(index + 1).some((later) => later.tankId === run.tankId),
    }));
  }, [
    kind,
    hasPackagingDecision,
    plannerProps.settings,
    plannerProps.pallets,
    plannerProps.tanks,
    plannerProps.plans,
    plannerProps.actuals,
    plannerProps.sources,
    plannerProps.today,
    plannerProps.holidays,
    plannerProps.shipments,
    week,
  ]);

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
    if (kind !== "packaging" || !hasPackagingDecision) return;
    const updateButton = () => {
      const button = Array.from(hostRef.current?.querySelectorAll<HTMLButtonElement>(".bp-week-packaging-card .bp-actions button") ?? [])
        .find((candidate) =>
          candidate.textContent?.includes("הוסף אריזות מהמלצה") ||
          candidate.textContent?.includes("מחק אריזות ואשר המלצה"),
        );
      if (!button) return;
      button.textContent = replacingPackagingRef.current ? "שומר…" : "מחק אריזות ואשר המלצה";
      button.dataset.ganttReplacePackaging = "true";
      button.disabled = replacingPackagingRef.current || plannerProps.disabled || replacementPackaging.length === 0;
      button.classList.add("bp-action-warning");
    };
    updateButton();
    const observer = new MutationObserver(updateButton);
    if (hostRef.current) observer.observe(hostRef.current, { childList: true, subtree: true, characterData: true, attributes: true });
    return () => observer.disconnect();
  }, [kind, hasPackagingDecision, plannerProps.disabled, replacementPackaging.length]);

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

  async function handleCapture(event: ReactMouseEvent<HTMLDivElement>) {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-gantt-replace-packaging='true']");
    if (!button || kind !== "packaging" || !hasPackagingDecision || replacingPackagingRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    if (!replacementPackaging.length) return;

    replacingPackagingRef.current = true;
    button.disabled = true;
    button.textContent = "שומר…";
    try {
      const current = savedWeek ?? { ...emptyWeek(week), maxRuns: plannerProps.settings.preferredRuns };
      await plannerProps.saveWeek({
        ...current,
        packaging: replacementPackaging,
        changeReason: "מחיקת החלטות אריזה ואישור המלצת המערכת",
      });
      onClose();
    } finally {
      replacingPackagingRef.current = false;
    }
  }

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
            <X size={20} />
          </button>
        </header>
        <div className="bp-gantt-editor-body" ref={hostRef} onClickCapture={handleCapture}>
          <PlanningWeeklyRecommendationsEnhanced {...plannerProps} />
        </div>
      </section>
    </div>
  );

  return createPortal(modal, document.body);
}
