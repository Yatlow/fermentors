import { useEffect, useState } from "react";
import { parseDate } from "../../SERVICES/planning/planningEngine";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";

/** Text input deliberately avoids the browser/OS-specific MM/DD date control. */
export default function PlanningDateInput({
  value,
  onChange,
  label = "תאריך",
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(value ? shortDate(value) : "");
  useEffect(() => {
    setText(value ? shortDate(value) : "");
  }, [value]);
  const parsed = parseDate(text);
  return (
    <label>
      {label}
      <input
        type="text"
        inputMode="numeric"
        dir="ltr"
        placeholder="DD/MM/YYYY"
        value={text}
        disabled={disabled}
        aria-invalid={!!text && !parsed}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseDate(e.target.value) ?? e.target.value);
        }}
      />
      {!!text && !parsed && <small role="alert">יש להזין יום/חודש/שנה</small>}
    </label>
  );
}
