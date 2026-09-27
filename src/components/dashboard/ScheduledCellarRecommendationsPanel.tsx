import { useMemo, useState } from "react";
import {
  createScheduledCellarRecommendation,
  scheduledActionLabel,
  scheduledForTank,
  setScheduledCellarRecommendationStatus,
  todayDateKey,
  type PressureChangeDirection,
  type ScheduledCellarActionType,
  type ScheduledCellarRecommendation,
} from "../../SERVICES/cellering/scheduledCellarRecommendations";
import "./ScheduledCellarRecommendationsPanel.css";

export type NaturalFutureCellarRecommendation = {
  id: string;
  actionType: ScheduledCellarActionType;
  label: string;
  dueDate?: string;
  detail?: string;
};

export type PressureDecisionCandidate = {
  reason: string;
};

type Props = {
  tankNumber: string | number;
  batchNumber: string | number;
  rows: ScheduledCellarRecommendation[];
  naturalFuture?: NaturalFutureCellarRecommendation[];
  pressureDecisionCandidate?: PressureDecisionCandidate;
};

function tomorrowKey(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return todayDateKey(date);
}

function displayDate(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

function pressureContext(reason: string): string {
  return reason
    .replace(/\s*מומלץ לבצע שינוי לחץ בהתאם או לוודא שבוצע\.?\s*$/u, "")
    .replace(/\s*מומלץ לבצע שינוי לחץ בהתאם\.?\s*$/u, "")
    .replace(/[.\s]+$/u, "")
    .trim();
}

export default function ScheduledCellarRecommendationsPanel({
  tankNumber,
  batchNumber,
  rows,
  naturalFuture = [],
  pressureDecisionCandidate,
}: Props) {
  const [open, setOpen] = useState(false);
  const [actionType, setActionType] = useState<ScheduledCellarActionType>("carbTest");
  const [dueDate, setDueDate] = useState(tomorrowKey);
  const [note, setNote] = useState("");
  const [pressureDirection, setPressureDirection] = useState<PressureChangeDirection>("lower");
  const [targetPressure, setTargetPressure] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const existing = useMemo(
    () => scheduledForTank(rows, tankNumber, batchNumber),
    [rows, tankNumber, batchNumber],
  );

  const today = todayDateKey();
  const hasTodayPressureDecision = existing.some(
    (row) => row.actionType === "pressureChange" && row.dueDate === today
  );

  const futureItems = useMemo(() => {
    const visibleManual = existing.filter((manual) =>
      !naturalFuture.some((natural) =>
        natural.actionType === manual.actionType &&
        Boolean(natural.dueDate) &&
        natural.dueDate === manual.dueDate
      )
    );

    return [
      ...naturalFuture.map((row) => ({
        key: `natural:${row.id}`,
        actionType: row.actionType,
        label: row.label,
        dueDate: row.dueDate,
        detail: row.detail,
        manualId: null as string | null,
        userDecision: false,
      })),
      ...visibleManual.map((row) => ({
        key: `manual:${row.id}`,
        actionType: row.actionType,
        label: `החלטת משתמש · ${scheduledActionLabel(row.actionType)}`,
        dueDate: row.dueDate,
        detail: row.note || undefined,
        manualId: row.id,
        userDecision: true,
      })),
    ].sort((a, b) =>
      String(a.dueDate ?? "9999-99-99").localeCompare(String(b.dueDate ?? "9999-99-99"))
    );
  }, [existing, naturalFuture]);

  async function add() {
    if (!dueDate) return;
    if (existing.some((row) => row.actionType === actionType && row.dueDate === dueDate)) {
      setMessage("כבר קיימת החלטת משתמש מאותו סוג לתאריך הזה");
      return;
    }
    if (naturalFuture.some((row) => row.actionType === actionType && row.dueDate === dueDate)) {
      setMessage("כבר קיימת המלצת מערכת מאותו סוג לתאריך הזה");
      return;
    }

    let pressureTarget: number | undefined;
    let scheduledNote = `יש לבצע ${scheduledActionLabel(actionType)}${note.trim() ? ` · ${note.trim()}` : ""}`;
    if (actionType === "pressureChange") {
      pressureTarget = Number(targetPressure);
      if (!Number.isFinite(pressureTarget) || pressureTarget < 0 || pressureTarget > 5) {
        setMessage("יש להזין לחץ יעד תקין בין 0 ל-5 bar");
        return;
      }
      const directionLabel = pressureDirection === "raise" ? "העלאת" : "הורדת";
      scheduledNote = `יש לבצע ${directionLabel} לחץ ל-${pressureTarget} bar${note.trim() ? ` · ${note.trim()}` : ""}`;
    }

    setSaving(true);
    setMessage("");
    try {
      await createScheduledCellarRecommendation({
        tankNumber,
        batchNumber,
        actionType,
        dueDate,
        note: scheduledNote,
        source: "user",
        ...(actionType === "pressureChange"
          ? {
              pressureDirection,
              targetPressure: pressureTarget,
            }
          : {}),
      });
      setNote("");
      if (actionType === "pressureChange") setTargetPressure("");
      setOpen(false);
      setMessage("החלטת המשתמש נשמרה");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "שמירת החלטת המשתמש נכשלה");
    } finally {
      setSaving(false);
    }
  }

  async function addPressureDecision() {
    if (!pressureDecisionCandidate || hasTodayPressureDecision) return;
    const target = Number(targetPressure);
    if (!Number.isFinite(target) || target < 0 || target > 5) {
      setMessage("יש להזין לחץ יעד תקין בין 0 ל-5 bar");
      return;
    }

    const directionLabel = pressureDirection === "raise" ? "העלאת" : "הורדת";
    const context = pressureContext(pressureDecisionCandidate.reason);
    const decisionText = `${context ? `${context}. ` : ""}יש לבצע ${directionLabel} לחץ ל-${target} bar`;

    setSaving(true);
    setMessage("");
    try {
      await createScheduledCellarRecommendation({
        tankNumber,
        batchNumber,
        actionType: "pressureChange",
        dueDate: today,
        note: decisionText,
        pressureDirection,
        targetPressure: target,
        source: "user",
      });
      setTargetPressure("");
      setMessage("החלטת המשתמש נוספה להמלצות של היום");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "שמירת החלטת המשתמש נכשלה");
    } finally {
      setSaving(false);
    }
  }

  async function finish(id: string, status: "completed" | "cancelled") {
    setSaving(true);
    setMessage("");
    try {
      await setScheduledCellarRecommendationStatus(id, status);
      setMessage(
        status === "completed"
          ? "סומן כבוצע — הפעולה תקבל ניקוד חיובי במדד של היום"
          : "החלטת המשתמש בוטלה ולא תוצג יותר"
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "עדכון ההחלטה נכשל");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="scheduled-cellar-panel">
      <div className="scheduled-cellar-heading">
        <strong>המלצות עתידיות</strong>
        <button type="button" disabled={saving} onClick={() => setOpen((value) => !value)}>
          {open ? "ביטול" : "+ המלצה"}
        </button>
      </div>

      {pressureDecisionCandidate && !hasTodayPressureDecision && (
        <div className="scheduled-pressure-decision">
          <strong>החלטת משתמש בעקבות גיזוז לא תקין</strong>
          <small>{pressureDecisionCandidate.reason}</small>
          <div className="scheduled-pressure-decision-form">
            <select
              value={pressureDirection}
              onChange={(event) => setPressureDirection(event.target.value as PressureChangeDirection)}
            >
              <option value="lower">הורדת לחץ</option>
              <option value="raise">העלאת לחץ</option>
            </select>
            <input
              type="number"
              min="0"
              max="5"
              step="0.01"
              inputMode="decimal"
              value={targetPressure}
              placeholder="לחץ יעד (bar)"
              onChange={(event) => setTargetPressure(event.target.value)}
            />
            <button type="button" disabled={saving || !targetPressure} onClick={() => void addPressureDecision()}>
              {saving ? "שומר…" : "הוסף להיום"}
            </button>
          </div>
        </div>
      )}

      {futureItems.length === 0 ? (
        <small className="scheduled-cellar-empty">אין המלצות עתידיות למיכל הזה</small>
      ) : (
        <div className="scheduled-cellar-list">
          {futureItems.map((row) => (
            <div
              className={`scheduled-cellar-row${row.userDecision ? " user-decision" : ""}`}
              key={row.key}
            >
              <div>
                <b>{row.label}</b>
                <span>
                  {row.dueDate ? displayDate(row.dueDate) : "מועד יחושב לפי התהליך"}
                  {row.detail ? ` · ${row.detail}` : ""}
                </span>
              </div>
              {row.manualId && (
                <div className="scheduled-cellar-actions">
                  <button type="button" disabled={saving} onClick={() => void finish(row.manualId!, "completed")}>בוצע</button>
                  <button type="button" disabled={saving} onClick={() => void finish(row.manualId!, "cancelled")}>בטל</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {open && (
        <div className="scheduled-cellar-form">
          <select
            value={actionType}
            onChange={(event) => {
              const nextActionType = event.target.value as ScheduledCellarActionType;
              setActionType(nextActionType);
              if (nextActionType === "pressureChange") {
                setDueDate(todayDateKey());
              }
            }}
          >
            <option value="carbTest">בדיקת גיזוז</option>
            <option value="yeastDrop">הורדת שמרים</option>
            <option value="pressureChange">שינוי לחץ</option>
          </select>
          <input type="date" min={todayDateKey()} value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
          {actionType === "pressureChange" && (
            <>
              <select
                value={pressureDirection}
                onChange={(event) => setPressureDirection(event.target.value as PressureChangeDirection)}
              >
                <option value="lower">הורדת לחץ</option>
                <option value="raise">העלאת לחץ</option>
              </select>
              <input
                type="number"
                min="0"
                max="5"
                step="0.01"
                inputMode="decimal"
                value={targetPressure}
                placeholder="לחץ יעד (bar)"
                onChange={(event) => setTargetPressure(event.target.value)}
              />
            </>
          )}
          <input value={note} placeholder="הערה (אופציונלי)" onChange={(event) => setNote(event.target.value)} />
          <button
            type="button"
            disabled={saving || !dueDate || (actionType === "pressureChange" && !targetPressure)}
            onClick={() => void add()}
          >
            {saving ? "שומר…" : "שמירה"}
          </button>
        </div>
      )}

      {message && <small className="scheduled-cellar-message">{message}</small>}
    </section>
  );
}
