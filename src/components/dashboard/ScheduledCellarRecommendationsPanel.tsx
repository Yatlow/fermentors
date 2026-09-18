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

export type NaturalFutureCellarRecommendation = {
  id: string;
  actionType: ScheduledCellarActionType;
  label: string;
  dueDate?: string;
  detail?: string;
};

type Props = {
  tankNumber: string | number;
  batchNumber: string | number;
  rows: ScheduledCellarRecommendation[];
  naturalFuture?: NaturalFutureCellarRecommendation[];
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
  naturalFuture = [],
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
      })),
      ...visibleManual.map((row) => ({
        key: `manual:${row.id}`,
        actionType: row.actionType,
        label: scheduledActionLabel(row.actionType),
        dueDate: row.dueDate,
        detail: row.note || undefined,
        manualId: row.id,
      })),
    ].sort((a, b) =>
      String(a.dueDate ?? "9999-99-99").localeCompare(String(b.dueDate ?? "9999-99-99"))
    );
  }, [existing, naturalFuture]);

  async function add() {
    if (!dueDate) return;
    if (existing.some((row) => row.actionType === actionType && row.dueDate === dueDate)) {
      setMessage("כבר קיימת המלצה ידנית מאותו סוג לתאריך הזה");
      return;
    }
    if (naturalFuture.some((row) => row.actionType === actionType && row.dueDate === dueDate)) {
      setMessage("כבר קיימת המלצה טבעית מאותו סוג לתאריך הזה");
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
      setMessage(
        status === "completed"
          ? "סומן כבוצע — הפעולה תקבל ניקוד חיובי במדד של היום"
          : "ההמלצה בוטלה ולא תוצג יותר"
      );
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

      {futureItems.length === 0 ? (
        <small className="scheduled-cellar-empty">אין המלצות עתידיות למיכל הזה</small>
      ) : (
        <div className="scheduled-cellar-list">
          {futureItems.map((row) => (
            <div className="scheduled-cellar-row" key={row.key}>
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
