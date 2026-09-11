import { addDays } from "../../SERVICES/planning/planningEngine";
import { WEEK_DAYS } from "../../SERVICES/planning/planningPresentation";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";

export default function PlanningDaySelect({
  week,
  value,
  onChange,
  label = "יום",
  allowWeekend = false,
}: {
  week: string;
  value: string;
  onChange: (value: string) => void;
  label?: string;
  allowWeekend?: boolean;
}) {
  const count = allowWeekend || value > addDays(week, 4) ? 7 : 5;
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">בחירת יום</option>
        {WEEK_DAYS.slice(0, count).map((name, i) => (
          <option key={name} value={addDays(week, i)}>
            {name} · {shortDate(addDays(week, i))}
          </option>
        ))}
      </select>
    </label>
  );
}
