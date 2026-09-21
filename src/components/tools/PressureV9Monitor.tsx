import { useEffect, useMemo, useState } from "react";
import {
  collection,
  onSnapshot,
  query,
  where,
} from "firebase/firestore";
import type { Fermentor } from "../../App";
import { db } from "../../firebase";
import type { SpecChart } from "../../SERVICES/getAndPost/getSpecsFromFb";
import { getMeasurementsByBatch } from "../../SERVICES/getAndPost/gettAllDataByBatch";
import {
  estimatePressureV9ForTank,
  type PressureV9LiveResult,
} from "../../SERVICES/cellering/pressurePredictionV9Live";
import {
  PRESSURE_V9_HISTORICAL_REFERENCE,
  PRESSURE_V9_MODEL_VERSION,
  PRESSURE_V9_SHADOW_INITIAL_CHECKPOINT,
} from "../../SERVICES/cellering/pressurePredictionV9Config";
import type {
  PressureV9ShadowSnapshot,
} from "../../SERVICES/cellering/pressurePredictionV9Shadow";
import "./PressureV9Monitor.css";

type ShadowDoc = {
  tankId?: string;
  tankNumber?: number;
  entries?: Record<string, PressureV9ShadowSnapshot>;
};

type ShadowRow = PressureV9ShadowSnapshot & {
  key: string;
  tankId: string;
};

function round(value: number | null | undefined, digits = 3): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return Number(value.toFixed(digits)).toString();
}

function percentile90(values: number[]): number | null {
  const clean = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!clean.length) return null;
  const index = Math.max(0, Math.ceil(clean.length * 0.9) - 1);
  return clean[index];
}

function actionText(
  snapshot: Pick<PressureV9ShadowSnapshot, "action" | "targetPressure">,
): string {
  const pressure = snapshot.targetPressure;
  if (snapshot.action === "raise") {
    return pressure === null ? "העלאת לחץ" : `להעלות לחץ ל-${round(pressure, 2)} bar`;
  }
  if (snapshot.action === "lower") {
    return pressure === null ? "הורדת לחץ" : `להוריד לחץ ל-${round(pressure, 2)} bar`;
  }
  if (snapshot.action === "hold") {
    return pressure === null ? "ללא שינוי לחץ" : `להשאיר לחץ על ${round(pressure, 2)} bar`;
  }
  if (snapshot.action === "outside_operational_range") {
    return "היעד מחוץ לטווח התפעולי — V9 לא נותן יעד לחץ";
  }
  return "אין מספיק מידע גאומטרי להמלצה";
}

function liveActionText(result: PressureV9LiveResult): string {
  return actionText({
    action: result.estimate.action,
    targetPressure: result.estimate.targetPressure,
  });
}

function measurementLabel(id: string): string {
  const match = id.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{1,2})(\d{2})$/);
  if (!match) return id;
  return `${match[3]}/${match[2]}/${match[1]} ${match[4].padStart(2, "0")}:${match[5]}`;
}

function pressureAction(snapshot: PressureV9ShadowSnapshot) {
  return (snapshot.actualActions ?? []).find(
    (action) => action.kind === "pressure" && action.targetPressure !== null,
  );
}

function recommendationMatched(snapshot: PressureV9ShadowSnapshot): boolean {
  if (snapshot.actionable === false) return false;
  if (!snapshot.outcome?.scorable) return false;

  if (snapshot.action === "hold") {
    return !(snapshot.actualActions ?? []).some((action) => action.kind === "pressure");
  }

  if (
    (snapshot.action === "raise" || snapshot.action === "lower") &&
    snapshot.targetPressure !== null
  ) {
    const actual = pressureAction(snapshot);
    return (
      actual?.targetPressure !== null &&
      actual?.targetPressure !== undefined &&
      Math.abs(actual.targetPressure - snapshot.targetPressure) <= 0.05
    );
  }

  return false;
}

export default function PressureV9Monitor({
  brews,
  specs,
}: {
  brews: Fermentor[];
  specs: SpecChart | null;
}) {
  const [rows, setRows] = useState<ShadowRow[]>([]);
  const [loadError, setLoadError] = useState("");
  const [selectedTankId, setSelectedTankId] = useState("");
  const [simCarb, setSimCarb] = useState("");
  const [simPressure, setSimPressure] = useState("");
  const [simTemp, setSimTemp] = useState("");
  const [simTarget, setSimTarget] = useState("");
  const [simResult, setSimResult] = useState<PressureV9LiveResult | null>(null);
  const [simLoading, setSimLoading] = useState(false);
  const [simError, setSimError] = useState("");

  useEffect(() => {
    return onSnapshot(
      query(
        collection(db, "scheduledCellarRecommendations"),
        where("status", "==", "v9_shadow"),
      ),
      (snapshot) => {
        const next: ShadowRow[] = [];
        snapshot.docs.forEach((item) => {
          const data = item.data() as ShadowDoc;
          Object.entries(data.entries ?? {}).forEach(([key, value]) => {
            if (!value) return;
            next.push({
              ...value,
              key,
              tankId: String(data.tankId ?? item.id.replace("v9-shadow-", "")),
            });
          });
        });
        next.sort((a, b) => String(b.measurementId).localeCompare(String(a.measurementId)));
        setRows(next);
        setLoadError("");
      },
      (error) => {
        console.error("Failed loading V9 shadow monitor", error);
        setLoadError("לא ניתן לטעון כרגע את נתוני V9 Shadow.");
      },
    );
  }, []);

  const activeTanks = useMemo(
    () =>
      brews
        .filter(
          (tank) =>
            Number(tank.tankNumber) !== 1 &&
            Number(tank.action) === 1 &&
            tank.batchNumber,
        )
        .slice()
        .sort((a, b) => Number(a.tankNumber) - Number(b.tankNumber)),
    [brews],
  );

  const selectedTank = useMemo(
    () => activeTanks.find((tank) => tank.id === selectedTankId) ?? null,
    [activeTanks, selectedTankId],
  );

  useEffect(() => {
    if (!selectedTank) return;
    setSimCarb(
      selectedTank.currentData?.carbonation === null ||
      selectedTank.currentData?.carbonation === undefined
        ? ""
        : String(selectedTank.currentData.carbonation),
    );
    setSimPressure(
      selectedTank.currentData?.pressure === null ||
      selectedTank.currentData?.pressure === undefined
        ? ""
        : String(selectedTank.currentData.pressure),
    );
    setSimTemp(
      selectedTank.currentData?.temp === null ||
      selectedTank.currentData?.temp === undefined
        ? ""
        : String(selectedTank.currentData.temp),
    );
    const style = String(selectedTank.beerStyle ?? "")
      .trim()
      .toLowerCase()
      .split(/\s+/)[0] || "other";
    const target = specs?.carbonation?.[style] ?? specs?.carbonation?.other;
    setSimTarget(target === undefined ? "" : String(target));
    setSimResult(null);
    setSimError("");
  }, [selectedTank, specs]);

  const completed = rows.filter((row) => row.outcome);
  const scorable = completed.filter((row) => row.outcome?.scorable);
  const scorableErrors = scorable
    .map((row) => row.outcome?.carbonationAbsError)
    .filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value));
  const liveMae = scorableErrors.length
    ? scorableErrors.reduce((sum, value) => sum + value, 0) / scorableErrors.length
    : null;
  const liveP90 = percentile90(scorableErrors);

  const matched = scorable.filter(recommendationMatched);
  const matchedErrors = matched
    .map((row) => row.outcome?.carbonationAbsError)
    .filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value));
  const matchedMae = matchedErrors.length
    ? matchedErrors.reduce((sum, value) => sum + value, 0) / matchedErrors.length
    : null;
  const matchedP90 = percentile90(matchedErrors);

  async function runSimulation() {
    if (!selectedTank || !specs || !selectedTank.batchNumber) return;
    setSimLoading(true);
    setSimResult(null);
    setSimError("");

    try {
      const carbonation = Number(simCarb);
      const pressure = Number(simPressure);
      const temperature = Number(simTemp);
      const target = Number(simTarget);

      if (
        !Number.isFinite(carbonation) ||
        !Number.isFinite(pressure) ||
        !Number.isFinite(temperature) ||
        !Number.isFinite(target)
      ) {
        throw new Error("צריך להזין גיזוז, לחץ, טמפרטורה ויעד תקינים.");
      }

      const measurements = await getMeasurementsByBatch(selectedTank.batchNumber);
      const result = await estimatePressureV9ForTank({
        tank: selectedTank,
        measurements,
        specs,
        carbonation,
        pressure,
        temperature,
        targetCarbonation: target,
      });

      if (!result) {
        throw new Error("V9 לא הצליח לחשב המלצה למצב הזה.");
      }

      setSimResult(result);
    } catch (error) {
      setSimError(error instanceof Error ? error.message : String(error));
    } finally {
      setSimLoading(false);
    }
  }

  return (
    <div className="v9-monitor" dir="rtl">
      <section className="v9-panel">
        <h2>V9 — מעקב חי ואבחון</h2>
        <p>
          V9 כרגע עובד ב-Shadow בלבד: העובדים לא רואים את ההמלצה שלו. המסך הזה
          מיועד לאבחון. מדדי התחזית ההיסטוריים אינם הוכחה שאיכות יעד הלחץ
          הקאונטרפקטואלי טובה; את זה צריך לאמת בנפרד.
        </p>

        <div className="v9-metrics">
          <div><b>{rows.length}</b><span>Snapshots שנאספו</span></div>
          <div><b>{completed.length}</b><span>מקרים עם תוצאה מאוחרת</span></div>
          <div><b>{scorable.length}</b><span>מקרים נקיים שניתנים למדידה</span></div>
          <div><b>{round(liveMae)}</b><span>MAE חי · vol</span></div>
          <div><b>{round(liveP90)}</b><span>P90 חי · vol</span></div>
          <div><b>{matched.length}</b><span>מקרים שבהם הפעולה בפועל תאמה ל-V9</span></div>
          <div><b>{round(matchedMae)}</b><span>MAE כשפעולת V9 בוצעה · vol</span></div>
          <div><b>{round(matchedP90)}</b><span>P90 כשפעולת V9 בוצעה · vol</span></div>
        </div>

        <div className="v9-checkpoint">
          <strong>
            Checkpoint חי: {Math.min(scorable.length, PRESSURE_V9_SHADOW_INITIAL_CHECKPOINT)}/
            {PRESSURE_V9_SHADOW_INITIAL_CHECKPOINT} מקרים נקיים
          </strong>
          <span>
            זה checkpoint ראשוני בלבד. מספר המקרים שבהם הפעולה בפועל ממש תאמה ל-V9
            מוצג בנפרד, כי רק בהם אפשר לבחון ישירות את ההמלצה ולא רק את הפיזיקה.
          </span>
        </div>

        <div className="v9-reference">
          <strong>נקודת ייחוס היסטורית לתחזית בלבד · {PRESSURE_V9_MODEL_VERSION}</strong>
          <span>
            בדיקת התחזית Out-of-time על {PRESSURE_V9_HISTORICAL_REFERENCE.testBatchCount} האצוות
            החדשות ביותר: MAE בחלונות תואמי מאזן סגור{" "}
            {PRESSURE_V9_HISTORICAL_REFERENCE.closedConsistentMaeVol.toFixed(3)} vol,
            P90 {PRESSURE_V9_HISTORICAL_REFERENCE.closedConsistentP90Vol.toFixed(3)} vol.
            על כלל החלונות: MAE {PRESSURE_V9_HISTORICAL_REFERENCE.allWindowsMaeVol.toFixed(3)},
            P90 {PRESSURE_V9_HISTORICAL_REFERENCE.allWindowsP90Vol.toFixed(3)}.
          </span>
        </div>
        {loadError && <p className="v9-error">{loadError}</p>}
      </section>

      <section className="v9-panel">
        <h3>סימולטור V9 — מה הוא היה ממליץ עכשיו?</h3>
        <p>
          בחר מיכל ושנה חופשי גיזוז/לחץ/טמפרטורה/יעד. רק האצווה של המיכל הנבחר
          נקראת מ-Firestore; אין כאן סריקה של כל ההיסטוריה.
        </p>

        <div className="v9-simulator-grid">
          <label>
            מיכל
            <select
              value={selectedTankId}
              onChange={(event) => setSelectedTankId(event.target.value)}
            >
              <option value="">בחר מיכל</option>
              {activeTanks.map((tank) => (
                <option key={tank.id} value={tank.id}>
                  מיכל {tank.tankNumber} · #{tank.batchNumber} · {tank.beerStyle}
                </option>
              ))}
            </select>
          </label>
          <label>
            גיזוז
            <input value={simCarb} onChange={(event) => setSimCarb(event.target.value)} inputMode="decimal" />
          </label>
          <label>
            לחץ bar
            <input value={simPressure} onChange={(event) => setSimPressure(event.target.value)} inputMode="decimal" />
          </label>
          <label>
            טמפרטורה °C
            <input value={simTemp} onChange={(event) => setSimTemp(event.target.value)} inputMode="decimal" />
          </label>
          <label>
            גיזוז רצוי
            <input value={simTarget} onChange={(event) => setSimTarget(event.target.value)} inputMode="decimal" />
          </label>
        </div>

        <button
          type="button"
          className="status-filter-button active"
          disabled={!selectedTank || !specs || simLoading}
          onClick={() => void runSimulation()}
        >
          {simLoading ? "מחשב V9…" : "חשב מה V9 היה ממליץ"}
        </button>

        {simError && <p className="v9-error">{simError}</p>}

        {simResult && (
          <div className="v9-simulation-result">
            {simResult.actionable ? (
              <strong>{liveActionText(simResult)}</strong>
            ) : (
              <>
                <strong>V9 לא כשיר לתת המלצת לחץ למצב הזה</strong>
                <span>{simResult.blockedReason}</span>
                <span>
                  חישוב גולמי לצורכי אבחון בלבד: {liveActionText(simResult)}
                </span>
              </>
            )}
            <span>
              יעד גיזוז {round(simResult.targetCarbonation, 2)} · k{" "}
              {simResult.kPerHour.toFixed(6)}/h · טמפ׳ סופית משוערת{" "}
              {round(simResult.finalTemperature, 1)}°C
            </span>
            <span>
              תחזית 48ש׳: {round(simResult.estimate.target48hCarbonation)} vol ·{" "}
              {round(simResult.estimate.target48hPressure, 2)} bar
            </span>
            <span>
              תחזית 72ש׳: {round(simResult.estimate.target72hCarbonation)} vol ·{" "}
              {round(simResult.estimate.target72hPressure, 2)} bar
            </span>
            <span>
              תחזית 96ש׳: {round(simResult.estimate.target96hCarbonation)} vol ·{" "}
              {round(simResult.estimate.target96hPressure, 2)} bar
            </span>
            <span>
              רגישות להערכת נפח המיכל:{" "}
              {round(simResult.estimate.geometrySensitivityWidthBar, 2)} bar · הפסד לחץ
              תפעולי עתידי משוער:{" "}
              {round(simResult.estimate.expectedFutureOperationalLossBar, 2)} bar
            </span>
          </div>
        )}
      </section>

      <section className="v9-panel">
        <h3>כל החלטות ה-Shadow</h3>
        {rows.length === 0 ? (
          <p>עוד לא נאספו בדיקות גיזוז מאז הפעלת ה-Shadow בפרודקשן.</p>
        ) : (
          <div className="v9-cases">
            {rows.map((row) => {
              const actualPressureAction = pressureAction(row);
              const matchedCase = recommendationMatched(row);
              return (
                <article key={row.key} className="v9-case">
                  <div className="v9-case-head">
                    <strong>
                      מיכל {row.tankNumber} · #{row.batchNumber} · {row.beerStyle}
                    </strong>
                    <span>{measurementLabel(String(row.measurementId))}</span>
                  </div>

                  <div className="v9-case-grid">
                    <span>
                      מצב: גיזוז {round(row.currentCarbonation, 2)} · לחץ{" "}
                      {round(row.currentPressure, 2)} · {round(row.currentTemperature, 1)}°C
                    </span>
                    <span>יעד: {round(row.targetCarbonation, 2)} vol</span>
                    <strong>
                      V9: {row.actionable === false
                        ? "לא כשיר להמלצה"
                        : actionText(row)}
                    </strong>
                    {row.actionable === false && (
                      <span>
                        סיבה: {row.blockedReason ?? "נפסל ע״י guard"}
                        {" "}· חישוב גולמי: {actionText(row)}
                      </span>
                    )}
                    <span>Confidence: {row.confidence}</span>
                    <span>
                      48ש׳ {round(row.target48hCarbonation)} · 72ש׳{" "}
                      {round(row.target72hCarbonation)} · 96ש׳ {round(row.target96hCarbonation)}
                    </span>
                    <span>
                      פעולה בפועל:{" "}
                      {actualPressureAction
                        ? `${round(actualPressureAction.targetPressure, 2)} bar אחרי ${round(actualPressureAction.delayHoursFromCarbonation, 1)} שעות`
                        : (row.actualActions?.length
                            ? row.actualActions.map((action) => action.kind).join(", ")
                            : "טרם תועדה")}
                    </span>
                    {row.outcome && (
                      <>
                        <span>
                          תוצאה: {round(row.outcome.actualCarbonation, 2)} vol ·{" "}
                          {round(row.outcome.actualPressure, 2)} bar
                        </span>
                        <span>
                          שגיאת תחזית: {round(row.outcome.carbonationAbsError)} vol
                        </span>
                        <span>
                          סטטוס:{" "}
                          {row.outcome.scorable
                            ? "מקרה נקי למדידה"
                            : `לא נכנס למדד (${row.outcome.contaminationReason ?? "לא ידוע"})`}
                        </span>
                        <span>
                          התאמה להמלצת V9:{" "}
                          {matchedCase ? "כן" : "לא / לא ניתן לקבוע"}
                        </span>
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
