import { useMemo, useState } from "react";
import {
  createScheduledCellarRecommendation,
  scheduledActionLabel,
  scheduledForTank,
  setScheduledCellarRecommendationStatus,
  todayDateKey,
  type ScheduledCellarActionType,
  type ScheduledCellarRecommendation,
} from "../../SERVICES/cellering/scheduledCellarRecommendations";
import "./ScheduledCellarRecommendationsPanel.css";

type Props = {
  tankNumber: string | number;
  batchNumber: string | number;
  rows: ScheduledCellarRecommendation[];
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

export default function ScheduledCellarRecommendationsPanel({
  tankNumber,
  batchNumber,
  rows,
}: Props) {
  const [open, setOpen] = useState(false);
  const [actionType, setActionType] = useState<ScheduledCellarActionType>("carbTest");
  const [dueDate, setDueDate] = useState(tomorrowKey);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const existing = useMemo(
    () => scheduledForTank(rows, tankNumber, batchNumber),
    [rows, tankNumber, batchNumber],
  );

  async function add() {
    if (!dueDate) return;
    if (existing.some((row) => row.actionType === actionType && row.dueDate === dueDate)) {
      setMessage("כבר קיימת המלצה מאותו סוג לתאריך הזה");
      return;
    }

    setSaving(true);
    setMessage("");
    try {
      await createScheduledCellarRecommendation({
        tankNumber,
        batchNumber,
        actionType,
        dueDate,
        note,
      });
      setNote("");
      setOpen(false);
      setMessage("ההמלצה נשמרה");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "שמירת ההמלצה נכשלה");
    } finally {
      setSaving(false);
    }
  }

  async function finish(id: string, status: "completed" | "cancelled") {
    setSaving(true);
    setMessage("");
    try {
      await setScheduledCellarRecommendationStatus(id, status);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "עדכון ההמלצה נכשל");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="scheduled-cellar-panel">
      <div className="scheduled-cellar-heading">
        <strong>המלצות מתוזמנות</strong>
        <button type="button" disabled={saving} onClick={() => setOpen((value) => !value)}>
          {open ? "ביטול" : "+ המלצה"}
        </button>
      </div>

      {existing.length === 0 ? (
        <small className="scheduled-cellar-empty">אין המלצות עתידיות ידניות למיכל הזה</small>
      ) : (
        <div className="scheduled-cellar-list">
          {existing.map((row) => (
            <div className="scheduled-cellar-row" key={row.id}>
              <div>
                <b>{scheduledActionLabel(row.actionType)}</b>
                <span>{displayDate(row.dueDate)}{row.note ? ` · ${row.note}` : ""}</span>
              </div>
              <div className="scheduled-cellar-actions">
                <button type="button" disabled={saving} onClick={() => void finish(row.id, "completed")}>בוצע</button>
                <button type="button" disabled={saving} onClick={() => void finish(row.id, "cancelled")}>בטל</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {open && (
        <div className="scheduled-cellar-form">
          <select value={actionType} onChange={(event) => setActionType(event.target.value as ScheduledCellarActionType)}>
            <option value="carbTest">בדיקת גיזוז</option>
            <option value="yeastDrop">הורדת שמרים</option>
          </select>
          <input type="date" min={todayDateKey()} value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
          <input value={note} placeholder="הערה (אופציונלי)" onChange={(event) => setNote(event.target.value)} />
          <button type="button" disabled={saving || !dueDate} onClick={() => void add()}>
            {saving ? "שומר…" : "שמירה"}
          </button>
        </div>
      )}

      {message && <small className="scheduled-cellar-message">{message}</small>}
    </section>
  );
}
